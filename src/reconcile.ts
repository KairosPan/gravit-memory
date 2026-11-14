// src/reconcile.ts — reading the bars of every decision that may have something to measure, and appending its lines
//
// Each market-and-symbol pair is read once per reconcile, and each market's benchmark once, so every figure of one
// reconcile for one symbol comes from one answer of the source. Whether the source last answered is kept in
// last-reconcile.json (D-j), a plain file that is overwritten, not a ledger, with the number of requests the run made:
// a run that asked the source, answered or refused, starts an interval (prices.every_minutes, 60 when absent) within
// which the next run that would ask the same source reads nothing and writes nothing, unless it is forced.
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkAgent, readDecisions, type DecisionView } from "./decisions.js";
import { readConfig } from "./home.js";
import { appendLine, readLog, type Fields, type LogRead } from "./log.js";
import { measure, targetDate, weekdaysGone, type Series } from "./outcomes.js";
import { RECONCILE_EVERY_MINUTES } from "./limits.js";
import { LATEST_BARS, LONGER_BARS, readDaily } from "./prices.js";
import type { Config, Deps, MarketConfig, OutcomeBody, OutcomeLine, ResealLine } from "./types.js";

/** One line this run appended: a horizon's k and change_pct, a leg's leg_pct (null when not taken), a closed line neither. */
export interface Written { decision: string; symbol: string; what: "leg" | "horizon" | "closed"; k?: number; pct?: number | null }

export interface ReconcileReport { source: string | null; measured: number; closed: number; stillDue: number;
  refused: Array<{ market: string; symbol: string; why: string }>; unmeasured: Array<{ decision: string; why: "no symbol" | "no market" }>;
  written: Written[]; fresh?: { asked_at: string; again_after: string; refused: number } }

/** What last-reconcile.json holds: asked is absent in a file v0.1 wrote; source is the run's, as `sourceOf` gives it. */
export interface Last { t: string; ok: boolean; refused: number; asked?: number; source?: string | null }

/** A reader of daily bars shaped as readDaily; the one reconcile passes counts each request it makes. */
type Reader = (...args: Parameters<typeof readDaily>) => ReturnType<typeof readDaily>;

/** A decision with something left to measure, in a market config.json names. */
interface Pending { view: DecisionView; market: string; symbol: string; m: MarketConfig; have: OutcomeLine[] }

const LAST_FILE = "last-reconcile.json";

/** The outcome lines of outcomes.jsonl, and the file's read. */
export async function readOutcomes(home: string): Promise<LogRead<OutcomeLine>> {
  const log = await readLog<OutcomeLine | ResealLine>(home, "outcomes.jsonl");
  return { ...log, lines: log.lines.filter((l): l is OutcomeLine => l.kind === "outcome") };
}

/**
 * Asks the price source for the bars of every decision with something left to measure and appends what they
 * measure, as `by`, an agent. A source that refuses a symbol writes nothing for it this time; one that refuses its
 * market's benchmark holds back the market's horizons, not its price legs or closed lines. Within the interval of
 * the last run that asked the source, the run is fresh: it reads nothing, writes nothing and says when it may ask
 * again, unless opts.force is set.
 */
export async function reconcile(home: string, by: string, deps: Deps, opts?: { force?: boolean }): Promise<ReconcileReport> {
  checkAgent(by);
  const cfg = await readConfig(home);
  const nowMs = (deps.now ?? Date.now)();
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const { views } = await readDecisions(home);
  const { pending, unmeasured } = sortOut(views, (await readOutcomes(home)).lines, cfg);
  const source = sourceOf(cfg);
  const report: ReconcileReport = { source, measured: 0, closed: 0, stillDue: 0, refused: [], unmeasured, written: [] };

  const fresh = source !== null && opts?.force !== true ? freshness(await lastReconcile(home), source, nowMs, cfg) : undefined;
  if (fresh !== undefined) {
    report.stillDue = countDue(pending, nowMs, cfg.horizons);
    return { ...report, fresh };
  }

  let asked = 0;
  const read: Reader = (...args) => { asked++; return readDaily(...args); };
  if (source !== null) {
    const byMarket = new Map<string, Pending[]>();
    for (const p of pending) byMarket.set(p.market, [...(byMarket.get(p.market) ?? []), p]);
    for (const [market, list] of byMarket) {
      for (const [p, bodies] of await measureMarket(cfg, market, list, fetchImpl, read, report)) {
        for (const body of bodies) {
          await appendLine<OutcomeLine>(home, "outcomes.jsonl", by, nowMs, "o",
            { kind: "outcome", decision: p.view.line.id, ...body } as Fields<OutcomeLine>);
          report.written.push(writtenOf(p, body));
          if (body.what === "closed") report.closed++;
          else report.measured++;
        }
      }
    }
  }

  report.stillDue = countDue(sortOut(views, (await readOutcomes(home)).lines, cfg).pending, nowMs, cfg.horizons);
  await writeLast(home, { t: new Date(nowMs).toISOString(), source, ok: source !== null && report.refused.length === 0,
    refused: report.refused.length, asked });
  return report;
}

