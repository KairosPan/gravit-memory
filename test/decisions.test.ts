import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { amendDecision, readDecisions, recordDecision, type DecisionView } from "../src/decisions.js";
import type { Code } from "../src/errors.js";
import { appendLine } from "../src/log.js";
import type { DecisionLine, RecallLine } from "../src/types.js";
import { DAY, HOUR, clock, tempHome } from "./helpers.js";

const base = { action: "buy", whose: "owner", thesis: "Earnings beat and the guide went up.", symbol: "NVDA", market: "US" } as const;

let home: string;
let c: ReturnType<typeof clock>;

beforeEach(async () => {
  home = await tempHome();
  c = clock("2026-03-02T15:00:00Z");
});

/** Runs p and expects it to fail with a MemoryError of the given code; returns its message. */
async function fails(p: Promise<unknown>, code: Code): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected ${code}, but it succeeded`).not.toBeNull();
  expect((err as { code?: string }).code).toBe(code);
  return (err as Error).message;
}

const record = (input: unknown, by = "agent-one") => recordDecision(home, by, input, c.now());

async function viewOf(id: string): Promise<DecisionView> {
  const { views } = await readDecisions(home);
  const view = views.find((v) => v.line.id === id);
  expect(view).toBeDefined();
  return view!;
}

test("a decision is one line with its writer", async () => {
  const line = await record(base);
  expect(line.kind).toBe("decision");
  expect(line.by).toBe("agent-one");
  expect(line.id).toMatch(/^d-/);
  expect(line).toMatchObject(base);
  const text = await readFile(join(home, "decisions.jsonl"), "utf8");
  expect(text.trim().split("\n")).toHaveLength(1);
  const { views, log } = await readDecisions(home);
  expect(log.chain.ok).toBe(true);
  expect(views).toHaveLength(1);
  expect(views[0]!.line).toEqual(line);
  expect(views[0]!.decidedMs).toBe(c.now());
});

test("required fields", async () => {
  for (const field of ["action", "whose", "thesis"] as const) {
    const { [field]: _gone, ...rest } = base;
    const message = await fails(record(rest), "E_INPUT");
    expect(message).toContain(field);
  }
});

test("an unknown field is refused by name", async () => {
  const message = await fails(record({ ...base, mood: "bold" }), "E_INPUT");
  expect(message).toContain("mood");
});

test("limits are in characters", async () => {
  await record({ ...base, thesis: "涨".repeat(1000) });
  expect(await fails(record({ ...base, thesis: "涨".repeat(1001) }), "E_INPUT")).toContain("thesis");
  expect(await fails(record({ ...base, wrong_if: "x".repeat(501) }), "E_INPUT")).toContain("wrong_if");
  expect(await fails(record({ ...base, size: "x".repeat(81) }), "E_INPUT")).toContain("size");
  // a character outside the basic plane is one character, though two UTF-16 units
  await record({ ...base, size: "🚀".repeat(80) });
});

test("symbol and market come together", async () => {
  const { market: _m, ...noMarket } = base;
  expect(await fails(record(noMarket), "E_INPUT")).toMatch(/symbol|market/);
  const { symbol: _s, market: _m2, ...neither } = base;
  const line = await record(neither);
  expect(line.symbol).toBeUndefined();
});

test("words belong to the owner", async () => {
  await record({ ...base, words: "Buy it." });
  expect(await fails(record({ ...base, whose: "agent", words: "Buy it." }), "E_INPUT")).toContain("words");
});

test("tags and facts", async () => {
  await record({ ...base, tags: ["sector:tech", "theme:ai"], facts: { pe: 30, run_5d: 12.5, crowded: true, phase: "late" },
    fact_sources: { pe: "the quote page" } });
  const tags13 = Array.from({ length: 13 }, (_, i) => `k${i}:v`);
  expect(await fails(record({ ...base, tags: tags13 }), "E_INPUT")).toContain("tags");
  expect(await fails(record({ ...base, tags: ["Sector:Tech"] }), "E_INPUT")).toContain("tags");
  expect(await fails(record({ ...base, tags: ["sector tech"] }), "E_INPUT")).toContain("tags");
  const facts21 = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, i]));
  expect(await fails(record({ ...base, facts: facts21 }), "E_INPUT")).toContain("facts");
  expect(await fails(record({ ...base, facts: { "5D%": 1 } }), "E_INPUT")).toContain("5D%");
  expect(await fails(record({ ...base, facts: { pe: 30 }, fact_sources: { eps: "the filing" } }), "E_INPUT"))
    .toContain("fact_sources");
  expect(await fails(record({ ...base, facts: { pe: 30 }, fact_sources: { pe: "s".repeat(121) } }), "E_INPUT"))
    .toContain("fact_sources");
});

test("horizon and price", async () => {
  await record({ ...base, horizon: 20, price: 123.45 });
  for (const horizon of [0, 251, 1.5]) {
    expect(await fails(record({ ...base, horizon }), "E_INPUT")).toContain("horizon");
  }
  for (const price of [0, -1, Number.NaN]) {
    expect(await fails(record({ ...base, price }), "E_INPUT")).toContain("price");
  }
});

test("decided_at later than the clock is refused", async () => {
  const later = new Date(c.now() + 1000).toISOString();
  expect(await fails(record({ ...base, decided_at: later }), "E_INPUT")).toContain("decided_at");
  expect(await fails(record({ ...base, decided_at: "yesterday" }), "E_INPUT")).toContain("decided_at");
});

test("backfilled after 24 hours", async () => {
  const day = await record({ ...base, decided_at: new Date(c.now() - 24 * HOUR).toISOString() });
  expect("backfilled" in day).toBe(false);
  const older = await record({ ...base, decided_at: new Date(c.now() - 24 * HOUR - 1).toISOString() });
  expect(older.backfilled).toBe(true);
  expect((await viewOf(older.id)).decidedMs).toBe(c.now() - 24 * HOUR - 1);
});

test("a recall named must exist", async () => {
  await fails(record({ ...base, recall: "r-20260302-deadbeef" }), "E_NOT_FOUND");
  const recall = await appendLine<RecallLine>(home, "recalls.jsonl", "agent-one", c.now(), "r",
    { kind: "recall", considering: ["buy"], applied: [], untold: [] });
  const line = await record({ ...base, recall: recall.id });
  expect(line.recall).toBe(recall.id);
});

test("no agent writes as owner", async () => {
  await fails(record(base, "owner"), "E_REFUSED");
});

test("amendments are new lines", async () => {
  const d = await record(base);
  const before = await readFile(join(home, "decisions.jsonl"), "utf8");
  const ref = await amendDecision(home, "agent-one", { decision: d.id, what: "ref", ref: "order 42" }, c.now());
  c.advance(HOUR);
  const review = await amendDecision(home, "agent-two",
    { decision: d.id, what: "review", thesis_held: "yes", wrong_if_hit: "no", whose: "agent" }, c.now());
  const close = await amendDecision(home, "agent-one",
    { decision: d.id, what: "close", closed_at: new Date(c.now()).toISOString(), price: 130 }, c.now());
  for (const a of [ref, review, close]) {
    expect(a.kind).toBe("amend");
    expect(a.id).toMatch(/^a-/);
    expect(a.decision).toBe(d.id);
  }
  const after = await readFile(join(home, "decisions.jsonl"), "utf8");
  expect(after.startsWith(before)).toBe(true);
  expect(after.trim().split("\n")).toHaveLength(4);
  const view = await viewOf(d.id);
  expect(view.line).toEqual(d);
  expect(view.amends.map((a) => a.what)).toEqual(["ref", "review", "close"]);
  await fails(amendDecision(home, "agent-one", { decision: "d-20260302-deadbeef", what: "ref", ref: "x" }, c.now()),
    "E_NOT_FOUND");
  expect(await fails(amendDecision(home, "agent-one", { decision: d.id, what: "shrug" }, c.now()), "E_INPUT"))
    .toContain("what");
});

test("a correction changes nothing computed", async () => {
  const d = await record(base);
  await amendDecision(home, "agent-one",
    { decision: d.id, what: "correction", field: "action", value: "pass", note: "it was a pass" }, c.now());
  const view = await viewOf(d.id);
  expect(view.line.action).toBe("buy");
  expect(view.open).toBe(true);
});

test("void: its writer, for 24 hours", async () => {
  const d = await record(base);
  c.advance(DAY);
  await amendDecision(home, "agent-one", { decision: d.id, what: "void", reason: "typed the wrong symbol" }, c.now());
  expect((await viewOf(d.id)).void).toBe(true);

  c.set("2026-03-02T15:00:00Z");
  const e = await record(base);
  c.advance(DAY + 1);
  const message = await fails(amendDecision(home, "agent-one", { decision: e.id, what: "void", reason: "late" }, c.now()),
    "E_REFUSED");
  expect(message).toContain("gravit-memory void");
  expect((await viewOf(e.id)).void).toBe(false);
});

test("void: not another agent", async () => {
  const d = await record(base);
  await fails(amendDecision(home, "agent-two", { decision: d.id, what: "void", reason: "not mine" }, c.now()), "E_REFUSED");
});

test("void: the owner at any time", async () => {
  const d = await record(base);
  c.advance(90 * DAY);
  await amendDecision(home, "owner", { decision: d.id, what: "void", reason: "a test entry" }, c.now());
  expect((await viewOf(d.id)).void).toBe(true);
});

test("a void decision takes no more amendments", async () => {
  const d = await record(base);
  await amendDecision(home, "agent-one", { decision: d.id, what: "void", reason: "a mistake" }, c.now());
  await fails(amendDecision(home, "agent-one", { decision: d.id, what: "ref", ref: "order 42" }, c.now()), "E_REFUSED");
  await fails(amendDecision(home, "owner", { decision: d.id, what: "void", reason: "again" }, c.now()), "E_REFUSED");
});

test("open", async () => {
  const opened: DecisionLine[] = [];
  for (const action of ["buy", "add", "short"] as const) opened.push(await record({ ...base, action }));
  for (const d of opened) expect((await viewOf(d.id)).open).toBe(true);
  for (const d of opened) {
    await amendDecision(home, "agent-one", { decision: d.id, what: "close", closed_at: new Date(c.now()).toISOString() },
      c.now());
    expect((await viewOf(d.id)).open).toBe(false);
  }
  for (const action of ["sell", "pass", "hold"] as const) {
    const d = await record({ ...base, action });
    expect((await viewOf(d.id)).open).toBe(false);
  }
  const v = await record(base);
  await amendDecision(home, "agent-one", { decision: v.id, what: "void", reason: "a mistake" }, c.now());
  expect((await viewOf(v.id)).open).toBe(false);
});

test("reviewed", async () => {
  const d = await record(base);
  expect((await viewOf(d.id)).reviewed).toBe(false);
  await amendDecision(home, "owner",
    { decision: d.id, what: "review", thesis_held: "unclear", wrong_if_hit: "no", whose: "owner", note: "too early" },
    c.now());
  expect((await viewOf(d.id)).reviewed).toBe(true);
});

test("a symbol and a market are codes of their own characters", async () => {
  for (const symbol of ["NVDA", "BRK.B", "brk.b", "600519", "000001", "ES=F", "BF-B", "X_Y^Z", "A".repeat(32)]) {
    expect((await record({ ...base, symbol })).symbol, symbol).toBe(symbol);
  }
  for (const symbol of ["^GSPC", ".X", "-X", "A B", "A/B", "A".repeat(33), "NVDA\n", "涨"]) {
    expect(await fails(record({ ...base, symbol }), "E_INPUT"), JSON.stringify(symbol)).toContain("symbol");
  }
  for (const market of ["US", "CN", "us_otc", "hk-main"]) expect((await record({ ...base, market })).market).toBe(market);
  for (const market of ["U S", "U.S", "", "M".repeat(33)]) {
    expect(await fails(record({ ...base, market }), "E_INPUT"), JSON.stringify(market)).toContain("market");
  }
});

test("a decision naming a recall on another symbol is refused", async () => {
  const r = await appendLine<RecallLine>(home, "recalls.jsonl", "agent-one", c.now(), "r",
    { kind: "recall", considering: ["buy"], symbol: "NVDA", market: "US", applied: [], untold: [] });
  expect(await fails(record({ ...base, symbol: "AMD", recall: r.id }), "E_INPUT")).toContain("recall");
  expect((await record({ ...base, recall: r.id })).recall).toBe(r.id);
  const { symbol: _s, market: _m, ...unnamed } = base;
  expect((await record({ ...unnamed, recall: r.id })).recall).toBe(r.id);              // no symbol on one side: no check
});
