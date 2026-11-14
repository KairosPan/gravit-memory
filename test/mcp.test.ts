import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/home.js";
import { openMemory, type Memory, type RecallAnswer } from "../src/index.js";
import { INSTRUCTIONS_MAX_BYTES } from "../src/limits.js";
import { readLog } from "../src/log.js";
import { INSTRUCTIONS, TOOL_NAMES, buildServer, runMcp } from "../src/mcp.js";
import type { RecallLine } from "../src/types.js";
import { DAY, candleStub, cboeAnswer, clock, tempHome, weekdays, writeCard } from "./helpers.js";

const ID = "no-chasing-after-a-run";
const ask = { considering: ["buy"], symbol: "NVDA", market: "US", facts: { sector: "software", change_5d_pct: 34.1 } };
const nvda = { action: "buy", whose: "agent", thesis: "Data-centre orders keep rising.", symbol: "NVDA", market: "US" };

let home: string;
let c: ReturnType<typeof clock>;
let fetches: number;
let memory: Memory;
let one: Client;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  home = await tempHome();
  c = clock("2026-03-02T15:00:00Z");                                            // Mon 10:00 in New York
  fetches = 0;
  memory = openMemory(home, { now: c.now, fetch: counting });
  one = await connect(memory, "agent-one");
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** The suite's fetch, counted: only 127.0.0.1 answers. */
const counting = (async (input: string | URL | Request, init?: RequestInit) => {
  fetches += 1;
  return fetch(input, init);
}) as typeof fetch;

/** A client linked to the door of `memory` as the agent `as`, over the SDK's in-memory pair. */
async function connect(m: Memory, as: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildServer(m, as);
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverSide);
  await client.connect(clientSide);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

