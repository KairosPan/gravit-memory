#!/usr/bin/env node
// src/cli.ts — the owner's door: the command line, the only place a lesson is armed or retired, a line voided or a
// chain resealed, each at a terminal with the typed word `yes` (D-f)
//
// The owner's acts (arm, retire, void, reseal, and review as a whole) refuse to run without a terminal before anything
// is read from or written to the home, and no flag answers for the owner. Each shows what will change, then asks
// `Type yes to <act>:`; anything but exactly `yes` changes nothing. They reach the core only through Memory.owner.
// Exit codes: 0 done; 1 nothing changed, a refusal, or verify not sound; 2 misuse.
//
// Text from the home (ledger lines, card files) is data, never the tool's own words. It is never printed on a line of
// the tool's: a label, then the value beneath behind a fence, "  | " on each of its lines (`fence`). Only validated
// identifiers stay inline (`ident`: ids, lesson ids, agents' names, enum words, ISO times; anything else shows as "?").
// Every word that reaches the terminal then passes `visible`, so no control, format or separator character hides or
// reorders what is shown, and `rows`, which cuts every line to the terminal's width as it is at that moment (every
// character but printable ASCII counted 2 columns, never fewer than a terminal draws) and puts each further row behind
// the fence: so no part of a stored value reaches column zero, and none can pose as a question or a result, however
// the terminal would have wrapped it. An owner's act refuses a terminal too narrow to show the fence and some text.
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable } from "node:stream";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { armedPath, lessonPath, parseCard, readBytes, readCardFile, renderCard, unreadable } from "./cards.js";
import { MemoryError } from "./errors.js";
import { initHome, resolveHome } from "./home.js";
import { sha256Hex } from "./ids.js";
import { openMemory, type CardRecord, type CardState, type DecisionView, type Figure, type Memory, type PastDecision,
  type Review, type Status } from "./index.js";
import { AGENT_NAME, FACT_NAME, LESSON_ID, REASON_MAX } from "./limits.js";
import { runMcp } from "./mcp.js";
import { ACTION, DECISION_ID, fitsShape, ISO_TIME, PROPOSAL_ID, UNSEEN, visible, WRITER } from "./render.js";
import type { Card, Deps, ProposalLine } from "./types.js";

export { visible } from "./render.js";

/**
 * The terminal: `columns` its width now, read again at every line written or asked (the real one is a getter over
 * process.stdout.columns, undefined when it is not a terminal); 80 is taken when it gives none.
 */
export interface Io { out(text: string): void; err(text: string): void; isTTY: boolean; ask(question: string): Promise<string>;
  env: NodeJS.ProcessEnv; columns?: number }

/** The Io the commands write through: every line made visible and cut to the width; `json` is a document, uncut. */
interface Door extends Io { json(text: string): void }

interface Command { usage: string; what: string; id?: string; json?: true; reason?: true; force?: true; owner?: true }

const COMMANDS: Record<string, Command> = {
  init: { usage: "init", what: "make the memory's home and say where it is" },
  status: { usage: "status [--json]", what: "the home: its files, chains, cards, the facts they need, the price source", json: true },
  lessons: { usage: "lessons [--json]", what: "each lesson card, its state and its words", json: true },
  show: { usage: "show <id> [--json]", what: "a decision with its amendments and figures, or a card with its record", id: "id", json: true },
  review: { usage: "review", what: "the review's material, then each proposal and each changed card for your answer", owner: true },
  arm: { usage: "arm <lesson>", what: "arm a card as its file is now", id: "lesson", owner: true },
  retire: { usage: "retire <lesson> --reason <words>", what: "retire an armed card", id: "lesson", reason: true, owner: true },
  void: { usage: "void <decision> --reason <words>", what: "void a decision", id: "decision", reason: true, owner: true },
  reconcile: { usage: "reconcile [--force]", what: "measure the decisions against the price source", force: true },
  verify: { usage: "verify [--json]", what: "check every chain, every id a line points at, every armed copy", json: true },
  reseal: { usage: "reseal", what: "restart each broken chain from where it broke", owner: true },
  mcp: { usage: "mcp --as <name>", what: "serve the agent's door over stdio" },
};

/** The name reconcile writes its outcome lines under when the command line runs it. */
const RECONCILER = "command-line";
const LINE_ID = /^[a-z]-\d{8}-[0-9a-f]{8}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const WHOSE = /^(owner|agent)$/;
const DEFAULT_COLUMNS = 80;
/** The narrowest terminal an owner's act runs on: the fence and some text on each row. */
const OWNER_COLUMNS = 20;
const OWNERS_ACT = "this is the owner's act: run it at a terminal";
const NOTHING = "nothing changed";

function usage(): string {
  const width = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));
  return ["usage: gravit-memory <command> [--home <path>]", "",
    ...Object.values(COMMANDS).map((c) => `  ${c.usage.padEnd(width)}  ${c.what}`), "",
    "The owner's acts (review, arm, retire, void, reseal) run only at a terminal, and each asks you to type yes."].join("\n");
}

