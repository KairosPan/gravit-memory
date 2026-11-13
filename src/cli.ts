#!/usr/bin/env node
// src/cli.ts — the owner's door: the command line, the only place a lesson is armed or retired, a line voided or a
// chain resealed, each at a terminal with the typed word `yes` (D-f)
//
// The owner's acts (arm, retire, void, reseal, and review as a whole) refuse to run without a terminal before anything
// is read from or written to the home, and no flag answers for the owner. Each shows what will change, then asks
// `Type yes to <act>:`; anything but exactly `yes` changes nothing. They reach the core only through Memory.owner.
// Exit codes: 0 done; 1 nothing changed, a refusal, or verify not sound; 2 misuse.
//
// Text from the home (ledger lines, card files) is data, never the tool's own words: a field that is one line has its
// newlines shown as \n (`one`), a value that may span lines is printed behind a fence, "  | " on each line (`fence`),
// so no line of it starts at column zero and none can pose as a question or a result. Every word that reaches the
// terminal then passes `visible`, so no control, format or separator character hides or reorders what is shown.
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable } from "node:stream";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { armedPath, lessonPath, renderCard } from "./cards.js";
import { MemoryError } from "./errors.js";
import { initHome, resolveHome } from "./home.js";
import { sha256Hex } from "./ids.js";
import { openMemory, type CardRecord, type CardState, type DecisionView, type Figure, type Memory, type PastDecision,
  type Review, type Status } from "./index.js";
import { LESSON_ID, REASON_MAX } from "./limits.js";
import { runMcp } from "./mcp.js";
import type { Deps, ProposalLine } from "./types.js";

export interface Io { out(text: string): void; err(text: string): void; isTTY: boolean; ask(question: string): Promise<string>; env: NodeJS.ProcessEnv }

interface Command { usage: string; what: string; id?: string; json?: true; reason?: true; owner?: true }

const COMMANDS: Record<string, Command> = {
  init: { usage: "init", what: "make the memory's home and say where it is" },
  status: { usage: "status [--json]", what: "the home: its files, chains, cards, the facts they need, the price source", json: true },
  lessons: { usage: "lessons [--json]", what: "each lesson card, its state and its words", json: true },
  show: { usage: "show <id> [--json]", what: "a decision with its amendments and figures, or a card with its record", id: "id", json: true },
  review: { usage: "review", what: "the review's material, then each proposal and each changed card for your answer", owner: true },
  arm: { usage: "arm <lesson>", what: "arm a card as its file is now", id: "lesson", owner: true },
  retire: { usage: "retire <lesson> --reason <words>", what: "retire an armed card", id: "lesson", reason: true, owner: true },
  void: { usage: "void <decision> --reason <words>", what: "void a decision", id: "decision", reason: true, owner: true },
  reconcile: { usage: "reconcile", what: "measure the decisions against the price source" },
  verify: { usage: "verify [--json]", what: "check every chain, every id a line points at, every armed copy", json: true },
  reseal: { usage: "reseal", what: "restart each broken chain from where it broke", owner: true },
  mcp: { usage: "mcp --as <name>", what: "serve the agent's door over stdio" },
};

/** The name reconcile writes its outcome lines under when the command line runs it. */
const RECONCILER = "command-line";
const DECISION_ID = /^d-\d{8}-[0-9a-f]{8}$/;
const OWNERS_ACT = "this is the owner's act: run it at a terminal";
const NOTHING = "nothing changed";

function usage(): string {
  const width = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));
  return ["usage: gravit-memory <command> [--home <path>]", "",
    ...Object.values(COMMANDS).map((c) => `  ${c.usage.padEnd(width)}  ${c.what}`), "",
    "The owner's acts (review, arm, retire, void, reseal) run only at a terminal, and each asks you to type yes."].join("\n");
}

/** C0 and C1 controls but the newline (tab included), DEL, format characters (bidi, zero-width, BOM), separators. */
const UNSEEN = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/gu;

