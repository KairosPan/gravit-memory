import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import type { CardState } from "../src/cards.js";
import { FILES } from "../src/home.js";
import { openMemory, type Memory, type ReconcileReport, type Review, type Status } from "../src/index.js";
import { RECONCILE_MAX_BYTES, REVIEW_MAX_BYTES, STATUS_MAX_BYTES } from "../src/limits.js";
import { appendLine } from "../src/log.js";
import { agentsStatus } from "../src/mcp.js";
import type { PastDecision } from "../src/recall.js";
import { TEXT_FRAME, TEXT_HEADS, reconcileText, reviewText, statusText } from "../src/texts.js";
import type { Card, LogFile, OutcomeLine, ProposalLine } from "../src/types.js";
import { clock, tempHome, writeCard } from "./helpers.js";

const ID = "no-chasing-after-a-run";
const ask = { considering: ["buy"], symbol: "NVDA", market: "US", facts: { sector: "software", change_5d_pct: 34.1 } };
const nvda = { action: "buy", whose: "owner", thesis: "Data-centre orders keep rising.", symbol: "NVDA", market: "US" };
/** One Han character, repeated: filler, never a lesson. */
const HAN = String.fromCodePoint(0x6da8);

let home: string;
let c: ReturnType<typeof clock>;
let memory: Memory;

beforeEach(async () => {
  home = await tempHome();
  c = clock("2026-03-02T15:00:00Z");                                              // Mon 10:00 in New York
  memory = openMemory(home, { now: c.now, fetch: (async () => { throw new Error("no bars here"); }) as typeof fetch });
});

/** A card's file text: a filler card with the given facts, each checked >= 1. */
function cardText(id: string, words: string, facts: Record<string, string> = {}): string {
  const names = Object.keys(facts);
  const check = names.length === 0 ? "" : `check:\n${names.map((f) => `  - { fact: ${f}, op: ">=", value: 1 }\n`).join("")}`;
  const defs = names.length === 0 ? "" : `facts:\n${names.map((f) => `  ${f}: ${JSON.stringify(facts[f])}\n`).join("")}`;
  return `---\nid: ${id}\nsays: dont\nactions: [buy]\nstrength: caveat\n${check}${defs}---\n${words}\n`;
}

/** A horizon line for decision d, written at the clock's time. */
async function measured(decision: string, k: number, change_pct: number): Promise<void> {
  await appendLine<OutcomeLine>(home, "outcomes.jsonl", "agent-one", c.now(), "o", {
    kind: "outcome", decision, what: "horizon", k, day0: "2026-03-02", day0_close: 100, date: "2026-03-03",
    close: 100 + change_pct, change_pct, source: "http://127.0.0.1:9", adjustment: null,
  });
}

/** A Status built by hand: every chain holds, no price source. */
function bareStatus(over: Partial<Status> = {}): Status {
  const files = Object.values(FILES) as LogFile[];
  return { home: "h", version: 1, lines: Object.fromEntries(files.map((f) => [f, 0])) as Record<LogFile, number>, partial: [],
    chains: files.map((file) => ({ file, ok: true })), cards: [], facts: [], tags: [], prices: { url: "" }, ...over };
}

/** n armed cards by hand, card-01 on, each with its own words and two facts of the given definition. */
function armedCards(n: number, words: (i: number) => string, definition: string): Pick<Status, "cards" | "facts"> {
  const cards: CardState[] = [];
  const facts: Status["facts"] = [];
  for (let i = 1; i <= n; i++) {
    const id = `card-${String(i).padStart(2, "0")}`;
    const card: Card = { id, says: "dont", actions: ["buy"], strength: "caveat", words: words(i),
      check: [{ fact: "fact_a", op: ">=", value: 1 }, { fact: "fact_b", op: ">=", value: 1 }],
      facts: { fact_a: definition, fact_b: definition } };
    cards.push({ id, state: "armed", card, sha256: "0".repeat(64), armedAt: "2026-03-02T15:00:00.000Z" });
    for (const fact of ["fact_a", "fact_b"]) facts.push({ card: id, fact, definition, checked: card.check!.filter((x) => x.fact === fact) });
  }
  return { cards, facts };
}

