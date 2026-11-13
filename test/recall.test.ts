import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { amendDecision, recordDecision } from "../src/decisions.js";
import type { Code } from "../src/errors.js";
import { DEFAULT_CONFIG } from "../src/home.js";
import { appendLine, readLog } from "../src/log.js";
import { arm } from "../src/owner.js";
import { recall, type AppliedCard, type PastDecision, type RecallAnswer, type UntoldCard } from "../src/recall.js";
import type { CardRecord } from "../src/records.js";
import { FRAME, renderRecall } from "../src/render.js";
import { RECALL_MAX_BYTES, RECALL_STRUCT_MAX_BYTES } from "../src/limits.js";
import type { Card, Deps, OwnerLine, ProposalLine, RecallLine } from "../src/types.js";
import { DAY, HOUR, STAND_IN_CARD, clock, tempHome, writeCard } from "./helpers.js";

const WORDS = "No new position in a name that ran 20% in five sessions.";
const ask = { considering: ["buy"], symbol: "NVDA", market: "US", facts: { sector: "software", change_5d_pct: 34.1 } };

let home: string;
let c: ReturnType<typeof clock>;
let fetched: number;
let deps: Deps;

beforeEach(async () => {
  home = await tempHome();
  c = clock("2026-03-02T15:00:00Z");
  fetched = 0;
  deps = { now: c.now, fetch: (async () => { fetched += 1; throw new Error("a recall reads no bars"); }) as typeof fetch };
});