/** The text with every unseen character written as a visible \uXXXX escape, or \u{XXXXX} above U+FFFF. */
export function visible(text: string): string {
  return text.replace(UNSEEN, (ch) => {
    const cp = ch.codePointAt(0)!;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`;
  });
}

/** A JSON document with every unseen character as JSON's own \uXXXX escape (a surrogate pair above U+FFFF). */
function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(UNSEEN, (ch) =>
    [...Array(ch.length).keys()].map((i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""));
}

/** A one-line field from the home: a newline in it is shown as \n, so it cannot start a line of its own. */
function one(text: string): string {
  return text.replaceAll("\n", "\\n");
}

const FENCE = "  | ";

/** Text from the home that may span lines, every line behind the fence. */
function fence(text: string): string {
  return text.split("\n").map((line) => `${FENCE}${line}`).join("\n");
}

/** A labelled value from the home: on the label's line when it is one line, else fenced beneath it. */
function field(label: string, value: string): string[] {
  return value.includes("\n") ? [`${label}:`, fence(value)] : [`${label}: ${value}`];
}

/** Runs one command line; the answer is the exit code: 0 done, 1 nothing changed or a refusal, 2 misuse. */
export async function runCli(argv: string[], raw: Io, deps?: Deps): Promise<number> {
  const io: Io = { isTTY: raw.isTTY, env: raw.env, out: (t) => raw.out(visible(t)), err: (t) => raw.err(visible(t)),
    ask: (q) => raw.ask(visible(q)) };
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

  let values: { home?: string; json?: boolean; reason?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest, strict: true, allowPositionals: true,
      options: {
        home: { type: "string" },
        ...(cmd.json ? { json: { type: "boolean" } } : {}),
        ...(cmd.reason ? { reason: { type: "string" } } : {}),
      },
    }) as { values: { home?: string; json?: boolean; reason?: string }; positionals: string[] });
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
      case "reconcile": return await reconcile(io, memory);
      case "verify": return await verify(io, memory, values.json === true);
      case "reseal": return await reseal(io, memory);
    }
    return misuse("is not a command.");
  } catch (err) {
    if (err instanceof MemoryError) { io.err(`gravit-memory: ${one(err.message)}`); return 1; }
    io.err(`gravit-memory failed: ${one(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}

// ---- the owner's acts ----

/** Asks for the typed word: only exactly `yes`, the line end aside, proceeds. */
async function confirm(io: Io, act: string): Promise<boolean> {
  const answer = await io.ask(`Type yes to ${act}: `);
  if (answer.replace(/[\r\n]+$/, "") === "yes") return true;
  io.out(NOTHING);
  return false;
}

async function arm(io: Io, memory: Memory, lesson: string): Promise<number> {
  const state = await cardOf(memory, lesson);
  if (state.state === "refused") throw new MemoryError("E_CARD", `lesson ${lesson} cannot be armed: ${state.fault ?? "its file is refused."}`);
  if (state.state === "armed") {
    io.out(`Lesson ${lesson} is armed already, as its file is now.`);
    io.out(NOTHING);
    return 1;
  }
  const bytes = await readBytes(lessonPath(memory.home, lesson));       // read once: shown, then armed only if unchanged
  if (bytes === null) throw new MemoryError("E_NOT_FOUND", `lesson ${lesson} has no file: write lessons/${lesson}.md first.`);
  const text = bytes.toString("utf8");
  io.out(`Arm lesson ${lesson} as its file is now:`);
  io.out("");
  io.out(fence(text.trimEnd()));
  io.out("");
  if (state.state === "changed" || state.state === "broken") {
    io.out(`This replaces the card armed on ${one(state.armedAt ?? "an earlier day")}. The difference from the armed copy:`);
    io.out(await difference(memory.home, state, text));
  } else if (state.state === "retired") {
    io.out("This arms again a lesson that was retired.");
  }
  if (!(await confirm(io, "arm"))) return 1;
  const { sha256 } = await memory.owner.arm(lesson, sha256Hex(bytes));
  io.out(`Armed lesson ${lesson} (${sha256.slice(0, 12)}).`);
  return 0;
}

async function retire(io: Io, memory: Memory, lesson: string, reason: string): Promise<number> {
  checkReason(reason);
  const state = await cardOf(memory, lesson);
  if (!(state.state === "armed" || state.state === "changed" || state.state === "broken")) {
    throw new MemoryError("E_REFUSED", `lesson ${lesson} is not armed: only an armed card is retired.`);
  }
  io.out(`Retire lesson ${lesson}, armed on ${one(state.armedAt ?? "an earlier day")}:`);
  io.out("");
  const armed = state.sha256 ? await readText(armedPath(memory.home, lesson, state.sha256)) : null;
  io.out(armed === null ? "(its armed copy is missing)" : fence(armed.trimEnd()));
  io.out("");
  io.out(field("Reason", reason).join("\n"));
  if (!(await confirm(io, "retire"))) return 1;
  await memory.owner.retire(lesson, reason);
  io.out(`Retired lesson ${lesson}: it applies no more until it is armed again.`);
  return 0;
}

async function voidDecision(io: Io, memory: Memory, decision: string, reason: string): Promise<number> {
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
  if (!(await confirm(io, "void"))) return 1;
  await memory.owner.void(decision, reason);
  io.out(`Voided decision ${decision}.`);
  return 0;
}

async function reseal(io: Io, memory: Memory): Promise<number> {
  const broken = (await memory.status()).chains.filter((ch) => !ch.ok);
  if (broken.length === 0) {
    io.out("Every chain holds: there is nothing to reseal.");
    return 0;
  }
  io.out("These chains are broken:");
  for (const ch of broken) io.out(`  ${ch.file}: broke at line ${ch.line ?? "?"}`);
  io.out("Resealing writes a reseal line at the end of each, naming where it broke and the hash of what is before it;");
  io.out("its chain is verified from there on. No line is changed or removed.");
  if (!(await confirm(io, "reseal"))) return 1;
  for (const r of await memory.owner.reseal()) io.out(`Resealed ${r.file}, broken at line ${r.broke_at}.`);
  return 0;
}

/** The review's material, then each waiting proposal and each changed card, one answer each. */
async function review(io: Io, memory: Memory): Promise<number> {
  const material = await memory.review();
  io.out(reviewLines(material).join("\n"));
  let refused = false;
  const each = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof MemoryError)) throw err;
      io.err(`gravit-memory: ${one(err.message)}`);
      refused = true;
    }
  };

  for (const p of material.proposals) {
    await each(async () => {
      io.out("");
      io.out(proposalLines(p).join("\n"));
      const choice = (await io.ask("Answer accept, edit, reject or skip: ")).trim();
      if (choice === "accept") {
        if (!(await confirm(io, "accept"))) return;
        const { lesson } = await memory.owner.accept(p.id);
        io.out(p.what === "retire" ? `Accepted: lesson ${one(lesson)} is retired.` : `Accepted: lesson ${one(lesson)} is armed.`);
      } else if (choice === "edit") {
        const { lesson, path } = await memory.owner.edit(p.id);
        io.out(`Lesson ${one(lesson)} is written, unarmed, at ${one(path)}: edit it, then run gravit-memory arm ${one(lesson)}.`);
      } else if (choice === "reject") {
        const why = (await io.ask("Why reject it? ")).trim();
        if (why === "") { io.out(`A rejection needs a word why: ${NOTHING}.`); return; }
        if (!(await confirm(io, "reject"))) return;
        await memory.owner.reject(p.id, why);
        io.out(`Rejected proposal ${one(p.id)}.`);
      } else {
        io.out(choice === "skip" ? "Skipped: it waits." : `${one(choice) || "No answer"} is not accept, edit, reject or skip: it waits.`);
      }
    });
  }

  const changed = (await memory.status()).cards.filter((s) => s.state === "changed");
  for (const s of changed) {
    await each(async () => {
      io.out("");
      const bytes = await readBytes(lessonPath(memory.home, s.id));    // read once: shown, then armed only if unchanged
      io.out(`Lesson ${one(s.id)} has changed since it was armed on ${one(s.armedAt ?? "an earlier day")}:`);
      io.out(await difference(memory.home, s, bytes === null ? null : bytes.toString("utf8")));
      const choice = (await io.ask("Answer arm, discard or skip: ")).trim();
      if (choice === "arm") {
        if (!(await confirm(io, "arm"))) return;
        if (bytes === null) throw new MemoryError("E_NOT_FOUND", `lesson ${one(s.id)} has no file: write lessons/${one(s.id)}.md first.`);
        const { sha256 } = await memory.owner.arm(s.id, sha256Hex(bytes));
        io.out(`Armed lesson ${one(s.id)} as its file is now (${sha256.slice(0, 12)}).`);
      } else if (choice === "discard") {
        if (!(await confirm(io, "discard"))) return;
        await memory.owner.discard(s.id);
        io.out(`Discarded the edit: lessons/${one(s.id)}.md is as it was armed.`);
      } else {
        io.out(choice === "skip" ? "Skipped: the armed copy still applies." : `${one(choice) || "No answer"} is not arm, discard or skip: the armed copy still applies.`);
      }
    });
  }
  return refused ? 1 : 0;
}

