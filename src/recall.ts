// src/recall.ts — what an agent asks before a decision, answered from the store alone
//
// No network and no bars: the cards as armed, the decisions, the outcomes already measured and the files' own state.
// A recall writes one line to recalls.jsonl first — every card that applied and every one it could not tell, not
// only those shown — then builds its answer from the store with that line in it, so a card's record counts this
// occasion. The same question over the same store at the same clock gets the same answer but for recall_id.
import { cardStates } from "./cards.js";
import { readDecisions, type DecisionView } from "./decisions.js";
import { MemoryError } from "./errors.js";
import { FILES, readConfig } from "./home.js";
import { AGENT_NAME, SHOW_CARDS, SHOW_LIKE, SHOW_SAME, SHOW_UNTOLD, THESIS_SHOWN } from "./limits.js";
import { appendLine, readLog } from "./log.js";
import { matchCard, type Need } from "./match.js";
import { waitingProposals } from "./proposals.js";
import { mayBeDue, readOutcomes } from "./reconcile.js";
import { cardRecord, figuresOf, occasionsOf, type CardRecord, type Figure } from "./records.js";
import { fitRecall } from "./render.js";
import { parseInput, recallInput } from "./schema.js";
import type { Action, Card, Deps, LogFile, OutcomeLine, RecallLine, ResealLine, Whose } from "./types.js";

export { FRAME, renderRecall } from "./render.js";

export type RecallInput = Pick<RecallLine, "considering" | "symbol" | "market" | "facts" | "fact_sources" | "tags" | "note">;
export interface AppliedCard { id: string; strength: Card["strength"]; says: Card["says"]; actions: Action[]; words: string; record: CardRecord }
export interface UntoldCard { id: string; needs: Need[] }
export interface PastDecision { id: string; date: string; by: string; whose: Whose; action: Action; symbol?: string; thesis: string;
  wrong_if?: string; at_entry: boolean; backfilled: boolean; figures: Figure[] }
/** `armed`: how many cards apply as armed (armed or changed since), none while the owner's chain is broken. */
export interface House { armed: number; may_be_due: number | "no price source"; proposals_waiting: number; cards_changed: string[];
  cards_broken: string[]; owner_chain_broken: boolean; chains_broken: Array<{ file: LogFile; line: number }>; partial: LogFile[] }
export interface RecallAnswer { recall_id: string; applies: AppliedCard[]; applies_more: number; untold: UntoldCard[]; untold_more: number;
  same: PastDecision[]; like: PastDecision[]; house: House; text: string }

/** Answers a question asked by the agent `by` before a decision, and leaves its one line in recalls.jsonl. */
export async function recall(home: string, by: string, input: unknown, deps: Deps): Promise<RecallAnswer> {
  const q = parseInput(recallInput, input, "a recall") as RecallInput;
  if (!AGENT_NAME.test(by)) {
    throw new MemoryError("E_INPUT", "by must be an agent's name: 2 to 32 lower-case letters, digits or dashes.");
  }
  const nowMs = (deps.now ?? Date.now)();

  const states = await cardStates(home);
  const applying: Card[] = [];
  const untold: UntoldCard[] = [];
  for (const card of states.applying) {
    const m = matchCard(card, q);
    if (m.result === "applies") applying.push(card);
    else if (m.result === "untold") untold.push({ id: card.id, needs: m.needs });
  }
  applying.sort((x, y) => rank(x) - rank(y) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  untold.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const line = await appendLine<RecallLine>(home, "recalls.jsonl", by, nowMs, "r",
    { kind: "recall", ...q, applied: applying.map((c) => c.id), untold: untold.map((u) => u.id) });

  const cfg = await readConfig(home);
  const recalls = (await readLog<RecallLine | ResealLine>(home, "recalls.jsonl")).lines
    .filter((l): l is RecallLine => l.kind === "recall");
  const { views } = await readDecisions(home);
  const outcomes = (await readOutcomes(home)).lines;
  const occasions = occasionsOf(recalls);

  const applies: AppliedCard[] = applying.map((c) => ({ id: c.id, strength: c.strength, says: c.says, actions: c.actions,
    words: c.words, record: cardRecord(c, occasions, views, outcomes, cfg.horizons, nowMs) }));

  const live = views.filter((v) => !v.void).map((v, i) => ({ v, i }))
    .sort((a, b) => b.v.decidedMs - a.v.decidedMs || b.i - a.i).map(({ v }) => v);
  const past = (v: DecisionView): PastDecision => pastOf(v, outcomes, cfg.horizons);
  const same = q.symbol === undefined ? [] : live.filter((v) => v.line.symbol === q.symbol).slice(0, SHOW_SAME).map(past);
  const tags = new Set(q.tags ?? []);
  const like = tags.size === 0 ? [] : live.filter((v) => v.line.symbol !== q.symbol
    && q.considering.includes(v.line.action) && (v.line.tags ?? []).some((t) => tags.has(t))).slice(0, SHOW_LIKE).map(past);

  const house = await houseOf(home, nowMs, states);
  const { answer, text } = fitRecall({
    recall_id: line.id,
    applies: applies.slice(0, SHOW_CARDS), applies_more: Math.max(0, applies.length - SHOW_CARDS),
    untold: untold.slice(0, SHOW_UNTOLD), untold_more: Math.max(0, untold.length - SHOW_UNTOLD),
    same, like, house,
  });
  return { ...answer, text };
}

function rank(card: Card): number {
  return card.strength === "red-line" ? 0 : 1;
}

/** A decision as a recall or a review shows it: its head, its thesis cut to THESIS_SHOWN, its figures so far. */
export function pastOf(v: DecisionView, outcomes: OutcomeLine[], horizons: number[]): PastDecision {
  const d = v.line;
  return {
    id: d.id,
    date: new Date(v.decidedMs).toISOString().slice(0, 10),
    by: d.by,
    whose: d.whose,
    action: d.action,
    ...(d.symbol !== undefined ? { symbol: d.symbol } : {}),
    thesis: [...d.thesis].slice(0, THESIS_SHOWN).join(""),
    ...(d.wrong_if !== undefined ? { wrong_if: d.wrong_if } : {}),
    at_entry: v.open && d.wrong_if !== undefined,
    backfilled: d.backfilled === true,
    figures: figuresOf(d.id, outcomes, horizons),
  };
}

async function houseOf(home: string, nowMs: number, states: Awaited<ReturnType<typeof cardStates>>): Promise<House> {
  const chains_broken: House["chains_broken"] = [];
  const partial: LogFile[] = [];
  for (const file of Object.values(FILES)) {
    const log = await readLog(home, file);
    if (!log.chain.ok) chains_broken.push({ file, line: log.chain.line });
    if (log.partial) partial.push(file);
  }

  return {
    armed: states.applying.length,
    may_be_due: await mayBeDue(home, nowMs),
    proposals_waiting: (await waitingProposals(home)).length,
    cards_changed: states.cards.filter((c) => c.state === "changed").map((c) => c.id),
    cards_broken: states.cards.filter((c) => c.state === "broken").map((c) => c.id),
    owner_chain_broken: states.ownerChainBroken,
    chains_broken,
    partial,
  };
}
