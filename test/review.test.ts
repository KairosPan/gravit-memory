import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { amendDecision, recordDecision } from "../src/decisions.js";
import type { Code } from "../src/errors.js";
import { FILES } from "../src/home.js";
import { appendLine } from "../src/log.js";
import { arm } from "../src/owner.js";
import { propose } from "../src/proposals.js";
import { recall } from "../src/recall.js";
import { reconcile } from "../src/reconcile.js";
import { review, status } from "../src/review.js";
import type { Deps, OutcomeLine } from "../src/types.js";
import { DAY, STAND_IN_CARD, clock, tempHome, writeCard } from "./helpers.js";

const ID = "no-chasing-after-a-run";
const ask = { considering: ["buy"], symbol: "NVDA", market: "US", facts: { sector: "software", change_5d_pct: 34.1 } };
const nvda = { action: "buy", whose: "owner", thesis: "Data-centre orders keep rising.", symbol: "NVDA", market: "US" } as const;

let home: string;
let c: ReturnType<typeof clock>;
let deps: Deps;

beforeEach(async () => {
  home = await tempHome();
  c = clock("2026-03-02T15:00:00Z");                                              // Mon 10:00 in New York
  deps = { now: c.now, fetch: (async () => { throw new Error("a review reads no bars"); }) as typeof fetch };
});