/** The price source a run asks: config.json's prices.url without its trailing slashes, or null when none is set. */
export function sourceOf(cfg: Config): string | null {
  return cfg.prices.url === "" ? null : cfg.prices.url.replace(/\/+$/, "");
}

/**
 * What last-reconcile.json says of the last reconcile, or undefined when there is none or it is not what a reconcile
 * writes: t a time (given back as an ISO time), ok a boolean, refused and asked (absent in a file v0.1 wrote)
 * whole numbers from 0, source a string, null or absent.
 */
export async function lastReconcile(home: string): Promise<Last | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(home, LAST_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const { t, ok, refused, asked, source } = raw as Record<string, unknown>;
  const count = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
  const ms = typeof t === "string" ? Date.parse(t) : NaN;
  if (Number.isNaN(ms) || typeof ok !== "boolean" || !count(refused)) return undefined;
  if (asked !== undefined && !count(asked)) return undefined;
  if (source !== undefined && source !== null && typeof source !== "string") return undefined;
  return { t: new Date(ms).toISOString(), ok, refused, ...(asked !== undefined ? { asked } : {}),
    ...(source !== undefined ? { source } : {}) };
}

/**
 * When the last run asked this same source at least once and its time is no later than now and less than the
 * interval before it, that run's time, the time a run may ask again and what it was refused; else undefined. An
 * interval of 0 holds nothing back.
 */
function freshness(last: Last | undefined, source: string | null, nowMs: number, cfg: Config): ReconcileReport["fresh"] {
  const intervalMs = (cfg.prices.every_minutes ?? RECONCILE_EVERY_MINUTES) * 60_000;
  if (intervalMs <= 0 || last === undefined || last.asked === undefined || last.asked < 1 || last.source !== source) return undefined;
  const askedMs = Date.parse(last.t);
  if (nowMs - askedMs < 0 || nowMs - askedMs >= intervalMs) return undefined;
  return { asked_at: new Date(askedMs).toISOString(), again_after: new Date(askedMs + intervalMs).toISOString(),
    refused: last.refused };
}

/** The entry of `written` for one line appended for p. */
function writtenOf(p: Pending, body: OutcomeBody): Written {
  const at = { decision: p.view.line.id, symbol: p.symbol };
  if (body.what === "horizon") return { ...at, what: "horizon", k: body.k, pct: body.change_pct };
  if (body.what === "leg") return { ...at, what: "leg", pct: body.leg_pct };
  return { ...at, what: "closed" };
}

/**
 * How many decisions have a horizon unmeasured that may be due by now (D-i), from the files alone: no bars are read.
 */
export async function mayBeDue(home: string, nowMs: number): Promise<number | "no price source"> {
  const cfg = await readConfig(home);
  if (cfg.prices.url === "") return "no price source";
  const { views } = await readDecisions(home);
  return countDue(sortOut(views, (await readOutcomes(home)).lines, cfg).pending, nowMs, cfg.horizons);
}

/**
 * Reads one market's symbols, each once (a US-style venue once more with the longer limit when a decision's day 0
 * is not among the bars), then its benchmark once when a horizon line would carry it, and measures each decision.
 * Refusals go to the report; a refused symbol's decisions get nothing, a refused benchmark's no horizon.
 */
