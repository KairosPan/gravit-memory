// src/prices.ts — the daily bars of one symbol, read from the price source config.json names
//
// The only place the package reaches the network, and only toward config.prices.url, with the fetch it is given.
// Anything that is not an answer of daily bars as the source's candles route gives them is a refusal in words,
// never a throw and never a partial series.
import type { Config } from "./types.js";
import type { DailyBar, Series } from "./outcomes.js";

/** The bars asked for a venue other than china, and once more when day 0 is not among them (D-h). */
export const LATEST_BARS = 750, LONGER_BARS = 5000;
const WAIT_MS = 10_000;

/** One symbol's daily bars from the price source, or its refusal in words. */
export async function readDaily(cfg: Config, market: string, symbol: string, fetchImpl: typeof fetch,
  opts?: { limit?: number }): Promise<Series | { refused: string }> {
  const m = cfg.prices.markets[market];
  if (!m) return { refused: `config.json names no market ${market}` };
  const base = cfg.prices.url.replace(/\/+$/, "");
  if (base === "") return { refused: "config.json names no price source" };

  const query: Record<string, string> = m.venue === "china"
    ? { venue: m.venue, symbol, range: "1Y" }
    : { venue: m.venue, symbol, interval: "1d", range: "MAX", limit: String(opts?.limit ?? LATEST_BARS) };
  const other = { refused: `the price source at ${base} answered something other than daily bars of ${symbol}` };

  let status: number;
  let body: unknown;
  try {
    const response = await fetchImpl(`${base}/api/candles?${new URLSearchParams(query)}`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(WAIT_MS),
    });
    status = response.status;
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      return other;
    }
  } catch {
    return { refused: `the price source at ${base} did not answer` };
  }

  if (!isObject(body)) return other;
  if (body.ok === false) {
    const message = isObject(body.refusal) ? body.refusal.message : body.error;
    if (typeof message !== "string" || message.trim() === "") return other;
    return status === 409 ? { refused: message } : { refused: `the price source at ${base} refused the question: ${message}` };
  }
  if (status !== 200 || body.ok !== true) return other;

  const bars = barsOf(body.candles);
  if (!bars) return other;
  if (bars.length === 0) return { refused: `the price source at ${base} answered no daily bars of ${symbol}` };

  const adjustment = body.adjustment ?? null;
  if (adjustment !== null && typeof adjustment !== "string") return other;
  let provisionalDate: string | undefined;
  if (body.today !== undefined && body.today !== null) {
    if (!isObject(body.today) || !isTime(body.today.t)) return other;
    provisionalDate = dateOf(body.today.t);
  }
  return { bars, ...(provisionalDate !== undefined ? { provisionalDate } : {}), adjustment, source: base };
}

/** The candles as daily bars, oldest first and one per date, or null when they are anything else. */
function barsOf(candles: unknown): DailyBar[] | null {
  if (!Array.isArray(candles)) return null;
  const bars: DailyBar[] = [];
  for (const candle of candles) {
    if (!isObject(candle) || !isTime(candle.t)) return null;
    const close = candle.c;
    if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) return null;
    const date = dateOf(candle.t);
    const last = bars.at(-1);
    if (last && date <= last.date) return null;
    bars.push({ date, close });
  }
  return bars;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isTime(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 8.64e15;
}

/** A bar's date: the UTC date of its time. */
function dateOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}