/** A JSON document with every unseen character as JSON's own \uXXXX escape (a surrogate pair above U+FFFF). */
function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(UNSEEN, (ch) =>
    [...Array(ch.length).keys()].map((i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""));
}

const FENCE = "  | ";

/** Text from the home, every line behind the fence; `rows` then cuts each to the width, the fence on every row. */
function fence(text: string): string {
  return text.split("\n").map((line) => `${FENCE}${line}`).join("\n");
}

/** A labelled value from the home: the label on its own line, the value fenced beneath it. */
function field(label: string, value: string): string[] {
  return [`${label}:`, fence(value)];
}

/** A value from the home that may stand on a line of the tool's: itself when it fits its shape (src/render.ts), else "?". */
function ident(value: unknown, pattern: RegExp): string {
  return fitsShape(value, pattern) ? value : "?";
}

/** The terminal's width: the Io's when it gives a sound one, else 80. Never more than the terminal reports. */
function columnsOf(columns: number | undefined): number {
  return columns !== undefined && Number.isFinite(columns) && columns >= 1 ? Math.floor(columns) : DEFAULT_COLUMNS;
}

/**
 * Columns a code point is counted as: 1 for printable ASCII, 2 for every other, wide, ambiguous or combining alike.
 * No terminal draws one wider, so a row counted to fit is never wrapped by the terminal; counting over only cuts early.
 */
export function charWidth(cp: number): number {
  return cp >= 0x20 && cp <= 0x7e ? 1 : 2;
}

/**
 * The text as the rows of a terminal `columns` wide: a line wider than that is cut, and each further row of it
 * carries the fence, so nothing of a line but its own start reaches column zero. On a terminal too narrow for the
 * fence and a character (only a read prints there), a further row goes without it, one character at worst.
 */
export function rows(text: string, columns: number): string {
  const lead = columns >= FENCE.length + 2 ? FENCE : "";
  return text.split("\n").map((line) => {
    const out: string[] = [];
    let row = "";
    let width = 0;
    let start = 0;
    for (const ch of line) {
      const w = charWidth(ch.codePointAt(0)!);
      if (width + w > columns && width > start) {
        out.push(row);
        row = lead;
        width = lead.length;
        start = width;
      }
      row += ch;
      width += w;
    }
    out.push(row);
    return out.join("\n");
  }).join("\n");
}

/** A card as the typed word names it, from validated pieces alone: "caveat, dont buy/add". */
function cardWords(card: Card | undefined): string {
  if (card === undefined) return "?";
  const actions = Array.isArray(card.actions) ? card.actions.map((a) => ident(a, ACTION)).join("/") : "?";
  return `${ident(card.strength, /^(caveat|red-line)$/)}, ${ident(card.says, /^(dont|do|careful)$/)} ${actions}`;
}

/** A refusal or a failure on err: the head, then its sentence fenced beneath (it may quote the home's text). */
function fault(io: Door, head: string, message: string): void {
  io.err(`${head}:`);
  io.err(fence(message));
}

