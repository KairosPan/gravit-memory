import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { sha256Hex } from "../src/ids.js";
import { withLock } from "../src/lock.js";
import { appendLine, readLog, resealLog, type Fields } from "../src/log.js";
import type { RecallLine } from "../src/types.js";
import { clock, tempHome } from "./helpers.js";

let home: string;
let c: ReturnType<typeof clock>;

beforeEach(async () => {
  home = await tempHome();
  c = clock("2026-03-02T15:00:00Z");
});

const recall: Fields<RecallLine> = { kind: "recall", considering: ["buy"], applied: [], untold: [] };

async function appendFive(): Promise<RecallLine[]> {
  const out: RecallLine[] = [];
  for (let i = 0; i < 5; i++) {
    out.push(await appendLine<RecallLine>(home, "recalls.jsonl", "agent-one", c.now(), "r", recall));
    c.advance(1000);
  }
  return out;
}

/** Changes one character inside the n-th line (1-based) of the file, keeping it valid JSON. */
async function editLine(file: string, n: number): Promise<void> {
  const path = join(home, file);
  const lines = (await readFile(path, "utf8")).split("\n");
  const line = lines[n - 1]!;
  expect(line).toContain('"by":"agent-one"');
  lines[n - 1] = line.replace('"by":"agent-one"', '"by":"agent-onf"');
  await writeFile(path, lines.join("\n"));
}

