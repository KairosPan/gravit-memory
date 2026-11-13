import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { amendDecision, recordDecision } from "../src/decisions.js";
import { appendLine } from "../src/log.js";
import { arm } from "../src/owner.js";
import { accept, propose } from "../src/proposals.js";
import { recall } from "../src/recall.js";
import type { Deps, OutcomeLine, OwnerLine } from "../src/types.js";
import { verify } from "../src/verify.js";
import { STAND_IN_CARD, clock, tempHome, writeCard } from "./helpers.js";

const ID = "no-chasing-after-a-run";
const nvda = { action: "buy", whose: "owner", thesis: "Data-centre orders keep rising.", symbol: "NVDA", market: "US" } as const;
const GONE = "d-20260302-0f3a9c21";

let home: string;
let c: ReturnType<typeof clock>;
let deps: Deps;

beforeEach(async () => {
  home = await tempHome();
  c = clock("2026-03-02T15:00:00Z");
  deps = { now: c.now, fetch: (async () => { throw new Error("verify reads no bars"); }) as typeof fetch };
});

/** A home with a line of every kind that points at another. */
async function soundHome(): Promise<string> {
  await writeCard(home);
  await arm(home, ID, c.now());
  const r = await recall(home, "agent-one", { considering: ["buy"], symbol: "NVDA", market: "US" }, deps);
  const d = await recordDecision(home, "agent-one", { ...nvda, recall: r.recall_id }, c.now());
  await amendDecision(home, "agent-one", { decision: d.id, what: "ref", ref: "order 1" }, c.now());
  await appendLine<OutcomeLine>(home, "outcomes.jsonl", "agent-one", c.now(), "o",
    { kind: "outcome", decision: d.id, what: "closed", reason: "not measurable from this source" });
  const p = await propose(home, "agent-one", { what: "retire", lesson: ID, reason: "Unused.", evidence: [d.id] }, c.now());
  await accept(home, p.id, c.now());
  return d.id;
}

test("verify passes on a sound home", async () => {
  await soundHome();
  const v = await verify(home);
  expect(v.ok).toBe(true);
  expect(v.dangling).toEqual([]);
  expect(v.chains.every((ch) => ch.ok)).toBe(true);
  expect(v.cards).toMatchObject([{ id: ID, state: "retired" }]);
});

test("verify finds a line pointing at an id that is gone", async () => {
  await soundHome();
  await appendLine<OutcomeLine>(home, "outcomes.jsonl", "agent-one", c.now(), "o",
    { kind: "outcome", decision: GONE, what: "closed", reason: "not measurable from this source" });
  await appendLine<OwnerLine>(home, "owner.jsonl", "owner", c.now(), "w",
    { kind: "owner", act: "reject", proposal: "p-20260302-0f3a9c21", reason: "No." });
  const v = await verify(home);
  expect(v.ok).toBe(false);
  expect(v.dangling).toEqual([
    { file: "outcomes.jsonl", line: 2, points_at: GONE },
    { file: "owner.jsonl", line: 3, points_at: "p-20260302-0f3a9c21" },
  ]);
  expect(v.chains.every((ch) => ch.ok)).toBe(true);
});

test("verify finds a broken chain and a tampered armed copy", async () => {
  await writeCard(home);
  const { sha256 } = await arm(home, ID, c.now());
  await recordDecision(home, "agent-one", nvda, c.now());
  const decisions = join(home, "decisions.jsonl");
  await writeFile(decisions, (await readFile(decisions, "utf8")).replace("Data-centre", "Data-center"));
  await writeFile(join(home, "armed", `${ID}.${sha256.slice(0, 12)}.md`), STAND_IN_CARD.replace("20%", "30%"));
  const v = await verify(home);
  expect(v.ok).toBe(false);
  expect(v.chains).toContainEqual({ file: "decisions.jsonl", ok: false, line: 1 });
  expect(v.cards).toMatchObject([{ id: ID, state: "broken" }]);
  expect(v.dangling).toEqual([]);
});
