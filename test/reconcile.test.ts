import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { amendDecision, recordDecision } from "../src/decisions.js";
import { DEFAULT_CONFIG } from "../src/home.js";
import { mayBeDue, readOutcomes, reconcile } from "../src/reconcile.js";
import type { OutcomeLine } from "../src/types.js";
import { candleStub, chinaAnswer, cboeAnswer, clock, tempHome, weekdays } from "./helpers.js";

const MINUTE = 60_000;

const nvda = { action: "buy", whose: "agent", thesis: "Data-centre orders keep rising.", symbol: "NVDA", market: "US" } as const;
const bars = weekdays("2026-03-02", [100, 104, 102, 110, 99, 120, 130]);         // Mon 03-02 … Tue 03-10
const spy = weekdays("2026-03-02", [500, 510, 520, 505, 530, 540, 525]);

let home: string;
let c: ReturnType<typeof clock>;
let stub: Awaited<ReturnType<typeof candleStub>>;

beforeEach(async () => {
  home = await tempHome();
  c = clock("2026-03-03T15:00:00Z");                                             // Tue 10:00 in New York
  stub = await candleStub();
  stub.set("SPY", cboeAnswer(spy));
});

/** Sets the price source, and the interval when one is given; the tests that reconcile twice at once give 0. */
async function useSource(url: string, every_minutes?: number): Promise<void> {
  const config = { ...DEFAULT_CONFIG,
    prices: { ...DEFAULT_CONFIG.prices, url, ...(every_minutes !== undefined ? { every_minutes } : {}) } };
  await writeFile(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

const record = (input: object, by = "agent-one") => recordDecision(home, by, input, c.now());
const run = (by = "agent-one") => reconcile(home, by, { now: c.now, fetch });
const outcomes = async () => (await readOutcomes(home)).lines;
const symbolsAsked = () => stub.requests.map((u) => u.searchParams.get("symbol")).sort();

test("no price source", async () => {
  await record(nvda);
  c.set("2026-03-11T12:00:00Z");
  const report = await run();
  expect(report).toMatchObject({ source: null, measured: 0, closed: 0, refused: [], unmeasured: [] });
  expect(await readFile(join(home, "outcomes.jsonl"), "utf8")).toBe("");
  expect(stub.requests).toHaveLength(0);
  expect(await mayBeDue(home, c.now())).toBe("no price source");
});

test("each symbol is read once", async () => {
  await useSource(stub.url, 0);
  await record(nvda);
  await record({ ...nvda, action: "add" });
  await record({ ...nvda, symbol: "AMD" });
  stub.set("NVDA", cboeAnswer(bars));
  stub.set("AMD", cboeAnswer(bars));
  c.set("2026-03-11T12:00:00Z");
  const report = await run();
  expect(symbolsAsked()).toEqual(["AMD", "NVDA", "SPY"]);
  expect(report).toMatchObject({ source: stub.url, measured: 6, closed: 0, stillDue: 0, refused: [], unmeasured: [] });
});

test("measured lines carry what was read", async () => {
  await useSource(stub.url, 0);
  const d = await record({ ...nvda, price: 101 });
  stub.set("NVDA", cboeAnswer(bars));
  c.set("2026-03-11T12:00:00Z");
  await run("agent-two");
  const lines = await outcomes();
  expect(lines.map((l) => l.what)).toEqual(["leg", "horizon", "horizon"]);
  for (const line of lines) {
    expect(line).toMatchObject({ kind: "outcome", decision: d.id, by: "agent-two", t: "2026-03-11T12:00:00.000Z",
      source: stub.url, adjustment: "split-adjusted, not dividend-adjusted" });
    expect(line.id).toMatch(/^o-20260311-[0-9a-f]{8}$/);
  }
  expect(lines[0]).toMatchObject({ day0_close: 104, price: 101, leg_pct: 2.97 });
  expect(lines[1]).toMatchObject({ k: 1, change_pct: -1.92, benchmark: { symbol: "SPY", day0_close: 510, close: 520 } });
});

test("a second reconcile measures only what came due", async () => {
  await useSource(stub.url, 0);
  await record({ ...nvda, price: 101 });
  stub.set("NVDA", cboeAnswer(bars.slice(0, 3)));
  c.set("2026-03-05T12:00:00Z");
  expect(await run()).toMatchObject({ measured: 2, stillDue: 0 });                 // the leg and k = 1
  const before = await readFile(join(home, "outcomes.jsonl"), "utf8");

  stub.set("NVDA", cboeAnswer(bars.map((b) => ({ ...b, close: b.close * 2 })))); // more bars, and re-scaled
  c.set("2026-03-11T12:00:00Z");
  expect(await run()).toMatchObject({ measured: 1 });
  const after = await readFile(join(home, "outcomes.jsonl"), "utf8");
  expect(after.startsWith(before)).toBe(true);
  const lines = await outcomes();
  expect(lines.map((l) => (l.what === "horizon" ? `h${l.k}` : l.what))).toEqual(["leg", "h1", "h5"]);
  expect(lines[2]).toMatchObject({ day0_close: 208, close: 260, change_pct: 25 });

  expect(await run()).toMatchObject({ measured: 0 });
  expect(await readFile(join(home, "outcomes.jsonl"), "utf8")).toBe(after);
});

test("an A share past the range is closed, and not asked again", async () => {
  await useSource(stub.url, 0);
  await record({ ...nvda, symbol: "sh600000", market: "CN", decided_at: "2025-01-06T03:00:00.000Z" });
  stub.set("sh600000", chinaAnswer(bars));
  c.set("2026-03-11T12:00:00Z");
  expect(await run()).toMatchObject({ measured: 0, closed: 1, stillDue: 0 });
  expect(await outcomes()).toEqual([expect.objectContaining({ what: "closed", reason: "not measurable from this source" })]);
  expect(symbolsAsked()).toEqual(["sh600000"]);                                    // CN names no benchmark
  await run();
  await run();
  expect(stub.requests).toHaveLength(1);
  expect(await outcomes()).toHaveLength(1);
  expect(await mayBeDue(home, c.now())).toBe(0);
});

test("a US day 0 beyond 750 bars is asked for once more", async () => {
  await useSource(stub.url, 0);
  await record({ ...nvda, decided_at: "2023-01-04T15:00:00.000Z" });
  stub.set("NVDA", cboeAnswer(bars));
  c.set("2026-03-11T12:00:00Z");
  expect(await run()).toMatchObject({ measured: 0, closed: 1 });
  const asked = stub.requests.filter((u) => u.searchParams.get("symbol") === "NVDA").map((u) => u.searchParams.get("limit"));
  expect(asked).toEqual(["750", "5000"]);
  expect(stub.requests.some((u) => u.searchParams.get("symbol") === "SPY")).toBe(false); // nothing to set beside it
  expect(await outcomes()).toEqual([expect.objectContaining({ what: "closed" })]);
});

test("a US day 0 found in the longer answer is measured from it", async () => {
  await useSource(stub.url, 0);
  const old = weekdays("2023-01-02", Array.from({ length: 900 }, (_, i) => 100 + i));
  stub.set("NVDA", cboeAnswer(old));
  stub.set("SPY", cboeAnswer(weekdays("2023-01-02", Array.from({ length: 900 }, () => 400))));
  await record({ ...nvda, decided_at: "2023-01-04T15:00:00.000Z" });
  c.set("2026-06-01T12:00:00Z");
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.searchParams.get("limit") === "750") {                                 // the latest 750 bars, as the source answers
      const symbol = url.searchParams.get("symbol");
      const body = cboeAnswer(symbol === "SPY" ? weekdays("2023-01-02", Array(900).fill(400)).slice(-750) : old.slice(-750));
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return fetch(input, init);
  }) as typeof fetch;
  const report = await reconcile(home, "agent-one", { now: c.now, fetch: fake });
  expect(report).toMatchObject({ measured: 4, closed: 0, refused: [] });
  const lines = await outcomes();
  expect(lines[0]).toMatchObject({ k: 1, day0: "2023-01-04", day0_close: 102, close: 103, benchmark: { symbol: "SPY" } });
  expect(stub.requests.map((u) => `${u.searchParams.get("symbol")} ${u.searchParams.get("limit")}`).sort())
    .toEqual(["NVDA 5000", "SPY 5000"]);
});