const words = (i: number): string => `${HAN.repeat(198)}${String(i).padStart(2, "0")}`;

test("a status's text holds what an agent must learn", async () => {
  await writeCard(home); await memory.owner.arm(ID);
  const text = statusText(agentsStatus(await memory.status()));                   // the status as the door gives it
  expect(text).toContain(`"No new position in a name that ran 20% in five sessions."`);
  expect(text).toContain("change_5d_pct");
  expect(text).toContain(`"today's close over the close five sessions earlier, minus 1, in percent"`);
  expect(text).toMatch(/change_5d_pct[^\n]*>= 20/);
  expect(text).toMatch(/sector[^\n]*in[^\n]*semiconductors/);
  expect(text).toContain(ID);
  expect(text).toMatch(/caveat/);
  expect(text).toMatch(/US/);
  for (const head of TEXT_HEADS.slice(0, 5)) expect(text.split("\n")).toContain(head);
});

test("a changed card applies as armed: its words are the armed copy's", async () => {
  await writeCard(home, cardText("card-changed", "Armed filler words."));
  await memory.owner.arm("card-changed");
  await writeCard(home, cardText("card-changed", "Edited filler words."));
  const text = statusText(agentsStatus(await memory.status()));
  expect(text).toContain(`"Armed filler words."`);
  expect(text).toContain("changed since armed; applies as armed");
  expect(text).not.toContain("Edited filler words");
});

test("words the owner has not armed are not in a status's text", async () => {
  await writeCard(home, cardText("card-unarmed", "Unarmed filler words.", { fact_u: "Unarmed filler definition." }));
  await writeCard(home, cardText("card-retired", "Retired filler words.", { fact_r: "Retired filler definition." }));
  await memory.owner.arm("card-retired");
  await memory.owner.retire("card-retired", "Done with it.");
  await writeFile(join(home, "lessons", "card-refused.md"), "no front matter, refused filler words\n");
  for (const s of [await memory.status(), agentsStatus(await memory.status())]) {  // the owner's full status too
    const text = statusText(s);
    expect(text).toMatch(/^- card-unarmed unarmed$/m);
    expect(text).toMatch(/^- card-retired retired$/m);
    expect(text).toMatch(/^- card-refused refused, fault: "[^\n]+"$/m);
    for (const gone of ["Unarmed filler", "Retired filler", "fact_u", "fact_r", "refused filler words"]) expect(text, gone).not.toContain(gone);
  }
});

test("a broken owner's chain applies nothing, and shows no words", async () => {
  await writeCard(home);
  await memory.owner.arm(ID);
  const s = await memory.status();
  const broken = { ...s, chains: s.chains.map((x) => (x.file === "owner.jsonl" ? { file: x.file, ok: false, line: 1 } : x)) };
  const text = statusText(broken);
  expect(text).toContain("owner.jsonl broken at line 1");
  expect(text).toContain("the owner's log chain is broken");
  expect(text).toMatch(/^- no-chasing-after-a-run armed$/m);
  expect(text).not.toContain("No new position");
  expect(text).not.toContain("change_5d_pct");
});

test("a new home's status reads plainly", async () => {
  const text = statusText(agentsStatus(await memory.status()));
  expect(text.split("\n")).toEqual([
    "0 lessons in all, 0 applying. Chains: decisions.jsonl holds, recalls.jsonl holds, outcomes.jsonl holds, "
      + "proposals.jsonl holds, owner.jsonl holds.",
    "Lessons that apply:", "none: no lesson is armed.",
    "Facts they need:", "none.",
    "Other lessons, not applied:", "none.",
    "Tags in use:", "none.",
    "Prices:", "- no price source is set.", "- not asked yet.",
  ]);
});

test("a status says its tags and its prices", async () => {
  await memory.record("agent-one", { ...nvda, tags: ["theme:ai", "setup:gap"] });
  await memory.record("agent-one", { ...nvda, tags: ["theme:ai"] });
  const s = { ...(await memory.status()), prices: { url: "http://127.0.0.1:9", last: { t: "2026-03-02T15:00:00.000Z", ok: false, refused: 2 } } };
  const text = statusText(s);
  expect(text).toContain(`- "theme:ai" 2\n- "setup:gap" 1`);
  expect(text).toContain(`- source: "http://127.0.0.1:9"`);
  expect(text).toContain("- last asked 2026-03-02T15:00:00.000Z, did not answer, refusals: 2");
});

