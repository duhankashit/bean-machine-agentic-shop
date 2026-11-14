import asyncio
import json
import logging
import os
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from typing import Literal
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from backend.agent_graph import create_agent_graph


BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIST_DIR = BASE_DIR / "frontend" / "dist"
load_dotenv(BASE_DIR / ".env")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("bean-machine")

MENU = {
    "drinks": [
        {"id": "latte", "name": "Latte", "price": 4.5, "recipe": "espresso + steamed milk"},
        {"id": "cappuccino", "name": "Cappuccino", "price": 4.25, "recipe": "espresso + silky foam"},
        {"id": "americano", "name": "Americano", "price": 3.5, "recipe": "espresso + hot water"},
        {"id": "mocha", "name": "Mocha", "price": 5, "recipe": "espresso + cocoa + milk"},
    ],
    "milks": [
        {"id": "whole", "name": "Whole milk", "price": 0},
        {"id": "oat", "name": "Oat milk", "price": 0.65},
        {"id": "almond", "name": "Almond milk", "price": 0.65},
        {"id": "soy", "name": "Soy milk", "price": 0.5},
    ],
    "sizes": [
        {"id": "small", "name": "Small", "price": 0, "shots": 1},
        {"id": "medium", "name": "Medium", "price": 0.75, "shots": 2},
        {"id": "large", "name": "Large", "price": 1.25, "shots": 3},
    ],
}


class OrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(max_length=32)
    drink: Literal["latte", "cappuccino", "americano", "mocha"]
    milk: Literal["whole", "oat", "almond", "soy"]
    size: Literal["small", "medium", "large"]
    extraShot: bool
    note: str = Field(max_length=120)
    outsideItem: str = Field(default="", max_length=120)


class SpeechAckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: int = Field(gt=0)


orders: OrderedDict[str, dict] = OrderedDict()


def _menu_item(group: str, item_id: str) -> dict:
    return next(item for item in MENU[group] if item["id"] == item_id)


def _publish(order: dict, event: dict) -> None:
    enriched = {"id": len(order["events"]) + 1, "time": int(time.time() * 1000), **event}
    order["events"].append(enriched)
    if order["voice_enabled"] and event["type"] == "message":
        order["awaiting_speech_event_id"] = enriched["id"]
    for listener in tuple(order["listeners"]):
        listener.put_nowait(enriched)


def _event_line(event: dict) -> str:
    return f"event: update\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"


@lru_cache(maxsize=1)
def _get_graph():
    return create_agent_graph()


async def _run_order(order: dict) -> None:
    selection = order["selection"]
    size = _menu_item("sizes", selection["size"])
    target_shots = size["shots"] + int(selection["extraShot"])
    try:
        graph = _get_graph()
        initial_state = {
            "order": {**selection, "total": order["total"]},
            "target_shots": target_shots,
            "speech_enabled": order["voice_enabled"],
            "speech_gate": order["speech_gate"],
            "transcript": [],
            "events": [],
        }
        async for update in graph.astream(initial_state, stream_mode="updates"):
            for node_update in update.values():
                for event in node_update.get("events", []):
                    _publish(order, event)
        if order["voice_enabled"] and order["awaiting_speech_event_id"] is not None:
            await order["speech_gate"].wait()
            order["awaiting_speech_event_id"] = None
        drink_name = _menu_item("drinks", selection["drink"])["name"]
        outside_item = selection.get("outsideItem", "").strip()
        ready_message = (
            f"{drink_name} and {outside_item} are ready for {selection['name'] or 'you'}!"
            if outside_item
            else f"{drink_name} is ready for {selection['name'] or 'you'}!"
        )
        _publish(
            order,
            {
                "type": "complete",
                "total": order["total"],
                "text": ready_message,
            },
        )
        order["done"] = True
    except Exception as error:
        logger.exception("Agent workflow failed for order %s", order["id"])
        message = str(error) if isinstance(error, RuntimeError) else (
            "The Groq agent workflow failed. Check the API key, model settings, and server log."
        )
        _publish(order, {"type": "error", "text": message})
        order["done"] = True


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    tasks = [order["task"] for order in orders.values() if order.get("task") and not order["task"].done()]
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="Bean & Machine API", lifespan=lifespan)


@app.get("/api/menu")
async def get_menu():
    return MENU


@app.get("/api/health")
async def health():
    configured = bool(os.getenv("GROK_API_KEY"))
    return {
        "status": "ready" if configured else "missing_groq_api_key",
        "model": os.getenv("GROK_MODEL", "qwen/qwen3.8-27b"),
    }


@app.post("/api/orders", status_code=201)
async def create_order(selection: OrderRequest):
    if not os.getenv("GROK_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="Groq is not configured. Add GROK_API_KEY to your .env file and restart the server.",
        )
    drink = _menu_item("drinks", selection.drink)
    milk = _menu_item("milks", selection.milk)
    size = _menu_item("sizes", selection.size)
    total = drink["price"] + milk["price"] + size["price"] + int(selection.extraShot)
    order_id = str(uuid4())
    speech_gate = asyncio.Event()
    speech_gate.set()
    voice_enabled = True
    order = {
        "id": order_id,
        "selection": selection.model_dump(),
        "total": total,
        "events": [],
        "listeners": set(),
        "done": False,
        "voice_enabled": voice_enabled,
        "speech_gate": speech_gate,
        "awaiting_speech_event_id": None,
    }
    orders[order_id] = order
    while len(orders) > 100:
        oldest_id, oldest = next(iter(orders.items()))
        if not oldest["done"]:
            break
        orders.pop(oldest_id)
    order["task"] = asyncio.create_task(_run_order(order))
    return {"id": order_id, "total": total}


@app.post("/api/orders/{order_id}/speech")
async def acknowledge_agent_speech(order_id: str, acknowledgement: SpeechAckRequest):
    order = orders.get(order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    if (
        not order["voice_enabled"]
        or order["done"]
        or acknowledgement.event_id != order["awaiting_speech_event_id"]
    ):
        return {"acknowledged": False}
    order["awaiting_speech_event_id"] = None
    order["speech_gate"].set()
    return {"acknowledged": True}


@app.get("/api/orders/{order_id}/events")
async def order_events(order_id: str):
    order = orders.get(order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")

    async def stream():
        queue: asyncio.Queue[dict] = asyncio.Queue()
        order["listeners"].add(queue)
        backlog = list(order["events"])
        try:
            for event in backlog:
                yield _event_line(event)
                if event["type"] in {"complete", "error"}:
                    return
            while True:
                event = await queue.get()
                yield _event_line(event)
                if event["type"] in {"complete", "error"}:
                    return
        finally:
            order["listeners"].discard(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


if FRONTEND_DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST_DIR, html=True), name="frontend")
