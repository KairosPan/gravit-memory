import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/home.js";
import { readDaily } from "../src/prices.js";
import type { Config } from "../src/types.js";
import { candleStub, chinaAnswer, cboeAnswer, weekdays } from "./helpers.js";

const bars = weekdays("2026-03-02", [100, 104, 102, 110, 99]);
const configAt = (url: string): Config => ({ ...DEFAULT_CONFIG, prices: { ...DEFAULT_CONFIG.prices, url } });
const ask = (cfg: Config, market: string, symbol: string, opts?: { limit?: number }) => readDaily(cfg, market, symbol, fetch, opts);

test("a US share is asked by venue, day bars, latest 750", async () => {
  const stub = await candleStub();
  stub.set("NVDA", cboeAnswer(bars));
  await ask(configAt(stub.url), "US", "NVDA");
  expect(stub.requests).toHaveLength(1);
  const [url] = stub.requests;
  expect(url!.pathname).toBe("/api/candles");
  expect(url!.search).toBe("?venue=cboe&symbol=NVDA&interval=1d&range=MAX&limit=750");
  await ask(configAt(`${stub.url}/`), "US", "NVDA", { limit: 5000 });              // a trailing slash in the url is one path
  expect(stub.requests[1]!.pathname).toBe("/api/candles");
  expect(stub.requests[1]!.searchParams.get("limit")).toBe("5000");
});

test("an A share is asked by range alone", async () => {
  const stub = await candleStub();
  stub.set("600000", chinaAnswer(bars));
  const got = await ask(configAt(stub.url), "CN", "600000", { limit: 5000 });
  expect(got).toMatchObject({ bars, adjustment: "forward-adjusted (前复权)", source: stub.url });
  const params = stub.requests[0]!.searchParams;
  expect(Object.fromEntries(params)).toEqual({ venue: "china", symbol: "600000", range: "1Y" });
  for (const key of ["interval", "limit", "since", "before"]) expect(params.has(key)).toBe(false);
});

test("bars, adjustment and the provisional date come through", async () => {
  const stub = await candleStub();
  const answer = cboeAnswer(bars) as { candles: Array<{ t: number }> };
  stub.set("NVDA", { ...answer, today: { t: answer.candles.at(-1)!.t, words: "Today so far" } });
  const got = await ask(configAt(stub.url), "US", "NVDA");
  expect(got).toEqual({ bars, provisionalDate: "2026-03-06", adjustment: "split-adjusted, not dividend-adjusted", source: stub.url });

  stub.set("AMD", cboeAnswer(bars, { adjustment: undefined }));
  expect(await ask(configAt(stub.url), "US", "AMD")).toEqual({ bars, adjustment: null, source: stub.url });
});

test("a bar's date is the UTC date of its time", async () => {
  const stub = await candleStub();
  stub.set("NVDA", { ok: true, candles: [{ t: Date.parse("2026-03-02T05:00:00Z"), o: 1, h: 1, l: 1, c: 10 },
    { t: Date.parse("2026-03-03T23:59:00Z"), o: 1, h: 1, l: 1, c: 11, v: 5 }] });
  expect(await ask(configAt(stub.url), "US", "NVDA")).toMatchObject({
    bars: [{ date: "2026-03-02", close: 10 }, { date: "2026-03-03", close: 11 }] });
});

test("a refusal is told in the source's words", async () => {
  const stub = await candleStub();
  stub.set("NVDA", { ok: false, refusal: { code: "E_VENUE_UNREACHABLE", message: "Cboe is not answering" } }, 409);
  expect(await ask(configAt(stub.url), "US", "NVDA")).toEqual({ refused: "Cboe is not answering" });
  stub.set("AMD", { ok: false, error: "a range is one of 1D, 1W" }, 400);
  expect(await ask(configAt(stub.url), "US", "AMD")).toEqual({ refused: expect.stringMatching(/price source.*a range is one of/) });
});

test("something else is refused", async () => {
  const stub = await candleStub();
  const answer = cboeAnswer(bars) as { candles: Array<{ t: number; c: number }> };
  const cases: Array<[unknown, number]> = [
    ["<html><body>Not here</body></html>", 200],
    [{ ok: true }, 200],
    [{ ...answer, candles: [...answer.candles].reverse() }, 200],                       // out of order
    [{ ...answer, candles: [answer.candles[0], { ...answer.candles[0]!, t: answer.candles[0]!.t + 3_600_000 }] }, 200], // one date twice
    [{ ...answer, candles: [{ ...answer.candles[0]!, c: "100" }] }, 200],
    [{ ...answer, candles: [{ ...answer.candles[0]!, c: 0 }] }, 200],
    [{ ...answer, candles: [] }, 200],
    [{ ...answer, today: "Today so far" }, 200],
    [{ ...answer, adjustment: 3 }, 200],
    [{ ok: false }, 409],
    [cboeAnswer(bars), 500],
  ];
  for (const [i, [body, status]] of cases.entries()) {
    stub.set(`S${i}`, body, status);
    const got = await ask(configAt(stub.url), "US", `S${i}`);
    expect(got, `case ${i}`).toEqual({ refused: expect.stringMatching(/price source/) });
  }
});

test("a market config.json does not name is refused", async () => {
  const stub = await candleStub();
  expect(await ask(configAt(stub.url), "JP", "7203")).toEqual({ refused: expect.stringMatching(/JP/) });
  expect(stub.requests).toHaveLength(0);
});

test("a source that does not answer", async () => {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));                  // a closed port
  const url = `http://127.0.0.1:${port}`;
  expect(await ask(configAt(url), "US", "NVDA")).toEqual({ refused: `the price source at ${url} did not answer` });
});

test("a redirect is not followed", async () => {
  const stub = await candleStub();
  stub.set("NVDA", cboeAnswer(bars));
  const server = createHttpServer((_req, res) => { res.writeHead(302, { location: `${stub.url}/api/candles?venue=cboe&symbol=NVDA` }); res.end(); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect(await ask(configAt(url), "US", "NVDA")).toEqual({ refused: `the price source at ${url} did not answer` });
    expect(stub.requests).toHaveLength(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("only the fetch it is given, and only toward the url", async () => {
  const seen: string[] = [];
  const counting = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(JSON.stringify(cboeAnswer(bars)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const got = await readDaily(configAt("http://127.0.0.1:9"), "US", "NVDA", counting);
  expect(got).toMatchObject({ bars });
  expect(seen).toEqual(["http://127.0.0.1:9/api/candles?venue=cboe&symbol=NVDA&interval=1d&range=MAX&limit=750"]);
});
