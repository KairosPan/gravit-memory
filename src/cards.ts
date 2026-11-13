// src/cards.ts — the owner's lesson cards: their file format, and the state each is in
//
// A card file is `---`, YAML, `---`, then the words. lessons/<id>.md is the working file the owner edits; a card
// applies only as the owner last armed it, from its byte-for-byte copy armed/<id>.<first 12 hex>.md, whose
// SHA-256 the owner's line names. Every hash is of a file's raw bytes.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { MemoryError } from "./errors.js";
import { sha256Hex } from "./ids.js";
import { LESSON_ID } from "./limits.js";
import { readLog } from "./log.js";
import { cardSchema, issueSentence } from "./schema.js";
import type { Card, OwnerLine, ResealLine } from "./types.js";

export interface CardState {
  id: string; state: "armed" | "changed" | "broken" | "unarmed" | "retired" | "refused";
  card?: Card; sha256?: string; armedAt?: string; fault?: string;
}
export interface CardStates { ownerChainBroken: boolean; brokeAt?: number; cards: CardState[]; applying: Card[] }

const SHA256 = /^[0-9a-f]{64}$/;
const CLOSE = /^---[ \t]*(?:\n|$)/m;

/** Parses a card file's bytes; its front matter id must be fileId. Throws E_CARD naming the fault. */
export function parseCard(bytes: Uint8Array | string, fileId: string): Card {
  let text = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
  if (text.startsWith("﻿")) text = text.slice(1);
  text = text.replaceAll("\r\n", "\n");
  const what = `card ${fileId}`;

  if (!/^---[ \t]*\n/.test(text)) {
    throw new MemoryError("E_CARD", `${what} has no front matter: it starts with a line of three dashes, then YAML, then another.`);
  }
  const rest = text.slice(text.indexOf("\n") + 1);
  const close = CLOSE.exec(rest);
  if (!close) throw new MemoryError("E_CARD", `${what} has its front matter open: it ends with a line of three dashes.`);

  let front: unknown;
  try {
    front = yaml.load(rest.slice(0, close.index), { schema: yaml.CORE_SCHEMA });
  } catch (err) {
    const reason = err instanceof yaml.YAMLException ? err.reason : String(err);
    throw new MemoryError("E_CARD", `${what} has front matter that is not YAML: ${reason}.`);
  }
  if (typeof front !== "object" || front === null || Array.isArray(front)) {
    throw new MemoryError("E_CARD", `${what} has front matter that is not a set of fields.`);
  }
  if ("words" in front) {
    throw new MemoryError("E_CARD", `${what} gives words in its front matter: the words are the text after it.`);
  }

  const input = { ...front, words: rest.slice(close.index + close[0].length).trim() };
  const result = cardSchema.safeParse(input);
  if (!result.success) {
    const sentences = result.error.issues.map((issue) => issueSentence(issue, input, what));
    throw new MemoryError("E_CARD", `${what}: ${sentences.join(" ")}`);
  }
  const card = result.data as Card;
  if (card.id !== fileId) {
    throw new MemoryError("E_CARD", `${what} names id ${card.id} in its front matter: a card's id is its file's name, ${fileId}.`);
  }
  return card;
}

/** The file text of a card; parseCard(renderCard(c), c.id) equals c. */
export function renderCard(card: Card): string {
  const { words, ...fields } = card;
  const front = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  return `---\n${yaml.dump(front, { schema: yaml.CORE_SCHEMA, lineWidth: -1, noRefs: true })}---\n${words}\n`;
}

/**
 * The state of every card the owner's log or lessons/ names, and the cards that apply: the armed copies of the
 * armed and changed cards — none while owner.jsonl's chain is broken.
 */
export async function cardStates(home: string): Promise<CardStates> {
  const log = await readLog<OwnerLine | ResealLine>(home, "owner.jsonl");

  // From the log, in order: each lesson's last arming, undone by a later retirement.
  const arming = new Map<string, { sha256: string; t: string } | null>();
  for (const line of log.lines) {
    if (line.kind !== "owner") continue;
    if (line.act === "arm" || (line.act === "accept" && line.sha256 !== undefined)) {
      arming.set(line.lesson, { sha256: line.sha256!, t: line.t });
    } else if (line.act === "retire" || line.act === "accept") {
      arming.set(line.lesson, null);
    }
  }

  const ids = new Set([...arming.keys(), ...(await lessonIds(home))]);
  const cards: CardState[] = [];
  for (const id of [...ids].sort()) {
    const armed = arming.get(id);
    cards.push(armed === undefined ? await unarmedState(home, id)
      : armed === null ? await retiredState(home, id)
      : await armedState(home, id, armed.sha256, armed.t));
  }

  const ownerChainBroken = !log.chain.ok;
  const applying = ownerChainBroken ? []
    : cards.flatMap((c) => ((c.state === "armed" || c.state === "changed") && c.card ? [c.card] : []));
  return { ownerChainBroken, ...(log.chain.ok ? {} : { brokeAt: log.chain.line }), cards, applying };
}

/** The path of a card's working file. */
export function lessonPath(home: string, id: string): string {
  return join(home, "lessons", `${id}.md`);
}

/** The path of a card's armed copy. */
export function armedPath(home: string, id: string, sha256: string): string {
  return join(home, "armed", `${id}.${sha256.slice(0, 12)}.md`);
}

/** The bytes of a file, or null when there is none. */
export async function readBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return null;
    throw err;
  }
}

async function lessonIds(home: string): Promise<string[]> {
  const names = await readdir(join(home, "lessons"));
  return names.filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3));
}

async function armedState(home: string, id: string, sha256: string, armedAt: string): Promise<CardState> {
  const base = { id, sha256, armedAt };
  if (!LESSON_ID.test(id) || !SHA256.test(sha256)) {
    return { ...base, state: "broken", fault: "The owner's line that armed it names no lesson id or no SHA-256." };
  }
  const bytes = await readBytes(armedPath(home, id, sha256));
  if (bytes === null) return { ...base, state: "broken", fault: "Its armed copy is missing." };
  if (sha256Hex(bytes) !== sha256) {
    return { ...base, state: "broken", fault: "Its armed copy does not hash to what the owner armed." };
  }
  let card: Card;
  try {
    card = parseCard(bytes, id);
  } catch (err) {
    return { ...base, state: "broken", fault: faultOf(err) };
  }
  const working = await readBytes(lessonPath(home, id));
  const same = working !== null && sha256Hex(working) === sha256;
  return { ...base, card, state: same ? "armed" : "changed" };
}

async function retiredState(home: string, id: string): Promise<CardState> {
  const working = LESSON_ID.test(id) ? await readBytes(lessonPath(home, id)) : null;
  if (working === null) return { id, state: "retired" };
  try {
    return { id, state: "retired", card: parseCard(working, id) };
  } catch {
    return { id, state: "retired" };
  }
}

async function unarmedState(home: string, id: string): Promise<CardState> {
  if (!LESSON_ID.test(id)) {
    return { id, state: "refused", fault: `${id}.md is not named by a lesson id: lower-case letters, digits and dashes, 2 to 40.` };
  }
  const working = await readBytes(lessonPath(home, id));
  if (working === null) return { id, state: "refused", fault: "Its file is missing." };
  try {
    return { id, state: "unarmed", card: parseCard(working, id) };
  } catch (err) {
    return { id, state: "refused", fault: faultOf(err) };
  }
}

function faultOf(err: unknown): string {
  if (err instanceof MemoryError) return err.message;
  throw err;
}