/** Runs a command to its end; its standard output. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
  });
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

test("a line carries v, id, seq, prev, t, by and sum", async () => {
  const a = await appendLine<RecallLine>(home, "recalls.jsonl", "agent-one", c.now(), "r", { kind: "recall", considering: ["buy"], applied: [], untold: [] });
  const b = await appendLine<RecallLine>(home, "recalls.jsonl", "agent-two", c.now(), "r", { kind: "recall", considering: ["buy"], applied: [], untold: [] });
  expect(a).toMatchObject({ v: 1, seq: 1, prev: null, by: "agent-one", t: "2026-03-02T15:00:00.000Z" });
  expect(a.id).toMatch(/^r-20260302-[0-9a-f]{8}$/);
  const text = (await readFile(join(home, "recalls.jsonl"), "utf8")).split("\n");
  expect(b.seq).toBe(2); expect(b.prev).toBe(sha256Hex(text[0]!));
  expect(text[0]!.endsWith(`,"sum":"${a.sum}"}`)).toBe(true);
  expect(a.sum).toBe(sha256Hex(text[0]!.slice(0, -74) + "}"));
  expect(Object.keys(JSON.parse(text[0]!))).toEqual(["v", "kind", "id", "seq", "prev", "t", "by", "considering", "applied", "untold", "sum"]);
});

test("a line over 16,384 bytes is refused and nothing is written", async () => {
  await appendLine<RecallLine>(home, "recalls.jsonl", "agent-one", c.now(), "r", recall);
  const before = (await stat(join(home, "recalls.jsonl"))).size;
  const big = appendLine<RecallLine>(home, "recalls.jsonl", "agent-one", c.now(), "r", { ...recall, note: "x".repeat(16_384) });
  await expect(big).rejects.toMatchObject({ code: "E_INPUT" });
  expect((await stat(join(home, "recalls.jsonl"))).size).toBe(before);
});

test("the chain holds", async () => {
  await appendFive();
  const r = await readLog<RecallLine>(home, "recalls.jsonl");
  expect(r.chain).toEqual({ ok: true });
  expect(r.lines).toHaveLength(5);
  expect(r.lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(r.partial).toBe(false);
  expect(r.skipped).toBe(0);
});

test("one edited byte is found at its line", async () => {
  await appendFive();
  await editLine("recalls.jsonl", 2);
  let r = await readLog<RecallLine>(home, "recalls.jsonl");
  expect(r.chain).toEqual({ ok: false, line: 2 });
  expect(r.lines).toHaveLength(5);

  home = await tempHome();
  await appendFive();
  await editLine("recalls.jsonl", 5);
  r = await readLog<RecallLine>(home, "recalls.jsonl");
  expect(r.chain).toEqual({ ok: false, line: 5 });
  expect(r.lines).toHaveLength(5);
});

test("a partial last line is survived", async () => {
  await appendFive();
  await appendFile(join(home, "recalls.jsonl"), 'x{"v":1');
  let r = await readLog<RecallLine>(home, "recalls.jsonl");
  expect(r.partial).toBe(true);
  expect(r.lines).toHaveLength(5);
  expect(r.chain).toEqual({ ok: true });

  await appendLine<RecallLine>(home, "recalls.jsonl", "agent-one", c.now(), "r", recall);
  const text = await readFile(join(home, "recalls.jsonl"), "utf8");
  expect(text.endsWith("\n")).toBe(true);
  expect(text).not.toContain("x{");
  r = await readLog<RecallLine>(home, "recalls.jsonl");
  expect(r.chain).toEqual({ ok: true });
  expect(r.lines).toHaveLength(6);
  expect(r.partial).toBe(false);
});

test("reseal restarts a broken chain", async () => {
  await appendFive();
  await editLine("recalls.jsonl", 2);
  const bytesBefore = await readFile(join(home, "recalls.jsonl"));
  expect(await resealLog(home, "recalls.jsonl", c.now())).toEqual({ broke_at: 2 });

  let r = await readLog(home, "recalls.jsonl");
  expect(r.chain).toEqual({ ok: true });
  expect(r.lines).toHaveLength(6);
  expect(r.lines[5]).toMatchObject({ kind: "reseal", broke_at: 2, file_sha256: sha256Hex(bytesBefore), by: "owner", seq: 6 });
  expect(r.lines[5]!.id).toMatch(/^s-20260302-[0-9a-f]{8}$/);

  await appendLine<RecallLine>(home, "recalls.jsonl", "agent-one", c.now(), "r", recall);
  r = await readLog(home, "recalls.jsonl");
  expect(r.chain).toEqual({ ok: true });

  await editLine("recalls.jsonl", 4);
  r = await readLog(home, "recalls.jsonl");
  expect(r.chain).toEqual({ ok: false, line: 6 });
});

test("reseal on a sound chain does nothing", async () => {
  await appendFive();
  const before = await readFile(join(home, "recalls.jsonl"));
  expect(await resealLog(home, "recalls.jsonl", c.now())).toBeNull();
  expect(await readFile(join(home, "recalls.jsonl"))).toEqual(before);
});

test("a stale lock is broken", async () => {
  const lock = join(home, "lock");
  await mkdir(lock);
  const old = new Date(Date.now() - 11_000);
  await utimes(lock, old, old);
  const a = await appendLine<RecallLine>(home, "recalls.jsonl", "agent-one", c.now(), "r", recall);
  expect(a.seq).toBe(1);
});

test("a held lock refuses the write", async () => {
  await mkdir(join(home, "lock"));
  let ran = false;
  await expect(withLock(home, async () => { ran = true; }, { waitMs: 200 })).rejects.toMatchObject({
    code: "E_LOCKED", message: "the memory is busy: another process holds its lock",
  });
  expect(ran).toBe(false);
});

test("two processes lose no line and tear none", async () => {
  await Promise.all(["agent-one", "agent-two"].map((n) => run(process.execPath, ["--import", "tsx", "test/fixtures/appender.ts", home, "200", n])));
  const r = await readLog<RecallLine>(home, "recalls.jsonl");
  expect(r.chain).toEqual({ ok: true }); expect(r.lines.map((l) => l.seq)).toEqual(range(1, 400));
  expect(r.lines.filter((l) => l.by === "agent-one")).toHaveLength(200);
}, 120_000);

test("a stale lock raced by many appenders in two processes loses no line and tears none", async () => {
  const TRIALS = 150;
  const homes: string[] = [];
  const old = new Date(Date.now() - 60_000);
  for (let i = 0; i < TRIALS; i++) {
    const h = await tempHome();
    await mkdir(join(h, "lock"));
    await utimes(join(h, "lock"), old, old);
    homes.push(h);
  }
  const list = join(await tempHome({ init: false }), "homes.json");
  await writeFile(list, JSON.stringify(homes));
  const start = String(Date.now() + 1500);                         // both processes are up by then, and start each home at once
  const counts = await Promise.all(["agent-one", "agent-two"].map(async (n) =>
    JSON.parse(await run(process.execPath, ["--import", "tsx", "test/fixtures/racer.ts", list, start, "8", "6", n])) as number[]));

  const bad: string[] = [];
  for (const [i, h] of homes.entries()) {
    const ok = counts[0]![i]! + counts[1]![i]!;
    const r = await readLog<RecallLine>(h, "recalls.jsonl");
    const text = await readFile(join(h, "recalls.jsonl"), "utf8");
    if (r.lines.length !== ok || r.skipped !== 0 || r.partial || !r.chain.ok || text.split("\n").length - 1 !== ok) {
      bad.push(`trial ${i}: ${ok} appends reported success, ${r.lines.length} lines, ${r.skipped} torn, chain ${JSON.stringify(r.chain)}`);
    }
  }
  expect(bad).toEqual([]);
}, 60_000);

test("release leaves a lock that another holder has taken since", async () => {
  const lock = join(home, "lock");
  await withLock(home, async () => {
    await rm(lock, { recursive: true, force: true });              // broken meanwhile by a waiter, who took it
    await mkdir(lock);
    await writeFile(join(lock, "token"), "another holder");
  });
  expect(await readFile(join(lock, "token"), "utf8")).toBe("another holder");
});

test("a stale lock.break is broken too, and a fresh one is waited on", async () => {
  const lock = join(home, "lock");
  const breaker = join(home, "lock.break");
  const old = new Date(Date.now() - 60_000);
  await mkdir(lock);
  await mkdir(breaker);
  await utimes(lock, old, old);
  await utimes(breaker, old, old);
  const a = await appendLine<RecallLine>(home, "recalls.jsonl", "agent-one", c.now(), "r", recall);
  expect(a.seq).toBe(1);
  await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(breaker)).rejects.toMatchObject({ code: "ENOENT" });

  await mkdir(lock);
  await mkdir(breaker);                                           // a breaker at work: the stale lock is not broken by a second
  await utimes(lock, old, old);
  await expect(withLock(home, async () => undefined, { waitMs: 200 })).rejects.toMatchObject({ code: "E_LOCKED" });
});
