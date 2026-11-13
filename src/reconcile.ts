// src/reconcile.ts — reading the bars of every decision that may have something to measure, and appending its lines
//
// Each market-and-symbol pair is read once per reconcile, and each market's benchmark once, so every figure of one
// reconcile for one symbol comes from one answer of the source. Whether the source last answered is kept in
// last-reconcile.json (D-j), a plain file that is overwritten, not a ledger.
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readDecisions, type DecisionView } from "./decisions.js";
import { readConfig } from "./home.js";
import { appendLine, readLog, type Fields, type LogRead } from "./log.js";
import { measure, targetDate, weekdaysGone, type Series } from "./outcomes.js";
import { LATEST_BARS, LONGER_BARS, readDaily } from "./prices.js";
import type { Config, Deps, MarketConfig, OutcomeLine, ResealLine } from "./types.js";

export interface ReconcileReport { source: string | null; measured: number; closed: number; stillDue: number;
  refused: Array<{ market: string; symbol: string; why: string }>; unmeasured: Array<{ decision: string; why: "no symbol" | "no market" }> }

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
 * measure, as `by`. A source that refuses a symbol, or its market's benchmark, writes nothing for it this time.
 */
export async function reconcile(home: string, by: string, deps: Deps): Promise<ReconcileReport> {
  const cfg = await readConfig(home);
  const nowMs = (deps.now ?? Date.now)();
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const { views } = await readDecisions(home);
  const { pending, unmeasured } = sortOut(views, (await readOutcomes(home)).lines, cfg);
  const source = cfg.prices.url === "" ? null : cfg.prices.url.replace(/\/+$/, "");
  const report: ReconcileReport = { source, measured: 0, closed: 0, stillDue: 0, refused: [], unmeasured };

  if (source !== null) {
    const byMarket = new Map<string, Pending[]>();
    for (const p of pending) byMarket.set(p.market, [...(byMarket.get(p.market) ?? []), p]);
    for (const [market, list] of byMarket) {
      for (const [p, bodies] of await measureMarket(cfg, market, list, fetchImpl, report)) {
        for (const body of bodies) {
          await appendLine<OutcomeLine>(home, "outcomes.jsonl", by, nowMs, "o",
            { kind: "outcome", decision: p.view.line.id, ...body } as Fields<OutcomeLine>);
          if (body.what === "closed") report.closed++;
          else report.measured++;
        }
      }
    }
  }

  report.stillDue = countDue(sortOut(views, (await readOutcomes(home)).lines, cfg).pending, nowMs, cfg.horizons);
  await writeLast(home, { t: new Date(nowMs).toISOString(), source, ok: source !== null && report.refused.length === 0,
    refused: report.refused.length });
  return report;
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
 * Refusals go to the report; the decisions they hold back get nothing.
 */
async function measureMarket(cfg: Config, market: string, list: Pending[], fetchImpl: typeof fetch,
  report: ReconcileReport): Promise<Array<[Pending, ReturnType<typeof measure>]>> {
  const m = list[0]!.m;
  const reads = new Map<string, { series: Series; limit: number }>();
  for (const symbol of new Set(list.map((p) => p.symbol))) {
    let limit = LATEST_BARS;
    let got = await readDaily(cfg, market, symbol, fetchImpl);
    if (!("refused" in got) && m.venue !== "china" && list.some((p) => p.symbol === symbol && beyond(p, got as Series))) {
      limit = LONGER_BARS;
      got = await readDaily(cfg, market, symbol, fetchImpl, { limit });
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
        const got = await readDaily(cfg, market, m.benchmark, fetchImpl, { limit });
        if ("refused" in got) {
          report.refused.push({ market, symbol: m.benchmark, why: got.refused });
          return [];                                                   // no horizon goes without its benchmark
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

async function writeLast(home: string, last: { t: string; source: string | null; ok: boolean; refused: number }): Promise<void> {
  const file = join(home, LAST_FILE);
  await writeFile(file, `${JSON.stringify(last)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(file, 0o600);
}
