// src/records.ts — occasions, and each lesson card's record of them
//
// Pure: the recalls, decisions and outcomes are read by the caller, and the only clock is the `nowMs` it passes.
// A card's counts are of occasions, not of questions; the memory computes no "right" or "wrong".
import type { DecisionView } from "./decisions.js";
import { MEDIAN_FROM, NO_DECISION_MS, OCCASION_MS } from "./limits.js";
import type { Action, Card, OutcomeLine, RecallLine, Whose } from "./types.js";

/** Recalls taken as one occasion; its id is its first recall's, `cards` the cards that applied in any of them. */
export interface Occasion { id: string; firstMs: number; symbol?: string; recalls: RecallLine[]; cards: string[] }
/** What the instrument did by horizon k: null where it is not measured. */
export interface Figure { k: number; change_pct: number | null; vs_benchmark_pct: number | null }
export interface Case { decision: string; date: string; symbol?: string; action: Action; figures: Figure[] }
export interface CardRecord {
  owner: { fired: number; followed: number; overridden: number; seen: number; backfilled: number; no_decision: number };
  agents: { followed: number; overridden: number; seen: number };
  followed: Case[]; overridden: Case[]; backfilled: Case[];
  /** A horizon is given only from MEDIAN_FROM measured cases. */
  medians: { followed: Record<number, number>; overridden: Record<number, number> };
}

/**
 * Folds recalls into occasions: on one symbol, every recall within 24 hours of the occasion's first, whoever asked;
 * with no symbol, the same agent's recalls with the same `considering`, in any order, within the same window.
 */
export function occasionsOf(recalls: RecallLine[]): Occasion[] {
  const ordered = recalls.map((r, i) => ({ r, i, ms: Date.parse(r.t) })).sort((a, b) => a.ms - b.ms || a.i - b.i);
  const occasions: Occasion[] = [];
  const open = new Map<string, Occasion>();
  for (const { r, ms } of ordered) {
    const key = r.symbol !== undefined
      ? `symbol\u0000${r.symbol}`
      : `agent\u0000${r.by}\u0000${[...new Set(r.considering)].sort().join(",")}`;
    let occasion = open.get(key);
    if (occasion === undefined || ms - occasion.firstMs > OCCASION_MS) {
      occasion = { id: r.id, firstMs: ms, ...(r.symbol !== undefined ? { symbol: r.symbol } : {}), recalls: [], cards: [] };
      occasions.push(occasion);
      open.set(key, occasion);
    }
    occasion.recalls.push(r);
    for (const card of r.applied) if (!occasion.cards.includes(card)) occasion.cards.push(card);
  }
  return occasions;
}

/**
 * One figure per horizon, in order, from the first horizon line for the decision and k and its first leg line: the
 * change compounds the leg when one was taken, else it is the horizon line's own. A line whose numbers are not finite
 * numbers (one written by hand) is no measurement: a horizon line whose change is not one, or a leg line whose leg is
 * neither null nor one, is passed over as if it were not there; a benchmark figure that is not one is null.
 */
export function figuresOf(decision: string, outcomes: OutcomeLine[], horizons: number[]): Figure[] {
  let leg: number | null = null;
  const byK = new Map<number, { change_pct: number; vs_benchmark_pct: number | null }>();
  let legSeen = false;
  for (const o of outcomes) {
    if (o.kind !== "outcome" || o.decision !== decision) continue;
    if (o.what === "leg" && !legSeen && (o.leg_pct === null || isFigure(o.leg_pct))) {
      legSeen = true;
      leg = o.leg_pct;
    } else if (o.what === "horizon" && !byK.has(o.k) && isFigure(o.change_pct)) {
      byK.set(o.k, { change_pct: o.change_pct, vs_benchmark_pct: isFigure(o.vs_benchmark_pct) ? o.vs_benchmark_pct : null });
    }
  }
  return horizons.map((k) => {
    const h = byK.get(k);
    if (h === undefined) return { k, change_pct: null, vs_benchmark_pct: null };
    const change = leg === null ? h.change_pct : round2(((1 + leg / 100) * (1 + h.change_pct / 100) - 1) * 100);
    return { k, change_pct: isFigure(change) ? change : null, vs_benchmark_pct: h.vs_benchmark_pct };
  });
}

/** Whether a value read from a line is a finite number. */
function isFigure(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * A card's record over the occasions it fired in. Each side is settled by its own earliest non-void decision that
 * names a recall of the occasion: the owner's (`whose: "owner"`) and the agents' (`whose: "agent"`). A backfilled
 * decision of the owner's settles as backfilled; one of an agent's settles nothing. A correction changes nothing:
 * the decision's own action is read.
 */
export function cardRecord(card: Card, occasions: Occasion[], decisions: DecisionView[], outcomes: OutcomeLine[],
  horizons: number[], nowMs: number): CardRecord {
  const rec: CardRecord = {
    owner: { fired: 0, followed: 0, overridden: 0, seen: 0, backfilled: 0, no_decision: 0 },
    agents: { followed: 0, overridden: 0, seen: 0 },
    followed: [], overridden: [], backfilled: [],
    medians: { followed: {}, overridden: {} },
  };

  for (const occasion of occasions) {
    if (!occasion.cards.includes(card.id)) continue;
    rec.owner.fired += 1;
    const ids = new Set(occasion.recalls.map((r) => r.id));
    const settling = (whose: Whose, skipBackfilled: boolean): DecisionView | undefined =>
      decisions.find((d) => !d.void && d.line.whose === whose && d.line.recall !== undefined && ids.has(d.line.recall)
        && !(skipBackfilled && d.line.backfilled === true));

    const owner = settling("owner", false);
    if (owner === undefined) {
      if (nowMs - occasion.firstMs > NO_DECISION_MS) rec.owner.no_decision += 1;
    } else if (owner.line.backfilled === true) {
      rec.owner.backfilled += 1;
      rec.backfilled.push(caseOf(owner, outcomes, horizons));
    } else {
      const verdict = verdictOf(card, owner.line.action);
      rec.owner[verdict] += 1;
      if (verdict !== "seen") rec[verdict].push(caseOf(owner, outcomes, horizons));
    }

    const agent = settling("agent", true);
    if (agent !== undefined) rec.agents[verdictOf(card, agent.line.action)] += 1;
  }

  rec.medians.followed = mediansOf(rec.followed, horizons);
  rec.medians.overridden = mediansOf(rec.overridden, horizons);
  return rec;
}

function verdictOf(card: Card, action: Action): "followed" | "overridden" | "seen" {
  if (card.says === "careful") return "seen";
  const named = card.actions.includes(action);
  if (card.says === "dont") return named ? "overridden" : "followed";
  return named ? "followed" : "overridden";
}

function caseOf(d: DecisionView, outcomes: OutcomeLine[], horizons: number[]): Case {
  return {
    decision: d.line.id,
    date: new Date(d.decidedMs).toISOString().slice(0, 10),
    ...(d.line.symbol !== undefined ? { symbol: d.line.symbol } : {}),
    action: d.line.action,
    figures: figuresOf(d.line.id, outcomes, horizons),
  };
}

function mediansOf(cases: Case[], horizons: number[]): Record<number, number> {
  const out: Record<number, number> = {};
  horizons.forEach((k, i) => {
    const values = cases.map((c) => c.figures[i]?.change_pct).filter((v): v is number => typeof v === "number");
    if (values.length < MEDIAN_FROM) return;
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    out[k] = round2(values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2);
  });
  return out;
}

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}
