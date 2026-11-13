// src/match.ts — whether a lesson card applies to a question, cannot be told, or does not apply
//
// What is unknown is not false: a market or a fact the question does not give, or gives as the wrong type for a
// check's op, is a need; a check false on a fact given is `no`, whatever else is missing. Values are taken as they
// stand: strings match exactly, and a boolean is a scalar like any other for ==, != and in.
import type { Action, Card, Check, FactValue } from "./types.js";

export type Need = { what: "market" } | { what: "fact"; fact: string; definition: string };
export type Match = { result: "applies" } | { result: "untold"; needs: Need[] } | { result: "no" };

/** Decides a card against a question: its actions, then its scope, then its checks. Pure. */
export function matchCard(
  card: Card,
  q: { considering: Action[]; symbol?: string; market?: string; facts?: Record<string, FactValue> },
): Match {
  if (!card.actions.some((a) => q.considering.includes(a))) return { result: "no" };

  const symbols = card.scope?.symbols;
  if (symbols !== undefined && (q.symbol === undefined || !symbols.includes(q.symbol))) return { result: "no" };

  const needs: Need[] = [];
  const markets = card.scope?.market;
  if (markets !== undefined) {
    if (q.market === undefined) needs.push({ what: "market" });
    else if (!markets.includes(q.market)) return { result: "no" };
  }

  const needed = new Set<string>();
  for (const check of card.check ?? []) {
    const value = q.facts !== undefined && Object.hasOwn(q.facts, check.fact) ? q.facts[check.fact] : undefined;
    const holds = value === undefined ? undefined : evaluate(check, value);
    if (holds === false) return { result: "no" };
    if (holds === undefined && !needed.has(check.fact)) {
      needed.add(check.fact);
      needs.push({ what: "fact", fact: check.fact, definition: card.facts?.[check.fact] ?? "" });
    }
  }

  return needs.length === 0 ? { result: "applies" } : { result: "untold", needs };
}

/** Whether a check holds on a value given; undefined when the value is of the wrong type for the check's op. */
function evaluate(check: Check, value: FactValue): boolean | undefined {
  const want = check.value;
  switch (check.op) {
    case "in": {
      const list = Array.isArray(want) ? want : [want];
      if (!list.some((v) => typeof v === typeof value)) return undefined;
      return list.includes(value);
    }
    case "==":
    case "!=": {
      if (Array.isArray(want) || typeof want !== typeof value) return undefined;
      return check.op === "==" ? value === want : value !== want;
    }
    default: {
      if (typeof want !== "number" || typeof value !== "number") return undefined;
      switch (check.op) {
        case ">": return value > want;
        case ">=": return value >= want;
        case "<": return value < want;
        case "<=": return value <= want;
      }
    }
  }
}