// ---- the reads ----

async function init(io: Io, home: string): Promise<number> {
  const { created } = await initHome(home);
  io.out(created ? `Made the memory at ${resolve(home)}.` : `The memory is at ${resolve(home)} already.`);
  return 0;
}

async function showStatus(io: Io, memory: Memory, json: boolean): Promise<number> {
  const s = await memory.status();
  if (json) { io.out(jsonText(s)); return 0; }
  io.out(statusLines(s).join("\n"));
  return 0;
}

async function lessons(io: Io, memory: Memory, json: boolean): Promise<number> {
  const { cards } = await memory.status();
  if (json) { io.out(jsonText(cards)); return 0; }
  if (cards.length === 0) { io.out("No lesson cards yet: write one in lessons/<id>.md, then run gravit-memory arm <id>."); return 0; }
  const width = Math.max(...cards.map((c) => one(c.id).length));
  const out: string[] = [];
  for (const c of cards) {
    const head = c.card ? `  ${c.card.says} ${c.card.actions.join(", ")}, ${c.card.strength}` : "";
    out.push(`${one(c.id).padEnd(width)}  ${c.state}${head}`);
    if (c.card) out.push(fence(c.card.words));
    if (c.fault) out.push(`  fault: ${one(c.fault)}`);
  }
  io.out(out.join("\n"));
  return 0;
}

