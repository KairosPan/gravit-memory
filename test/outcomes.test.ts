import { expect, test } from "vitest";
import { measure, targetDate, weekdaysGone, type DailyBar, type Series } from "../src/outcomes.js";
import type { DecisionLine, MarketConfig, OutcomeBody, OutcomeLine } from "../src/types.js";
import { weekdays } from "./helpers.js";

const US: MarketConfig = { venue: "cboe", benchmark: "SPY", zone: "America/New_York", close: "16:00" };
const bars = weekdays("2026-03-02", [100, 104, 102, 110, 99, 120, 130]);         // Mon 03-02 … Tue 03-10
const series = (b: DailyBar[], extra = {}): Series => ({ bars: b, adjustment: null, source: "stub", ...extra });
const d = (over = {}) => ({ kind: "decision", id: "d-1", action: "buy", symbol: "NVDA", market: "US", t: "2026-03-03T15:00:00.000Z", ...over }) as unknown as DecisionLine;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** What measure gave, as lines of the outcomes file would hold them. */
const had = (bodies: OutcomeBody[]): OutcomeLine[] => bodies.map((b) => ({ kind: "outcome", decision: "d-1", ...b }) as unknown as OutcomeLine);

test("day 0", () => {
  expect(targetDate(Date.parse("2026-03-03T15:00:00Z"), US)).toBe("2026-03-03");   // 10:00 in New York
  expect(targetDate(Date.parse("2026-03-03T21:00:00Z"), US)).toBe("2026-03-03");   // 16:00, at the close
  expect(targetDate(Date.parse("2026-03-03T21:30:00Z"), US)).toBe("2026-03-04");   // 16:30, after it
  expect(targetDate(Date.parse("2026-03-07T15:00:00Z"), US)).toBe("2026-03-07");   // a Saturday: day 0 is the first bar on or after
});

test("close to close", () => {
  const out = measure(d(), US, series(bars), null, [1, 5, 20, 60], []);
  expect(out).toEqual([
    expect.objectContaining({ what: "horizon", k: 1, day0: "2026-03-03", day0_close: 104, date: "2026-03-04", close: 102, change_pct: -1.92 }),
    expect.objectContaining({ what: "horizon", k: 5, date: "2026-03-10", close: 130, change_pct: 25 }),
  ]);                                                                              // 20 and 60 are not there yet: no line
  expect(out[0]).toMatchObject({ source: "stub", adjustment: null });
  expect(out[0]).not.toHaveProperty("benchmark");
});

test("a Saturday's decision is measured from the Monday", () => {
  const out = measure(d({ t: "2026-03-07T15:00:00.000Z" }), US, series(bars), null, [1], []);
  expect(out).toEqual([expect.objectContaining({ k: 1, day0: "2026-03-09", day0_close: 120, date: "2026-03-10", close: 130 })]);
});

test("bars re-scaled by the source move no change", () => {
  const half = bars.map((b) => ({ ...b, close: b.close * 0.5 }));
  const pcts = (b: DailyBar[]) => measure(d(), US, series(b), null, [1, 5], []).map((l) => (l.what === "horizon" ? l.change_pct : null));
  expect(pcts(half)).toEqual(pcts(bars));
  expect(pcts(half)).toEqual([-1.92, 25]);
});

test("a provisional last bar is not measured from", () => {
  const out = measure(d(), US, series(bars, { provisionalDate: "2026-03-10" }), null, [1, 5, 20, 60], []);
  expect(out).toEqual([expect.objectContaining({ what: "horizon", k: 1 })]);
});

test("the price leg, once", () => {
  const first = measure(d({ price: 100 }), US, series(bars), null, [1, 5], []);
  expect(first[0]).toEqual({ what: "leg", day0: "2026-03-03", day0_close: 104, price: 100, leg_pct: 4, source: "stub", adjustment: null });
  expect(first.map((l) => l.what)).toEqual(["leg", "horizon", "horizon"]);
  const again = measure(d({ price: 100 }), US, series(bars), null, [1, 5, 20], had(first));
  expect(again).toEqual([]);
  const legOnly = measure(d({ price: 100 }), US, series(bars), null, [1, 5], had(first.slice(0, 1)));
  expect(legOnly.map((l) => l.what)).toEqual(["horizon", "horizon"]);
});

test("the leg is not taken late", () => {
  const eight = weekdays("2026-03-02", [100, 104, 102, 110, 99, 120, 130, 131]);  // the last bar 6 sessions after day 0
  const out = measure(d({ price: 100 }), US, series(eight), null, [1], []);
  expect(out[0]).toEqual({ what: "leg", day0: "2026-03-03", day0_close: 104, price: 100, leg_pct: null, not_taken: "late",
    source: "stub", adjustment: null });
  const five = measure(d({ price: 100 }), US, series(bars), null, [1], []);        // 5 sessions: still taken
  expect(five[0]).toMatchObject({ what: "leg", leg_pct: 4 });
});