/** Runs one command line; the answer is the exit code: 0 done, 1 nothing changed or a refusal, 2 misuse. */
export async function runCli(argv: string[], raw: Io, deps?: Deps): Promise<number> {
  const shown = (t: string): string => rows(visible(t), columnsOf(raw.columns));   // the width as it is now
  const io: Door = { isTTY: raw.isTTY, env: raw.env, out: (t) => raw.out(shown(t)), err: (t) => raw.err(shown(t)),
    ask: (q) => raw.ask(shown(q)), json: (t) => raw.out(visible(t)) };
  const [name, ...rest] = argv;
  const cmd = name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (name === undefined || cmd === undefined) {
    io.err(name === undefined ? usage() : `gravit-memory: ${name} is not a command.\n${usage()}`);
    return 2;
  }
  const misuse = (why: string): number => { io.err(`gravit-memory ${name}: ${why}\nusage: gravit-memory ${cmd.usage} [--home <path>]`); return 2; };

  if (name === "mcp") {
    const stderr = new Writable({ write(chunk, _enc, done) { io.err(String(chunk).replace(/\n$/, "")); done(); } });
    return runMcp(rest, { ...deps, stderr, env: io.env });
  }

  let values: { home?: string; json?: boolean; reason?: string; force?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest, strict: true, allowPositionals: true,
      options: {
        home: { type: "string" },
        ...(cmd.json ? { json: { type: "boolean" } } : {}),
        ...(cmd.reason ? { reason: { type: "string" } } : {}),
        ...(cmd.force ? { force: { type: "boolean" } } : {}),
      },
    }) as { values: { home?: string; json?: boolean; reason?: string; force?: boolean }; positionals: string[] });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const opt = /'([^']+)'/.exec((err as Error).message)?.[1] ?? "an option";
      return misuse(`unknown option ${opt}${cmd.owner ? ": no flag answers for the owner" : ""}.`);
    }
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) return misuse((err as Error).message);
    throw err;
  }
  if (positionals.length !== (cmd.id ? 1 : 0)) {
    return misuse(cmd.id ? `give exactly one ${cmd.id}.` : "takes no arguments.");
  }
  const reason = values.reason?.trim();
  if (cmd.reason && !reason) return misuse("--reason <words> is required: say why.");
  if (cmd.owner && !io.isTTY) { io.err(`gravit-memory ${name}: ${OWNERS_ACT}`); return 2; }
  if (cmd.owner && columnsOf(raw.columns) < OWNER_COLUMNS) {
    io.err(`gravit-memory ${name}: the terminal is too narrow: widen it to ${OWNER_COLUMNS} columns or more.`);
    return 2;
  }

  const home = values.home ?? resolveHome(io.env);
  const id = positionals[0] ?? "";
  try {
    if (name === "init") return await init(io, home);
    const memory = openMemory(home, deps);
    switch (name) {
      case "status": return await showStatus(io, memory, values.json === true);
      case "lessons": return await lessons(io, memory, values.json === true);
      case "show": return await show(io, memory, id, values.json === true);
      case "review": return await review(io, memory);
      case "arm": return await arm(io, memory, id);
      case "retire": return await retire(io, memory, id, reason!);
      case "void": return await voidDecision(io, memory, id, reason!);
      case "reconcile": return await reconcile(io, memory, values.force === true);
      case "verify": return await verify(io, memory, values.json === true);
      case "reseal": return await reseal(io, memory);
    }
    return misuse("is not a command.");
  } catch (err) {
    if (err instanceof MemoryError) { fault(io, "gravit-memory", err.message); return 1; }
    fault(io, "gravit-memory failed", err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// ---- the owner's acts ----

/** Asks for the typed word, naming the act and its object: only exactly `yes`, the line end aside, proceeds. */
async function confirm(io: Door, act: string): Promise<boolean> {
  const answer = await io.ask(`Type yes to ${act}: `);
  if (answer.replace(/[\r\n]+$/, "") === "yes") return true;
  io.out(NOTHING);
  return false;
}

async function arm(io: Door, memory: Memory, lesson: string): Promise<number> {
  const state = await cardOf(memory, lesson);
  if (state.state === "refused") throw new MemoryError("E_CARD", `lesson ${lesson} cannot be armed: ${state.fault ?? "its file is refused."}`);
  if (state.state === "armed") {
    io.out(`Lesson ${lesson} is armed already, as its file is now.`);
    io.out(NOTHING);
    return 1;
  }
  const bytes = await readCardFile(lessonPath(memory.home, lesson));   // read once: shown, then armed only if unchanged
  if (bytes === null) throw new MemoryError("E_NOT_FOUND", `lesson ${lesson} has no file: write lessons/${lesson}.md first.`);
  if (unreadable(bytes)) throw new MemoryError("E_CARD", `lesson ${lesson} cannot be armed: ${cannotRead(lesson, bytes)}`);
  const text = bytes.toString("utf8");
  const shownSha = sha256Hex(bytes);
  const card = parseCard(bytes, lesson);
  io.out(`Arm lesson ${lesson} as its file is now:`);
  io.out("");
  io.out(fence(text.trimEnd()));
  io.out("");
  if (state.state === "changed" || state.state === "broken") {
    io.out(`This replaces the card armed on ${armedOn(state)}. The difference from the armed copy:`);
    io.out(await difference(memory.home, state, text));
  } else if (state.state === "retired") {
    io.out("This arms again a lesson that was retired.");
  }
  if (!(await confirm(io, `arm ${lesson} (${cardWords(card)}, sha ${shownSha.slice(0, 12)})`))) return 1;
  const { sha256 } = await memory.owner.arm(lesson, shownSha);
  io.out(`Armed lesson ${lesson} (${sha256.slice(0, 12)}).`);
  await ownerChainNote(io, memory);
  return 0;
}

async function retire(io: Door, memory: Memory, lesson: string, reason: string): Promise<number> {
  checkReason(reason);
  const state = await cardOf(memory, lesson);
  if (!(state.state === "armed" || state.state === "changed" || state.state === "broken")) {
    throw new MemoryError("E_REFUSED", `lesson ${lesson} is not armed: only an armed card is retired.`);
  }
  io.out(`Retire lesson ${lesson}, armed on ${armedOn(state)}:`);
  io.out("");
  const armed = state.sha256 ? await readCardFile(armedPath(memory.home, lesson, state.sha256)) : null;
  io.out(armed === null ? "(its armed copy is missing)" : unreadable(armed) ? "(its armed copy cannot be read)"
    : fence(armed.toString("utf8").trimEnd()));
  io.out("");
  io.out(field("Reason", reason).join("\n"));
  if (!(await confirm(io, `retire ${lesson}`))) return 1;
  await memory.owner.retire(lesson, reason);
  io.out(`Retired lesson ${lesson}: it applies no more until it is armed again.`);
  return 0;
}

async function voidDecision(io: Door, memory: Memory, decision: string, reason: string): Promise<number> {
  checkReason(reason);
  if (!DECISION_ID.test(decision)) throw new MemoryError("E_INPUT", "decision must be a decision id, such as d-20260302-0f3a9c21.");
  const shown = await memory.show(decision);
  if (!("decision" in shown)) throw new MemoryError("E_NOT_FOUND", `decision ${decision} is not in the memory.`);
  if (shown.decision.void) throw new MemoryError("E_REFUSED", `decision ${decision} is void already.`);
  io.out("Void this decision:");
  io.out("");
  io.out(decisionLines(shown.decision).join("\n"));
  io.out("");
  io.out(field("Reason", reason).join("\n"));
  if (!(await confirm(io, `void ${decision}`))) return 1;
  await memory.owner.void(decision, reason);
  io.out(`Voided decision ${decision}.`);
  return 0;
}

async function reseal(io: Door, memory: Memory): Promise<number> {
  const status = await memory.status();
  const broken = status.chains.filter((ch) => !ch.ok);
  if (broken.length === 0) {
    io.out("Every chain holds: there is nothing to reseal.");
    return 0;
  }
  io.out("These chains are broken, each where it breaks:");
  for (const ch of broken) {
    const text = (await readBytes(join(memory.home, ch.file)))?.toString("utf8") ?? "";
    io.out(`  ${ch.file}: broke at line ${ch.line ?? "?"}:`);
    io.out(fence(ch.line !== undefined ? text.split("\n")[ch.line - 1] ?? "" : ""));
  }
  if (broken.some((ch) => ch.file === "owner.jsonl")) {
    const after = status.cards.filter((c) => (c.state === "armed" || c.state === "changed") && c.card).map((c) => ident(c.id, LESSON_ID));
    io.out(after.length === 0 ? "After the reseal no lesson applies." : `After the reseal these lessons apply: ${after.join(", ")}`);
  }
  io.out("Resealing writes a reseal line at the end of each, naming where it broke and the hash of what is before it;");
  io.out("its chain is verified from there on. No line is changed or removed.");
  if (!(await confirm(io, `reseal ${broken.map((ch) => ch.file).join(", ")}`))) return 1;
  for (const r of await memory.owner.reseal()) io.out(`Resealed ${r.file}, broken at line ${r.broke_at}.`);
  return 0;
}

/** The review's material, then each waiting proposal and each changed card, one answer each. */
async function review(io: Door, memory: Memory): Promise<number> {
  const material = await memory.review();
  io.out(reviewLines(material).join("\n"));
  let refused = false;
  const each = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof MemoryError)) throw err;
      fault(io, "gravit-memory", err.message);
      refused = true;
    }
  };

  for (const p of material.proposals) {
    await each(async () => {
      io.out("");
      io.out(proposalLines(p).join("\n"));
      const pid = ident(p.id, PROPOSAL_ID);
      const lesson = ident(p.lesson, LESSON_ID);
      const choice = (await io.ask("Answer accept, edit, reject or skip: ")).trim();
      if (choice === "accept") {
        const act = p.what === "retire" ? `retire ${lesson}`
          : `arm ${lesson} (${cardWords(p.card)}, sha ${p.card ? sha256Hex(renderCard(p.card)).slice(0, 12) : "?"})`;
        if (!(await confirm(io, `${act} from proposal ${pid}`))) return;
        await memory.owner.accept(p.id);
        io.out(p.what === "retire" ? `Accepted: lesson ${lesson} is retired.` : `Accepted: lesson ${lesson} is armed.`);
        await ownerChainNote(io, memory);
      } else if (choice === "edit") {
        const { path } = await memory.owner.edit(p.id);
        io.out(`Lesson ${lesson} is written, unarmed, at ${lesson === "?" ? "?" : path}: edit it, then run gravit-memory arm ${lesson}.`);
      } else if (choice === "reject") {
        const why = (await io.ask("Why reject it? ")).trim();
        if (why === "") { io.out(`A rejection needs a word why: ${NOTHING}.`); return; }
        if (!(await confirm(io, `reject proposal ${pid}`))) return;
        await memory.owner.reject(p.id, why);
        io.out(`Rejected proposal ${pid}.`);
      } else {
        io.out(choice === "skip" ? "Skipped: it waits." : "That is not accept, edit, reject or skip: it waits.");
      }
    });
  }

  const changed = (await memory.status()).cards.filter((s) => s.state === "changed");
  for (const s of changed) {
    await each(async () => {
      io.out("");
      const id = ident(s.id, LESSON_ID);
      const bytes = await readCardFile(lessonPath(memory.home, s.id));  // read once: shown, then armed only if unchanged
      if (unreadable(bytes)) {
        io.out(`Lesson ${id} has changed since it was armed on ${armedOn(s)}, and its working file cannot be read: `
          + `${cannotRead(id, bytes)} Nothing is armed for it; the armed copy still applies.`);
        return;
      }
      io.out(`Lesson ${id} has changed since it was armed on ${armedOn(s)}:`);
      io.out(await difference(memory.home, s, bytes === null ? null : bytes.toString("utf8")));
      const choice = (await io.ask("Answer arm, discard or skip: ")).trim();
      if (choice === "arm") {
        if (bytes === null) throw new MemoryError("E_NOT_FOUND", `lesson ${id} has no file: write lessons/${id}.md first.`);
        const shownSha = sha256Hex(bytes);
        if (!(await confirm(io, `arm ${id} (${cardWords(parseCard(bytes, s.id))}, sha ${shownSha.slice(0, 12)})`))) return;
        const { sha256 } = await memory.owner.arm(s.id, shownSha);
        io.out(`Armed lesson ${id} as its file is now (${sha256.slice(0, 12)}).`);
        await ownerChainNote(io, memory);
      } else if (choice === "discard") {
        if (!(await confirm(io, `discard the edit of ${id}`))) return;
        await memory.owner.discard(s.id);
        io.out(`Discarded the edit: lessons/${id}.md is as it was armed.`);
      } else {
        io.out(choice === "skip" ? "Skipped: the armed copy still applies." : "That is not arm, discard or skip: the armed copy still applies.");
      }
    });
  }
  return refused ? 1 : 0;
}