async function show(io: Io, memory: Memory, id: string, json: boolean): Promise<number> {
  const shown = await memory.show(id);
  if (json) { io.out(jsonText(shown)); return 0; }
  if ("decision" in shown) {
    io.out([...decisionLines(shown.decision), "Figures:", `  ${figuresText(shown.figures)}`].join("\n"));
    return 0;
  }
  const { card, record } = shown;
  const out = [`${one(card.id)}: ${card.state}${card.armedAt ? `, armed on ${one(card.armedAt)}` : ""}${card.sha256 ? ` (${one(card.sha256.slice(0, 12))})` : ""}`];
  if (card.fault) out.push(`fault: ${one(card.fault)}`);
  if (card.card) out.push("", fence(renderCard(card.card).trimEnd()), "");
  if (record) out.push("Record:", ...recordLines(record).map((l) => `  ${l}`));
  io.out(out.join("\n"));
  return 0;
}

async function reconcile(io: Io, memory: Memory): Promise<number> {
  const r = await memory.reconcile(RECONCILER);
  if (r.source === null) { io.out("No price source is set: nothing was measured. Set prices.url in config.json."); return 0; }
  io.out(`Measured ${r.measured}, closed ${r.closed}, still due ${r.stillDue}, refused ${r.refused.length}, unmeasured ${r.unmeasured.length}.`);
  for (const x of r.refused) io.out(`  refused: ${one(x.symbol)} in ${one(x.market)}: ${one(x.why)}`);
  for (const x of r.unmeasured) io.out(`  unmeasured: ${one(x.decision)}: ${x.why}`);
  return 0;
}