test("a status holds 6,000 bytes and cuts no applying card's words", () => {
  const s = bareStatus({ ...armedCards(30, words, "d".repeat(500)),
    tags: Array.from({ length: 40 }, (_, i) => ({ tag: `tag:filler-${i}`, count: 40 - i })) });
  const text = statusText(s);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(STATUS_MAX_BYTES);
  expect(STATUS_MAX_BYTES).toBe(6000);
  const shown = s.cards.filter((x) => text.includes(x.id));
  expect(shown.length).toBeGreaterThan(0);
  for (const x of shown) expect(text).toContain(x.card!.words);
  expect(text).toMatch(/\d+ more not shown/);
  expect(text).toContain(`${30 - shown.length} more not shown.`);
  expect(shown.map((x) => x.id)).toEqual(s.cards.slice(0, shown.length).map((x) => x.id));   // from the end
});

test("a status yields in order", () => {
  const tags = Array.from({ length: 300 }, (_, i) => ({ tag: `tag:filler-${i}`, count: 1 }));
  const others: CardState[] = Array.from({ length: 300 }, (_, i) => ({ id: `other-${String(i).padStart(3, "0")}`, state: "unarmed" }));

  const one = statusText(bareStatus({ tags, cards: others.slice(0, 3) }));        // the tags go to a count first
  expect(one).toContain("- 300 tags, left out for length.");
  expect(one).toContain("- other-000 unarmed");

  const two = statusText(bareStatus({ tags, cards: others }));                     // then the other lessons
  expect(two).toContain("- 300 tags, left out for length.");
  expect(two).not.toContain("other-000");
  expect(two).toContain("- unarmed: 300");

  const long = "d".repeat(500);
  const six = armedCards(6, (i) => `Filler words ${i}.`, long);
  const full = statusText(bareStatus({ ...armedCards(4, (i) => `Filler words ${i}.`, long), tags: tags.slice(0, 2) }));
  expect(full).toContain(long);                                                    // whole while they fit
  expect(full).toContain(`- "tag:filler-0" 1`);
  const three = statusText(bareStatus({ cards: [...six.cards, ...others], facts: six.facts, tags }));
  expect(three).not.toContain(long);                                               // then the definitions are cut
  expect(three).toContain(`"${"d".repeat(60)}…"`);
  expect(three).not.toContain("more not shown");
  for (const x of six.cards) expect(three).toContain(x.card!.words);

  const many = armedCards(30, words, long);                                        // last, cards from the end
  const four = statusText(bareStatus({ cards: [...many.cards, ...others], facts: many.facts, tags }));
  expect(four).toMatch(/^\d+ more not shown\.$/m);
  expect(four).toContain("the facts of the lessons not shown are left out.");
  expect(four).toContain("card-01");
  expect(four).not.toContain("card-30");
  expect(Buffer.byteLength(four)).toBeLessThanOrEqual(STATUS_MAX_BYTES);
});