// ---- the reads ----

async function init(io: Door, home: string): Promise<number> {
  const { created } = await initHome(home);
  io.out(created ? `Made the memory at ${resolve(home)}.` : `The memory is at ${resolve(home)} already.`);
  return 0;
}

async function showStatus(io: Door, memory: Memory, json: boolean): Promise<number> {
  const s = await memory.status();
  if (json) { io.json(jsonText(s)); return 0; }
  io.out(statusLines(s).join("\n"));
  return 0;
}

async function lessons(io: Door, memory: Memory, json: boolean): Promise<number> {
  const { cards } = await memory.status();
  if (json) { io.json(jsonText(cards)); return 0; }
  if (cards.length === 0) { io.out("No lesson cards yet: write one in lessons/<id>.md, then run gravit-memory arm <id>."); return 0; }
  const width = Math.max(...cards.map((c) => ident(c.id, LESSON_ID).length));
  const out: string[] = [];
  for (const c of cards) {
    const head = c.card ? `  ${cardWords(c.card)}` : "";
    out.push(`${ident(c.id, LESSON_ID).padEnd(width)}  ${c.state}${head}`);
    if (!LESSON_ID.test(c.id)) out.push("  file:", fence(`${c.id}.md`));
    if (c.card) out.push(fence(c.card.words));
    if (c.fault) out.push("  fault:", fence(c.fault));
  }
  io.out(out.join("\n"));
  return 0;
}