async function verify(io: Io, memory: Memory, json: boolean): Promise<number> {
  const v = await memory.verify();
  if (json) { io.out(jsonText(v)); return v.ok ? 0 : 1; }
  if (v.ok) { io.out("Sound: every chain holds, every id a line points at is there, no armed card is broken."); return 0; }
  const out = ["Not sound:"];
  for (const ch of v.chains) if (!ch.ok) out.push(`  ${ch.file}: the chain breaks at line ${ch.line ?? "?"}`);
  for (const d of v.dangling) out.push(`  ${d.file} line ${d.line}: points at ${one(d.points_at)}, which is not there`);
  for (const c of v.cards) if (c.state === "broken") out.push(`  lesson ${one(c.id)} is broken: ${one(c.fault ?? "")}`);
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

function checkReason(reason: string): void {
  if ([...reason].length > REASON_MAX) throw new MemoryError("E_INPUT", `reason must hold 1 to ${REASON_MAX} characters.`);
}

async function readText(path: string): Promise<string | null> {
  return (await readBytes(path))?.toString("utf8") ?? null;
}

async function readBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return null;
    throw err;
  }
}

/** Lines only in the armed copy marked "-", lines only in the working file's text (as read) marked "+". */
async function difference(home: string, s: CardState, working: string | null): Promise<string> {
  const armed = s.sha256 ? await readText(armedPath(home, s.id, s.sha256)) : null;
  const linesOf = (t: string | null) => (t ?? "").replaceAll("\r\n", "\n").split("\n").filter((l, i, all) => i < all.length - 1 || l !== "");
  const a = linesOf(armed);
  const w = linesOf(working);
  const only = (xs: string[], ys: string[]) => {
    const left = new Map<string, number>();
    for (const y of ys) left.set(y, (left.get(y) ?? 0) + 1);
    return xs.filter((x) => { const n = left.get(x) ?? 0; if (n > 0) { left.set(x, n - 1); return false; } return true; });
  };
  const out = [...only(a, w).map((l) => `${FENCE}- ${l}`), ...only(w, a).map((l) => `${FENCE}+ ${l}`)];
  if (armed === null) out.unshift("(its armed copy is missing)");
  if (working === null) out.unshift(`(lessons/${one(s.id)}.md is gone)`);
  return out.length > 0 ? out.join("\n") : "(no line differs; the bytes do, such as line ends)";
}