test("a review's text holds its material", async () => {
  await writeCard(home);
  await memory.owner.arm(ID);
  const r1 = await memory.recall("agent-one", ask);
  const d = await memory.record("agent-one", { ...nvda, recall: r1.recall_id, wrong_if: "Orders fall two quarters running.",
    horizon: 5, tags: ["setup:gap"] });
  await memory.record("agent-one", { ...nvda, symbol: "AMD", tags: ["setup:gap"] });
  await memory.record("agent-one", { ...nvda, symbol: "AVGO", tags: ["setup:gap"] });
  const gone = await memory.record("agent-two", { ...nvda, whose: "agent", symbol: "MU" });
  await memory.amend("agent-two", { decision: gone.id, what: "void", reason: "Registered by mistake." });
  const p = await memory.propose("agent-one", { what: "new", lesson: "filler-lesson", reason: "A filler reason.",
    card: { id: "filler-lesson", says: "careful", actions: ["sell"], strength: "caveat", words: "Proposed filler words." } });
  c.set("2026-03-10T22:00:00Z");
  await measured(d.id, 5, 4.25);

  const r = await memory.review();
  const text = reviewText(r);
  expect(text.split("\n")[0]).toBe("From the start.");
  expect(text).toContain(d.id);
  expect(text).toContain("5d +4.25%");
  expect(text).toContain(`"Data-centre orders keep rising."`);
  expect(text).toMatch(/^- no-chasing-after-a-run: owner: fired 1, followed 0, overridden 1, /m);
  expect(text).toContain(`- "setup:gap" 3 decisions`);
  expect(text).toMatch(new RegExp(`Past their own horizon, not reviewed:\\n- ${d.id}\\n`));
  expect(text).toContain("Without wrong_if since:\n- decisions: 2");             // the voided one is not counted
  expect(text).toContain(`- ${gone.id} by agent-two`);
  expect(text).toContain(`- ${p.id}: new lesson filler-lesson, by agent-one, reason: "A filler reason."`);
  expect(text).not.toContain("Proposed filler words");                            // P-f
  expect(reviewText(await memory.review("2026-03-03")).split("\n")[0]).toBe("Since 2026-03-03T00:00:00.000Z.");
});

test("a new home's review reads plainly", async () => {
  expect(reviewText(await memory.review()).split("\n")).toEqual([
    "From the start.",
    "Measured since:", "none.",
    "Lessons:", "none.",
    "Tags shared:", "none.",
    "Past their own horizon, not reviewed:", "none.",
    "Without wrong_if since:", "- decisions: 0",
    "Voided since:", "none.",
    "Proposals waiting:", "none.",
  ]);
});

test("a review holds 8,000 bytes", () => {
  const fig = [{ k: 1, change_pct: 1.5, vs_benchmark_pct: -0.25 }, { k: 5, change_pct: null, vs_benchmark_pct: null }];
  const measuredList: PastDecision[] = Array.from({ length: 60 }, (_, i) => ({ id: `d-20260302-${String(i).padStart(8, "0")}`,
    date: "2026-03-02", by: "agent-one", whose: "owner", action: "buy", symbol: "NVDA", thesis: "t".repeat(1000),
    wrong_if: "w".repeat(500), at_entry: false, backfilled: false, figures: fig }));
  const record = { owner: { fired: 9, followed: 4, overridden: 5, seen: 0, backfilled: 0, no_decision: 0 },
    agents: { followed: 1, overridden: 0, seen: 2 }, followed: [], overridden: [], backfilled: [],
    medians: { followed: { 1: 1.25, 5: -2 }, overridden: { 1: 0.5 } } };
  const cards = Array.from({ length: 20 }, (_, i) => ({ id: `card-${String(i).padStart(2, "0")}`, record, quiet: true, overridden_often: true }));
  const proposals = Array.from({ length: 30 }, (_, i) => ({ kind: "proposal", id: `p-20260302-${String(i).padStart(8, "0")}`,
    what: "new", lesson: `lesson-${i}`, reason: "r".repeat(500), by: "agent-one" }) as unknown as ProposalLine);
  const r: Review = { since: "2026-03-01T00:00:00.000Z", measured: measuredList, cards, tags_shared: [{ tag: "setup:gap", decisions: ["x", "y", "z"] }],
    past_horizon: measuredList.map((m) => m.id), without_wrong_if: 4, voided: [], proposals };
  const text = reviewText(r);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(REVIEW_MAX_BYTES);
  expect(REVIEW_MAX_BYTES).toBe(8000);
  expect(text).toContain("Since 2026-03-01T00:00:00.000Z.");
  expect(text).toMatch(/^\d+ more not shown\.$/m);
  expect(text).toContain("- decisions: 4");
  for (const head of TEXT_HEADS.slice(5)) expect(text.split("\n")).toContain(head);

  const small = reviewText({ ...r, measured: measuredList.slice(0, 2), cards: cards.slice(0, 1), proposals: proposals.slice(0, 1),
    past_horizon: [] });
  expect(small).toContain("t".repeat(1000));                                       // whole while it fits
  expect(small).toContain("median followed 1d +1.25%, 5d -2%; median overridden 1d +0.5%");
  expect(small).toContain("quiet for 90 days; overridden 3 times or more");
});

