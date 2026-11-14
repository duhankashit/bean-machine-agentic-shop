import asyncio
import unittest

from langchain_core.messages import AIMessage

from backend.agent_graph import AGENT_PROMPTS, build_agent_graph


class FakeModel:
    async def ainvoke(self, messages):
        prompt = messages[-1].content
        return AIMessage(content=f"Confirmed: {prompt[:40]}")


class AgentGraphTests(unittest.TestCase):
    def test_voice_waits_for_current_message_before_calling_next_model(self):
        async def run_graph():
            class CountingModel:
                def __init__(self):
                    self.calls = 0
                    self.first_call = asyncio.Event()
                    self.second_call = asyncio.Event()

                async def ainvoke(self, _messages):
                    self.calls += 1
                    if self.calls == 1:
                        self.first_call.set()
                    elif self.calls == 2:
                        self.second_call.set()
                    return AIMessage(content="A short spoken update.")

            model = CountingModel()
            speech_gate = asyncio.Event()
            speech_gate.set()
            graph = build_agent_graph(model)
            async def consume_graph():
                async for _ in graph.astream(
                    {
                        "order": {
                            "name": "Sam",
                            "drink": "latte",
                            "milk": "whole",
                            "size": "small",
                            "extraShot": False,
                            "note": "",
                        },
                        "target_shots": 1,
                        "speech_enabled": True,
                        "speech_gate": speech_gate,
                        "transcript": [],
                        "events": [],
                    },
                    stream_mode="updates",
                ):
                    pass

            task = asyncio.create_task(consume_graph())
            try:
                await asyncio.wait_for(model.first_call.wait(), timeout=1)
                await asyncio.sleep(0.05)
                self.assertEqual(model.calls, 1)
                speech_gate.set()
                await asyncio.wait_for(model.second_call.wait(), timeout=1)
            finally:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        asyncio.run(run_graph())

    def test_correct_order_has_no_injected_mistake_or_remake(self):
        async def run_graph():
            graph = build_agent_graph(FakeModel())
            return await graph.ainvoke(
                {
                    "order": {
                        "name": "Sam",
                        "drink": "latte",
                        "milk": "oat",
                        "size": "medium",
                        "extraShot": False,
                        "note": "",
                        "outsideItem": "",
                        "total": 5.9,
                    },
                    "target_shots": 2,
                    "transcript": [],
                    "events": [],
                }
            )

        result = asyncio.run(run_graph())
        messages = [event for event in result["events"] if event["type"] == "message"]
        routes = [(event["from"], event["to"]) for event in messages]
        self.assertIn(("owner", "barista"), routes)
        self.assertIn(("owner", "stock"), routes)
        self.assertIn(("owner", "cleaner"), routes)
        self.assertIn(("owner", "quality"), routes)
        self.assertIn(("owner", "cashier"), routes)
        self.assertIn(("stock", "barista"), routes)
        self.assertIn(("cleaner", "owner"), routes)
        self.assertIn(("barista", "quality"), routes)
        self.assertIn(("quality", "cashier"), routes)
        self.assertIn(("cashier", "owner"), routes)
        self.assertNotIn(("owner", "item_buyer"), routes)
        self.assertFalse(any(event.get("kind") == "correction" for event in messages))
        self.assertEqual(routes.count(("barista", "quality")), 1)
        self.assertEqual(len(result["transcript"]), len(messages))

    def test_missing_almond_milk_is_bought_before_brewing(self):
        async def run_graph():
            graph = build_agent_graph(FakeModel())
            return await graph.ainvoke(
                {
                    "order": {
                        "name": "Sam",
                        "drink": "latte",
                        "milk": "almond",
                        "size": "medium",
                        "extraShot": False,
                        "note": "",
                        "outsideItem": "sandwich",
                        "total": 5.9,
                    },
                    "target_shots": 2,
                    "transcript": [],
                    "events": [],
                }
            )

        result = asyncio.run(run_graph())
        messages = [event for event in result["events"] if event["type"] == "message"]
        routes = [(event["from"], event["to"]) for event in messages]
        self.assertIn(("stock", "owner"), routes)
        self.assertIn(("owner", "item_buyer"), routes)
        self.assertIn(("item_buyer", "stock"), routes)
        self.assertIn(("stock", "barista"), routes)
        buyer_index = routes.index(("item_buyer", "stock"))
        brew_index = routes.index(("barista", "quality"))
        self.assertLess(buyer_index, brew_index)
        self.assertEqual(result["purchased_items"], ["almond milk", "sandwich"])

    def test_outside_item_request_is_bought_before_order_delivery(self):
        async def run_graph():
            class EchoTaskModel:
                async def ainvoke(self, messages):
                    return AIMessage(content=messages[-1].content)

            graph = build_agent_graph(EchoTaskModel())
            return await graph.ainvoke(
                {
                    "order": {
                        "name": "Sam",
                        "drink": "latte",
                        "milk": "oat",
                        "size": "medium",
                        "extraShot": False,
                        "note": "",
                        "outsideItem": "sandwich",
                        "total": 5.9,
                    },
                    "target_shots": 2,
                    "transcript": [],
                    "events": [],
                }
            )

        result = asyncio.run(run_graph())
        messages = [event for event in result["events"] if event["type"] == "message"]
        routes = [(event["from"], event["to"]) for event in messages]
        self.assertIn(("stock", "owner"), routes)
        self.assertIn(("owner", "item_buyer"), routes)
        self.assertIn(("item_buyer", "stock"), routes)
        self.assertEqual(result["purchased_items"], ["sandwich"])
        self.assertLess(routes.index(("item_buyer", "stock")), routes.index(("barista", "quality")))
        self.assertIn("sandwich", messages[-1]["text"])

    def test_each_agent_has_a_distinct_role_prompt(self):
        self.assertEqual(
            set(AGENT_PROMPTS),
            {"owner", "barista", "stock", "quality", "cleaner", "cashier", "item_buyer"},
        )
        self.assertEqual(len(set(AGENT_PROMPTS.values())), len(AGENT_PROMPTS))

    def test_graph_uses_fallback_when_primary_model_fails(self):
        class FailingModel:
            async def ainvoke(self, _messages):
                raise RuntimeError("primary unavailable")

        async def run_graph():
            graph = build_agent_graph(FailingModel(), FakeModel())
            return await graph.ainvoke(
                {
                    "order": {
                        "name": "Sam",
                        "drink": "latte",
                        "milk": "oat",
                        "size": "medium",
                        "extraShot": False,
                        "note": "",
                        "outsideItem": "",
                    },
                    "target_shots": 2,
                    "transcript": [],
                    "events": [],
                }
            )

        result = asyncio.run(run_graph())
        first_message = next(event for event in result["events"] if event["type"] == "message")
        self.assertTrue(first_message["text"].startswith("Confirmed:"))