test("void, no symbol, an unnamed market", async () => {
  await useSource(stub.url, 0);
  const gone = await record(nvda);
  await amendDecision(home, "agent-one", { decision: gone.id, what: "void", reason: "Recorded twice." }, c.now());
  const bare = await record({ action: "hold", whose: "agent", thesis: "The book stays as it is." });
  const jp = await record({ ...nvda, symbol: "7203", market: "JP" });
  c.set("2026-03-11T12:00:00Z");
  const report = await run();
  expect(report.unmeasured).toEqual([{ decision: bare.id, why: "no symbol" }, { decision: jp.id, why: "no market" }]);
  expect(report).toMatchObject({ measured: 0, stillDue: 0, refused: [] });
  expect(stub.requests).toHaveLength(0);
  expect(await outcomes()).toEqual([]);
  expect(await mayBeDue(home, c.now())).toBe(0);
});

test("a refused source writes nothing", async () => {
  await useSource(stub.url, 0);
  await record(nvda);
  c.set("2026-03-11T12:00:00Z");
  const report = await run();                                                      // the stub has no answer for NVDA
  expect(report.refused).toEqual([{ market: "US", symbol: "NVDA", why: "no answer set for NVDA" }]);
  expect(report).toMatchObject({ measured: 0, stillDue: 1 });
  expect(await readFile(join(home, "outcomes.jsonl"), "utf8")).toBe("");
});

