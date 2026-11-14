// src/proposals.ts — what agents propose of the owner's lessons, and the owner's answer to each
//
// An agent proposes: one line in proposals.jsonl, the card carried as fields (D-d), nothing written under lessons/.
// The owner answers each proposal once, with a line in owner.jsonl, `by: "owner"`: accept (the card is written and
// armed in one act, or a retirement retires), edit (the card is written, unarmed, for the owner's editor and a later
// arm), or reject with a word why. Only the owner's door calls accept, edit and reject (Memory.owner, the command
// line). Each writes its files first and its line after, as src/owner.ts does.
import { armedPath, cardStates, lessonPath, parseCard, readCardFile, renderCard, unreadable, unreadableSentence } from "./cards.js";
import { checkAgent, readDecisions } from "./decisions.js";
import { MemoryError } from "./errors.js";
import { assertHome } from "./home.js";
import { sha256Hex } from "./ids.js";
import { REASON_MAX } from "./limits.js";
import { appendLine, readLog, type Fields } from "./log.js";
import { writePrivate } from "./owner.js";
import { cardSchema, issueSentence, parseInput, proposalInput } from "./schema.js";
import type { OwnerLine, ProposalLine, ResealLine } from "./types.js";

export type ProposalInput = Pick<ProposalLine, "what" | "lesson" | "card" | "reason" | "evidence">;

/**
 * Appends a proposal of the agent `by`. A new lesson's id is used by no card and no waiting proposal (E_REFUSED); a
 * change or a retirement names a card there is (E_NOT_FOUND); the card is held to the card's schema (E_CARD); the
 * evidence names decisions there are (E_NOT_FOUND).
 */
export async function propose(home: string, by: string, input: unknown, nowMs: number): Promise<ProposalLine> {
  checkAgent(by);
  checkCard(input);
  const data = parseInput(proposalInput, input, "a proposal") as ProposalInput;

  const known = (await cardStates(home)).cards.some((c) => c.id === data.lesson);
  if (data.what === "new") {
    if (known) throw new MemoryError("E_REFUSED", `lesson ${data.lesson} is a card already: propose a change to it.`);
    if ((await waitingProposals(home)).some((p) => p.lesson === data.lesson)) {
      throw new MemoryError("E_REFUSED", `lesson ${data.lesson} is named by a proposal waiting for the owner.`);
    }
  } else if (!known) {
    throw new MemoryError("E_NOT_FOUND", `lesson ${data.lesson} is not a card: only a card there is is changed or retired.`);
  }
  if (data.evidence !== undefined && data.evidence.length > 0) {
    const ids = new Set((await readDecisions(home)).views.map((v) => v.line.id));
    const missing = data.evidence.find((id) => !ids.has(id));
    if (missing !== undefined) throw new MemoryError("E_NOT_FOUND", `evidence names ${missing}, which is not a decision in the memory.`);
  }

  return appendLine<ProposalLine>(home, "proposals.jsonl", by, nowMs, "p", { kind: "proposal", ...data } as Fields<ProposalLine>);
}

/** The proposals no owner's line has answered yet, in the order they were made. */
export async function waitingProposals(home: string): Promise<ProposalLine[]> {
  const answered = await answeredIds(home);
  return (await readLog<ProposalLine | ResealLine>(home, "proposals.jsonl")).lines
    .filter((l): l is ProposalLine => l.kind === "proposal" && !answered.has(l.id));
}

/**
 * The owner accepts: a new or changed card is written to lessons/, copied to armed/ and armed by the one accept line,
 * which carries its sha256; a retirement is the accept line alone, without one.
 */
export async function accept(home: string, proposal: string, nowMs: number): Promise<{ lesson: string }> {
  const p = await waiting(home, proposal);
  const { lesson } = p;
  if (p.what === "retire") {
    await appendLine<OwnerLine>(home, "owner.jsonl", "owner", nowMs, "w", { kind: "owner", act: "accept", proposal, lesson });
    return { lesson };
  }
  const text = cardText(p);
  await keepOwnersFile(home, p);
  const sha256 = sha256Hex(text);
  await writePrivate(lessonPath(home, lesson), text);
  await writePrivate(armedPath(home, lesson, sha256), text);
  await appendLine<OwnerLine>(home, "owner.jsonl", "owner", nowMs, "w", { kind: "owner", act: "accept", proposal, lesson, sha256 });
  return { lesson };
}

