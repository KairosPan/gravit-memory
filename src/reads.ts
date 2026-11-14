// src/reads.ts — two reads for a host's own screens: the lessons with their texts, the decisions with what followed
//
// They are reads, not tools: the agent's door has none for them. Like the status, they answer when a log's chain is
// broken or its last line is partial; a fault in one card's files is that card's, never the whole read's.
import { armedPath, cardStates, lessonPath, parseCard, readCardFile, type CardState } from "./cards.js";
import { readDecisions, type DecisionView } from "./decisions.js";
import { MemoryError } from "./errors.js";
import { readConfig } from "./home.js";
import { sha256Hex } from "./ids.js";
import { DECISIONS_LIMIT_DEFAULT, LESSON_ID } from "./limits.js";
import { readLog } from "./log.js";
import { readOutcomes } from "./reconcile.js";
import { cardRecord, figuresOf, occasionsOf, type CardRecord, type Figure } from "./records.js";
import { decisionsFilter, parseInput } from "./schema.js";
import type { Card, RecallLine, ResealLine } from "./types.js";

export interface LessonView {
  id: string; state: CardState["state"]; fault?: string; armedAt?: string;
  /** The armed copy, for an armed or a changed card. */
  armed?: { sha256: string; text: string; card: Card };
  /** lessons/<id>.md as it is now, whenever there is one: its card when it parses, else the fault that stops it. */
  file?: { sha256: string; text: string; card?: Card; fault?: string };
  /** The applying card's record; null when the card does not apply. */
  record: CardRecord | null;
}
export interface Lessons { ownerChainBroken: boolean; lessons: LessonView[] }
export interface DecisionItem { view: DecisionView; figures: Figure[] }
export interface Decisions { items: DecisionItem[]; more: boolean }

/** Every card by id, with its armed copy, its working file and, when it applies, its record as of nowMs. */
export async function readLessons(home: string, nowMs: number): Promise<Lessons> {
  const states = await cardStates(home);
  let records: ((card: Card) => CardRecord) | undefined;
  if (states.applying.length > 0) {
    const cfg = await readConfig(home);
    const { views } = await readDecisions(home);
    const outcomes = (await readOutcomes(home)).lines;
    const recalls = (await readLog<RecallLine | ResealLine>(home, "recalls.jsonl")).lines
      .filter((l): l is RecallLine => l.kind === "recall");
    const occasions = occasionsOf(recalls);
    records = (card) => cardRecord(card, occasions, views, outcomes, cfg.horizons, nowMs);
  }

  const lessons: LessonView[] = [];
  for (const s of states.cards) {
    const applies = s.card !== undefined && states.applying.includes(s.card);
    const armed = await armedView(home, s);
    const file = await fileView(home, s);
    lessons.push({
      id: s.id, state: s.state,
      ...(s.fault !== undefined ? { fault: s.fault } : {}),
      ...(s.armedAt !== undefined ? { armedAt: s.armedAt } : {}),
      ...(armed !== undefined ? { armed } : {}),
      ...(file !== undefined ? { file } : {}),
      record: applies && records !== undefined ? records(s.card!) : null,
    });
  }
  return { ownerChainBroken: states.ownerChainBroken, lessons };
}

/** The decisions newest first by registration, each with its figures; E_INPUT on a bad filter, E_NOT_FOUND on before. */
export async function listDecisions(home: string, filter: unknown): Promise<Decisions> {
  const f = parseInput(decisionsFilter, filter === undefined ? {} : filter, "the decisions' filter");
  const { views } = await readDecisions(home);
  let older = views;
  if (f.before !== undefined) {
    const at = views.findIndex((v) => v.line.id === f.before);
    if (at < 0) throw new MemoryError("E_NOT_FOUND", `decision ${f.before} is not in the memory.`);
    older = views.slice(0, at);
  }
  const matching = (f.symbol === undefined ? older : older.filter((v) => v.line.symbol === f.symbol)).reverse();
  const limit = f.limit ?? DECISIONS_LIMIT_DEFAULT;
  const shown = matching.slice(0, limit);
  const cfg = await readConfig(home);
  const outcomes = (await readOutcomes(home)).lines;
  return {
    items: shown.map((view) => ({ view, figures: figuresOf(view.line.id, outcomes, cfg.horizons) })),
    more: matching.length > limit,
  };
}

/** The armed copy of an armed or a changed card, as cardStates found it hashing and parsing. */
async function armedView(home: string, s: CardState): Promise<LessonView["armed"]> {
  if ((s.state !== "armed" && s.state !== "changed") || s.card === undefined || s.sha256 === undefined) return undefined;
  const bytes = await readCardFile(armedPath(home, s.id, s.sha256));
  if (!Buffer.isBuffer(bytes)) return undefined;
  return { sha256: sha256Hex(bytes), text: bytes.toString("utf8"), card: s.card };
}

/**
 * lessons/<id>.md when there is one that can be read. A refused card is the only one whose id may not be a lesson
 * id: its id is then a file's name in lessons/, so it is still read there. The text is the bytes as UTF-8, a byte
 * that is not shown as the replacement character; whether the file is a card is parseCard's to say.
 */
async function fileView(home: string, s: CardState): Promise<LessonView["file"]> {
  if (!LESSON_ID.test(s.id) && s.state !== "refused") return undefined;
  const bytes = await readCardFile(lessonPath(home, s.id));
  if (!Buffer.isBuffer(bytes)) return undefined;
  const base = { sha256: sha256Hex(bytes), text: bytes.toString("utf8") };
  try {
    return { ...base, card: parseCard(bytes, s.id) };
  } catch (err) {
    if (err instanceof MemoryError) return { ...base, fault: err.message };
    throw err;
  }
}
