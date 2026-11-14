import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { cardStates, parseCard, renderCard, type CardState } from "../src/cards.js";
import { recordDecision } from "../src/decisions.js";
import type { Code } from "../src/errors.js";
import { sha256Hex } from "../src/ids.js";
import { appendLine, readLog } from "../src/log.js";
import { arm, discard } from "../src/owner.js";
import { accept, edit, propose, reject, waitingProposals } from "../src/proposals.js";
import type { Card, OwnerLine, ProposalLine } from "../src/types.js";
import { STAND_IN_CARD, clock, tempHome, writeCard } from "./helpers.js";

const ID = "no-chasing-after-a-run";
const card = parseCard(STAND_IN_CARD, ID);
const fresh: Card = { ...card, id: "no-buying-the-gap", words: "No buying a gap up on the open." };
const newOne = { what: "new", lesson: fresh.id, card: fresh, reason: "Three gap-up buys went the wrong way." } as const;

let home: string;
let c: ReturnType<typeof clock>;

beforeEach(async () => {
  home = await tempHome();
  c = clock("2026-03-02T15:00:00Z");
});

async function fails(p: Promise<unknown>, code: Code): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected ${code}, but it succeeded`).not.toBeNull();
  expect((err as { code?: string }).code).toBe(code);
  return (err as Error).message;
}

const proposeAs = (input: unknown, by = "agent-one") => propose(home, by, input, c.now());
const ownerLines = async () => (await readLog<OwnerLine>(home, "owner.jsonl")).lines.filter((l) => l.kind === "owner");
const proposalLines = async () => (await readLog<ProposalLine>(home, "proposals.jsonl")).lines.filter((l) => l.kind === "proposal");

async function stateOf(id: string): Promise<CardState | undefined> {
  return (await cardStates(home)).cards.find((x) => x.id === id);
}

test("a proposal writes nothing under lessons", async () => {
  const p = await proposeAs(newOne);
  expect(p.id).toMatch(/^p-20260302-[0-9a-f]{8}$/);
  expect(p).toMatchObject({ kind: "proposal", by: "agent-one", what: "new", lesson: fresh.id, card: fresh, reason: newOne.reason });
  expect(await proposalLines()).toEqual([p]);
  expect(await readdir(join(home, "lessons"))).toEqual([]);
  expect(await readdir(join(home, "armed"))).toEqual([]);
  expect(await waitingProposals(home)).toEqual([p]);
});

test("a proposed card is held to the card's schema", async () => {
  const unknownKey = await fails(proposeAs({ ...newOne, card: { ...fresh, colour: "red" } }), "E_CARD");
  expect(unknownKey).toContain("colour");
  const long = await fails(proposeAs({ ...newOne, card: { ...fresh, words: "x".repeat(201) } }), "E_CARD");
  expect(long).toContain("words");
  await fails(proposeAs({ ...newOne, card: { ...fresh, words: " Leading space." } }), "E_CARD");
  await fails(proposeAs({ ...newOne, card: { ...fresh, words: "Trailing newline.\n" } }), "E_CARD");
  await fails(proposeAs({ ...newOne, card: { ...fresh, words: "A carriage\rreturn." } }), "E_CARD");
  await fails(proposeAs({ ...newOne, reason: "x".repeat(501) }), "E_INPUT");
  await fails(proposeAs({ ...newOne, card: { ...fresh, id: "another-id" } }), "E_INPUT");
  expect(await proposalLines()).toEqual([]);
});

test("a proposed card renders and parses back equal", async () => {
  const p = await proposeAs({ ...newOne, card: { ...fresh, words: "Two lines:\nthe second one." } });
  expect(parseCard(renderCard(p.card!), p.lesson)).toEqual(p.card);
});

test("new must be new; change and retire must exist", async () => {
  await writeCard(home);
  await fails(proposeAs({ what: "new", lesson: ID, card, reason: "Again." }), "E_REFUSED");
  await proposeAs(newOne);
  await fails(proposeAs(newOne), "E_REFUSED");                      // a waiting proposal already uses the id
  await fails(proposeAs({ what: "change", lesson: "not-a-card", card: { ...card, id: "not-a-card" }, reason: "Why." }), "E_NOT_FOUND");
  await fails(proposeAs({ what: "retire", lesson: "not-a-card", reason: "Why." }), "E_NOT_FOUND");
  await proposeAs({ what: "change", lesson: ID, card: { ...card, strength: "red-line" }, reason: "It held every time." });
  await proposeAs({ what: "retire", lesson: ID, reason: "The market changed." });
  expect(await proposalLines()).toHaveLength(3);
});

test("evidence must exist", async () => {
  const d = await recordDecision(home, "agent-one", { action: "buy", whose: "owner", thesis: "A gap up." }, c.now());
  await fails(proposeAs({ ...newOne, evidence: [d.id, "d-20260302-0f3a9c21"] }), "E_NOT_FOUND");
  const p = await proposeAs({ ...newOne, evidence: [d.id] });
  expect(p.evidence).toEqual([d.id]);
});

test("only an agent proposes", async () => {
  await fails(proposeAs(newOne, "owner"), "E_REFUSED");
  await fails(proposeAs(newOne, "Agent One"), "E_INPUT");
});

test("accept writes and arms in one act", async () => {
  const p = await proposeAs(newOne);
  c.advance(60_000);
  expect(await accept(home, p.id, c.now())).toEqual({ lesson: fresh.id });
  const bytes = await readFile(join(home, "lessons", `${fresh.id}.md`));
  expect(bytes.toString("utf8")).toBe(renderCard(fresh));
  const sha256 = sha256Hex(bytes);
  expect(await readFile(join(home, "armed", `${fresh.id}.${sha256.slice(0, 12)}.md`))).toEqual(bytes);
  expect(await stateOf(fresh.id)).toMatchObject({ state: "armed", card: fresh, sha256 });
  expect(await ownerLines()).toMatchObject([{ act: "accept", proposal: p.id, lesson: fresh.id, sha256, by: "owner" }]);
  expect(await waitingProposals(home)).toEqual([]);
});

test("accept of a change arms the changed card", async () => {
  const id = await writeCard(home);
  await arm(home, id, c.now());
  const changed: Card = { ...card, strength: "red-line" };
  const p = await proposeAs({ what: "change", lesson: id, card: changed, reason: "It held every time." });
  await accept(home, p.id, c.now());
  expect(await stateOf(id)).toMatchObject({ state: "armed", card: changed });
});

test("neither accept nor edit writes over a new lesson's file that appeared", async () => {
  const p = await proposeAs(newOne);
  const own = STAND_IN_CARD.replace(`id: ${ID}`, `id: ${fresh.id}`).replace("No new position", "My own words: no new position");
  await writeCard(home, own);
  const file = join(home, "lessons", `${fresh.id}.md`);
  const before = await readFile(file);
  expect(await fails(accept(home, p.id, c.now()), "E_REFUSED")).toContain("reject this proposal, or arm your own file");
  await fails(edit(home, p.id, c.now()), "E_REFUSED");
  expect(await readFile(file)).toEqual(before);
  expect(await ownerLines()).toEqual([]);
  expect(await readdir(join(home, "armed"))).toEqual([]);
  expect(await waitingProposals(home)).toEqual([p]);
});

test("neither accept nor edit writes over a changed card's edits", async () => {
  const id = await writeCard(home);
  await arm(home, id, c.now());
  const p = await proposeAs({ what: "change", lesson: id, card: { ...card, strength: "red-line" }, reason: "It held." });
  await writeCard(home, STAND_IN_CARD.replace("No new position", "Never a new position"));
  const file = join(home, "lessons", `${id}.md`);
  const before = await readFile(file);
  expect(await fails(accept(home, p.id, c.now()), "E_REFUSED")).toContain("arm or discard the edit first");
  await fails(edit(home, p.id, c.now()), "E_REFUSED");
  expect(await readFile(file)).toEqual(before);
  expect(await ownerLines()).toHaveLength(1);                                       // the arm alone
  expect((await stateOf(id))?.state).toBe("changed");
});

test("a change on a card never armed is refused", async () => {
  const id = await writeCard(home);
  const p = await proposeAs({ what: "change", lesson: id, card: { ...card, strength: "red-line" }, reason: "It held." });
  await fails(accept(home, p.id, c.now()), "E_REFUSED");
  await fails(edit(home, p.id, c.now()), "E_REFUSED");
  expect(await readFile(join(home, "lessons", `${id}.md`), "utf8")).toBe(STAND_IN_CARD);
  expect(await ownerLines()).toEqual([]);
});

test("edit of a change on an armed card writes it, unarmed until armed", async () => {
  const id = await writeCard(home);
  await arm(home, id, c.now());
  const changed: Card = { ...card, strength: "red-line" };
  const p = await proposeAs({ what: "change", lesson: id, card: changed, reason: "It held." });
  await edit(home, p.id, c.now());
  expect(await readFile(join(home, "lessons", `${id}.md`), "utf8")).toBe(renderCard(changed));
  expect((await stateOf(id))?.state).toBe("changed");
});

test("accept of a retirement retires", async () => {
  const id = await writeCard(home);
  await arm(home, id, c.now());
  const p = await proposeAs({ what: "retire", lesson: id, reason: "The market changed." });
  expect(await accept(home, p.id, c.now())).toEqual({ lesson: id });
  expect((await stateOf(id))?.state).toBe("retired");
  const last = (await ownerLines()).at(-1)!;
  expect(last).toMatchObject({ act: "accept", proposal: p.id, lesson: id });
  expect(last).not.toHaveProperty("sha256");
});

test("edit writes the card unarmed", async () => {
  const p = await proposeAs(newOne);
  const out = await edit(home, p.id, c.now());
  expect(out).toEqual({ lesson: fresh.id, path: join(home, "lessons", `${fresh.id}.md`) });
  expect(await readFile(out.path, "utf8")).toBe(renderCard(fresh));
  expect(await stateOf(fresh.id)).toMatchObject({ state: "unarmed", card: fresh });
  expect(await ownerLines()).toMatchObject([{ act: "edit", proposal: p.id, lesson: fresh.id, by: "owner" }]);
  expect(await readdir(join(home, "armed"))).toEqual([]);
  expect(await waitingProposals(home)).toEqual([]);
});

test("edit of a retirement is refused", async () => {
  const id = await writeCard(home);
  const p = await proposeAs({ what: "retire", lesson: id, reason: "The market changed." });
  await fails(edit(home, p.id, c.now()), "E_REFUSED");
});

test("reject keeps the word why", async () => {
  const p = await proposeAs(newOne);
  await fails(reject(home, p.id, "", c.now()), "E_INPUT");
  await reject(home, p.id, "Gaps are my edge.", c.now());
  expect(await ownerLines()).toMatchObject([{ act: "reject", proposal: p.id, reason: "Gaps are my edge.", by: "owner" }]);
  expect(await readdir(join(home, "lessons"))).toEqual([]);
  expect(await waitingProposals(home)).toEqual([]);
});

test("a proposal is answered once", async () => {
  const p = await proposeAs(newOne);
  await accept(home, p.id, c.now());
  await fails(accept(home, p.id, c.now()), "E_REFUSED");
  await fails(edit(home, p.id, c.now()), "E_REFUSED");
  await fails(reject(home, p.id, "Late.", c.now()), "E_REFUSED");
  await fails(accept(home, "p-20260302-0f3a9c21", c.now()), "E_NOT_FOUND");
  expect(await ownerLines()).toHaveLength(1);
});

test("an answer not written by the owner answers nothing", async () => {
  const p = await proposeAs(newOne);
  await appendLine<OwnerLine>(home, "owner.jsonl", "agent-one", c.now(), "w",
    { kind: "owner", act: "reject", proposal: p.id, reason: "Forged." });
  expect(await waitingProposals(home)).toEqual([p]);
});

test("a working file that is a directory: accept, edit and discard refuse in plain words, and write nothing", async () => {
  await writeCard(home);
  await arm(home, ID, c.now());
  const p = await proposeAs({ what: "change", lesson: ID, card: { ...card, words: "Filler words, changed." }, reason: "Filler." });
  await rm(join(home, "lessons", `${ID}.md`));
  await mkdir(join(home, "lessons", `${ID}.md`));
  const before = await ownerLines();
  for (const act of [() => accept(home, p.id, c.now()), () => edit(home, p.id, c.now()), () => discard(home, ID, c.now())]) {
    const message = await fails(act(), "E_REFUSED");
    expect(message).toContain(`lessons/${ID}.md is a directory, not a card file.`);
    expect(message).not.toContain(home);
  }
  expect(await ownerLines()).toEqual(before);
  expect(await waitingProposals(home)).toEqual([p]);
});