/** The owner takes the proposed card to edit: it is written to lessons/, unarmed, for a later arm. */
export async function edit(home: string, proposal: string, nowMs: number): Promise<{ lesson: string; path: string }> {
  const p = await waiting(home, proposal);
  if (p.what === "retire") {
    throw new MemoryError("E_REFUSED", `proposal ${proposal} retires a lesson: it has no card to edit; accept or reject it.`);
  }
  const text = cardText(p);
  await keepOwnersFile(home, p);
  const path = lessonPath(home, p.lesson);
  await writePrivate(path, text);
  await appendLine<OwnerLine>(home, "owner.jsonl", "owner", nowMs, "w", { kind: "owner", act: "edit", proposal, lesson: p.lesson });
  return { lesson: p.lesson, path };
}

/** The owner rejects a proposal, with a word why. */
export async function reject(home: string, proposal: string, reason: string, nowMs: number): Promise<void> {
  const n = [...reason].length;
  if (n < 1 || n > REASON_MAX) throw new MemoryError("E_INPUT", `reason must hold 1 to ${REASON_MAX} characters.`);
  await waiting(home, proposal);
  await appendLine<OwnerLine>(home, "owner.jsonl", "owner", nowMs, "w", { kind: "owner", act: "reject", proposal, reason });
}

/**
 * Neither accept nor edit writes over a lessons/ file the owner holds that is not what was armed: a new lesson's
 * file that has appeared since the proposal, or a card's working file that differs from its armed copy or was never
 * armed, or one that is a directory or cannot be read. A file equal to the armed copy, or a retired card's, is written
 * over as proposed.
 */
async function keepOwnersFile(home: string, p: ProposalLine): Promise<void> {
  const bytes = await readCardFile(lessonPath(home, p.lesson));
  if (bytes === null) return;
  if (unreadable(bytes)) throw new MemoryError("E_REFUSED", unreadableSentence(p.lesson, bytes, "written over"));
  if (p.what === "new") {
    throw new MemoryError("E_REFUSED", `lesson ${p.lesson} has a file of its own now, lessons/${p.lesson}.md: `
      + "reject this proposal, or arm your own file.");
  }
  const state = (await cardStates(home)).cards.find((c) => c.id === p.lesson);
  if (state?.state === "retired") return;
  if (state?.sha256 !== undefined && sha256Hex(bytes) === state.sha256) return;
  throw new MemoryError("E_REFUSED", `lesson ${p.lesson} has edits in lessons/${p.lesson}.md that are not armed: `
    + "arm or discard the edit first, then answer this proposal.");
}

/** A proposed card that breaks the card's schema is E_CARD, not E_INPUT: the same fault a card file would have. */
function checkCard(input: unknown): void {
  if (typeof input !== "object" || input === null || !("card" in input) || input.card === undefined) return;
  const result = cardSchema.safeParse(input.card);
  if (result.success) return;
  const sentences = result.error.issues.map((issue) => issueSentence(issue, input.card, "the card"));
  throw new MemoryError("E_CARD", `the proposed card: ${sentences.join(" ")}`);
}

/** The proposal by id, while no owner's line has answered it. */
async function waiting(home: string, proposal: string): Promise<ProposalLine> {
  await assertHome(home);
  const p = (await readLog<ProposalLine | ResealLine>(home, "proposals.jsonl")).lines
    .find((l): l is ProposalLine => l.kind === "proposal" && l.id === proposal);
  if (!p) throw new MemoryError("E_NOT_FOUND", `proposal ${proposal} is not in the memory.`);
  if ((await answeredIds(home)).has(proposal)) {
    throw new MemoryError("E_REFUSED", `proposal ${proposal} is answered already: a proposal is answered once.`);
  }
  return p;
}

/** The ids of the proposals the owner's own lines answer. */
async function answeredIds(home: string): Promise<Set<string>> {
  const answered = new Set<string>();
  for (const l of (await readLog<OwnerLine | ResealLine>(home, "owner.jsonl")).lines) {
    if (l.kind === "owner" && l.by === "owner" && (l.act === "accept" || l.act === "edit" || l.act === "reject")) {
      answered.add(l.proposal);
    }
  }
  return answered;
}

/** The proposed card's file text, read back as a card file is before it is written (E_CARD when it is not one). */
function cardText(p: ProposalLine): string {
  if (p.card === undefined) throw new MemoryError("E_CARD", `proposal ${p.id} carries no card.`);
  const text = renderCard(p.card);
  parseCard(text, p.lesson);
  return text;
}
