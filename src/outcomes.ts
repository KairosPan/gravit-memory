// src/outcomes.ts — what an instrument did after a decision, measured close to close from one reading of its bars
//
// No clock and no I/O: the bars come in, the lines to append go out. A source may re-adjust its past bars at any
// time, so every figure of a line comes from the one series it is given, a horizon is measured once and never
// again, and the price leg (day 0's close over the decision's own price) is taken at most once.
import { LEG_MAX_ABS_PCT, LEG_MAX_SESSIONS } from "./limits.js";
import type { DecisionLine, MarketConfig, OutcomeBody, OutcomeLine } from "./types.js";

export interface DailyBar { date: string; close: number }
/** One answer of the price source: its daily bars oldest first, the date of a provisional last bar, its words. */
export interface Series { bars: DailyBar[]; provisionalDate?: string; adjustment: string | null; source: string }

export const NOT_MEASURABLE = "not measurable from this source";

type Horizon = Extract<OutcomeBody, { what: "horizon" }>;
type Leg = Extract<OutcomeBody, { what: "leg" }>;

/**
 * The date day 0 is looked for from: the decision's date in the market's zone, or the next calendar day when it
 * was made after the market's close.
 */
export function targetDate(decidedMs: number, m: MarketConfig): string {
  const { date, time } = local(decidedMs, m.zone);
  return time > m.close ? nextDay(date) : date;
}

/**
 * The lines to append now for decision d, in order: the price leg when the decision has a price and no leg was
 * taken, then each configured horizon not yet measured whose bar the series holds and whose change is a finite number
 * (one that overflows is written at no run, and stays due). A day 0 the series no longer
 * reaches is the one "closed" line. A decision with a "closed" line, or with nothing left to measure, gets none.
 */
export function measure(d: DecisionLine, m: MarketConfig, series: Series, bench: { symbol: string; series: Series } | null,
  horizons: number[], have: OutcomeLine[]): OutcomeBody[] {
  if (have.some((l) => l.what === "closed")) return [];
  const legDue = d.price !== undefined && !have.some((l) => l.what === "leg");
  const measured = new Set(have.flatMap((l) => (l.what === "horizon" ? [l.k] : [])));
  const due = horizons.filter((k, i) => !measured.has(k) && horizons.indexOf(k) === i);
  if (!legDue && due.length === 0) return [];

  const bars = usable(series);
  if (bars.length === 0) return [];
  const target = targetDate(Date.parse(d.decided_at ?? d.t), m);
  if (target < bars[0]!.date) return [{ what: "closed", reason: NOT_MEASURABLE }];
  const i0 = bars.findIndex((b) => b.date >= target);
  if (i0 === -1) return [];
  const day0 = bars[i0]!;
  const read = { source: series.source, adjustment: series.adjustment };
  const out: OutcomeBody[] = [];

  if (legDue) {
    const leg: Leg = { what: "leg", day0: day0.date, day0_close: day0.close, price: d.price!, leg_pct: null, ...read };
    const pct = pctChange(d.price!, day0.close);
    if (bars.length - 1 - i0 > LEG_MAX_SESSIONS) leg.not_taken = "late";
    else if (Math.abs(pct) > LEG_MAX_ABS_PCT) leg.not_taken = "scale";
    else leg.leg_pct = round2(pct);
    out.push(reorder(leg));
  }

  const benchBars = bench ? new Map(usable(bench.series).map((b) => [b.date, b.close])) : null;
  for (const k of due) {
    const dayK = bars[i0 + k];
    if (!dayK) continue;
    const s = dayK.close / day0.close - 1;
    if (!Number.isFinite(round2(s * 100))) continue;              // a change that overflows is no measurement: it stays due
    const line: Horizon = { what: "horizon", k, day0: day0.date, day0_close: day0.close, date: dayK.date, close: dayK.close,
      change_pct: round2(s * 100), ...read };
    const b0 = benchBars?.get(day0.date), bk = benchBars?.get(dayK.date);
    if (bench && b0 !== undefined && bk !== undefined) {
      const b = bk / b0 - 1;
      line.benchmark = { symbol: bench.symbol, day0_close: b0, close: bk, change_pct: round2(b * 100) };
      line.vs_benchmark_pct = round2(((1 + s) / (1 + b) - 1) * 100);
    }
    out.push(reorder(line));
  }
  return out;
}

/**
 * Weekdays, Monday to Friday, after the date of fromMs through the date of toMs, both read in the zone; 0 when
 * toMs is on or before fromMs's date.
 */
export function weekdaysGone(fromMs: number, toMs: number, zone: string): number {
  const from = dayNumber(local(fromMs, zone).date), to = dayNumber(local(toMs, zone).date);
  let n = 0;
  for (let day = from + 1; day <= to; day++) {
    const weekday = new Date(day * DAY_MS).getUTCDay();
    if (weekday !== 0 && weekday !== 6) n++;
  }
  return n;
}

/** The bars a measure reads: all but the one dated as provisional. */
function usable(series: Series): DailyBar[] {
  return series.provisionalDate === undefined ? series.bars : series.bars.filter((b) => b.date !== series.provisionalDate);
}

/** Percent change from `from` to `to`, unrounded. */
function pctChange(from: number, to: number): number {
  return (to / from - 1) * 100;
}

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/** The same body with source and adjustment last, the order a line is read in. */
function reorder<B extends Leg | Horizon>(body: B): B {
  const { source, adjustment, ...rest } = body;
  return { ...rest, source, adjustment } as B;
}

const DAY_MS = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

/** The date (YYYY-MM-DD) and the time (HH:MM, 00 to 23) of ms in the zone. */
function local(ms: number, zone: string): { date: string; time: string } {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formats.set(zone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

function nextDay(date: string): string {
  return new Date((dayNumber(date) + 1) * DAY_MS).toISOString().slice(0, 10);
}