/** Calls a tool and returns its whole answer; the client never throws for a refusal. */
async function answer(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(r: CallToolResult): string {
  const first = r.content[0];
  return first?.type === "text" ? first.text : "";
}

/** Calls a tool that must answer, and returns its structure. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await answer(client, name, args);
  expect(r.isError, textOf(r)).toBeFalsy();
  return r.structuredContent;
}

async function useSource(url: string): Promise<void> {
  const config = { ...DEFAULT_CONFIG, prices: { ...DEFAULT_CONFIG.prices, url } };
  await writeFile(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

test("seven tools, and none that arms", async () => {
  const names = (await one.listTools()).tools.map((t) => t.name);
  expect(names.sort()).toEqual([...TOOL_NAMES].sort());
  expect(names.join(" ")).not.toMatch(/arm|retire|accept|reseal|discard|delete|edit/);
});

test("each listed tool says when to call it and shows its fields", async () => {
  const tools = (await one.listTools()).tools;
  for (const t of tools) expect(t.description, t.name).toMatch(/^Call /);
  const record = tools.find((t) => t.name === "memory_record")!;
  expect(Object.keys(record.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["action", "whose", "thesis", "recall"]));
  expect(record.inputSchema.required).toEqual(["action", "whose", "thesis"]);
  const recall = tools.find((t) => t.name === "memory_recall")!;
  expect(Object.keys(recall.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["considering", "facts"]));
  const amend = tools.find((t) => t.name === "memory_amend")!;
  expect(JSON.stringify(amend.inputSchema)).toContain("\"void\"");
  const review = tools.find((t) => t.name === "memory_review")!;
  expect(Object.keys(review.inputSchema.properties ?? {})).toEqual(["since"]);
});

test("every tool publishes a flat object schema, every field described", async () => {
  const tools = (await one.listTools()).tools;
  expect(tools).toHaveLength(7);
  for (const t of tools) {
    const schema = t.inputSchema as Record<string, unknown>;
    expect(schema.type, t.name).toBe("object");
    for (const key of ["oneOf", "anyOf", "allOf"]) expect(schema, `${t.name} ${key}`).not.toHaveProperty(key);
    const properties = (schema.properties ?? {}) as Record<string, { description?: unknown }>;
    for (const [field, p] of Object.entries(properties)) {
      expect(typeof p.description === "string" && p.description.length > 0, `${t.name}.${field}`).toBe(true);
    }
  }
  const amend = tools.find((t) => t.name === "memory_amend")!.inputSchema as Record<string, any>;
  expect(amend.required).toEqual(["decision", "what"]);
  expect(amend.properties.what.enum).toEqual(["ref", "close", "review", "correction", "void"]);
  for (const field of ["ref", "closed_at", "price", "note", "thesis_held", "wrong_if_hit", "whose", "field", "value", "reason"]) {
    expect(amend.properties, field).toHaveProperty(field);
    expect(amend.properties[field].description, field).toMatch(/what/);
  }
  const r = await answer(one, "memory_amend", { decision: "d-20260302-0f3a9c21", what: "ref" });
  expect(r.isError).toBe(true);                                   // the core's strict parse stays the judge
  expect(textOf(r)).toContain("ref is required");
});

test("the instructions fit and are served", async () => {
  expect(Buffer.byteLength(INSTRUCTIONS)).toBeLessThanOrEqual(INSTRUCTIONS_MAX_BYTES);
  expect(INSTRUCTIONS_MAX_BYTES).toBe(1500);
  expect(one.getInstructions()).toBe(INSTRUCTIONS);
});

test("the server gives the package's name and version", async () => {
  const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
  expect(one.getServerVersion()).toMatchObject({ name: "gravit-memory", version: pkg.version });
});

test("a bad name is refused", async () => {
  for (const name of ["Owner", "owner", "a", "has space"]) {
    let code: unknown;
    try { buildServer(memory, name); } catch (err) { code = (err as { code?: unknown }).code; }
    expect(code, name).toBe("E_INPUT");
  }
  const stderr = new PassThrough();
  const said: string[] = [];
  stderr.on("data", (b: Buffer) => said.push(b.toString()));
  expect(await runMcp([], { stderr })).toBe(2);
  expect(await runMcp(["--as", "owner"], { stderr })).toBe(2);
  expect(await runMcp(["--as"], { stderr })).toBe(2);
  expect(await runMcp(["--as", "agent-one", "--port", "1"], { stderr })).toBe(2);
  expect(said).toHaveLength(4);
  for (const line of said) expect(line).toMatch(/^gravit-memory mcp: [^\n]+\n$/);
  expect(said[0]).toContain("--as");
});

test("over stdio: only protocol frames on stdout, and 0 when the input ends", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (b: Buffer) => { out += b.toString(); });
  stderr.on("data", (b: Buffer) => { err += b.toString(); });
  const run = runMcp(["--as", "agent-one", "--home", home], { stdin, stdout, stderr, now: c.now, fetch: counting });
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "memory_status", arguments: {} } })}\n`);
  for (let waited = 0; out.split("\n").length < 3 && waited < 5000; waited += 10) {
    await new Promise((done) => setTimeout(done, 10));
  }
  stdin.end();
  expect(await run).toBe(0);
  const frames = out.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> });
  expect(frames.map((f) => f.id)).toEqual([1, 2]);
  expect(frames[0]!.result).toMatchObject({ instructions: INSTRUCTIONS, serverInfo: { name: "gravit-memory" } });
  expect(frames[1]!.result.isError).toBeFalsy();
  expect(err).toBe("");
});

test("no home: the server starts and each tool says so", async () => {
  const none = await connect(openMemory(await tempHome({ init: false }), { now: c.now, fetch: counting }), "agent-one");
  const args: Record<string, Record<string, unknown>> = {
    memory_recall: ask, memory_record: nvda, memory_amend: { decision: "d-20260302-0f3a9c21", what: "ref", ref: "x" },
    memory_propose: { what: "retire", lesson: ID, reason: "Unused." }, memory_reconcile: {}, memory_review: {}, memory_status: {},
  };
  for (const name of TOOL_NAMES) {
    const r = await answer(none, name, args[name]);
    expect(r.isError, name).toBe(true);
    expect(textOf(r), name).toBe("no memory here: run gravit-memory init");
  }
});

test("a refusal is an answer, in words", async () => {
  const r = await answer(one, "memory_record", { action: "buy", whose: "agent" });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toBe("thesis is required.");
  const odd = await answer(one, "memory_recall", { ...ask, leaning: "buy" });
  expect(odd.isError).toBe(true);
  expect(textOf(odd)).toContain("leaning");
  const extra = await answer(one, "memory_reconcile", { now: "2026-03-02" });
  expect(extra.isError).toBe(true);
  expect(textOf(extra)).toContain("now");
  const since = await answer(one, "memory_review", { since: "last week" });
  expect(since.isError).toBe(true);
  expect(textOf(since)).toContain("since");
  expect(await readFile(join(home, "decisions.jsonl"), "utf8")).toBe("");
});

test("a fault inside is answered without its stack or a path", async () => {
  const faulty = { ...memory, status: async () => { throw new Error(`EACCES: permission denied, open '${home}/x'`); } };
  const r = await answer(await connect(faulty, "agent-one"), "memory_status");
  expect(r.isError).toBe(true);
  expect(textOf(r)).not.toContain(home);
  expect(textOf(r)).not.toMatch(/EACCES|at /);
});

test("a tool answers text and the same as structure", async () => {
  const r = await answer(one, "memory_recall", ask);
  const s = r.structuredContent as unknown as RecallAnswer;
  expect(textOf(r)).toBe(s.text);
  expect(s.recall_id).toMatch(/^r-20260302-[0-9a-f]{8}$/);

  const d = await answer(one, "memory_record", { ...nvda, recall: s.recall_id });
  expect(textOf(d)).toContain((d.structuredContent as { id: string }).id);
  expect(textOf(d)).not.toMatch(/should|recommend/i);
  const st = await call(one, "memory_status");
  expect(st.lines["decisions.jsonl"]).toBe(1);
});

test("the stand-in for the owner's example, from two agents", async () => {
  const two = await connect(openMemory(home, { now: c.now, fetch: counting }), "agent-two");
  await writeCard(home);
  await memory.owner.arm(ID);                                                    // the owner arms

  const r = await call(one, "memory_recall", ask);
  expect(r.applies[0].words).toBe("No new position in a name that ran 20% in five sessions.");
  const d = await call(one, "memory_record", { action: "pass", whose: "owner", thesis: "It ran too far too fast.",
    symbol: "NVDA", market: "US", recall: r.recall_id });

  const stub = await candleStub();
  await useSource(stub.url);
  const days = 22;                                                               // Mon 03-02 … Tue 03-31
  stub.set("NVDA", cboeAnswer(weekdays("2026-03-02", Array.from({ length: days }, (_, i) => 100 + i))));
  stub.set("SPY", cboeAnswer(weekdays("2026-03-02", Array.from({ length: days }, (_, i) => 500 + i / 2))));
  c.advance(30 * DAY);
  expect((await call(one, "memory_reconcile")).measured).toBeGreaterThan(0);

  const again = await call(two, "memory_recall", { ...ask, facts: { sector: "software", change_5d_pct: 25 } });
  expect(again.applies[0].record.owner).toMatchObject({ fired: 2, followed: 1, overridden: 0 });
  expect(again.applies[0].record.followed[0].figures.find((f: { k: number }) => f.k === 20).change_pct).not.toBeNull();
  expect(again.same[0]).toMatchObject({ id: d.id, by: "agent-one", action: "pass" });
  const bys = (await readLog<RecallLine>(home, "recalls.jsonl")).lines.map((l) => l.by);
  expect(bys).toEqual(["agent-one", "agent-two"]);
});

test("an agent voids its own line, not another's", async () => {
  const two = await connect(memory, "agent-two");
  const d = await call(one, "memory_record", nvda);
  const theirs = await answer(two, "memory_amend", { decision: d.id, what: "void", reason: "Not mine to keep." });
  expect(theirs.isError).toBe(true);
  expect(textOf(theirs)).toContain("only its writer or the owner voids it");
  const mine = await call(one, "memory_amend", { decision: d.id, what: "void", reason: "Registered by mistake." });
  expect(mine).toMatchObject({ decision: d.id, what: "void", by: "agent-one" });
});

test("memory_reconcile takes no force, and answers fresh within the interval", async () => {
  const forced = await answer(one, "memory_reconcile", { force: true });
  expect(forced.isError).toBe(true);
  expect(textOf(forced)).toContain("force");

  const stub = await candleStub();
  await useSource(stub.url);
  await call(one, "memory_record", nvda);
  c.set("2026-03-05T15:00:00Z");
  const first = await call(one, "memory_reconcile");                             // NVDA refused: asked once
  expect(first.fresh).toBeUndefined();
  expect(stub.requests).toHaveLength(1);
  c.advance(60_000);
  const second = await call(one, "memory_reconcile");
  expect(second.fresh).toEqual({ asked_at: "2026-03-05T15:00:00.000Z", again_after: "2026-03-05T16:00:00.000Z" });
  expect(stub.requests).toHaveLength(1);
});

test("only reconcile reaches the network", async () => {
  const stub = await candleStub();
  await useSource(stub.url);
  await writeCard(home);
  await memory.owner.arm(ID);
  const r = await call(one, "memory_recall", ask);
  const d = await call(one, "memory_record", { ...nvda, recall: r.recall_id });
  await call(one, "memory_amend", { decision: d.id, what: "ref", ref: "order 1" });
  await call(one, "memory_propose", { what: "retire", lesson: ID, reason: "Unused." });
  await call(one, "memory_review", { since: "2026-03-01" });
  await call(one, "memory_status");
  expect(fetches).toBe(0);
  expect(stub.requests).toHaveLength(0);

  stub.set("NVDA", cboeAnswer(weekdays("2026-03-02", [100, 101, 102])));
  stub.set("SPY", cboeAnswer(weekdays("2026-03-02", [500, 501, 502])));
  c.set("2026-03-05T12:00:00Z");
  await call(one, "memory_reconcile");
  expect(fetches).toBeGreaterThan(0);
});

test("memory_status gives an agent the words of the applying cards alone, as armed", async () => {
  const card = (id: string, words = "Stand-in words for a test.") =>
    `---\nid: ${id}\nsays: dont\nactions: [buy]\nstrength: caveat\n---\n${words}\n`;
  for (const id of ["card-armed", "card-changed", "card-retired", "card-broken"]) {
    await writeCard(home, card(id));
    await memory.owner.arm(id);
  }
  await writeCard(home, card("card-changed", "Edited words, not armed."));
  await memory.owner.retire("card-retired", "Done with it.");
  await writeCard(home, card("card-unarmed", "Unarmed words."));
  await writeFile(join(home, "lessons", "card-refused.md"), "no front matter, refused words\n");
  const broken = (await memory.status()).cards.find((s) => s.id === "card-broken")!;
  await writeFile(join(home, "armed", `card-broken.${broken.sha256!.slice(0, 12)}.md`), card("card-broken", "Broken words."));

  const st = await call(one, "memory_status");
  const byId: Record<string, Record<string, unknown>> = Object.fromEntries((st.cards as Array<Record<string, unknown>>).map((x) => [x.id, x]));
  expect(Object.fromEntries(Object.entries(byId).map(([id, x]) => [id, x.state]))).toEqual({ "card-armed": "armed",
    "card-broken": "broken", "card-changed": "changed", "card-refused": "refused", "card-retired": "retired", "card-unarmed": "unarmed" });
  expect((byId["card-armed"]!.card as { words: string }).words).toBe("Stand-in words for a test.");
  expect((byId["card-changed"]!.card as { words: string }).words).toBe("Stand-in words for a test.");    // the armed copy's
  for (const id of ["card-unarmed", "card-retired", "card-refused", "card-broken"]) {
    expect(Object.keys(byId[id]!).every((k) => ["id", "state", "fault"].includes(k)), id).toBe(true);
  }
  expect(byId["card-refused"]!.fault).toEqual(expect.any(String));
  expect(byId["card-broken"]!.fault).toEqual(expect.any(String));
  const seen = JSON.stringify(st);
  for (const words of ["Edited words", "Unarmed words", "refused words", "Broken words"]) expect(seen, words).not.toContain(words);

  const full = await memory.status();                                               // the core and the command line keep it all
  expect(full.cards.find((x) => x.id === "card-unarmed")!.card!.words).toBe("Unarmed words.");

  const owner = join(home, "owner.jsonl");                                          // a broken owner's chain: nothing applies
  await writeFile(owner, (await readFile(owner, "utf8")).replace("card-armed", "card-armex"));
  const after = await call(one, "memory_status");
  expect(JSON.stringify(after)).not.toContain("Stand-in words");
});

test("a fault inside is one line on the server's stderr, and the fixed sentence to the agent", async () => {
  const faults: unknown[] = [];
  const server = buildServer({ ...memory, status: async () => { throw new Error("a bug"); } }, "agent-one", { onFault: (e) => faults.push(e) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverSide);
  await client.connect(clientSide);
  closers.push(async () => { await client.close(); await server.close(); });
  const r = await answer(client, "memory_status");
  expect(r.isError).toBe(true);
  expect(textOf(r)).toBe("gravit-memory failed inside and gave no answer; the call may be tried again.");
  expect(faults).toHaveLength(1);
  expect(await answer(client, "memory_record", {})).toMatchObject({ isError: true });         // a refusal is no fault
  expect(faults).toHaveLength(1);

  await rm(join(home, "recalls.jsonl"));
  await mkdir(join(home, "recalls.jsonl"));                                         // a fault runMcp meets for real
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (b: Buffer) => { out += b.toString(); });
  stderr.on("data", (b: Buffer) => { err += b.toString(); });
  const run = runMcp(["--as", "agent-one", "--home", home], { stdin, stdout, stderr, now: c.now, fetch: counting });
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_status", arguments: {} } })}\n`);
  for (let waited = 0; out.split("\n").length < 3 && waited < 5000; waited += 10) await new Promise((done) => setTimeout(done, 10));
  stdin.end();
  expect(await run).toBe(0);
  expect(err.split("\n").filter((l) => l !== "")).toEqual([expect.stringMatching(/^gravit-memory mcp: a fault inside memory_status: /)]);
});