async function show(io: Door, memory: Memory, id: string, json: boolean): Promise<number> {
  const shown = await memory.show(id);
  if (json) { io.json(jsonText(shown)); return 0; }
  if ("decision" in shown) {
    io.out([...decisionLines(shown.decision), "Figures:", `  ${figuresText(shown.figures)}`].join("\n"));
    return 0;
  }
  const { card, record } = shown;
  const out = [`${ident(card.id, LESSON_ID)}: ${card.state}${card.armedAt ? `, armed on ${armedOn(card)}` : ""}`
    + `${card.sha256 ? ` (${ident(card.sha256, SHA256).slice(0, 12)})` : ""}`];
  if (card.fault) out.push(...field("fault", card.fault));
  if (card.card) out.push("", fence(renderCard(card.card).trimEnd()), "");
  if (record) out.push("Record:", ...recordLines(record).map((l) => (l.startsWith(FENCE) ? l : `  ${l}`)));
  io.out(out.join("\n"));
  return 0;
}

async function reconcile(io: Door, memory: Memory, force: boolean): Promise<number> {
  const r = await memory.reconcile(RECONCILER, { force });
  if (r.source === null) { io.out("No price source is set: nothing was measured. Set prices.url in config.json."); return 0; }
  if (r.fresh) {
    io.out(`Fresh: the price source was asked at ${ident(r.fresh.asked_at, ISO_TIME)}.`);
    io.out(`Asked again after ${ident(r.fresh.again_after, ISO_TIME)}, or now with reconcile --force.`);
    return 0;
  }
  io.out(`Measured ${r.measured}, closed ${r.closed}, still due ${r.stillDue}, refused ${r.refused.length}, unmeasured ${r.unmeasured.length}.`);
  if (r.refused.length > 0) io.out(["Refused, each its symbol, its market and why:", ...r.refused.map((x) => fence(`${x.symbol} in ${x.market}: ${x.why}`))].join("\n"));
  for (const x of r.unmeasured) io.out(`  unmeasured: ${ident(x.decision, DECISION_ID)}: ${ident(x.why, /^no (symbol|market)$/)}`);
  return 0;
}

