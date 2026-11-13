// src/index.ts — the core as one object, the one both doors (the MCP server, the command line) are built on
//
// An agent's methods take its name, `by`, and refuse "owner"; the owner's acts are reached only through
// Memory.owner and write as "owner". Every method first checks that the home is a memory. Nothing but the clock
// and the fetch lives in the object; everything else is read from the home at each call.
import { cardStates, type CardState } from "./cards.js";
import { amendDecision, checkAgent, readDecisions, recordDecision, type DecisionView } from "./decisions.js";
import { MemoryError } from "./errors.js";
import { FILES, assertHome, readConfig } from "./home.js";
import { readLog, resealLog } from "./log.js";
import { arm, discard, retire } from "./owner.js";
import { accept, edit, propose, reject } from "./proposals.js";
import { recall, type RecallAnswer } from "./recall.js";
import { readOutcomes, reconcile, type ReconcileReport } from "./reconcile.js";
import { cardRecord, figuresOf, occasionsOf, type CardRecord, type Figure } from "./records.js";
import { review, status, type Review, type Status } from "./review.js";
import type { AmendLine, DecisionLine, Deps, LogFile, ProposalLine, RecallLine, ResealLine } from "./types.js";
import { verify, type VerifyReport } from "./verify.js";

export * from "./home.js";
export * from "./types.js";
export * from "./errors.js";
export * from "./limits.js";
export type { CardState } from "./cards.js";
export type { AmendInput, DecisionInput, DecisionView } from "./decisions.js";
export type { Need } from "./match.js";
export type { ProposalInput } from "./proposals.js";
export type { AppliedCard, House, PastDecision, RecallAnswer, RecallInput, UntoldCard } from "./recall.js";
export type { ReconcileReport } from "./reconcile.js";
export type { Case, CardRecord, Figure } from "./records.js";
export type { Review, Status } from "./review.js";
export type { VerifyReport } from "./verify.js";

export interface Memory {
  home: string;
  recall(by: string, input: unknown): Promise<RecallAnswer>;
  record(by: string, input: unknown): Promise<DecisionLine>;
  amend(by: string, input: unknown): Promise<AmendLine>;
  propose(by: string, input: unknown): Promise<ProposalLine>;
  reconcile(by: string): Promise<ReconcileReport>;
  review(since?: string): Promise<Review>;
  status(): Promise<Status>;
  verify(): Promise<VerifyReport>;
  show(id: string): Promise<{ decision: DecisionView; figures: Figure[] } | { card: CardState; record: CardRecord | null }>;
  owner: { arm(lesson: string): Promise<{ sha256: string }>; retire(lesson: string, reason: string): Promise<void>;
    discard(lesson: string): Promise<void>; void(decision: string, reason: string): Promise<void>;
    reseal(): Promise<Array<{ file: LogFile; broke_at: number }>>;
    accept(proposal: string): Promise<{ lesson: string }>; edit(proposal: string): Promise<{ lesson: string; path: string }>;
    reject(proposal: string, reason: string): Promise<void> };
}

/** The memory in the home, with the clock and the fetch it is given (the system's when none). */
export function openMemory(home: string, deps?: Deps): Memory {
  const now = deps?.now ?? Date.now;
  const fetchImpl = deps?.fetch ?? globalThis.fetch;
  const d: Deps = { now, fetch: fetchImpl };

  /** Checks the home, then the agent's name, then runs fn. */
  const asAgent = async <T>(by: string, fn: () => Promise<T>): Promise<T> => {
    await assertHome(home);
    checkAgent(by);
    return fn();
  };
  /** Checks the home, then runs fn. */
  const inHome = async <T>(fn: () => Promise<T>): Promise<T> => {
    await assertHome(home);
    return fn();
  };

  return {
    home,
    recall: (by, input) => asAgent(by, () => recall(home, by, input, d)),
    record: (by, input) => asAgent(by, () => recordDecision(home, by, input, now())),
    amend: (by, input) => asAgent(by, () => amendDecision(home, by, input, now())),
    propose: (by, input) => asAgent(by, () => propose(home, by, input, now())),
    reconcile: (by) => asAgent(by, () => reconcile(home, by, d)),
    review: (since) => inHome(() => review(home, since, d)),
    status: () => inHome(() => status(home)),
    verify: () => inHome(() => verify(home)),
    show: (id) => inHome(() => show(home, id, now())),
    owner: {
      arm: (lesson) => inHome(() => arm(home, lesson, now())),
      retire: (lesson, reason) => inHome(() => retire(home, lesson, reason, now())),
      discard: (lesson) => inHome(() => discard(home, lesson, now())),
      void: (decision, reason) => inHome(async () => {
        await amendDecision(home, "owner", { decision, what: "void", reason }, now());
      }),
      reseal: () => inHome(async () => {
        const resealed: Array<{ file: LogFile; broke_at: number }> = [];
        for (const file of Object.values(FILES)) {
          const r = await resealLog(home, file, now());
          if (r !== null) resealed.push({ file, broke_at: r.broke_at });
        }
        return resealed;
      }),
      accept: (proposal) => inHome(() => accept(home, proposal, now())),
      edit: (proposal) => inHome(() => edit(home, proposal, now())),
      reject: (proposal, reason) => inHome(() => reject(home, proposal, reason, now())),
    },
  };
}

const DECISION_ID = /^d-\d{8}-[0-9a-f]{8}$/;

/** A decision with its amendments and its figures, when the id is a decision's; else a card with its record. */
async function show(home: string, id: string, nowMs: number): Promise<Awaited<ReturnType<Memory["show"]>>> {
  const cfg = await readConfig(home);
  const { views } = await readDecisions(home);
  const outcomes = (await readOutcomes(home)).lines;
  if (DECISION_ID.test(id)) {
    const decision = views.find((v) => v.line.id === id);
    if (!decision) throw new MemoryError("E_NOT_FOUND", `decision ${id} is not in the memory.`);
    return { decision, figures: figuresOf(id, outcomes, cfg.horizons) };
  }
  const card = (await cardStates(home)).cards.find((c) => c.id === id);
  if (!card) throw new MemoryError("E_NOT_FOUND", `lesson ${id} is not a card in the memory.`);
  if (card.card === undefined) return { card, record: null };
  const recalls = (await readLog<RecallLine | ResealLine>(home, "recalls.jsonl")).lines
    .filter((l): l is RecallLine => l.kind === "recall");
  return { card, record: cardRecord(card.card, occasionsOf(recalls), views, outcomes, cfg.horizons, nowMs) };
}
