import { expect, test } from "vitest";
import type { DecisionView } from "../src/decisions.js";
import { cardRecord, figuresOf, occasionsOf, type Occasion } from "../src/records.js";
import type { Action, AmendLine, Card, DecisionLine, OutcomeLine, RecallLine } from "../src/types.js";
import { DAY, HOUR } from "./helpers.js";

const T0 = Date.parse("2026-03-02T15:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const HORIZONS = [1, 5, 20, 60];

const card: Card = { id: "no-chasing-after-a-run", says: "dont", actions: ["buy", "add"], strength: "caveat",
  words: "No new position in a name that ran 20% in five sessions." };

let n = 0;
const base = () => ({ v: 1 as const, seq: n, prev: null, sum: "0".repeat(64) });

function recall(id: string, atMs: number, opts: { symbol?: string; by?: string; considering?: Action[]; applied?: string[] } = {}): RecallLine {
  n += 1;
  return { ...base(), kind: "recall", id, t: iso(atMs), by: opts.by ?? "agent-one", considering: opts.considering ?? ["buy"],
    ...(opts.symbol !== undefined ? { symbol: opts.symbol } : {}), applied: opts.applied ?? [], untold: [] };
}

function decision(id: string, atMs: number, opts: { action: Action; whose?: "owner" | "agent"; recall?: string;
  symbol?: string; backfilled?: boolean; void?: boolean; amends?: AmendLine[] }): DecisionView {
  n += 1;
  const line: DecisionLine = { ...base(), kind: "decision", id, t: iso(atMs), by: "agent-one", action: opts.action,
    whose: opts.whose ?? "owner", thesis: "A test thesis.", symbol: opts.symbol ?? "NVDA", market: "US",
    ...(opts.recall !== undefined ? { recall: opts.recall } : {}), ...(opts.backfilled ? { backfilled: true as const } : {}) };
  return { line, amends: opts.amends ?? [], void: opts.void ?? false, open: false, reviewed: false, decidedMs: atMs };
}

function horizon(decisionId: string, k: number, change_pct: number, vs?: number): OutcomeLine {
  n += 1;
  return { ...base(), kind: "outcome", id: `o-h-${n}`, t: iso(T0), by: "agent-one", decision: decisionId, what: "horizon", k,
    day0: "2026-03-02", day0_close: 100, date: "2026-03-09", close: 100 + change_pct, change_pct,
    ...(vs !== undefined ? { vs_benchmark_pct: vs } : {}), source: "test", adjustment: null };
}

function leg(decisionId: string, leg_pct: number | null): OutcomeLine {
  n += 1;
  return { ...base(), kind: "outcome", id: `o-l-${n}`, t: iso(T0), by: "agent-one", decision: decisionId, what: "leg",
    day0: "2026-03-02", day0_close: 100, price: 100, leg_pct, source: "test", adjustment: null };
}

/** One NVDA occasion at T0 in which the card fired, recall r1. */
const fired = (): Occasion[] => occasionsOf([recall("r1", T0, { symbol: "NVDA", applied: [card.id] })]);

const record = (c: Card, occasions: Occasion[], decisions: DecisionView[], outcomes: OutcomeLine[] = [], nowMs = T0 + HOUR) =>
  cardRecord(c, occasions, decisions, outcomes, HORIZONS, nowMs);

test("recalls on one symbol within 24 hours are one occasion", () => {
  const occasions = occasionsOf([
    recall("r1", T0, { symbol: "NVDA" }),
    recall("r2", T0 + HOUR, { symbol: "AMD" }),
    recall("r3", T0 + 3 * HOUR, { symbol: "NVDA", by: "agent-two" }),
    recall("r4", T0 + 23 * HOUR, { symbol: "NVDA" }),
    recall("r5", T0 + 25 * HOUR, { symbol: "NVDA" }),
  ]);
  expect(occasions.map((o) => o.recalls.map((r) => r.id))).toEqual([["r1", "r3", "r4"], ["r2"], ["r5"]]);
  expect(occasions.map((o) => o.id)).toEqual(["r1", "r2", "r5"]);
  expect(occasions[0]!.firstMs).toBe(T0);
  expect(occasions[0]!.symbol).toBe("NVDA");
  expect(occasions[1]!.symbol).toBe("AMD");
});

test("an occasion's window runs from its first recall", () => {
  const occasions = occasionsOf([
    recall("r1", T0, { symbol: "NVDA" }),
    recall("r2", T0 + 23 * HOUR, { symbol: "NVDA" }),
    recall("r3", T0 + 30 * HOUR, { symbol: "NVDA" }),
  ]);
  expect(occasions.map((o) => o.recalls.map((r) => r.id))).toEqual([["r1", "r2"], ["r3"]]);
});

test("with no symbol: the same agent and the same actions", () => {
  const occasions = occasionsOf([
    recall("r1", T0, { by: "agent-one", considering: ["buy", "add"] }),
    recall("r2", T0 + HOUR, { by: "agent-one", considering: ["add", "buy"] }),
    recall("r3", T0 + 2 * HOUR, { by: "agent-two", considering: ["buy", "add"] }),
    recall("r4", T0 + 3 * HOUR, { by: "agent-one", considering: ["sell"] }),
  ]);
  expect(occasions.map((o) => o.recalls.map((r) => r.id))).toEqual([["r1", "r2"], ["r3"], ["r4"]]);
  expect(occasions[0]!.symbol).toBeUndefined();
});

test("a card fired in an occasion when it applied in any of its recalls", () => {
  const occasions = occasionsOf([
    recall("r1", T0, { symbol: "NVDA" }),
    recall("r2", T0 + HOUR, { symbol: "NVDA", applied: [card.id, "other-card"] }),
    recall("r3", T0 + 2 * HOUR, { symbol: "NVDA", applied: [card.id] }),
    recall("r4", T0 + 3 * HOUR, { symbol: "AMD" }),
  ]);
  expect(occasions[0]!.cards).toEqual([card.id, "other-card"]);
  expect(occasions[1]!.cards).toEqual([]);
  const rec = record(card, occasions, []);
  expect(rec.owner.fired).toBe(1);
});

test("dont", () => {
  const buy = record(card, fired(), [decision("d1", T0 + HOUR, { action: "buy", recall: "r1" })]);
  expect(buy.owner).toMatchObject({ fired: 1, overridden: 1, followed: 0, seen: 0 });
  expect(buy.overridden.map((c) => c.decision)).toEqual(["d1"]);
  const pass = record(card, fired(), [decision("d2", T0 + HOUR, { action: "pass", recall: "r1" })]);
  expect(pass.owner).toMatchObject({ fired: 1, overridden: 0, followed: 1, seen: 0 });
  expect(pass.followed.map((c) => c.decision)).toEqual(["d2"]);
});

test("do", () => {
  const doCard: Card = { ...card, says: "do", actions: ["trim"] };
  const occasions = occasionsOf([recall("r1", T0, { symbol: "NVDA", applied: [doCard.id] })]);
  const trim = record(doCard, occasions, [decision("d1", T0 + HOUR, { action: "trim", recall: "r1" })]);
  expect(trim.owner).toMatchObject({ followed: 1, overridden: 0 });
  const hold = record(doCard, occasions, [decision("d2", T0 + HOUR, { action: "hold", recall: "r1" })]);
  expect(hold.owner).toMatchObject({ followed: 0, overridden: 1 });
});

test("careful", () => {
  const careful: Card = { ...card, says: "careful" };
  const rec = record(careful, fired(), [decision("d1", T0 + HOUR, { action: "buy", recall: "r1" })]);
  expect(rec.owner).toMatchObject({ fired: 1, seen: 1, followed: 0, overridden: 0 });
  expect(rec.followed).toEqual([]);
  expect(rec.overridden).toEqual([]);
});

test("each side by its own first decision", () => {
  const occasions = occasionsOf([
    recall("r1", T0, { symbol: "NVDA", applied: [card.id] }),
    recall("r2", T0 + HOUR, { symbol: "NVDA" }),
    recall("r3", T0 + 2 * HOUR, { symbol: "NVDA", by: "agent-two" }),
  ]);
  const rec = record(card, occasions, [
    decision("d1", T0 + HOUR, { action: "pass", whose: "agent", recall: "r1" }),
    decision("d2", T0 + 3 * HOUR, { action: "buy", whose: "owner", recall: "r3" }),
    decision("d3", T0 + 4 * HOUR, { action: "pass", whose: "owner", recall: "r2" }),
  ]);
  expect(rec.owner).toMatchObject({ fired: 1, overridden: 1, followed: 0 });
  expect(rec.agents).toEqual({ followed: 1, overridden: 0, seen: 0 });
  expect(rec.overridden.map((c) => c.decision)).toEqual(["d2"]);
  expect(rec.followed).toEqual([]);
});

test("a void decision settles nothing", () => {
  const rec = record(card, fired(), [decision("d1", T0 + HOUR, { action: "pass", recall: "r1", void: true })]);
  expect(rec.owner.followed).toBe(0);
  expect(rec.owner.overridden).toBe(0);
  expect(rec.followed).toEqual([]);
});

test("a correction changes no count", () => {
  n += 1;
  const correction: AmendLine = { ...base(), kind: "amend", id: "a-1", t: iso(T0 + 2 * HOUR), by: "agent-one",
    decision: "d1", what: "correction", field: "action", value: "pass" };
  const rec = record(card, fired(), [decision("d1", T0 + HOUR, { action: "buy", recall: "r1", amends: [correction] })]);
  expect(rec.owner).toMatchObject({ overridden: 1, followed: 0 });
  expect(rec.overridden[0]!.action).toBe("buy");
});

test("no decision registered after 7 days", () => {
  const sixDays = record(card, fired(), [], [], T0 + 6 * DAY);
  expect(sixDays.owner).toMatchObject({ fired: 1, no_decision: 0 });
  const sevenDays = record(card, fired(), [], [], T0 + 7 * DAY);
  expect(sevenDays.owner.no_decision).toBe(0);
  const past = record(card, fired(), [], [], T0 + 7 * DAY + 1);
  expect(past.owner).toMatchObject({ fired: 1, no_decision: 1 });
  // an agent's decision alone does not register the owner's
  const agentOnly = record(card, fired(), [decision("d1", T0 + HOUR, { action: "pass", whose: "agent", recall: "r1" })], [], T0 + 8 * DAY);
  expect(agentOnly.owner.no_decision).toBe(1);
  expect(agentOnly.agents.followed).toBe(1);
  // an occasion the card did not fire in is not counted
  const notFired = record(card, occasionsOf([recall("r9", T0, { symbol: "AMD" })]), [], [], T0 + 8 * DAY);
  expect(notFired.owner).toMatchObject({ fired: 0, no_decision: 0 });
});

test("a backfilled decision is counted apart", () => {
  const rec = record(card, fired(), [decision("d1", T0 + HOUR, { action: "pass", recall: "r1", backfilled: true })],
    [horizon("d1", 5, 3)]);
  expect(rec.owner).toMatchObject({ backfilled: 1, followed: 0, overridden: 0, no_decision: 0 });
  expect(rec.backfilled.map((c) => c.decision)).toEqual(["d1"]);
  expect(rec.followed).toEqual([]);
  // a backfilled agent decision settles nothing on the agents' side
  const agent = record(card, fired(), [decision("d2", T0 + HOUR, { action: "pass", whose: "agent", recall: "r1", backfilled: true })]);
  expect(agent.agents).toEqual({ followed: 0, overridden: 0, seen: 0 });
});

test("figures", () => {
  const outcomes = [
    leg("d1", 4), horizon("d1", 1, 10, 7.5), horizon("d1", 1, 99), horizon("d1", 5, 2),
    leg("d2", null), horizon("d2", 1, 10, -1),
  ];
  expect(figuresOf("d1", outcomes, HORIZONS)).toEqual([
    { k: 1, change_pct: 14.4, vs_benchmark_pct: 7.5 },
    { k: 5, change_pct: 6.08, vs_benchmark_pct: null },
    { k: 20, change_pct: null, vs_benchmark_pct: null },
    { k: 60, change_pct: null, vs_benchmark_pct: null },
  ]);
  expect(figuresOf("d2", outcomes, HORIZONS)[0]).toEqual({ k: 1, change_pct: 10, vs_benchmark_pct: -1 });
  expect(figuresOf("d3", outcomes, [1])).toEqual([{ k: 1, change_pct: null, vs_benchmark_pct: null }]);

  // a case carries its figures, date and symbol
  const rec = record(card, fired(), [decision("d1", T0 + HOUR, { action: "buy", recall: "r1" })], outcomes);
  expect(rec.overridden[0]).toEqual({ decision: "d1", date: "2026-03-02", symbol: "NVDA", action: "buy",
    figures: figuresOf("d1", outcomes, HORIZONS) });
});

test("a median only from 8 measured cases", () => {
  const build = (count: number) => {
    const recalls: RecallLine[] = [];
    const decisions: DecisionView[] = [];
    const outcomes: OutcomeLine[] = [];
    for (let i = 0; i < count; i++) {
      const at = T0 + i * 2 * DAY;
      recalls.push(recall(`r${i}`, at, { symbol: "NVDA", applied: [card.id] }));
      decisions.push(decision(`d${i}`, at + HOUR, { action: "pass", recall: `r${i}` }));
      outcomes.push(horizon(`d${i}`, 5, i + 1));
      if (i > 0) outcomes.push(horizon(`d${i}`, 20, i * 10));
    }
    return record(card, occasionsOf(recalls), decisions, outcomes, T0 + 100 * DAY);
  };
  const seven = build(7);
  expect(seven.owner.followed).toBe(7);
  expect(seven.medians.followed[5]).toBeUndefined();
  const eight = build(8);
  expect(eight.owner.followed).toBe(8);
  expect(eight.medians.followed[5]).toBe(4.5);
  // the first case is unmeasured at k = 20: seven measured cases there
  expect(eight.medians.followed[20]).toBeUndefined();
  expect(eight.medians.overridden).toEqual({});
  const nine = build(9);
  expect(nine.medians.followed[5]).toBe(5);
  expect(nine.medians.followed[20]).toBe(45);
});

test("backfilled cases enter no median", () => {
  const recalls: RecallLine[] = [];
  const decisions: DecisionView[] = [];
  const outcomes: OutcomeLine[] = [];
  for (let i = 0; i < 8; i++) {
    const at = T0 + i * 2 * DAY;
    recalls.push(recall(`r${i}`, at, { symbol: "NVDA", applied: [card.id] }));
    decisions.push(decision(`d${i}`, at + HOUR, { action: "pass", recall: `r${i}`, backfilled: i === 0 }));
    outcomes.push(horizon(`d${i}`, 5, i + 1));
  }
  const rec = record(card, occasionsOf(recalls), decisions, outcomes, T0 + 100 * DAY);
  expect(rec.owner).toMatchObject({ followed: 7, backfilled: 1 });
  expect(rec.medians.followed[5]).toBeUndefined();
});