async function verify(io: Door, memory: Memory, json: boolean): Promise<number> {
  const v = await memory.verify();
  if (json) { io.json(jsonText(v)); return v.ok ? 0 : 1; }
  if (v.ok) { io.out("Sound: every chain holds, every id a line points at is there, no armed card is broken."); return 0; }
  const out = ["Not sound:"];
  for (const ch of v.chains) if (!ch.ok) out.push(`  ${ch.file}: the chain breaks at line ${ch.line ?? "?"}`);
  for (const d of v.dangling) out.push(`  ${d.file} line ${d.line}: points at an id that is not there:`, fence(d.points_at));
  for (const c of v.cards) if (c.state === "broken") out.push(`  lesson ${ident(c.id, LESSON_ID)} is broken:`, fence(c.fault ?? ""));
  io.out(out.join("\n"));
  return 1;
}

// ---- helpers ----

/** The card's state, after checking the id; E_NOT_FOUND when no file and no owner's line names it. */
async function cardOf(memory: Memory, lesson: string): Promise<CardState> {
  if (!LESSON_ID.test(lesson)) throw new MemoryError("E_INPUT", "lesson must be a lesson id: lower-case letters, digits and dashes, 2 to 40.");
  const state = (await memory.status()).cards.find((c) => c.id === lesson);
  if (!state) throw new MemoryError("E_NOT_FOUND", `lesson ${lesson} has no file: write lessons/${lesson}.md first.`);
  return state;
}

/** After an act that arms: while owner.jsonl's chain is broken no lesson applies, armed or not; says so. */
async function ownerChainNote(io: Door, memory: Memory): Promise<void> {
  if ((await memory.status()).chains.some((ch) => ch.file === "owner.jsonl" && !ch.ok)) {
    io.out("owner.jsonl's chain is broken: no lesson applies until gravit-memory reseal.");
  }
}

/** When a card was armed, as an ISO time, or "an earlier day". */
function armedOn(s: CardState): string {
  return s.armedAt === undefined ? "an earlier day" : ident(s.armedAt, ISO_TIME);
}

function checkReason(reason: string): void {
  if ([...reason].length > REASON_MAX) throw new MemoryError("E_INPUT", `reason must hold 1 to ${REASON_MAX} characters.`);
}

/** Why a card's working file cannot be read, as one sentence. */
function cannotRead(id: string, file: { unreadable: "a directory" | "not readable" }): string {
  return `lessons/${id}.md ${file.unreadable === "a directory" ? "is a directory, not a card file" : "cannot be read"}.`;
}

/** Lines only in the armed copy marked "-", lines only in the working file's text (as read) marked "+", all fenced. */
async function difference(home: string, s: CardState, working: string | null): Promise<string> {
  const copy = s.sha256 ? await readCardFile(armedPath(home, s.id, s.sha256)) : null;
  const armed = Buffer.isBuffer(copy) ? copy.toString("utf8") : null;
  const linesOf = (t: string | null) => (t ?? "").replaceAll("\r\n", "\n").split("\n").filter((l, i, all) => i < all.length - 1 || l !== "");
  const a = linesOf(armed);
  const w = linesOf(working);
  const only = (xs: string[], ys: string[]) => {
    const left = new Map<string, number>();
    for (const y of ys) left.set(y, (left.get(y) ?? 0) + 1);
    return xs.filter((x) => { const n = left.get(x) ?? 0; if (n > 0) { left.set(x, n - 1); return false; } return true; });
  };
  const out = [...only(a, w).map((l) => fence(`- ${l}`)), ...only(w, a).map((l) => fence(`+ ${l}`))];
  if (armed === null) out.unshift(unreadable(copy) ? "(its armed copy cannot be read)" : "(its armed copy is missing)");
  if (working === null) out.unshift(`(lessons/${ident(s.id, LESSON_ID)}.md is gone)`);
  return out.length > 0 ? out.join("\n") : "(no line differs; the bytes do, such as line ends)";
}

