import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import type { Code } from "../src/errors.js";
import * as api from "../src/index.js";
import { openMemory, type Memory } from "../src/index.js";
import { DAY, STAND_IN_CARD, clock, tempHome, writeCard } from "./helpers.js";

const ID = "no-chasing-after-a-run";
const nvda = { action: "buy", whose: "owner", thesis: "Data-centre orders keep rising.", symbol: "NVDA", market: "US" } as const;
const ask = { considering: ["buy"], symbol: "NVDA", market: "US", facts: { sector: "software", change_5d_pct: 34.1 } };

let home: string;
let c: ReturnType<typeof clock>;
let memory: Memory;

beforeEach(async () => {
  home = await tempHome();
  c = clock("2026-03-02T15:00:00Z");
  memory = openMemory(home, { now: c.now, fetch: (async () => { throw new Error("no bars in this test"); }) as typeof fetch });
});

async function fails(p: Promise<unknown>, code: Code): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected ${code}, but it succeeded`).not.toBeNull();
  expect((err as { code?: string }).code).toBe(code);
  return (err as Error).message;
}

/** Changes the first occurrence of from in a file, so its chain no longer holds. */
async function tamper(file: string, from: string, to: string): Promise<void> {
  const path = join(home, file);
  const text = await readFile(path, "utf8");
  expect(text).toContain(from);
  await writeFile(path, text.replace(from, to));
}

test("every method refuses a missing home in the same words", async () => {
  const none = openMemory(await tempHome({ init: false }));
  const messages = [
    await fails(none.recall("agent-one", ask), "E_NO_HOME"),
    await fails(none.record("owner", nvda), "E_NO_HOME"),
    await fails(none.status(), "E_NO_HOME"),
    await fails(none.owner.arm(ID), "E_NO_HOME"),
    await fails(none.owner.reseal(), "E_NO_HOME"),
    await fails(none.show("d-20260302-0f3a9c21"), "E_NO_HOME"),
  ];
  expect(new Set(messages).size).toBe(1);
});

test("the owner voids at any time, an agent's name cannot be owner", async () => {
  const d = await memory.record("agent-one", nvda);
  c.advance(90 * DAY);
  await fails(memory.amend("agent-one", { decision: d.id, what: "void", reason: "Mistaken." }), "E_REFUSED");
  await memory.owner.void(d.id, "Registered by mistake.");
  const shown = await memory.show(d.id);
  expect(shown).toMatchObject({ decision: { void: true, amends: [{ what: "void", by: "owner" }] } });

  await fails(memory.record("owner", nvda), "E_REFUSED");
  await fails(memory.amend("owner", { decision: d.id, what: "ref", ref: "x" }), "E_REFUSED");
  await fails(memory.recall("owner", ask), "E_REFUSED");
  await fails(memory.propose("owner", { what: "retire", lesson: ID, reason: "x" }), "E_REFUSED");
  await fails(memory.reconcile("owner"), "E_REFUSED");
  await fails(memory.recall("Agent One", ask), "E_INPUT");
  await fails(memory.reconcile("Agent One"), "E_INPUT");
});

test("reseal answers for every broken file", async () => {
  await writeCard(home);
  await memory.owner.arm(ID);
  await memory.record("agent-one", nvda);
  expect(await memory.owner.reseal()).toEqual([]);
  await tamper("decisions.jsonl", "Data-centre", "Data-center");
  await tamper("owner.jsonl", "\"t\":\"2026-", "\"t\":\"2025-");
  expect(await memory.owner.reseal()).toEqual([
    { file: "decisions.jsonl", broke_at: 1 },
    { file: "owner.jsonl", broke_at: 1 },
  ]);
  const v = await memory.verify();
  expect(v.chains.every((ch) => ch.ok)).toBe(true);
  expect(v.ok).toBe(true);
  expect(await memory.owner.reseal()).toEqual([]);
});

test("the owner's acts on a card and a proposal", async () => {
  await writeCard(home);
  const { sha256 } = await memory.owner.arm(ID);
  expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  await writeCard(home, STAND_IN_CARD.replace("No new position", "Never a new position"));
  await memory.owner.discard(ID);
  const p = await memory.propose("agent-one", { what: "retire", lesson: ID, reason: "Unused." });
  expect((await memory.review()).proposals).toEqual([p]);
  await memory.owner.reject(p.id, "Keep it.");
  await memory.owner.retire(ID, "The market changed.");
  expect(await memory.show(ID)).toMatchObject({ card: { id: ID, state: "retired" } });
});

test("show a decision with its figures, or a card with its record", async () => {
  const d = await memory.record("agent-one", nvda);
  const one = await memory.show(d.id);
  expect(one).toMatchObject({ decision: { line: { id: d.id } } });
  expect("figures" in one && one.figures.map((f) => f.k)).toEqual([1, 5, 20, 60]);
  await fails(memory.show("d-20260302-0f3a9c21"), "E_NOT_FOUND");
  await fails(memory.show("no-such-card"), "E_NOT_FOUND");

  await writeCard(home);
  expect(await memory.show(ID)).toMatchObject({ card: { id: ID, state: "unarmed" } });
  await memory.owner.arm(ID);
  await memory.recall("agent-one", ask);
  const card = await memory.show(ID);
  expect("record" in card && card.record?.owner.fired).toBe(1);
});

test("a lesson id that begins d- is shown as a card", async () => {
  await writeCard(home, STAND_IN_CARD.replace(`id: ${ID}`, "id: d-day-rule"));
  expect(await memory.show("d-day-rule")).toMatchObject({ card: { id: "d-day-rule", state: "unarmed" } });
});

test("the agent's door reaches recall, record, amend, propose, reconcile, review, status and verify", async () => {
  await writeCard(home);
  await memory.owner.arm(ID);
  const a = await memory.recall("agent-one", ask);
  expect(a.applies.map((x) => x.id)).toEqual([ID]);
  const d = await memory.record("agent-one", { ...nvda, recall: a.recall_id });
  await memory.amend("agent-one", { decision: d.id, what: "ref", ref: "order 1" });
  expect((await memory.reconcile("agent-one")).source).toBeNull();
  expect((await memory.review()).cards[0]!.record.owner.overridden).toBe(1);
  expect((await memory.status()).lines["decisions.jsonl"]).toBe(2);
  expect((await memory.verify()).ok).toBe(true);
});

test("the package exports no bare owner's act", () => {
  for (const name of ["arm", "retire", "discard", "accept", "edit", "reject", "appendLine", "resealLog"]) {
    expect(api).not.toHaveProperty(name);
  }
  for (const name of ["openMemory", "initHome", "resolveHome", "assertHome", "readConfig", "MemoryError", "AGENT_NAME"]) {
    expect(api).toHaveProperty(name);
  }
});