test("a refused benchmark holds its market's measuring back", async () => {
  await useSource(stub.url, 0);
  await record(nvda);
  stub.set("NVDA", cboeAnswer(bars));
  stub.set("SPY", { ok: false, refusal: { message: "Cboe is not answering" } }, 409);
  c.set("2026-03-11T12:00:00Z");
  const report = await run();
  expect(report.refused).toEqual([{ market: "US", symbol: "SPY", why: "Cboe is not answering" }]);
  expect(report).toMatchObject({ measured: 0, stillDue: 1 });
  expect(await outcomes()).toEqual([]);
});

test("a refused benchmark still lets the price leg and a closed line be written", async () => {
  await useSource(stub.url, 0);
  const d = await record({ ...nvda, price: 101 });
  const old = await record({ ...nvda, symbol: "AMD", decided_at: "2026-02-02T15:00:00Z" });
  stub.set("NVDA", cboeAnswer(bars));
  stub.set("AMD", cboeAnswer(bars));                                              // day 0 of AMD is before its first bar
  stub.set("SPY", { ok: false, refusal: { message: "Cboe is not answering" } }, 409);
  c.set("2026-03-11T12:00:00Z");
  const report = await run();
  expect(report.refused).toEqual([{ market: "US", symbol: "SPY", why: "Cboe is not answering" }]);
  expect(report).toMatchObject({ measured: 1, closed: 1, stillDue: 1 });
  expect((await outcomes()).map((l) => [l.decision, l.what])).toEqual([[d.id, "leg"], [old.id, "closed"]]);
});

test("reconcile writes only under an agent's name", async () => {
  await expect(run("owner")).rejects.toMatchObject({ code: "E_REFUSED" });
  await expect(run("Agent One")).rejects.toMatchObject({ code: "E_INPUT" });
});

test("mayBeDue", async () => {
  await useSource(stub.url, 0);
  c.set("2026-03-02T15:00:00Z");                                                   // Monday
  await record(nvda);
  expect(await mayBeDue(home, Date.parse("2026-03-03T15:00:00Z"))).toBe(0);         // Tuesday
  expect(await mayBeDue(home, Date.parse("2026-03-04T15:00:00Z"))).toBe(1);         // Wednesday: horizon 1 may be due
  expect(stub.requests).toHaveLength(0);

  const long = weekdays("2026-03-02", Array.from({ length: 70 }, (_, i) => 100 + i));
  stub.set("NVDA", cboeAnswer(long));
  stub.set("SPY", cboeAnswer(long));
  c.set("2026-06-15T12:00:00Z");
  expect(await run()).toMatchObject({ measured: 4, stillDue: 0 });
  expect(await mayBeDue(home, c.now())).toBe(0);                                    // all four measured
});