async function measureMarket(cfg: Config, market: string, list: Pending[], fetchImpl: typeof fetch, read: Reader,
  report: ReconcileReport): Promise<Array<[Pending, ReturnType<typeof measure>]>> {
  const m = list[0]!.m;
  const reads = new Map<string, { series: Series; limit: number }>();
  for (const symbol of new Set(list.map((p) => p.symbol))) {
    let limit = LATEST_BARS;
    let got = await read(cfg, market, symbol, fetchImpl);
    if (!("refused" in got) && m.venue !== "china" && list.some((p) => p.symbol === symbol && beyond(p, got as Series))) {
      limit = LONGER_BARS;
      got = await read(cfg, market, symbol, fetchImpl, { limit });
    }
    if ("refused" in got) report.refused.push({ market, symbol, why: got.refused });
    else reads.set(symbol, { series: got, limit });
  }

  const ready = list.filter((p) => reads.has(p.symbol));
  let bench: { symbol: string; series: Series } | null = null;
  if (m.benchmark !== undefined) {
    const carry = ready.filter((p) => measure(p.view.line, m, reads.get(p.symbol)!.series, null, cfg.horizons, p.have)
      .some((b) => b.what === "horizon"));
    if (carry.length > 0) {
      const limit = Math.max(...carry.map((p) => reads.get(p.symbol)!.limit));
      const kept = reads.get(m.benchmark);
      if (kept && kept.limit >= limit) {
        bench = { symbol: m.benchmark, series: kept.series };
      } else {
        const got = await read(cfg, market, m.benchmark, fetchImpl, { limit });
        if ("refused" in got) {
          report.refused.push({ market, symbol: m.benchmark, why: got.refused });
          // No horizon goes without its benchmark; a price leg or a closed line needs none.
          return ready.map((p) => [p, measure(p.view.line, m, reads.get(p.symbol)!.series, null, cfg.horizons, p.have)
            .filter((b) => b.what !== "horizon")]);
        }
        bench = { symbol: m.benchmark, series: got };
        if (kept) reads.set(m.benchmark, { series: got, limit });      // one answer for the symbol, its own figures too
      }
    }
  }
  return ready.map((p) => [p, measure(p.view.line, m, reads.get(p.symbol)!.series, bench, cfg.horizons, p.have)]);
}

/** Whether p's day 0 is earlier than the first bar of the series. */
function beyond(p: Pending, series: Series): boolean {
  const first = series.bars[0];
  return first !== undefined && targetDate(p.view.decidedMs, p.m) < first.date;
}

/**
 * The decisions with something left to measure, and those that cannot be measured at all. A void decision is
 * neither; nor is one with a "closed" line or with every horizon measured and its leg taken.
 */
function sortOut(views: DecisionView[], outcomes: OutcomeLine[], cfg: Config): { pending: Pending[];
  unmeasured: ReconcileReport["unmeasured"] } {
  const byDecision = new Map<string, OutcomeLine[]>();
  for (const line of outcomes) byDecision.set(line.decision, [...(byDecision.get(line.decision) ?? []), line]);
  const pending: Pending[] = [];
  const unmeasured: ReconcileReport["unmeasured"] = [];
  for (const view of views) {
    if (view.void) continue;
    const { id, symbol, market } = view.line;
    if (symbol === undefined) { unmeasured.push({ decision: id, why: "no symbol" }); continue; }
    const m = market === undefined ? undefined : cfg.prices.markets[market];
    if (market === undefined || m === undefined) { unmeasured.push({ decision: id, why: "no market" }); continue; }
    const have = byDecision.get(id) ?? [];
    if (have.some((l) => l.what === "closed")) continue;
    const legDue = view.line.price !== undefined && !have.some((l) => l.what === "leg");
    if (!legDue && unmeasuredHorizons(have, cfg.horizons).length === 0) continue;
    pending.push({ view, market, symbol, m, have });
  }
  return { pending, unmeasured };
}

/** The pending decisions with an unmeasured horizon k whose weekdays gone are at least k + 1 (D-i). */
function countDue(pending: Pending[], nowMs: number, horizons: number[]): number {
  return pending.filter((p) => {
    const gone = weekdaysGone(p.view.decidedMs, nowMs, p.m.zone);
    return unmeasuredHorizons(p.have, horizons).some((k) => gone >= k + 1);
  }).length;
}

function unmeasuredHorizons(have: OutcomeLine[], horizons: number[]): number[] {
  return horizons.filter((k) => !have.some((l) => l.what === "horizon" && l.k === k));
}

async function writeLast(home: string, last: { t: string; source: string | null; ok: boolean; refused: number; asked: number }): Promise<void> {
  const file = join(home, LAST_FILE);
  await writeFile(file, `${JSON.stringify(last)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(file, 0o600);
}