function pct(n: number | null): string {
  return n === null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function figuresText(figures: Figure[]): string {
  if (figures.length === 0) return "none";
  return figures.map((f) => `${f.k}d ${pct(f.change_pct)}${f.vs_benchmark_pct !== null ? ` (${pct(f.vs_benchmark_pct)} vs benchmark)` : ""}`).join(", ");
}

const BASE = new Set(["v", "kind", "id", "seq", "prev", "t", "by", "sum"]);

/** A line's own fields, each a labelled value (a JSON value on one line), indented by `indent`. */
function fieldLines(obj: object, skip: Set<string>, indent: string): string[] {
  return Object.entries(obj).filter(([k]) => !skip.has(k)).flatMap(([k, v]) => {
    const [head, ...rest] = field(`${indent}${one(k)}`, typeof v === "string" ? v : JSON.stringify(v));
    return [head!, ...rest];
  });
}

function decisionLines(v: DecisionView): string[] {
  const l = v.line;
  const on = l.symbol !== undefined ? ` ${one(l.symbol)}${l.market !== undefined ? ` in ${one(l.market)}` : ""}` : "";
  const out = [`Decision ${one(l.id)}${v.void ? " (void)" : ""}: ${one(l.action)}${on}, whose ${one(l.whose)}, registered ${one(l.t)} by ${one(l.by)}`,
    ...fieldLines(l, new Set([...BASE, "action", "whose", "symbol", "market"]), "  ")];
  if (v.amends.length > 0) {
    out.push("Amendments:");
    for (const a of v.amends) {
      out.push(`  ${one(a.id)} ${one(a.t)} by ${one(a.by)}: ${one(a.what)}`, ...fieldLines(a, new Set([...BASE, "decision", "what"]), "    "));
    }
  }
  return out;
}

function recordLines(r: CardRecord): string[] {
  const o = r.owner;
  const cases = (name: string, xs: CardRecord["followed"]) =>
    xs.length === 0 ? [] : [`${name}: ${xs.map((c) => one(`${c.decision} ${c.date} ${c.action}${c.symbol ? ` ${c.symbol}` : ""}`)).join("; ")}`];
  const medians = (name: string, m: Record<number, number>) => {
    const ks = Object.keys(m);
    return ks.length === 0 ? [] : [`median ${name}: ${ks.map((k) => `${k}d ${pct(m[Number(k)] ?? null)}`).join(", ")}`];
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
    for (const f of s.facts) out.push(`  ${one(f.fact)} (${one(f.card)}): ${one(f.definition)}`);
  }
  if (s.tags.length > 0) out.push(`Tags: ${s.tags.map((t) => `${one(t.tag)} ${t.count}`).join(", ")}`);
  if (s.prices.url === "") {
    out.push("Prices: no price source: set prices.url in config.json");
  } else {
    const last = s.prices.last;
    out.push(`Prices: ${one(s.prices.url)}${last ? `; last reconcile ${one(last.t)}, ${last.ok ? "answered" : "did not answer"}, ${last.refused} refused` : "; never reconciled"}`);
  }
  return out;
}

function pastLine(p: PastDecision): string {
  return `${one(`${p.id} ${p.date} ${p.action}${p.symbol ? ` ${p.symbol}` : ""}, whose ${p.whose}`)}: ${figuresText(p.figures)}`;
}

function reviewLines(r: Review): string[] {
  const out = [Date.parse(r.since) === 0 ? "Review, from the start" : `Review since ${r.since}`, ""];
  out.push(`Decisions measured: ${r.measured.length}`, ...r.measured.map((p) => `  ${pastLine(p)}`));
  out.push(`Lessons with a record: ${r.cards.length}`);
  for (const c of r.cards) {
    const flags = [c.quiet ? "quiet" : "", c.overridden_often ? "overridden often" : ""].filter(Boolean);
    out.push(`  ${one(c.id)}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`, ...recordLines(c.record).map((l) => `    ${l}`));
  }
  if (r.tags_shared.length > 0) {
    out.push("Tags shared by several decisions:", ...r.tags_shared.map((t) => `  ${one(t.tag)}: ${one(t.decisions.join(", "))}`));
  }
  out.push(`Past their horizon, without a review: ${r.past_horizon.length === 0 ? "none" : one(r.past_horizon.join(", "))}`);
  out.push(`Decisions without wrong_if: ${r.without_wrong_if}`);
  if (r.voided.length > 0) out.push(`Voided: ${one(r.voided.map((x) => `${x.decision} by ${x.by}`).join(", "))}`);
  out.push(`Proposals waiting: ${r.proposals.length}`);
  return out;
}

function proposalLines(p: ProposalLine): string[] {
  const verb = p.what === "new" ? "add" : p.what;
  const out = [`Proposal ${one(`${p.id} by ${p.by}, ${p.t}: ${verb} lesson ${p.lesson}`)}`];
  if (p.card) out.push("", fence(renderCard(p.card).trimEnd()), "");
  out.push(...field("Reason", p.reason));
  if (p.evidence && p.evidence.length > 0) out.push(`Evidence: ${p.evidence.map(one).join(", ")}`);
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
    process.stderr.write(`gravit-memory failed: ${visible(one(err instanceof Error ? err.message : String(err)))}\n`);
    process.exitCode = 1;
  });
}