async function fails(p: Promise<unknown>, code: Code): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected ${code}, but it succeeded`).not.toBeNull();
  expect((err as { code?: string }).code).toBe(code);
  return (err as Error).message;
}

/** The stand-in card under another id, strength or words; armed. */
async function armCard(id = "no-chasing-after-a-run", o: { strength?: Card["strength"]; words?: string } = {}): Promise<void> {
  const text = STAND_IN_CARD.replace("id: no-chasing-after-a-run", `id: ${id}`)
    .replace("strength: caveat", `strength: ${o.strength ?? "caveat"}`).replace(WORDS, o.words ?? WORDS);
  await writeCard(home, text);
  await arm(home, id, c.now());
}

const decide = (input: object, by = "agent-one") => recordDecision(home, by, input, c.now());
const nvda = { action: "buy", whose: "owner", thesis: "Data-centre orders keep rising.", symbol: "NVDA", market: "US" } as const;
const recallLines = async () => (await readLog<RecallLine>(home, "recalls.jsonl")).lines.filter((l) => l.kind === "recall");

async function useSource(url: string): Promise<void> {
  const config = { ...DEFAULT_CONFIG, prices: { ...DEFAULT_CONFIG.prices, url } };
  await writeFile(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/** Changes the first occurrence of from in a file, keeping its length, so its chain no longer holds. */
async function tamper(file: string, from: string, to: string): Promise<void> {
  const path = join(home, file);
  const text = await readFile(path, "utf8");
  expect(text).toContain(from);
  await writeFile(path, text.replace(from, to));
}

test("the card comes back in the owner's words, with its record", async () => {
  await armCard();
  const a = await recall(home, "agent-one", ask, deps);
  expect(a.applies).toMatchObject([{ id: "no-chasing-after-a-run", strength: "caveat", words: WORDS }]);
  expect(a.applies[0]!.record.owner.fired).toBe(1);
  expect(a.text).toContain(`"${WORDS}"`);
  expect(a.recall_id).toMatch(/^r-20260302-[0-9a-f]{8}$/);
});

test("it leaves one line and reads no bars", async () => {
  await armCard();
  await useSource("http://127.0.0.1:9");
  const a = await recall(home, "agent-one", { ...ask, tags: ["theme:ai"], note: "after the print" }, deps);
  const lines = await recallLines();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ kind: "recall", id: a.recall_id, by: "agent-one", t: "2026-03-02T15:00:00.000Z",
    considering: ["buy"], symbol: "NVDA", market: "US", facts: ask.facts, tags: ["theme:ai"], note: "after the print",
    applied: ["no-chasing-after-a-run"], untold: [] });
  expect(fetched).toBe(0);
});

test("the question is checked, and a bad one leaves no line", async () => {
  const message = await fails(recall(home, "agent-one", { considering: [] }, deps), "E_INPUT");
  expect(message).toContain("considering");
  expect(await fails(recall(home, "agent-one", { ...ask, leaning: "pass" }, deps), "E_INPUT")).toContain("leaning");
  await fails(recall(home, "Agent One", ask, deps), "E_INPUT");
  expect(await recallLines()).toHaveLength(0);
});

test("a card it cannot tell names what is missing", async () => {
  await armCard();
  const a = await recall(home, "agent-one", { ...ask, facts: { sector: "software" } }, deps);
  expect(a.applies).toEqual([]);
  const definition = "today's close over the close five sessions earlier, minus 1, in percent";
  expect(a.untold).toEqual([{ id: "no-chasing-after-a-run", needs: [{ what: "fact", fact: "change_5d_pct", definition }] }]);
  expect(a.text).toContain("change_5d_pct");
  expect(a.text).toContain(`"${definition}"`);
  expect((await recallLines())[0]).toMatchObject({ applied: [], untold: ["no-chasing-after-a-run"] });

  // no market given: the market is a need, not a no
  const b = await recall(home, "agent-one", { considering: ["buy"], facts: ask.facts }, deps);
  expect(b.untold[0]!.needs).toEqual([{ what: "market" }]);
});

test("red lines first, five shown, the rest counted", async () => {
  for (const id of ["card-a", "card-b", "card-c", "card-d", "card-e"]) await armCard(id);
  await armCard("card-x", { strength: "red-line" });
  await armCard("card-y", { strength: "red-line" });
  const a = await recall(home, "agent-one", ask, deps);
  expect(a.applies.map((x) => x.id)).toEqual(["card-x", "card-y", "card-a", "card-b", "card-c"]);
  expect(a.applies_more).toBe(2);
  expect(a.text).toContain("2 more not shown.");
  // the line holds every card that applied
  expect((await recallLines())[0]!.applied).toEqual(["card-x", "card-y", "card-a", "card-b", "card-c", "card-d", "card-e"]);
});

test("untold: five shown, the rest counted", async () => {
  for (const id of ["card-a", "card-b", "card-c", "card-d", "card-e", "card-f"]) await armCard(id);
  const a = await recall(home, "agent-one", { ...ask, facts: { sector: "software" } }, deps);
  expect(a.untold.map((u) => u.id)).toEqual(["card-a", "card-b", "card-c", "card-d", "card-e"]);
  expect(a.untold_more).toBe(1);
  expect((await recallLines())[0]!.untold).toHaveLength(6);
});

test("the same instrument before", async () => {
  const d1 = await decide({ ...nvda, action: "pass", thesis: "Too far, too fast." });
  c.advance(DAY);
  const d2 = await decide({ ...nvda, thesis: "x".repeat(400), wrong_if: "Orders fall two quarters running." });
  c.advance(DAY);
  const d3 = await decide({ ...nvda, action: "sell", whose: "agent", thesis: "Taking the gain.", wrong_if: "It keeps running." });
  c.advance(DAY);
  const d4 = await decide({ ...nvda, action: "hold", thesis: "Nothing changed." });
  await decide({ ...nvda, symbol: "AMD" });
  c.advance(HOUR);
  const a = await recall(home, "agent-one", ask, deps);
  expect(a.same.map((d) => d.id)).toEqual([d4.id, d3.id, d2.id]);
  expect(a.same.map((d) => d.id)).not.toContain(d1.id);
  expect([...a.same[2]!.thesis]).toHaveLength(160);
  expect(a.same[2]).toMatchObject({ date: "2026-03-03", by: "agent-one", whose: "owner", action: "buy", symbol: "NVDA",
    wrong_if: "Orders fall two quarters running.", at_entry: true, backfilled: false });
  expect(a.same[2]!.figures.map((f) => f.k)).toEqual([1, 5, 20, 60]);
  expect(a.same[1]).toMatchObject({ action: "sell", whose: "agent", at_entry: false });
  expect(a.text).toContain(`your condition at entry: "Orders fall two quarters running."`);
  expect(a.text).toContain(`wrong if: "It keeps running."`);

  // a void decision is not shown
  await amendDecision(home, "agent-one", { decision: d4.id, what: "void", reason: "Entered twice." }, c.now());
  const b = await recall(home, "agent-one", ask, deps);
  expect(b.same.map((d) => d.id)).toEqual([d3.id, d2.id, d1.id]);
});

test("like decisions", async () => {
  const tag = { tags: ["theme:ai"] };
  const amd = await decide({ ...nvda, symbol: "AMD", ...tag });
  c.advance(HOUR);
  const avgo = await decide({ ...nvda, symbol: "AVGO", tags: ["theme:ai", "size:large"] });
  c.advance(HOUR);
  await decide({ ...nvda, symbol: "TSM", action: "sell", ...tag });                   // not an action considered
  await decide({ ...nvda, symbol: "MU", tags: ["theme:memory"] });                     // no tag shared
  await decide({ ...nvda, ...tag });                                                   // the same symbol
  const gone = await decide({ ...nvda, symbol: "ARM", ...tag });
  await amendDecision(home, "agent-one", { decision: gone.id, what: "void", reason: "Wrong symbol." }, c.now());
  c.advance(HOUR);
  const smci = await decide({ ...nvda, symbol: "SMCI", action: "add", ...tag });
  c.advance(HOUR);
  const intc = await decide({ ...nvda, symbol: "INTC", ...tag });

  const a = await recall(home, "agent-one", { ...ask, considering: ["buy", "add"], ...tag }, deps);
  expect(a.like.map((d) => d.id)).toEqual([intc.id, smci.id, avgo.id]);
  expect(a.like.map((d) => d.id)).not.toContain(amd.id);
  // no tags asked: no like decisions
  expect((await recall(home, "agent-one", ask, deps)).like).toEqual([]);
});

test("the house", async () => {
  await armCard();
  await armCard("card-b");
  await useSource("http://127.0.0.1:9");
  const d = await decide(nvda);
  const card: Card = { id: "new-card", says: "careful", actions: ["buy"], strength: "caveat", words: "A stand-in proposal." };
  const p1 = await appendLine<ProposalLine>(home, "proposals.jsonl", "agent-one", c.now(), "p",
    { kind: "proposal", what: "new", lesson: "new-card", card, reason: "A stand-in reason." });
  await appendLine<ProposalLine>(home, "proposals.jsonl", "agent-one", c.now(), "p",
    { kind: "proposal", what: "retire", lesson: "card-b", reason: "A stand-in reason." });
  await appendLine<OwnerLine>(home, "owner.jsonl", "owner", c.now(), "w",
    { kind: "owner", act: "reject", proposal: p1.id, reason: "Not now." });
  await writeFile(join(home, "lessons", "card-b.md"), STAND_IN_CARD.replace("no-chasing-after-a-run", "card-b").replace(WORDS, "Edited."));
  c.set("2026-03-12T15:00:00Z");

  const a = await recall(home, "agent-one", ask, deps);
  expect(a.house).toEqual({ armed: 2, may_be_due: 1, proposals_waiting: 1, cards_changed: ["card-b"], cards_broken: [],
    owner_chain_broken: false, chains_broken: [], partial: [] });
  expect(a.applies.map((x) => x.id)).toEqual(["card-b", "no-chasing-after-a-run"]);
  expect(a.applies[0]!.words).toBe(WORDS);                                             // applies as armed
  expect(a.text).toContain("changed since armed: card-b");

  await tamper("decisions.jsonl", d.thesis, d.thesis.replace("Data", "Dbta"));
  await appendFile(join(home, "outcomes.jsonl"), "{\"v\":1");
  const b = await recall(home, "agent-one", ask, deps);
  expect(b.house.chains_broken).toEqual([{ file: "decisions.jsonl", line: 1 }]);
  expect(b.house.partial).toEqual(["outcomes.jsonl"]);
  expect(b.text).toContain("chain broken: decisions.jsonl at line 1");
  expect(b.text).toContain("partial last line: outcomes.jsonl");
  expect(fetched).toBe(0);
});

test("with no price source the house says so", async () => {
  const a = await recall(home, "agent-one", ask, deps);
  expect(a.house.may_be_due).toBe("no price source");
  expect(a.text).toContain("no price source is set");
});

test("a broken owner log", async () => {
  await armCard();
  await tamper("owner.jsonl", "\"t\":\"2026-", "\"t\":\"2025-");
  const a = await recall(home, "agent-one", ask, deps);
  expect(a.applies).toEqual([]);
  expect(a.untold).toEqual([]);
  expect(a.house.owner_chain_broken).toBe(true);
  expect(a.house.chains_broken).toEqual([{ file: "owner.jsonl", line: 1 }]);
  expect(a.text).toContain("no lesson is applied until the owner reseals");
  expect((await recallLines())[0]).toMatchObject({ applied: [], untold: [] });
});

test("the same question, store and clock get the same answer", async () => {
  await armCard();
  await armCard("card-b", { strength: "red-line" });
  await decide(nvda);
  const a = await recall(home, "agent-one", ask, deps);
  const b = await recall(home, "agent-one", ask, deps);
  expect(b.recall_id).not.toBe(a.recall_id);
  expect({ ...b, recall_id: a.recall_id }).toEqual(a);
  expect(b.applies[0]!.record.owner.fired).toBe(1);
  expect(await recallLines()).toHaveLength(2);
});

test("a new home answers plainly", async () => {
  const a = await recall(home, "agent-one", ask, deps);
  expect(a).toMatchObject({ applies: [], applies_more: 0, untold: [], untold_more: 0, same: [], like: [] });
  expect(a.text).toContain("no lesson is armed");
  expect(await recallLines()).toHaveLength(1);
});

test("the 4,000 bytes hold, and a card's words are never cut", async () => {
  const words = "涨".repeat(200);
  for (const id of ["card-a", "card-b", "card-c", "card-d", "card-e"]) await armCard(id, { words });
  const tags = ["theme:ai"];
  for (let i = 0; i < 3; i++) {
    await decide({ ...nvda, thesis: "跌".repeat(1000), wrong_if: "险".repeat(500), tags });
    c.advance(HOUR);
  }
  for (const symbol of ["AMD", "AVGO", "SMCI"]) {
    await decide({ ...nvda, symbol, thesis: "跌".repeat(1000), wrong_if: "险".repeat(500), tags });
    c.advance(HOUR);
  }
  const a = await recall(home, "agent-one", { ...ask, tags }, deps);
  expect(Buffer.byteLength(a.text)).toBeLessThanOrEqual(4000);
  for (const card of a.applies) expect(a.text).toContain(card.words);
  expect(a.applies.length + a.applies_more).toBe(5);
  expect(a.applies.length).toBeGreaterThan(0);
});

/** The answer is as short in structure as in text: under the bound, and every case it carries is in the text. */
function boundedAsShown(a: RecallAnswer): void {
  expect(RECALL_STRUCT_MAX_BYTES).toBe(16_000);
  expect(Buffer.byteLength(JSON.stringify(a))).toBeLessThan(RECALL_STRUCT_MAX_BYTES);
  for (const card of a.applies) {
    for (const x of [...card.record.followed, ...card.record.overridden, ...card.record.backfilled]) expect(a.text).toContain(x.decision);
  }
  for (const d of [...a.same, ...a.like]) {
    expect(a.text).toContain(d.id);
    expect(a.text).toContain(JSON.stringify(d.thesis));
  }
}

test("the structure of the 4,000-byte store is as short as its text", async () => {
  const words = "涨".repeat(200);
  for (const id of ["card-a", "card-b", "card-c", "card-d", "card-e"]) await armCard(id, { words });
  const tags = ["theme:ai"];
  for (const symbol of ["NVDA", "NVDA", "NVDA", "AMD", "AVGO", "SMCI"]) {
    await decide({ ...nvda, symbol, thesis: "跌".repeat(1000), wrong_if: "险".repeat(500), tags });
    c.advance(HOUR);
  }
  boundedAsShown(await recall(home, "agent-one", { ...ask, tags }, deps));
});

test("after 120 occasions the structure stays bounded, the counts whole", async () => {
  await armCard();
  for (let i = 0; i < 120; i++) {
    c.advance(26 * HOUR);
    const r = await recall(home, "agent-one", { ...ask, symbol: `SYM${i}` }, deps);
    await decide({ ...nvda, action: i % 2 ? "pass" : "buy", symbol: `SYM${i}`, thesis: "t".repeat(300), wrong_if: "w".repeat(200), recall: r.recall_id });
  }
  c.advance(26 * HOUR);
  const a = await recall(home, "agent-one", { ...ask, symbol: "SYM1" }, deps);
  boundedAsShown(a);
  const r = a.applies[0]!.record;
  expect(r.owner.followed + r.owner.overridden).toBe(120);
  expect(r.followed.length + r.overridden.length).toBeLessThan(120);
}, 60_000);

test("untold lessons yield before any applying card", async () => {
  const words = "涨".repeat(200);
  for (const id of ["card-a", "card-b", "card-c"]) await armCard(id, { words });
  await armCard("card-x", { strength: "red-line", words });
  await armCard("card-y", { strength: "red-line", words });
  const definition = "义".repeat(500);
  for (const id of ["untold-a", "untold-b", "untold-c", "untold-d", "untold-e"]) {
    const text = STAND_IN_CARD.replace("id: no-chasing-after-a-run", `id: ${id}`)
      .replace("  - { fact: change_5d_pct, op: \">=\", value: 20 }\n", "  - { fact: change_5d_pct, op: \">=\", value: 20 }\n  - { fact: pe, op: \">\", value: 50 }\n")
      .replace("facts:\n", `facts:\n  pe: ${definition}\n`);
    await writeCard(home, text);
    await arm(home, id, c.now());
  }
  const a = await recall(home, "agent-one", ask, deps);
  expect(Buffer.byteLength(a.text)).toBeLessThanOrEqual(4000);
  expect(a.untold.length + a.untold_more).toBe(5);
  expect(a.applies.length + a.applies_more).toBe(5);
  expect(a.applies.slice(0, 2).map((x) => x.id)).toEqual(["card-x", "card-y"]);
  for (const card of a.applies) expect(a.text).toContain(`owner's words: "${card.words}"`);
  expect((await recallLines())[0]!.untold).toHaveLength(5);
});

