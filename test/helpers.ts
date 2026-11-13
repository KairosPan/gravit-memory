import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { initHome } from "../src/home.js";
import type { DailyBar } from "../src/outcomes.js";

export { DAY, HOUR } from "../src/limits.js";

const made: string[] = [];
const stubs: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((close) => close()));
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh directory under the system's temporary directory, initialised unless init is false, removed afterEach. */
export async function tempHome(opts?: { init?: boolean; under?: string }): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "gravit-memory-"));
  made.push(base);
  let home = base;
  if (opts?.under !== undefined) {
    home = join(base, opts.under);
    await mkdir(home);
  }
  if (opts?.init !== false) await initHome(home);
  return home;
}

/** A clock the test moves by hand. */
export function clock(iso: string): { now: () => number; advance(ms: number): void; set(iso: string): void } {
  let t = at(iso);
  return {
    now: () => t,
    advance(ms: number) { t += ms; },
    set(next: string) { t = at(next); },
  };
}

function at(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`clock: not a date: ${iso}`);
  return t;
}

/** The stand-in card: the only lesson text the repository holds. */
export const STAND_IN_CARD = `---
id: no-chasing-after-a-run
says: dont
actions: [buy, add]
strength: caveat
scope:
  market: [US]
check:
  - { fact: sector, op: in, value: [semiconductors, software] }
  - { fact: change_5d_pct, op: ">=", value: 20 }
facts:
  sector: the stock's sector, as the price source's listing names it
  change_5d_pct: today's close over the close five sessions earlier, minus 1, in percent
source: ["owner, 2026-01-05"]
---
No new position in a name that ran 20% in five sessions.
`;

/** Writes a card's text to lessons/<id>.md, the id read from its front matter, and returns the id. */
export async function writeCard(home: string, text: string = STAND_IN_CARD): Promise<string> {
  const id = /^id:\s*(\S+)\s*$/m.exec(text)?.[1];
  if (id === undefined) throw new Error("writeCard: the text names no id");
  const file = join(home, "lessons", `${id}.md`);
  await writeFile(file, text, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(file, 0o600);
  return id;
}

/** One bar per weekday from the date on (the date itself when it is a weekday), one for each close. */
export function weekdays(fromIso: string, closes: number[]): DailyBar[] {
  const bars: DailyBar[] = [];
  let ms = at(`${fromIso}T00:00:00Z`);
  for (const close of closes) {
    while ([0, 6].includes(new Date(ms).getUTCDay())) ms += DAY_MS;
    bars.push({ date: new Date(ms).toISOString().slice(0, 10), close });
    ms += DAY_MS;
  }
  return bars;
}

const DAY_MS = 86_400_000;

function candles(bars: DailyBar[]): Array<{ t: number; o: number; h: number; l: number; c: number }> {
  return bars.map((b) => ({ t: at(`${b.date}T00:00:00Z`), o: b.close, h: b.close, l: b.close, c: b.close }));
}

/** A Cboe day-bar answer of the price source for these bars; `extra` adds or replaces keys. */
export function cboeAnswer(bars: DailyBar[], extra?: object): object {
  return { ok: true, venue: "cboe", interval: "1d", candles: candles(bars), more: false,
    adjustment: "split-adjusted, not dividend-adjusted", ...extra };
}

/** An A share's answer of the price source for these bars. */
export function chinaAnswer(bars: DailyBar[]): object {
  return { ok: true, venue: "china", range: "1Y", candles: candles(bars), adjustment: "forward-adjusted (前复权)" };
}

/**
 * A price source on 127.0.0.1 answering GET /api/candles by symbol, with what `set` gave it; a symbol not set is
 * refused as the source refuses. Every request's URL is kept. Closed afterEach if the test did not.
 */
export async function candleStub(): Promise<{ url: string; requests: URL[]; set(symbol: string, answer: unknown, status?: number): void; close(): Promise<void> }> {
  const answers = new Map<string, { answer: unknown; status: number }>();
  const requests: URL[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(url);
    const symbol = url.searchParams.get("symbol") ?? "";
    const set = url.pathname === "/api/candles" ? answers.get(symbol) : undefined;
    const { answer, status } = set ?? { answer: { ok: false, refusal: { code: "E_STUB", message: `no answer set for ${symbol}` } }, status: 409 };
    const body = typeof answer === "string" ? answer : JSON.stringify(answer);
    res.writeHead(status, { "content-type": typeof answer === "string" ? "text/html" : "application/json" });
    res.end(body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  };
  stubs.push(close);
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    set(symbol, answer, status = 200) { answers.set(symbol, { answer, status }); },
    close,
  };
}
