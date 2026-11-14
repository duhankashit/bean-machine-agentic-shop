import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { acknowledgeSpeech, createOrder, getMenu } from "./api";
import { isSpeechSynthesisSupported, speakAgentMessage } from "./speech";
import type { AgentId, CoffeeEvent, Menu, OrderDraft } from "./types";
import sceneMarkup from "./shop-scene.svg?raw";
import "./styles.css";

const crew: Record<AgentId, { name: string; role: string; color: string; icon: string }> = {
  owner: { name: "Mara", role: "OWNER", color: "#e9a47d", icon: "M" },
  barista: { name: "Leo", role: "BARISTA", color: "#92c7ae", icon: "L" },
  stock: { name: "Pip", role: "STOCK", color: "#e7c77f", icon: "P" },
  quality: { name: "Sage", role: "QUALITY", color: "#a9a0d5", icon: "S" },
  cleaner: { name: "Ash", role: "CLEANER", color: "#83b8d0", icon: "A" },
  cashier: { name: "Nico", role: "CASHIER", color: "#e68e83", icon: "$" },
  item_buyer: { name: "Ivy", role: "ITEM BUYER", color: "#d6a5ca", icon: "I" },
};

const initialOrder: OrderDraft = {
  name: "",
  drink: "latte",
  milk: "whole",
  size: "medium",
  extraShot: false,
  note: "",
  outsideItem: "",
};