function pct(n: number | null): string {
  return typeof n !== "number" || !Number.isFinite(n) ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function figuresText(figures: Figure[]): string {
  if (figures.length === 0) return "none";
  return figures.map((f) => `${Number.isInteger(f.k) ? f.k : "?"}d ${pct(f.change_pct)}${f.vs_benchmark_pct !== null ? ` (${pct(f.vs_benchmark_pct)} vs benchmark)` : ""}`).join(", ");
}

const BASE = new Set(["v", "kind", "id", "seq", "prev", "t", "by", "sum"]);

/** A line's own fields, each a label indented by `indent` with its value fenced beneath (a JSON value on one line). */
function fieldLines(obj: object, skip: Set<string>, indent: string): string[] {
  return Object.entries(obj).filter(([k]) => !skip.has(k))
    .flatMap(([k, v]) => field(`${indent}${ident(k, /^[a-z_]{1,32}$/)}`, typeof v === "string" ? v : JSON.stringify(v)));
}

/** A decision's head, of validated pieces alone; its other fields, symbol and market among them, fenced beneath. */
function decisionLines(v: DecisionView): string[] {
  const l = v.line;
  const out = [`Decision ${ident(l.id, DECISION_ID)}${v.void ? " (void)" : ""}: ${ident(l.action, ACTION)}, whose ${ident(l.whose, WHOSE)}, `
    + `registered ${ident(l.t, ISO_TIME)} by ${ident(l.by, WRITER)}`, ...fieldLines(l, new Set([...BASE, "action", "whose"]), "  ")];
  if (v.amends.length > 0) {
    out.push("Amendments:");
    for (const a of v.amends) {
      out.push(`  ${ident(a.id, LINE_ID)} ${ident(a.t, ISO_TIME)} by ${ident(a.by, WRITER)}: ${ident(a.what, /^(ref|close|review|correction|void)$/)}`,
        ...fieldLines(a, new Set([...BASE, "decision", "what"]), "    "));
    }
  }
  return out;
}

/** One past case: its decision, date and action, and the instrument it was on — fenced, as a symbol is free text. */
function caseText(c: { decision: string; date: string; action: string; symbol?: string }): string {
  return fence(`${c.decision} ${c.date} ${c.action}${c.symbol !== undefined ? ` ${c.symbol}` : ""}`);
}

function recordLines(r: CardRecord): string[] {
  const o = r.owner;
  const cases = (name: string, xs: CardRecord["followed"]) => (xs.length === 0 ? [] : [`${name}:`, ...xs.map(caseText)]);
  const medians = (name: string, m: Record<number, number>) => {
    const ks = Object.keys(m);
    return ks.length === 0 ? [] : [`median ${name}: ${ks.map((k) => `${ident(k, /^\d{1,3}$/)}d ${pct(m[Number(k)] ?? null)}`).join(", ")}`];
  };
  return [
    `the owner: fired ${o.fired}, followed ${o.followed}, overridden ${o.overridden}, seen ${o.seen}, backfilled ${o.backfilled}, no decision ${o.no_decision}`,
    `agents: followed ${r.agents.followed}, overridden ${r.agents.overridden}, seen ${r.agents.seen}`,
    ...medians("followed", r.medians.followed), ...medians("overridden", r.medians.overridden),
    ...cases("followed", r.followed), ...cases("overridden", r.overridden), ...cases("backfilled", r.backfilled),
  ];
}

function statusLines(s: Status): string[] {
  const n = s.lines;
  const broken = s.chains.filter((c) => !c.ok);
  const states = new Map<string, number>();
  for (const c of s.cards) states.set(c.state, (states.get(c.state) ?? 0) + 1);
  const out = [
    `The memory at ${s.home}, version ${s.version}`,
    `Ledgers: ${n["decisions.jsonl"]} decisions and amendments, ${n["recalls.jsonl"]} recalls, ${n["outcomes.jsonl"]} outcomes, `
      + `${n["proposals.jsonl"]} proposals, ${n["owner.jsonl"]} owner's lines`,
    broken.length === 0 ? "Chains: every chain holds" : `Chains: broken: ${broken.map((c) => `${c.file} at line ${c.line ?? "?"}`).join(", ")}`,
  ];
  if (s.partial.length > 0) out.push(`A partial last line, left aside: ${s.partial.join(", ")}`);
  out.push(s.cards.length === 0 ? "Lessons: none"
    : `Lessons: ${s.cards.length} (${[...states].map(([state, k]) => `${k} ${state}`).join(", ")})`);
  if (s.facts.length > 0) {
    out.push("Facts the applying lessons need:");
    for (const f of s.facts) out.push(`  ${ident(f.fact, FACT_NAME)} (${ident(f.card, LESSON_ID)}):`, fence(f.definition));
  }
  if (s.tags.length > 0) out.push("Tags, each with how many decisions carry it:", ...s.tags.map((t) => fence(`${t.tag} ${t.count}`)));
  if (s.prices.url === "") {
    out.push("Prices: no price source: set prices.url in config.json");
  } else {
    const last = s.prices.last;
    out.push("Prices: the price source is", fence(s.prices.url),
      !last ? "  never reconciled"
        : last.asked === 0 ? `  last reconcile ${ident(last.t, ISO_TIME)}, asked the source nothing`
        : `  last reconcile ${ident(last.t, ISO_TIME)}, ${last.ok ? "answered" : "did not answer"}, ${last.refused} refused`);
  }
  return out;
}

function pastLines(p: PastDecision): string[] {
  const head = `  ${ident(p.id, DECISION_ID)} ${ident(p.date, ISO_TIME)} ${ident(p.action, ACTION)}, whose ${ident(p.whose, WHOSE)}: ${figuresText(p.figures)}`;
  return p.symbol !== undefined ? [head, fence(`on ${p.symbol}`)] : [head];
}

function reviewLines(r: Review): string[] {
  const out = [Date.parse(r.since) === 0 ? "Review, from the start" : `Review since ${r.since}`, ""];
  out.push(`Decisions measured: ${r.measured.length}`, ...r.measured.flatMap(pastLines));
  out.push(`Lessons with a record: ${r.cards.length}`);
  for (const c of r.cards) {
    const flags = [c.quiet ? "quiet" : "", c.overridden_often ? "overridden often" : ""].filter(Boolean);
    out.push(`  ${ident(c.id, LESSON_ID)}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`,
      ...recordLines(c.record).map((l) => (l.startsWith(FENCE) ? l : `    ${l}`)));
  }
  if (r.tags_shared.length > 0) {
    out.push("Tags shared by several decisions:", ...r.tags_shared.map((t) => fence(`${t.tag}: ${t.decisions.join(", ")}`)));
  }
  out.push(`Past their horizon, without a review: ${r.past_horizon.length === 0 ? "none" : r.past_horizon.map((id) => ident(id, DECISION_ID)).join(", ")}`);
  out.push(`Decisions without wrong_if: ${r.without_wrong_if}`);
  if (r.voided.length > 0) out.push(`Voided: ${r.voided.map((x) => `${ident(x.decision, DECISION_ID)} by ${ident(x.by, WRITER)}`).join(", ")}`);
  out.push(`Proposals waiting: ${r.proposals.length}`);
  return out;
}

function proposalLines(p: ProposalLine): string[] {
  const verb = p.what === "new" ? "add" : ident(p.what, /^(change|retire)$/);
  const out = [`Proposal ${ident(p.id, PROPOSAL_ID)} by ${ident(p.by, AGENT_NAME)}, ${ident(p.t, ISO_TIME)}: ${verb} lesson ${ident(p.lesson, LESSON_ID)}`];
  if (p.card) out.push("", fence(renderCard(p.card).trimEnd()), "");
  out.push(...field("Reason", p.reason));
  if (p.evidence && p.evidence.length > 0) out.push("Evidence:", ...p.evidence.map(fence));
  return out;
}

// ---- the entry ----

/**
 * The real Io's ask over these streams: the line typed, or "" when the input closes (Ctrl-D, the end of a pipe) or the
 * owner presses Ctrl-C while the question waits — so an unanswered question changes nothing.
 */
export function makeAsk(input: Readable, output: Writable): (question: string) => Promise<string> {
  return (question) => new Promise<string>((done) => {
    if (input.readableEnded || input.destroyed) { done(""); return; }
    const rl = createInterface({ input, output });
    let settled = false;
    const finish = (answer: string): void => {
      if (settled) return;
      settled = true;
      rl.close();
      done(answer);
    };
    rl.once("close", () => { setImmediate(() => finish("")); });      // after a last line the input ended on
    rl.once("SIGINT", () => { output.write("\n"); finish(""); });
    rl.question(question).then(finish, () => finish(""));
  });
}

function processIo(): Io {
  return {
    get columns() { return process.stdout.isTTY ? process.stdout.columns : undefined; },
    out: (text) => { process.stdout.write(`${text}\n`); },
    err: (text) => { process.stderr.write(`${text}\n`); },
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    env: process.env,
    ask: makeAsk(process.stdin, process.stdout),
  };
}

/**
 * Whether the script the process was started with (argv1) is the module at moduleUrl: compared as real paths, so it
 * holds through a symlink (npm's bin link), and without regard to case on Windows, where a drive letter's case varies.
 */
export function isEntry(argv1: string | undefined, moduleUrl: string, platform: NodeJS.Platform): boolean {
  if (argv1 === undefined) return false;
  const windows = platform === "win32";
  const real = (path: string): string => {
    try {
      return realpathSync.native(path);
    } catch {
      return path;
    }
  };
  const a = real(argv1);
  const b = real(fileURLToPath(moduleUrl, { windows }));
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isEntry(process.argv[1], import.meta.url, process.platform)) {
  runCli(process.argv.slice(2), processIo()).then((code) => { process.exitCode = code; }, (err: unknown) => {
    process.stderr.write(`gravit-memory failed:\n${rows(visible(fence(err instanceof Error ? err.message : String(err))), columnsOf(process.stderr.isTTY ? process.stderr.columns : undefined))}\n`);
    process.exitCode = 1;
  });
}
