export type DrinkId = "latte" | "cappuccino" | "americano" | "mocha";
export type MilkId = "whole" | "oat" | "almond" | "soy";
export type SizeId = "small" | "medium" | "large";
export type AgentId = "owner" | "barista" | "stock" | "quality" | "cleaner" | "cashier" | "item_buyer";

export interface MenuItem<Id extends string = string> {
  id: Id;
  name: string;
  price: number;
  recipe?: string;
  shots?: number;
}

export interface Menu {
  drinks: MenuItem<DrinkId>[];
  milks: MenuItem<MilkId>[];
  sizes: MenuItem<SizeId>[];
}

export interface OrderDraft {
  name: string;
  drink: DrinkId;
  milk: MilkId;
  size: SizeId;
  extraShot: boolean;
  note: string;
  outsideItem: string;
}

export type CoffeeEvent =
  | { id: number; type: "agent"; agent: AgentId; state: string; station: string }
  | { id: number; type: "message"; from: AgentId; to: AgentId; text: string; kind?: string }
  | { id: number; type: "complete"; total: number; text: string }
  | { id: number; type: "error"; text: string };