async function fails(p: Promise<unknown>, code: Code): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected ${code}, but it succeeded`).not.toBeNull();
  expect((err as { code?: string }).code).toBe(code);
  return (err as Error).message;
}

const decide = (input: object, by = "agent-one") => recordDecision(home, by, input, c.now());
const run = (since?: string) => review(home, since, deps);

/** A horizon line for decision d, written at the clock's time. */
async function measured(decision: string, k: number, change_pct: number): Promise<void> {
  await appendLine<OutcomeLine>(home, "outcomes.jsonl", "agent-one", c.now(), "o", {
    kind: "outcome", decision, what: "horizon", k, day0: "2026-03-02", day0_close: 100, date: "2026-03-03",
    close: 100 + change_pct, change_pct, source: "http://127.0.0.1:9", adjustment: null,
  });
}

test("a new home reviews plainly", async () => {
  expect(await run()).toEqual({ since: "1970-01-01T00:00:00.000Z", measured: [], cards: [], tags_shared: [], past_horizon: [],
    without_wrong_if: 0, voided: [], proposals: [] });
});

test("since must be a date or a time", async () => {
  await fails(run("last week"), "E_INPUT");
  expect((await run("2026-03-01")).since).toBe("2026-03-01T00:00:00.000Z");
  expect((await run("2026-03-01T12:00:00+01:00")).since).toBe("2026-03-01T11:00:00.000Z");
});

test("what was measured since a date", async () => {
  const early = await decide(nvda);
  const late = await decide({ ...nvda, symbol: "AMD" });
  await decide({ ...nvda, symbol: "AVGO" });                                     // never measured
  c.set("2026-03-03T22:00:00Z");
  await measured(early.id, 1, 2);
  c.set("2026-03-09T22:00:00Z");
  await measured(late.id, 5, -3);
  await measured(late.id, 1, 1);
  const r = await run("2026-03-05");
  expect(r.measured.map((d) => d.id)).toEqual([late.id]);
  expect(r.measured[0]!.figures).toEqual([
    { k: 1, change_pct: 1, vs_benchmark_pct: null }, { k: 5, change_pct: -3, vs_benchmark_pct: null },
    { k: 20, change_pct: null, vs_benchmark_pct: null }, { k: 60, change_pct: null, vs_benchmark_pct: null },
  ]);
  expect((await run()).measured.map((d) => d.id).sort()).toEqual([early.id, late.id].sort());
});

test("a card quiet for 90 days", async () => {
  await writeCard(home);
  await arm(home, ID, c.now());
  c.advance(89 * DAY);
  expect((await run()).cards).toMatchObject([{ id: ID, quiet: false, overridden_often: false }]);
  c.advance(2 * DAY);                                                              // armed 91 days ago, never fired
  expect((await run()).cards).toMatchObject([{ id: ID, quiet: true }]);
  await recall(home, "agent-one", ask, deps);
  const r = await run();
  expect(r.cards).toMatchObject([{ id: ID, quiet: false }]);
  expect(r.cards[0]!.record.owner.fired).toBe(1);
});

test("a card the owner overrode 3 times", async () => {
  await writeCard(home);
  await arm(home, ID, c.now());
  const override = async (symbol: string) => {
    const r = await recall(home, "agent-one", { ...ask, symbol }, deps);
    await decide({ ...nvda, symbol, recall: r.recall_id });
  };
  await override("NVDA");
  await override("AMD");
  expect((await run()).cards).toMatchObject([{ id: ID, overridden_often: false }]);
  await override("AVGO");
  const r = await run();
  expect(r.cards).toMatchObject([{ id: ID, overridden_often: true }]);
  expect(r.cards[0]!.record.owner.overridden).toBe(3);
});

test("tags shared by 3 decisions", async () => {
  const ids: string[] = [];
  for (const symbol of ["NVDA", "AMD", "AVGO"]) ids.push((await decide({ ...nvda, symbol, tags: ["setup:gap"] })).id);
  await decide({ ...nvda, tags: ["theme:ai"] });
  await decide({ ...nvda, symbol: "AMD", tags: ["theme:ai"] });
  expect((await run()).tags_shared).toEqual([{ tag: "setup:gap", decisions: ids }]);
});

test("past its own horizon with no review", async () => {
  const d = await decide({ ...nvda, horizon: 5 });
  await decide(nvda);                                                              // no horizon: never listed
  c.set("2026-03-06T15:00:00Z");                                                   // Fri: 4 weekdays gone
  expect((await run()).past_horizon).toEqual([]);
  c.set("2026-03-09T15:00:00Z");                                                   // Mon: 5 weekdays gone
  expect((await run()).past_horizon).toEqual([d.id]);
  await amendDecision(home, "agent-one", { decision: d.id, what: "review", thesis_held: "yes", wrong_if_hit: "no", whose: "owner" }, c.now());
  expect((await run()).past_horizon).toEqual([]);
});

test("without wrong_if, voided, waiting", async () => {
  await decide(nvda);
  await decide({ ...nvda, symbol: "AMD", wrong_if: "Orders fall two quarters running." });
  const gone = await decide({ ...nvda, symbol: "AVGO" }, "agent-two");
  await amendDecision(home, "agent-two", { decision: gone.id, what: "void", reason: "Registered by mistake." }, c.now());
  await writeCard(home);
  const waiting = await propose(home, "agent-one", { what: "retire", lesson: ID, reason: "Unused." }, c.now());
  const r = await run();
  expect(r.without_wrong_if).toBe(1);
  expect(r.voided).toEqual([{ decision: gone.id, by: "agent-two" }]);
  expect(r.proposals).toEqual([waiting]);
});

test("status names what each armed card needs", async () => {
  await writeCard(home);
  await arm(home, ID, c.now());
  await decide({ ...nvda, tags: ["setup:gap", "theme:ai"] });
  await decide({ ...nvda, tags: ["theme:ai"] });
  const s = await status(home);
  expect(s).toMatchObject({ home, version: 1, partial: [], prices: { url: "" } });
  expect(s.prices).not.toHaveProperty("last");
  expect(s.lines).toEqual({ "decisions.jsonl": 2, "recalls.jsonl": 0, "outcomes.jsonl": 0, "proposals.jsonl": 0, "owner.jsonl": 1 });
  expect(s.chains).toEqual(Object.values(FILES).map((file) => ({ file, ok: true })));
  expect(s.cards).toMatchObject([{ id: ID, state: "armed" }]);
  expect(s.facts).toEqual([
    { card: ID, fact: "sector", definition: "the stock's sector, as the price source's listing names it",
      checked: [{ fact: "sector", op: "in", value: ["semiconductors", "software"] }] },
    { card: ID, fact: "change_5d_pct", definition: "today's close over the close five sessions earlier, minus 1, in percent",
      checked: [{ fact: "change_5d_pct", op: ">=", value: 20 }] },
  ]);
  expect(s.tags).toEqual([{ tag: "theme:ai", count: 2 }, { tag: "setup:gap", count: 1 }]);
});

test("status says whether the price source last answered", async () => {
  await writeFile(join(home, "config.json"), JSON.stringify({ prices: { url: "http://127.0.0.1:9", markets: {} }, horizons: [1] }));
  await reconcile(home, "agent-one", deps);
  expect((await status(home)).prices).toEqual({ url: "http://127.0.0.1:9",
    last: { t: "2026-03-02T15:00:00.000Z", ok: true, refused: 0 } });
});

test("status names a refused and a changed card", async () => {
  await writeCard(home);
  await arm(home, ID, c.now());
  await writeCard(home, STAND_IN_CARD.replace("No new position", "Never a new position"));
  await writeCard(home, STAND_IN_CARD.replace(`id: ${ID}`, "id: bad-card").replace("says: dont\n", "says: dont\ncolour: red\n"));
  const s = await status(home);
  expect(s.cards).toMatchObject([{ id: "bad-card", state: "refused" }, { id: ID, state: "changed" }]);
  expect(s.cards[0]!.fault).toContain("colour");
  expect(s.facts.map((f) => f.card)).toEqual([ID, ID]);                            // a changed card applies as armed
});