// ---- the renderer alone

const T = "2026-03-02";

function rec(cases: number): CardRecord {
  const list = Array.from({ length: cases }, (_, i) => ({ decision: `d-case-${i}`, date: T, symbol: "NVDA", action: "pass" as const,
    figures: [{ k: 5, change_pct: 1.5, vs_benchmark_pct: -0.25 }, { k: 20, change_pct: null, vs_benchmark_pct: null }] }));
  return { owner: { fired: cases, followed: cases, overridden: 0, seen: 0, backfilled: 0, no_decision: 0 },
    agents: { followed: 0, overridden: 0, seen: 0 }, followed: list, overridden: [], backfilled: [],
    medians: { followed: {}, overridden: {} } };
}

function card(id: string, strength: Card["strength"], words: string, cases = 0): AppliedCard {
  return { id, strength, says: "dont", actions: ["buy"], words, record: rec(cases) };
}

function past(id: string, thesis: string, wrong_if?: string): PastDecision {
  return { id, date: T, by: "agent-one", whose: "owner", action: "buy", symbol: "NVDA", thesis,
    ...(wrong_if !== undefined ? { wrong_if } : {}), at_entry: false, backfilled: false,
    figures: [{ k: 5, change_pct: 2, vs_benchmark_pct: null }] };
}

