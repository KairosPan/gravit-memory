// src/types.ts
export type Action = "buy" | "add" | "trim" | "sell" | "short" | "cover" | "hold" | "pass";
export type Whose = "owner" | "agent";
export type Tri = "yes" | "no" | "unclear";
export type FactValue = number | string | boolean;
export type LogFile = "decisions.jsonl" | "recalls.jsonl" | "outcomes.jsonl" | "proposals.jsonl" | "owner.jsonl";
export type IdPrefix = "d" | "a" | "r" | "o" | "p" | "w" | "s";

export interface LineBase { v: 1; kind: string; id: string; seq: number; prev: string | null; t: string; by: string; sum: string }

export interface DecisionLine extends LineBase {
  kind: "decision"; action: Action; whose: Whose; thesis: string;
  symbol?: string; market?: string; wrong_if?: string; horizon?: number; words?: string;
  decided_at?: string; price?: number; price_source?: string; size?: string;
  tags?: string[]; facts?: Record<string, FactValue>; fact_sources?: Record<string, string>;
  evidence?: string[]; recall?: string; backfilled?: true;
}
export type AmendBody =
  | { what: "ref"; ref: string }
  | { what: "close"; closed_at: string; price?: number; note?: string }
  | { what: "review"; thesis_held: Tri; wrong_if_hit: Tri; whose: Whose; note?: string }
  | { what: "correction"; field: string; value: string; note?: string }
  | { what: "void"; reason: string };
export type AmendLine = LineBase & { kind: "amend"; decision: string } & AmendBody;

export interface RecallLine extends LineBase {
  kind: "recall"; considering: Action[]; symbol?: string; market?: string;
  facts?: Record<string, FactValue>; fact_sources?: Record<string, string>; tags?: string[]; note?: string;
  applied: string[]; untold: string[];
}
export type OutcomeBody =
  | { what: "leg"; day0: string; day0_close: number; price: number; leg_pct: number | null; not_taken?: "late" | "scale";
      source: string; adjustment: string | null }
  | { what: "horizon"; k: number; day0: string; day0_close: number; date: string; close: number; change_pct: number;
      benchmark?: { symbol: string; day0_close: number; close: number; change_pct: number }; vs_benchmark_pct?: number;
      source: string; adjustment: string | null }
  | { what: "closed"; reason: string };
export type OutcomeLine = LineBase & { kind: "outcome"; decision: string } & OutcomeBody;

export interface Check { fact: string; op: ">=" | ">" | "<=" | "<" | "==" | "!=" | "in"; value: FactValue | FactValue[] }
export interface Card {
  id: string; says: "dont" | "do" | "careful"; actions: Action[]; strength: "caveat" | "red-line";
  scope?: { market?: string[]; symbols?: string[] }; check?: Check[]; facts?: Record<string, string>;
  source?: string[]; words: string;
}
export interface ProposalLine extends LineBase {
  kind: "proposal"; what: "new" | "change" | "retire"; lesson: string; card?: Card; reason: string; evidence?: string[];
}
export type OwnerBody =
  | { act: "arm"; lesson: string; sha256: string }
  | { act: "retire"; lesson: string; reason: string }
  | { act: "discard"; lesson: string }
  | { act: "accept"; proposal: string; lesson: string; sha256?: string }
  | { act: "edit"; proposal: string; lesson: string }
  | { act: "reject"; proposal: string; reason: string };
export type OwnerLine = LineBase & { kind: "owner" } & OwnerBody;
export interface ResealLine extends LineBase { kind: "reseal"; broke_at: number; file_sha256: string }

export interface MarketConfig { venue: string; benchmark?: string; zone: string; close: string }
export interface Config { prices: { url: string; markets: Record<string, MarketConfig> }; horizons: number[] }
export interface Deps { now?: () => number; fetch?: typeof fetch }
