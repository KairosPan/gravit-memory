// src/decisions.ts — decisions and their amendments, both lines of decisions.jsonl
//
// A decision is never changed: what follows it (a reference, its close, a review, a correction, its void) is an
// amendment, a new line naming it. A correction is a note only; nothing computed reads it.
import { MemoryError } from "./errors.js";
import { AGENT_NAME, BACKFILL_MS, VOID_WINDOW_MS } from "./limits.js";
import { appendLine, readLog, type Fields, type LogRead } from "./log.js";
import { amendInput, decisionInput, parseInput } from "./schema.js";
import type { Action, AmendBody, AmendLine, DecisionLine, LineBase, RecallLine } from "./types.js";

export type DecisionInput = Omit<DecisionLine, keyof LineBase | "backfilled">;
export type AmendInput = { decision: string } & AmendBody;
export interface DecisionView { line: DecisionLine; amends: AmendLine[]; void: boolean; open: boolean; reviewed: boolean; decidedMs: number }

/** The actions that hold a position until a close amendment. */
const OPENS: ReadonlySet<Action> = new Set(["buy", "add", "short"]);

/** Records a decision written by the agent `by`; the owner's own decisions come through an agent, whose "owner". */
export async function recordDecision(home: string, by: string, input: unknown, nowMs: number): Promise<DecisionLine> {
  if (by === "owner") {
    throw new MemoryError("E_REFUSED", "no agent writes as the owner: write under your own name, with whose \"owner\" for the owner's decision.");
  }
  checkWriter(by);
  const data = parseInput(decisionInput, input, "a decision") as DecisionInput;

  let backfilled = false;
  if (data.decided_at !== undefined) {
    const decidedMs = Date.parse(data.decided_at);
    if (decidedMs > nowMs) throw new MemoryError("E_INPUT", "decided_at is later than the clock: a decision is not dated ahead.");
    backfilled = nowMs - decidedMs > BACKFILL_MS;
  }
  if (data.recall !== undefined) {
    const recalls = await readLog<RecallLine>(home, "recalls.jsonl");
    if (!recalls.lines.some((l) => l.kind === "recall" && l.id === data.recall)) {
      throw new MemoryError("E_NOT_FOUND", `recall ${data.recall} is not in the memory.`);
    }
  }

  const fields: Fields<DecisionLine> = { kind: "decision", ...data, ...(backfilled ? { backfilled: true as const } : {}) };
  return appendLine<DecisionLine>(home, "decisions.jsonl", by, nowMs, "d", fields);
}

/**
 * Appends an amendment to an existing decision. `by` is an agent, or "owner" when the owner's door calls. A void
 * decision takes no more amendments; a decision is voided by its writer within 24 hours, or by the owner at any time.
 */
export async function amendDecision(home: string, by: string, input: unknown, nowMs: number): Promise<AmendLine> {
  if (by !== "owner") checkWriter(by);
  const data = parseInput(amendInput, input, "an amendment") as AmendInput;

  const { views } = await readDecisions(home);
  const view = views.find((v) => v.line.id === data.decision);
  if (!view) throw new MemoryError("E_NOT_FOUND", `decision ${data.decision} is not in the memory.`);
  const id = view.line.id;
  if (view.void) throw new MemoryError("E_REFUSED", `decision ${id} is void: it takes no more amendments.`);

  if (data.what === "void" && by !== "owner") {
    if (by !== view.line.by) {
      throw new MemoryError("E_REFUSED", `decision ${id} was written by ${view.line.by}: only its writer or the owner voids it.`);
    }
    if (nowMs - Date.parse(view.line.t) > VOID_WINDOW_MS) {
      throw new MemoryError("E_REFUSED",
        `decision ${id} is more than 24 hours old: only the owner voids it now, with gravit-memory void ${id}.`);
    }
  }
  if (data.what === "close") {
    if (Date.parse(data.closed_at) > nowMs) throw new MemoryError("E_INPUT", "closed_at is later than the clock.");
    if (!view.open) {
      throw new MemoryError("E_REFUSED", `decision ${id} is not open: only an open buy, add or short is closed.`);
    }
  }

  return appendLine<AmendLine>(home, "decisions.jsonl", by, nowMs, "a", { kind: "amend", ...data } as Fields<AmendLine>);
}

/** Every decision of the file in order, each with its amendments and what they make of it, and the file's read. */
export async function readDecisions(home: string): Promise<{ views: DecisionView[]; log: LogRead<DecisionLine | AmendLine> }> {
  const log = await readLog<DecisionLine | AmendLine>(home, "decisions.jsonl");
  const amends = new Map<string, AmendLine[]>();
  for (const line of log.lines) {
    if (line.kind !== "amend") continue;
    const list = amends.get(line.decision) ?? [];
    list.push(line);
    amends.set(line.decision, list);
  }
  const views: DecisionView[] = [];
  for (const line of log.lines) {
    if (line.kind !== "decision") continue;
    const own = amends.get(line.id) ?? [];
    const isVoid = own.some((a) => a.what === "void");
    views.push({
      line,
      amends: own,
      void: isVoid,
      open: !isVoid && OPENS.has(line.action) && !own.some((a) => a.what === "close"),
      reviewed: own.some((a) => a.what === "review"),
      decidedMs: Date.parse(line.decided_at ?? line.t),
    });
  }
  return { views, log };
}

function checkWriter(by: string): void {
  if (!AGENT_NAME.test(by)) {
    throw new MemoryError("E_INPUT", "by must be an agent's name: 2 to 32 lower-case letters, digits or dashes.");
  }
}