function answer(applies: AppliedCard[], same: PastDecision[], like: PastDecision[], untold: UntoldCard[] = []): Omit<RecallAnswer, "text"> {
  return { recall_id: "r-20260302-00000000", applies, applies_more: 0, untold, untold_more: 0, same, like,
    house: { armed: applies.length, may_be_due: 0, proposals_waiting: 0, cards_changed: [], cards_broken: [],
      owner_chain_broken: false, chains_broken: [], partial: [] } };
}

function untoldCard(id: string, definition: string): UntoldCard {
  return { id, needs: [{ what: "fact", fact: "change_5d_pct", definition }] };
}

/** Which yield step a text shows: 0 nothing yielded … 5 untold cards left out, 6 applying cards left out. */
function step(text: string, shownCards: number, untoldCards = 0): number {
  if (text.includes("d-case-0:")) return 0;                                    // a full record lists every case
  if ((text.match(/owner's words:/g) ?? []).length < shownCards) return 6;
  if ((text.match(/^- u-card-/gm) ?? []).length < untoldCards) return 5;
  if (!text.includes("d-same-")) return 4;
  if (!text.includes("d-like-")) return 3;
  return text.includes("…") ? 2 : 1;
}

test("what yields, in order", () => {
  const long = (ch: string, n: number) => ch.repeat(n);
  const same = [1, 2, 3].map((i) => past(`d-same-${i}`, long("跌", 160), long("险", 500)));
  const like = [1, 2, 3].map((i) => past(`d-like-${i}`, long("跌", 160), long("险", 500)));
  const shortSame = [1, 2, 3].map((i) => past(`d-same-${i}`, "A short thesis.", "A short condition."));
  const shortLike = [1, 2, 3].map((i) => past(`d-like-${i}`, "A short thesis.", "A short condition."));

  // nothing yields when it fits
  const small = renderRecall(answer([card("card-a", "caveat", WORDS, 2)], shortSame, shortLike));
  expect(step(small, 1)).toBe(0);
  expect(small).toContain("followed 2026-03-02 NVDA pass d-case-0: 5d +1.5% (-0.25% vs benchmark)");

  // first the records shrink to their counts and one line a group
  const records = renderRecall(answer([card("card-a", "caveat", WORDS, 60)], shortSame, shortLike));
  expect(step(records, 1)).toBe(1);
  expect(records).toContain("followed: 60 cases, latest 2026-03-02 NVDA pass d-case-59");
  expect(records).toContain(`record: "A short thesis."`);

  // then theses, conditions and untold definitions are cut with a mark
  const cut = renderRecall(answer([card("card-a", "caveat", WORDS, 60)], same, like, [untoldCard("u-card-0", long("义", 500))]));
  expect(step(cut, 1, 1)).toBe(2);
  expect(cut).toContain(`record: "${long("跌", 60)}…"`);
  expect(cut).not.toContain(long("跌", 61));
  expect(cut).toContain(`definition: "${long("义", 60)}…"`);
  expect(cut).not.toContain(long("义", 61));

  // then like decisions go, then the same instrument's, then untold cards from the end, and last applying cards
  // from the end, caveats before red lines
  const untold = [0, 1, 2, 3, 4].map((i) => untoldCard(`u-card-${i}`, long("义", 500)));
  const seen: number[] = [];
  let last: { text: string; cards: AppliedCard[] } | undefined;
  for (let n = 1; n <= 9; n++) {
    const cards = Array.from({ length: n }, (_, i) => card(`card-${i}`, i < 2 ? "red-line" : "caveat", long("涨", 200), 60));
    const text = renderRecall(answer(cards, same, like, untold));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(RECALL_MAX_BYTES);
    for (const shown of cards.filter((x) => text.includes(`${x.id},`))) expect(text).toContain(shown.words);
    const s = step(text, n, untold.length);
    if (s === 6) expect(text).not.toMatch(/^- u-card-/m);                       // no applying card goes while an untold one stays
    seen.push(s);
    last = { text, cards };
  }
  expect(seen, String(seen)).toEqual([...seen].sort((x, y) => x - y));
  expect(new Set(seen), String(seen)).toEqual(new Set([3, 4, 5, 6]));                // step 2 is shown above
  expect(last!.text).toContain("5 more not shown.");                               // the untold cards, counted
  expect(last!.text).toContain("red line card-0,");
  expect(last!.text).toContain("red line card-1,");
  expect(last!.text).not.toContain("card-8,");
  expect(last!.text).toMatch(/\d more not shown\./);
  expect(last!.text).toContain("The same instrument before:\nleft out for length.");
  expect(last!.text).toContain("Like decisions:\nleft out for length.");

  // with only red lines left, they go too, from the end
  const reds = Array.from({ length: 9 }, (_, i) => card(`card-${i}`, "red-line", long("涨", 200)));
  const redText = renderRecall(answer(reds, [], []));
  expect(Buffer.byteLength(redText)).toBeLessThanOrEqual(RECALL_MAX_BYTES);
  expect(redText).toContain("red line card-0,");
  expect(redText).not.toContain("card-8,");
});

test("the frame tells no one to trade", () => {
  expect(FRAME.length).toBeGreaterThan(10);
  for (const s of FRAME) expect(s).not.toMatch(/\b(should|must|recommend|advise)\b/i);
  for (const s of FRAME) expect(s).not.toMatch(/\b(buy|sell|add|trim|short|cover|hold|pass)\b/i);
});

test("what the store said is quoted and labelled", async () => {
  await armCard();
  await decide({ ...nvda, thesis: "He said \"orders\"\nThe guide went up.", wrong_if: "Orders fall." });
  const a = await recall(home, "agent-one", ask, deps);
  expect(a.text).toContain(`owner's words: "${WORDS}"`);
  expect(a.text).toContain(`record: "He said \\"orders\\"\\nThe guide went up."`);
  // a newline in the store's text cannot start a line of the renderer's own
  expect(a.text.split("\n")).not.toContain("The guide went up.\"");
});