test("the leg is not taken on another scale", () => {
  const out = measure(d({ price: 30 }), US, series(bars), null, [1], []);
  expect(out[0]).toMatchObject({ what: "leg", day0_close: 104, price: 30, leg_pct: null, not_taken: "scale" });
  expect(out[1]).toMatchObject({ what: "horizon", k: 1 });
});

test("against the benchmark", () => {
  const spy = weekdays("2026-03-02", [500, 510, 520, 505, 530, 540, 525]);
  const out = measure(d(), US, series(bars), { symbol: "SPY", series: series(spy) }, [1, 5], []);
  const s1 = 102 / 104 - 1, b1 = 520 / 510 - 1;
  expect(out[0]).toMatchObject({
    k: 1, change_pct: -1.92,
    benchmark: { symbol: "SPY", day0_close: 510, close: 520, change_pct: round2(b1 * 100) },
    vs_benchmark_pct: round2(((1 + s1) / (1 + b1) - 1) * 100),
  });
  const s5 = 130 / 104 - 1, b5 = 525 / 510 - 1;
  expect(out[1]).toMatchObject({ k: 5, vs_benchmark_pct: round2(((1 + s5) / (1 + b5) - 1) * 100) });

  const gap = spy.filter((b) => b.date !== "2026-03-04");                         // a date missing
  const paired = measure(d(), US, series(bars), { symbol: "SPY", series: series(gap) }, [1, 5], []);
  expect(paired[0]).not.toHaveProperty("benchmark");
  expect(paired[0]).not.toHaveProperty("vs_benchmark_pct");
  expect(paired[1]).toHaveProperty("benchmark");
});

test("each horizon once", () => {
  const first = measure(d(), US, series(bars), null, [1], []);
  const out = measure(d(), US, series(bars), null, [1, 5], had(first));
  expect(out).toEqual([expect.objectContaining({ what: "horizon", k: 5 })]);
});

test("day 0 has not traded", () => {
  expect(measure(d({ t: "2026-03-10T22:00:00.000Z" }), US, series(bars), null, [1, 5], [])).toEqual([]);
  expect(measure(d({ t: "2026-03-11T15:00:00.000Z", price: 100 }), US, series(bars), null, [1, 5], [])).toEqual([]);
});

test("day 0 has left the source's reach", () => {
  const out = measure(d({ t: "2026-02-20T15:00:00.000Z" }), US, series(bars), null, [1, 5], []);
  expect(out).toEqual([{ what: "closed", reason: "not measurable from this source" }]);
  expect(measure(d({ t: "2026-02-20T15:00:00.000Z" }), US, series(bars), null, [1, 5], had(out))).toEqual([]);
});

test("a closed decision is not measured again", () => {
  const closed = had([{ what: "closed", reason: "not measurable from this source" }]);
  expect(measure(d(), US, series(bars), null, [1, 5], closed)).toEqual([]);
});

test("a pass is measured as a buy", () => {
  const buy = measure(d({ price: 100 }), US, series(bars), null, [1, 5], []);
  expect(measure(d({ action: "pass", price: 100 }), US, series(bars), null, [1, 5], [])).toEqual(buy);
});

test("the decision's own horizon adds no measurement", () => {
  const out = measure(d({ horizon: 3 }), US, series(bars), null, [1, 5, 20, 60], []);
  expect(out.map((l) => (l.what === "horizon" ? l.k : null))).toEqual([1, 5]);
});

test("a decision's decided_at is the time it is measured from", () => {
  const out = measure(d({ decided_at: "2026-03-04T15:00:00.000Z", t: "2026-03-09T15:00:00.000Z" }), US, series(bars), null, [1], []);
  expect(out).toEqual([expect.objectContaining({ day0: "2026-03-04", date: "2026-03-05" })]);
});

test("weekdaysGone", () => {
  const ny = "America/New_York";
  const ms = (iso: string) => Date.parse(iso);
  expect(weekdaysGone(ms("2026-03-02T15:00:00Z"), ms("2026-03-03T15:00:00Z"), ny)).toBe(1);   // Mon → Tue
  expect(weekdaysGone(ms("2026-03-06T15:00:00Z"), ms("2026-03-09T15:00:00Z"), ny)).toBe(1);   // Fri → Mon
  expect(weekdaysGone(ms("2026-03-02T15:00:00Z"), ms("2026-03-09T15:00:00Z"), ny)).toBe(5);   // Mon → the next Mon
  expect(weekdaysGone(ms("2026-03-02T15:00:00Z"), ms("2026-03-02T20:00:00Z"), ny)).toBe(0);   // the same day
  expect(weekdaysGone(ms("2026-03-03T02:00:00Z"), ms("2026-03-03T15:00:00Z"), ny)).toBe(1);   // Mon evening in New York → Tue
});