test("a reconcile's text says what was written and what was refused", () => {
  const base: ReconcileReport = { source: "http://127.0.0.1:9", measured: 2, closed: 1, stillDue: 3,
    refused: [{ market: "US", symbol: "AMD", why: "the source said \"no such symbol\"" }],
    unmeasured: [{ decision: "d-20260302-00000009", why: "no symbol" }],
    written: [{ decision: "d-20260302-00000001", symbol: "NVDA", what: "leg", pct: 1.25 },
      { decision: "d-20260302-00000001", symbol: "NVDA", what: "horizon", k: 5, pct: -3.5 },
      { decision: "d-20260302-00000002", symbol: "600519", what: "leg", pct: null },
      { decision: "d-20260302-00000003", symbol: "MU", what: "closed" }] };
  expect(reconcileText(base).split("\n")).toEqual([
    "Measured 2, closed 1, still due 3, refused 1, unmeasured 1.",
    "- wrote d-20260302-00000001 NVDA: leg +1.25%",
    "- wrote d-20260302-00000001 NVDA: horizon 5d -3.5%",
    "- wrote d-20260302-00000002 600519: leg not taken",
    "- wrote d-20260302-00000003 MU: closed",
    `- refused AMD in US: "the source said \\"no such symbol\\""`,
    "- not measured d-20260302-00000009: no symbol",
  ]);
  expect(reconcileText({ ...base, source: null })).toBe("No price source is set: nothing was measured.");
  const fresh = reconcileText({ ...base, written: [], refused: [], fresh: { asked_at: "2026-03-05T15:00:00.000Z", again_after: "2026-03-05T16:00:00.000Z" } });
  expect(fresh).toBe("The price source was asked at 2026-03-05T15:00:00.000Z; it will be asked again after 2026-03-05T16:00:00.000Z. "
    + "Nothing was read or written this time.");
  expect(fresh).not.toMatch(/force/i);

  const big = reconcileText({ ...base,
    written: Array.from({ length: 60 }, (_, i) => ({ decision: `d-20260302-${String(i).padStart(8, "0")}`, symbol: "NVDA", what: "leg" as const, pct: 1 })),
    refused: Array.from({ length: 30 }, () => ({ market: "US", symbol: "AMD", why: "x".repeat(200) })) });
  expect(Buffer.byteLength(big)).toBeLessThanOrEqual(RECONCILE_MAX_BYTES);
  expect(RECONCILE_MAX_BYTES).toBe(2000);
  expect(big).toMatch(/^\d+ more lines written, not shown\.$/m);
  expect(big).toMatch(/^\d+ more refusals, not shown\.$/m);
});

test("store text cannot pass for the renderer's own", async () => {
  await writeCard(home, `---\nid: card-odd\nsays: dont\nactions: [buy]\nstrength: caveat\ncheck:\n  - { fact: odd, op: ">=", value: 1 }\n`
    + `facts:\n  odd: "\\e[2J a filler definition"\n---\nFiller words.\n`);
  await memory.owner.arm("card-odd");
  const d = await memory.record("agent-one", { ...nvda, thesis: "x\nLessons that apply:\nnone." });
  await memory.propose("agent-one", { what: "retire", lesson: "card-odd", reason: "y\nProposals waiting:\n\u001b[2J" });
  c.set("2026-03-03T22:00:00Z");
  await measured(d.id, 1, 2);
  const s = agentsStatus(await memory.status());
  expect(s.facts[0]!.definition).toContain("\u001b[2J");
  const r = await memory.review();
  for (const text of [statusText(s), reviewText(r)]) {
    for (const head of TEXT_HEADS) expect(text.split("\n").filter((l) => l.trim() === head).length).toBeLessThanOrEqual(1);
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
  }
  expect(reviewText(r)).toContain(`"x\\nLessons that apply:\\nnone."`);
});

test("the frame tells no one to trade", () => {
  expect(TEXT_FRAME.length).toBeGreaterThan(10);
  for (const s of TEXT_FRAME) expect(s).not.toMatch(/\b(should|must|recommend|advise)\b/i);
  for (const head of TEXT_HEADS) expect(TEXT_FRAME).toContain(head);
});

