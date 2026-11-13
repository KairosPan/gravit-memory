import { expect, test } from "vitest";
import { parseCard } from "../src/cards.js";
import { matchCard } from "../src/match.js";
import type { Action, Card, Check, FactValue } from "../src/types.js";
import { STAND_IN_CARD } from "./helpers.js";

const card = parseCard(STAND_IN_CARD, "no-chasing-after-a-run");

type Question = { considering: Action[]; symbol?: string; market?: string; facts?: Record<string, FactValue> };
const q = (over: Partial<Question> = {}): Question => ({
  considering: ["buy"], symbol: "NVDA", market: "US", facts: { sector: "software", change_5d_pct: 34.1 }, ...over,
});

test.each([
  ["everything holds",                 q(),                                              { result: "applies" }],
  ["a check is false",                 q({ facts: { sector: "software", change_5d_pct: 12 } }), { result: "no" }],
  ["a fact is missing",                q({ facts: { sector: "software" } }),             { result: "untold", needs: [{ what: "fact", fact: "change_5d_pct", definition: "today's close over the close five sessions earlier, minus 1, in percent" }] }],
  ["false beats missing",              q({ facts: { sector: "banks" } }),                { result: "no" }],
  ["no market given",                  q({ market: undefined }),                         { result: "untold", needs: [{ what: "market" }] }],
  ["another market",                   q({ market: "CN" }),                              { result: "no" }],
  ["another action",                   q({ considering: ["sell"] }),                     { result: "no" }],
  ["one of two actions",               q({ considering: ["sell", "buy"] }),              { result: "applies" }],
  ["a string where a number is asked", q({ facts: { sector: "software", change_5d_pct: "a lot" } }), { result: "untold", needs: [expect.objectContaining({ fact: "change_5d_pct" })] }],
] as [string, Question, unknown][])("%s", (_n, question, want) => expect(matchCard(card, question)).toEqual(want));

test("no market and a missing fact are both named, market first", () => {
  expect(matchCard(card, q({ market: undefined, facts: {} }))).toEqual({
    result: "untold",
    needs: [
      { what: "market" },
      { what: "fact", fact: "sector", definition: "the stock's sector, as the price source's listing names it" },
      { what: "fact", fact: "change_5d_pct", definition: "today's close over the close five sessions earlier, minus 1, in percent" },
    ],
  });
});

test("a false check after a missing fact, or with no market, is still no", () => {
  expect(matchCard(card, q({ facts: { change_5d_pct: 12 } }))).toEqual({ result: "no" });
  expect(matchCard(card, q({ market: undefined, facts: { sector: "banks" } }))).toEqual({ result: "no" });
});

test("a card scoped to symbols", () => {
  const scoped: Card = { ...card, scope: { symbols: ["NVDA"] }, check: undefined };
  expect(matchCard(scoped, q({ symbol: "NVDA" }))).toEqual({ result: "applies" });
  expect(matchCard(scoped, q({ symbol: "AMD" }))).toEqual({ result: "no" });
  expect(matchCard(scoped, q({ symbol: undefined }))).toEqual({ result: "no" });
});

test("a card with no scope and no check applies to its actions", () => {
  const bare: Card = { id: "bare", says: "careful", actions: ["sell"], strength: "caveat", words: "Think twice." };
  expect(matchCard(bare, { considering: ["sell"] })).toEqual({ result: "applies" });
  expect(matchCard(bare, { considering: ["buy"] })).toEqual({ result: "no" });
});

test("each op", () => {
  const one = (c: Check, x: FactValue): string => {
    const k: Card = { id: "one", says: "dont", actions: ["buy"], strength: "caveat", check: [c], facts: { x: "a fact" }, words: "w" };
    return matchCard(k, { considering: ["buy"], facts: { x } }).result;
  };
  const cases: [Check, FactValue, string][] = [
    [{ fact: "x", op: "==", value: 5 }, 5, "applies"],
    [{ fact: "x", op: "==", value: 5 }, 6, "no"],
    [{ fact: "x", op: "!=", value: 5 }, 6, "applies"],
    [{ fact: "x", op: "!=", value: 5 }, 5, "no"],
    [{ fact: "x", op: ">", value: 5 }, 6, "applies"],
    [{ fact: "x", op: ">", value: 5 }, 5, "no"],
    [{ fact: "x", op: ">=", value: 5 }, 5, "applies"],
    [{ fact: "x", op: ">=", value: 5 }, 4.99, "no"],
    [{ fact: "x", op: "<", value: 5 }, 4, "applies"],
    [{ fact: "x", op: "<", value: 5 }, 5, "no"],
    [{ fact: "x", op: "<=", value: 5 }, 5, "applies"],
    [{ fact: "x", op: "<=", value: 5 }, 5.01, "no"],
    [{ fact: "x", op: "==", value: "a" }, "a", "applies"],
    [{ fact: "x", op: "==", value: "a" }, "A", "no"],
    [{ fact: "x", op: "==", value: "a" }, " a", "no"],
    [{ fact: "x", op: "!=", value: "a" }, "b", "applies"],
    [{ fact: "x", op: "!=", value: "a" }, "a", "no"],
    [{ fact: "x", op: "in", value: ["a", "b"] }, "b", "applies"],
    [{ fact: "x", op: "in", value: ["a", "b"] }, "c", "no"],
    [{ fact: "x", op: "in", value: [1, 2] }, 2, "applies"],
    [{ fact: "x", op: "in", value: [1, 2] }, 3, "no"],
    [{ fact: "x", op: "==", value: true }, true, "applies"],
    [{ fact: "x", op: "!=", value: true }, true, "no"],
    [{ fact: "x", op: "in", value: [true] }, false, "no"],
    // a value of the wrong type for its op is not false: it is untold
    [{ fact: "x", op: ">", value: 5 }, "6", "untold"],
    [{ fact: "x", op: ">", value: 5 }, true, "untold"],
    [{ fact: "x", op: "==", value: 5 }, "5", "untold"],
    [{ fact: "x", op: "!=", value: "a" }, 1, "untold"],
    [{ fact: "x", op: "in", value: ["a", "b"] }, 1, "untold"],
  ];
  for (const [c, x, want] of cases) expect(one(c, x), `${c.op} ${JSON.stringify(c.value)} on ${JSON.stringify(x)}`).toBe(want);
});
