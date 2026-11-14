// src/review.ts — the review's material and the home's status, both read from the files alone
//
// Material, not judgement: no bars are read and no network is reached, and the only clock is the one passed in.
// `since` (an ISO date, read as UTC midnight, or an ISO time) bounds what is new: horizons measured, decisions
// recorded (for the shared tags and the count without wrong_if) and voids written since then. What stands now —
// each card's record and whether it is quiet, decisions past their own horizon, proposals waiting — is read whole.
import { z } from "zod";
import { cardStates, type CardState } from "./cards.js";
import { readDecisions, type DecisionView } from "./decisions.js";
import { MemoryError } from "./errors.js";
import { FILES, readConfig } from "./home.js";
import { OVERRIDDEN_FLAG, QUIET_CARD_MS, TAG_SHARED_FLAG } from "./limits.js";
import { readLog } from "./log.js";
import { weekdaysGone } from "./outcomes.js";
import { waitingProposals } from "./proposals.js";
import { pastOf, type PastDecision } from "./recall.js";
import { lastReconcile, readOutcomes, sourceOf } from "./reconcile.js";
import { cardRecord, isMeasurement, occasionsOf, type CardRecord } from "./records.js";
import type { Check, Config, Deps, LogFile, ProposalLine, RecallLine, ResealLine } from "./types.js";

export interface Review { since: string; measured: Array<PastDecision>; cards: Array<{ id: string; record: CardRecord; quiet: boolean; overridden_often: boolean }>;
  tags_shared: Array<{ tag: string; decisions: string[] }>; past_horizon: string[]; without_wrong_if: number;
  voided: Array<{ decision: string; by: string }>; proposals: ProposalLine[] }

export interface Status { home: string; version: 1; lines: Record<LogFile, number>; partial: LogFile[];
  chains: Array<{ file: LogFile; ok: boolean; line?: number }>; cards: CardState[];
  facts: Array<{ card: string; fact: string; definition: string; checked: Check[] }>; tags: Array<{ tag: string; count: number }>;
  prices: { url: string; last?: { t: string; ok: boolean; refused: number; asked?: number } } }

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoTime = z.iso.datetime({ offset: true });

/** The review's material since a date or a time; everything when since is absent. */
export async function review(home: string, since: string | undefined, deps: Deps): Promise<Review> {
  const sinceMs = sinceOf(since);
  const nowMs = (deps.now ?? Date.now)();
  const cfg = await readConfig(home);
  const { views } = await readDecisions(home);
  const outcomes = (await readOutcomes(home)).lines;
  const recalls = (await readLog<RecallLine | ResealLine>(home, "recalls.jsonl")).lines
    .filter((l): l is RecallLine => l.kind === "recall");
  const occasions = occasionsOf(recalls);
  const states = await cardStates(home);
  const live = views.filter((v) => !v.void);
  const after = (t: string) => Date.parse(t) >= sinceMs;

  const measuredIds = new Set(outcomes.flatMap((o) => (o.what === "horizon" && isMeasurement(o) && after(o.t) ? [o.decision] : [])));
  const cards = states.cards.flatMap((s) => {
    if (s.card === undefined) return [];
    const record = cardRecord(s.card, occasions, views, outcomes, cfg.horizons, nowMs);
    const applies = s.state === "armed" || s.state === "changed";
    const quiet = applies && s.armedAt !== undefined && nowMs - Date.parse(s.armedAt) > QUIET_CARD_MS
      && !occasions.some((o) => o.cards.includes(s.id) && nowMs - o.firstMs <= QUIET_CARD_MS);
    return [{ id: s.id, record, quiet, overridden_often: record.owner.overridden >= OVERRIDDEN_FLAG }];
  });

  const recent = live.filter((v) => after(v.line.t));
  const byTag = new Map<string, string[]>();
  for (const v of recent) for (const tag of new Set(v.line.tags ?? [])) byTag.set(tag, [...(byTag.get(tag) ?? []), v.line.id]);

  return {
    since: new Date(sinceMs).toISOString(),
    measured: live.filter((v) => measuredIds.has(v.line.id)).map((v) => pastOf(v, outcomes, cfg.horizons)),
    cards,
    tags_shared: [...byTag].filter(([, ids]) => ids.length >= TAG_SHARED_FLAG)
      .sort(([a, x], [b, y]) => y.length - x.length || (a < b ? -1 : a > b ? 1 : 0))
      .map(([tag, decisions]) => ({ tag, decisions })),
    past_horizon: live.filter((v) => pastHorizon(v, cfg, nowMs)).map((v) => v.line.id),
    without_wrong_if: recent.filter((v) => v.line.wrong_if === undefined).length,
    voided: views.flatMap((v) => v.amends.filter((a) => a.what === "void" && after(a.t))
      .map((a) => ({ decision: v.line.id, by: a.by }))),
    proposals: await waitingProposals(home),
  };
}

/** The home as it stands: its files, their chains, the cards, what the applying cards need, the tags, the prices. */
export async function status(home: string): Promise<Status> {
  const cfg = await readConfig(home);
  const lines = {} as Record<LogFile, number>;
  const partial: LogFile[] = [];
  const chains: Status["chains"] = [];
  for (const file of Object.values(FILES)) {
    const log = await readLog(home, file);
    lines[file] = log.lines.length;
    if (log.partial) partial.push(file);
    chains.push(log.chain.ok ? { file, ok: true } : { file, ok: false, line: log.chain.line });
  }

  const states = await cardStates(home);
  const facts = states.applying.flatMap((card) => Object.entries(card.facts ?? {}).map(([fact, definition]) =>
    ({ card: card.id, fact, definition, checked: (card.check ?? []).filter((ch) => ch.fact === fact) })));

  const counts = new Map<string, number>();
  for (const v of (await readDecisions(home)).views) {
    if (v.void) continue;
    for (const tag of new Set(v.line.tags ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const tags = [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0)).map(([tag, count]) => ({ tag, count }));

  // The last run is the price source's only when it asked the source set now; else the source is never asked yet.
  const read = await lastReconcile(home);
  const { source, ...last } = read ?? {};
  const ours = read !== undefined && source === sourceOf(cfg);
  return { home, version: 1, lines, partial, chains, cards: states.cards, facts, tags,
    prices: { url: cfg.prices.url, ...(ours ? { last: last as NonNullable<Status["prices"]["last"]> } : {}) } };
}

/** since as epoch milliseconds: 0 when absent; E_INPUT when it is neither an ISO date nor an ISO time. */
function sinceOf(since: string | undefined): number {
  if (since === undefined) return 0;
  const ms = DATE.test(since) ? Date.parse(`${since}T00:00:00Z`) : isoTime.safeParse(since).success ? Date.parse(since) : NaN;
  if (Number.isNaN(ms)) {
    throw new MemoryError("E_INPUT", "since must be an ISO date or time, such as 2026-03-02 or 2026-03-02T15:00:00Z.");
  }
  return ms;
}

/** A decision with a horizon, no review, and at least that many weekdays gone in its market's zone (D-i). */
function pastHorizon(v: DecisionView, cfg: Config, nowMs: number): boolean {
  const horizon = v.line.horizon;
  if (horizon === undefined || v.reviewed) return false;
  const zone = (v.line.market !== undefined ? cfg.prices.markets[v.line.market]?.zone : undefined) ?? "UTC";
  return weekdaysGone(v.decidedMs, nowMs, zone) >= horizon;
}
