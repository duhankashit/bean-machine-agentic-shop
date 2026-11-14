import type { AgentId } from "./types";

const agentOrder: AgentId[] = ["owner", "barista", "stock", "quality", "cleaner", "cashier", "item_buyer"];

const voiceStyles: Record<AgentId, { rate: number; pitch: number }> = {
  owner: { rate: 0.88, pitch: 1 },
  barista: { rate: 0.9, pitch: 1.04 },
  stock: { rate: 0.88, pitch: 0.96 },
  quality: { rate: 0.86, pitch: 1.01 },
  cleaner: { rate: 0.9, pitch: 1.06 },
  cashier: { rate: 0.88, pitch: 0.98 },
  item_buyer: { rate: 0.89, pitch: 1.03 },
};

export function isSpeechSynthesisSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

export function speakAgentMessage(agent: AgentId, text: string, onEnd: () => void, onError: () => void) {
  const synthesis = window.speechSynthesis;
  const englishVoices = synthesis.getVoices().filter((voice) => voice.lang.toLowerCase().startsWith("en"));
  const voices = englishVoices.length > 0 ? englishVoices : synthesis.getVoices();
  const preferredVoices = [...voices].sort((first, second) => {
    const naturalVoice = /natural|neural|enhanced|premium/i;
    return Number(naturalVoice.test(second.name)) - Number(naturalVoice.test(first.name));
  });
  const agentIndex = agentOrder.indexOf(agent);
  const utterance = new SpeechSynthesisUtterance(text);
  const style = voiceStyles[agent];

  if (preferredVoices.length > 0) {
    utterance.voice = preferredVoices[agentIndex % preferredVoices.length];
    utterance.lang = utterance.voice.lang;
  } else {
    utterance.lang = "en-US";
  }

  utterance.rate = style.rate;
  utterance.pitch = style.pitch;
  utterance.onend = onEnd;
  utterance.onerror = (event) => {
    if (event.error !== "canceled" && event.error !== "interrupted") onError();
  };
  synthesis.speak(utterance);
}