test("last-reconcile.json", async () => {
  const file = join(home, "last-reconcile.json");
  await record(nvda);
  c.set("2026-03-11T12:00:00Z");
  await run();
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ t: "2026-03-11T12:00:00.000Z", source: null, ok: false, refused: 0, asked: 0 });

  await useSource(stub.url, 0);
  await run();
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ t: "2026-03-11T12:00:00.000Z", source: stub.url, ok: false, refused: 1, asked: 1 });

  stub.set("NVDA", cboeAnswer(bars));
  c.set("2026-03-12T12:00:00Z");
  await run();
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ t: "2026-03-12T12:00:00.000Z", source: stub.url, ok: true, refused: 0, asked: 2 });
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
});

test("readOutcomes reads outcome lines alone", async () => {
  expect(await readOutcomes(home)).toMatchObject({ lines: [], partial: false, chain: { ok: true } });
  const lines: OutcomeLine[] = (await readOutcomes(home)).lines;
  expect(lines).toEqual([]);
});

// ---- the interval ----

const lastFile = () => join(home, "last-reconcile.json");
const askedFor = (symbol: string) => stub.requests.filter((u) => u.searchParams.get("symbol") === symbol).length;

/** One NVDA decision on Tue 03-03 with its bars set, the clock at Tue 03-10 15:00Z: horizons 20 and 60 stay due. */
async function oneDecision(): Promise<void> {
  await useSource(stub.url);
  await record(nvda);
  stub.set("NVDA", cboeAnswer(bars));
  c.set("2026-03-10T15:00:00Z");
}

test("a reconcile sooner than the interval reads nothing and says fresh", async () => {
  await oneDecision();
  const first = await run("agent-one");
  expect(first.fresh).toBeUndefined();
  expect(first.written.length).toBeGreaterThan(0);
  const asked = stub.requests.length;
  const before = await readFile(lastFile(), "utf8");
  const lines = await readFile(join(home, "outcomes.jsonl"), "utf8");

  c.advance(59 * MINUTE);
  const second = await run("agent-two");
  expect(second.fresh).toEqual({ asked_at: "2026-03-10T15:00:00.000Z", again_after: "2026-03-10T16:00:00.000Z" });
  expect(second).toMatchObject({ source: stub.url, measured: 0, closed: 0, refused: [], written: [], unmeasured: [],
    stillDue: first.stillDue });
  expect(stub.requests.length).toBe(asked);                                        // nothing was read
  expect(await readFile(lastFile(), "utf8")).toBe(before);                          // and nothing written (P-c)
  expect(await readFile(join(home, "outcomes.jsonl"), "utf8")).toBe(lines);
});

test("at the interval it reads again", async () => {
  await oneDecision();
  await run();
  const asked = askedFor("NVDA");
  c.advance(60 * MINUTE);
  const again = await run();
  expect(again.fresh).toBeUndefined();
  expect(askedFor("NVDA")).toBe(asked + 1);
  expect(JSON.parse(await readFile(lastFile(), "utf8"))).toMatchObject({ t: "2026-03-10T16:00:00.000Z" });
});

test("force reads at once", async () => {
  await oneDecision();
  await run();
  const asked = askedFor("NVDA");
  c.advance(MINUTE);
  const forced = await reconcile(home, "agent-one", { now: c.now, fetch }, { force: true });
  expect(forced.fresh).toBeUndefined();
  expect(askedFor("NVDA")).toBe(asked + 1);
  expect(JSON.parse(await readFile(lastFile(), "utf8"))).toMatchObject({ t: "2026-03-10T15:01:00.000Z" });
});

test("every_minutes 0 never holds back", async () => {
  await oneDecision();
  await useSource(stub.url, 0);
  await run();
  const asked = askedFor("NVDA");
  c.advance(MINUTE);
  expect((await run()).fresh).toBeUndefined();
  await run();
  expect(askedFor("NVDA")).toBe(asked + 2);
});

test("a run that asked nothing starts no interval", async () => {
  await useSource(stub.url);
  c.set("2026-03-11T12:00:00Z");
  expect(await run()).toMatchObject({ measured: 0, written: [] });
  expect(JSON.parse(await readFile(lastFile(), "utf8"))).toMatchObject({ asked: 0 });
  expect(stub.requests).toHaveLength(0);

  c.advance(MINUTE);
  await record({ ...nvda, decided_at: "2026-03-03T15:00:00.000Z" });
  stub.set("NVDA", cboeAnswer(bars));
  const report = await run();
  expect(report.fresh).toBeUndefined();
  expect(report.measured).toBeGreaterThan(0);
  expect(askedFor("NVDA")).toBe(1);
});

