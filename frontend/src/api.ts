import type { Menu, OrderDraft } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body: unknown = await response.json();
  if (!response.ok) {
    const detail = typeof body === "object" && body !== null && "detail" in body
      ? body.detail
      : typeof body === "object" && body !== null && "error" in body
        ? body.error
        : "Request failed.";
    throw new Error(typeof detail === "string" ? detail : "Please check your order and try again.");
  }
  return body as T;
}

export function getMenu(): Promise<Menu> {
  return request<Menu>("/api/menu");
}

export function createOrder(order: OrderDraft): Promise<{ id: string; total: number }> {
  return request<{ id: string; total: number }>("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(order),
  });
}

export function acknowledgeSpeech(orderId: string, eventId: number): Promise<{ acknowledged: boolean }> {
  return request<{ acknowledged: boolean }>(`/api/orders/${orderId}/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_id: eventId }),
  });
}