function App() {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [order, setOrder] = useState<OrderDraft>(initialOrder);
  const [messages, setMessages] = useState<Extract<CoffeeEvent, { type: "message" }>[]>([]);
  const [activeAgent, setActiveAgent] = useState<AgentId | null>(null);
  const [activeStation, setActiveStation] = useState("Pass");
  const [status, setStatus] = useState("READY FOR ORDERS");
  const [callout, setCallout] = useState("The crew is ready when you are.");
  const [ticketLabel, setTicketLabel] = useState("WAITING FOR A TICKET");
  const [orderNumber, setOrderNumber] = useState(0);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const [speechAvailable] = useState(isSpeechSynthesisSupported);
  const [voiceError, setVoiceError] = useState("");
  const [formMessage, setFormMessage] = useState("");
  const [clock, setClock] = useState(() => formatClock());
  const activeOrderId = useRef<string | null>(null);
  const pendingSpeech = useRef<{ orderId: string; eventId: number } | null>(null);
  const eventSource = useRef<EventSource | null>(null);
  const sceneHost = useRef<HTMLDivElement>(null);

  const total = useMemo(() => {
    if (!menu) return 0;
    const drink = menu.drinks.find((item) => item.id === order.drink);
    const milk = menu.milks.find((item) => item.id === order.milk);
    const size = menu.sizes.find((item) => item.id === order.size);
    return (drink?.price ?? 0) + (milk?.price ?? 0) + (size?.price ?? 0) + (order.extraShot ? 1 : 0);
  }, [menu, order]);

  useEffect(() => {
    let active = true;
    if ("speechSynthesis" in window) window.speechSynthesis.getVoices();
    getMenu()
      .then((loadedMenu) => {
        if (active) setMenu(loadedMenu);
      })
      .catch((error: Error) => {
        if (active) setFormMessage(error.message);
      });
    const timer = window.setInterval(() => setClock(formatClock()), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      eventSource.current?.close();
    };
  }, []);

  useEffect(() => {
    const svg = sceneHost.current?.querySelector("svg");
    if (!svg) return;
    svg.querySelectorAll<SVGGElement>(".agent[data-agent]").forEach((agent) => {
      const isActive = agent.dataset.agent === activeAgent;
      agent.classList.toggle("is-active", isActive);
      agent.classList.toggle("is-done", finished);
    });
  }, [activeAgent, finished]);

  function finishSpeech(eventId: number) {
    const pending = pendingSpeech.current;
    if (!pending || pending.eventId !== eventId) return;
    pendingSpeech.current = null;
    acknowledgeSpeech(pending.orderId, eventId)
      .then(({ acknowledged }) => {
        if (!acknowledged) setVoiceError("The shop could not confirm that the voice message finished.");
      })
      .catch((error: Error) => {
        setVoiceError(`Could not sync voice playback with the shop: ${error.message}`);
      });
  }

  function handleEvent(event: CoffeeEvent) {
    if (event.type === "message") {
      setMessages((current) => [...current, event]);
      const orderId = activeOrderId.current;
      if (orderId) {
        pendingSpeech.current = { orderId, eventId: event.id };
        if (!speechAvailable) {
          setVoiceError("Speech playback is unavailable in this browser; agent updates will continue without audio.");
          finishSpeech(event.id);
        } else {
          try {
            speakAgentMessage(
              event.from,
              event.text,
              () => finishSpeech(event.id),
              () => {
                setVoiceError("Voice playback failed. Check that a speech voice and audio output are available.");
                finishSpeech(event.id);
              },
            );
          } catch {
            setVoiceError("Voice playback could not start. Check your browser's speech voices and audio output.");
            finishSpeech(event.id);
          }
        }
      }
      const text = `↗ ${crew[event.from].name} → ${crew[event.to].name}: ${event.text}`;
      setCallout(text.length > 110 ? `${text.slice(0, 107)}...` : text);
      return;
    }

    if (event.type === "agent") {
      setActiveAgent(event.agent);
      setActiveStation(event.station);
      setStatus(event.state.toUpperCase());
      return;
    }

    if (event.type === "complete") {
      setFinished(true);
      setBusy(false);
      setActiveAgent(null);
      setStatus("ORDER READY");
      setCallout(event.text);
      setFormMessage(event.text);
      eventSource.current?.close();
      eventSource.current = null;
      return;
    }

    setBusy(false);
    setFinished(false);
    setStatus("NEEDS ATTENTION");
    setFormMessage(event.text);
    eventSource.current?.close();
    eventSource.current = null;
  }

  async function submitOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !menu) return;

    if (pendingSpeech.current) finishSpeech(pendingSpeech.current.eventId);
    eventSource.current?.close();
    activeOrderId.current = null;
    setBusy(true);
    setFinished(false);
    setActiveAgent(null);
    setStatus("ORDER INCOMING");
    setCallout("The crew is picking up your ticket.");
    setFormMessage("");
    setMessages([]);
    setTicketLabel("WAITING FOR A TICKET");
    setVoiceError("");

    try {
      const result = await createOrder(order);
      activeOrderId.current = result.id;
      const nextOrderNumber = orderNumber + 1;
      setOrderNumber(nextOrderNumber);
      setTicketLabel(`TICKET #${String(nextOrderNumber).padStart(3, "0")} · $${result.total.toFixed(2)}`);
      const source = new EventSource(`/api/orders/${result.id}/events`);
      eventSource.current = source;
      source.addEventListener("update", (message: MessageEvent<string>) => {
        handleEvent(JSON.parse(message.data) as CoffeeEvent);
      });
      source.onerror = () => {
        if (source.readyState !== EventSource.CLOSED) {
          setFormMessage("Lost connection to the shop. Reconnecting…");
        }
      };
    } catch (error) {
      setBusy(false);
      setStatus("READY FOR ORDERS");
      setFormMessage(error instanceof Error ? error.message : "Could not place your order.");
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Bean and Machine home">
          <span className="brand-mark" aria-hidden="true">B<span>&amp;</span>M</span>
          <span className="brand-name">BEAN <span>&amp;</span> MACHINE<small>THE AGENTIC COFFEE CO.</small></span>
        </a>
        <div className="topbar-center"><span className="live-dot" /> THE SHOP IS OPEN <span className="topbar-divider">/</span> <span>{clock}</span></div>
        <div className="voice-indicator" aria-label="Agent voice playback is always on">
          <span className="sound-icon">♫</span> VOICE ALWAYS ON
        </div>
      </header>

      <main>
        <section className="intro">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" /> A LITTLE COFFEE, A LOT OF COORDINATION</div>
            <h1>Good coffee is<br />always a <em>team effort.</em></h1>
          </div>
          <div className="intro-note">Meet the crew. Watch them work.<br />Your cup is in good hands.</div>
        </section>

        <section className="workbench" aria-label="Coffee shop agent workspace">
          <aside className="order-panel panel">
            <div className="panel-heading">
              <div><div className="eyebrow">01 / YOUR ORDER</div><h2>Make it yours.</h2></div>
              <span className="order-number">{orderNumber ? `# ${String(orderNumber).padStart(3, "0")}` : "# —"}</span>
            </div>
            <form id="order-form" onSubmit={submitOrder}>
              <label className="field-label" htmlFor="customer-name">YOUR NAME <span className="optional">OPTIONAL</span></label>
              <input id="customer-name" type="text" maxLength={32} placeholder="What should we call you?" value={order.name} onChange={(event) => setOrder({ ...order, name: event.target.value })} />

              <label className="field-label">PICK YOUR COFFEE</label>
              <div className="drink-grid" role="group" aria-label="Coffee type">
                {(menu?.drinks ?? []).map((drink) => (
                  <button key={drink.id} className={`drink-option${order.drink === drink.id ? " selected" : ""}`} type="button" onClick={() => setOrder({ ...order, drink: drink.id })}>
                    <span className="drink-emoji">{drink.id === "americano" ? "◉" : "☕"}</span><span>{drink.name}</span><small>${drink.price.toFixed(2)}</small>
                  </button>
                ))}
              </div>

              <label className="field-label" htmlFor="milk">YOUR MILK</label>
              <div className="select-wrap">
                <select id="milk" value={order.milk} onChange={(event) => setOrder({ ...order, milk: event.target.value as OrderDraft["milk"] })}>
                  {(menu?.milks ?? []).map((milk) => <option key={milk.id} value={milk.id}>{milk.name}{milk.price ? ` + $${milk.price.toFixed(2)}` : " — classic"}</option>)}
                </select>
                <span className="select-arrow">⌄</span>
              </div>

              <div className="size-heading"><span className="field-label">CUP SIZE</span><span className="field-label">EXTRA SHOT <span className="price-note">+$1</span></span></div>
              <div className="size-row">
                <div className="size-options" role="group" aria-label="Cup size">
                  {(menu?.sizes ?? []).map((size) => (
                    <button key={size.id} type="button" className={`size-option${order.size === size.id ? " selected" : ""}`} aria-label={`${size.name}${size.price ? ` + $${size.price.toFixed(2)}` : ""}`} aria-pressed={order.size === size.id} onClick={() => setOrder({ ...order, size: size.id })}>
                      {size.name[0]}
                    </button>
                  ))}
                </div>
                <label className="toggle" aria-label="Add an extra espresso shot">
                  <input id="extra-shot" type="checkbox" checked={order.extraShot} onChange={(event) => setOrder({ ...order, extraShot: event.target.checked })} />
                  <span className="toggle-track" />
                </label>
              </div>

              <label className="field-label" htmlFor="note">PREPARATION NOTE <span className="optional">OPTIONAL</span></label>
              <input id="note" type="text" maxLength={120} placeholder="Extra hot, less sweet..." value={order.note} onChange={(event) => setOrder({ ...order, note: event.target.value })} />

              <label className="field-label" htmlFor="outside-item">ADD SOMETHING FROM OUTSIDE <span className="optional">OPTIONAL</span></label>
              <input id="outside-item" type="text" maxLength={120} placeholder="A sandwich, pastry, or other item" value={order.outsideItem} onChange={(event) => setOrder({ ...order, outsideItem: event.target.value })} />
              <small className="outside-item-help">Ivy fetches it in the demo; it is not included in the coffee total.</small>

              <div className="order-total"><span>COFFEE TOTAL</span><strong>${total.toFixed(2)}</strong></div>
              <button className="submit-button" id="submit-order" type="submit" disabled={busy || !menu}>
                <span>{busy ? "The crew is on it..." : finished ? "Order another coffee" : "Send it to the crew"}</span><span className="button-arrow">↗</span>
              </button>
              <p className={`form-message${finished ? " success" : ""}`} aria-live="polite">{formMessage}</p>
            </form>
            <div className="panel-footnote"><span>✳</span> MADE FRESH, NEVER RUSHED</div>
          </aside>

          <section className={`shop-panel panel${busy ? " busy" : ""}${finished ? " done" : ""}`} aria-label="Live 3D coffee shop">
            <div className="shop-toolbar">
              <div><div className="eyebrow">02 / THE SHOP FLOOR</div><h2>A team in their element.</h2></div>
              <div className="simulation-status"><span className="status-pulse" /><span>{status}</span></div>
            </div>

            <div className="scene-wrap">
              <div className="scene-grain" />
              <div className="scene-svg" ref={sceneHost} dangerouslySetInnerHTML={{ __html: sceneMarkup }} />
              <div className="scene-callout" aria-live="polite"><span className="callout-spark">✳</span><span>{activeAgent ? `${crew[activeAgent].name} · ${activeStation}` : callout}</span></div>
              <div className="scene-caption"><span><span className="caption-dot" /> LIVE FLOOR VIEW</span><span>7 CREW MEMBERS <i>·</i> 1 SHARED MISSION</span></div>
            </div>
            <div className="crew-roster" aria-label="Coffee shop agents">
              {(Object.entries(crew) as [AgentId, (typeof crew)[AgentId]][]).map(([id, agent]) => (
                <div key={id} className={`crew-chip${activeAgent === id ? " is-active" : ""}`}>
                  <span className="crew-avatar" style={{ "--agent-color": agent.color } as CSSProperties}>{agent.icon}</span>
                  <span><b>{agent.name}</b><small>{agent.role}</small></span><i />
                </div>
              ))}
            </div>
          </section>

          <aside className="conversation-panel panel">
            <div className="conversation-heading">
              <div><div className="eyebrow">03 / AGENT-TO-AGENT</div><h2>Behind the bar.</h2></div>
              <span className="live-label"><span className="live-dot" /> LIVE</span>
            </div>
            <div className="conversation-meta"><span>{ticketLabel}</span><span className="mono">{messages.length} MESSAGE{messages.length === 1 ? "" : "S"}</span></div>
            {voiceError && <p className="voice-error" role="status">{voiceError}</p>}
            <div className="conversation-feed" aria-live="polite" aria-label="Agent conversation">
              {messages.length === 0 ? (
                <div className="empty-conversation"><div className="empty-icon">✳</div><p>The team’s channel is quiet.<br /><span>Place an order to hear them think out loud.</span></p></div>
              ) : messages.map((message, index) => (
                <article key={`${index}-${message.from}`} className={`message kind-${message.kind ?? "message"}`} style={{ "--agent-color": crew[message.from].color } as CSSProperties}>
                  <div className="message-top"><span className="message-sender">{crew[message.from].name}</span><span className="message-route">→ {crew[message.to].name}</span></div>
                  <p className="message-text">{message.text}</p>
                </article>
              ))}
            </div>
            <div className="team-note"><span className="team-note-icon">↗</span><p><b>Shared mission, shared channel.</b><br />Turn voice on to hear each new agent message.</p></div>
          </aside>
        </section>

        <footer className="page-footer"><span>BEAN &amp; MACHINE <span className="footer-mark">✳</span> A NEIGHBORHOOD COFFEE SHOP</span><span>GOOD THINGS TAKE A FEW AGENTS.</span></footer>
      </main>
    </div>
  );
}

function formatClock() {
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

export default App;