test("a refused run starts the interval too", async () => {
  await useSource(stub.url);
  await record(nvda);
  c.set("2026-03-10T15:00:00Z");
  const first = await run();                                                        // the stub has no answer for NVDA
  expect(first.refused).toEqual([{ market: "US", symbol: "NVDA", why: "no answer set for NVDA" }]);
  expect(JSON.parse(await readFile(lastFile(), "utf8"))).toMatchObject({ ok: false, refused: 1, asked: 1 });

  stub.set("NVDA", cboeAnswer(bars));
  c.advance(MINUTE);
  const second = await run();
  expect(second.fresh).toEqual({ asked_at: "2026-03-10T15:00:00.000Z", again_after: "2026-03-10T16:00:00.000Z" });
  expect(askedFor("NVDA")).toBe(1);                                                 // not asked again (P-a)
});

test("a home made by v0.1 is not held back", async () => {
  const config = { ...DEFAULT_CONFIG, prices: { ...DEFAULT_CONFIG.prices, url: stub.url } };
  await writeFile(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  await record(nvda);
  stub.set("NVDA", cboeAnswer(bars));
  c.set("2026-03-10T15:00:00Z");
  await writeFile(lastFile(), `${JSON.stringify({ t: "2026-03-10T14:59:00.000Z", source: stub.url, ok: true, refused: 0 })}\n`);
  const report = await run();
  expect(report.fresh).toBeUndefined();
  expect(askedFor("NVDA")).toBe(1);
});

test("a clock that went back holds nothing back", async () => {
  await oneDecision();
  await writeFile(lastFile(),
    `${JSON.stringify({ t: "2026-03-10T16:00:00.000Z", source: stub.url, ok: true, refused: 0, asked: 3 })}\n`);
  const report = await run();
  expect(report.fresh).toBeUndefined();
  expect(askedFor("NVDA")).toBe(1);
});

test("written says what each line said", async () => {
  await useSource(stub.url);
  const d = await record({ ...nvda, price: 101 });
  const old = await record({ ...nvda, symbol: "AMD", decided_at: "2026-02-02T15:00:00Z" });
  stub.set("NVDA", cboeAnswer(bars));
  stub.set("AMD", cboeAnswer(bars));                                              // day 0 of AMD is before its first bar
  c.set("2026-03-11T12:00:00Z");
  const report = await run();
  expect(report.written).toEqual([
    { decision: d.id, symbol: "NVDA", what: "leg", pct: 2.97 },
    { decision: d.id, symbol: "NVDA", what: "horizon", k: 1, pct: -1.92 },
    { decision: d.id, symbol: "NVDA", what: "horizon", k: 5, pct: 25 },
    { decision: old.id, symbol: "AMD", what: "closed" },
  ]);
  const lines = await outcomes();
  expect(lines.map((l) => [l.decision, l.what])).toEqual(report.written.map((w) => [w.decision, w.what]));
});

test("a leg not taken is written with pct null", async () => {
  await useSource(stub.url);
  const d = await record({ ...nvda, price: 50 });                                  // half the close: a scale, not a price
  stub.set("NVDA", cboeAnswer(bars));
  c.set("2026-03-11T12:00:00Z");
  const report = await run();
  const leg = (await outcomes()).find((l) => l.what === "leg");
  expect(leg).toMatchObject({ leg_pct: null });
  expect(report.written[0]).toEqual({ decision: d.id, symbol: "NVDA", what: "leg", pct: null });
});

test("last-reconcile.json counts what was asked", async () => {
  await useSource(stub.url);
  await record(nvda);
  await record({ ...nvda, symbol: "AMD" });
  stub.set("NVDA", cboeAnswer(bars));
  stub.set("AMD", cboeAnswer(bars));
  c.set("2026-03-11T12:00:00Z");
  await run();
  expect(symbolsAsked()).toEqual(["AMD", "NVDA", "SPY"]);
  expect(JSON.parse(await readFile(lastFile(), "utf8"))).toMatchObject({ ok: true, refused: 0, asked: 3 });
});
