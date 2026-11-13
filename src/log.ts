// src/log.ts — the append-only, hash-chained JSONL files of the home
//
// Each line is one JSON object, keys in the order v, kind, id, seq, prev, t, by, the caller's fields, sum.
// `prev` is the SHA-256 of the previous line's text; `sum` the SHA-256 of the line's own text before `sum` was
// added (D-a). A file is verified from its last reseal line on (D-b), or from line 1.
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryError } from "./errors.js";
import { assertHome } from "./home.js";
import { newId, sha256Hex } from "./ids.js";
import { LINE_MAX_BYTES } from "./limits.js";
import { withLock } from "./lock.js";
import type { IdPrefix, LineBase, LogFile, ResealLine } from "./types.js";

/** What a caller gives appendLine for a line type L: its own fields and its kind. Distributes over unions. */
export type Fields<L> = L extends LineBase ? Omit<L, keyof LineBase> & { kind: L["kind"] } : never;

export interface LogRead<L> { lines: L[]; partial: boolean; skipped: number; chain: { ok: true } | { ok: false; line: number } }

type Chain = LogRead<unknown>["chain"];
type Built = { kind: string } & Record<string, unknown>;

/** One complete line of a file: its text without the newline, where it starts, and its object if it has a kind. */
interface Raw { text: string; start: number; line: LineBase | null }

const BASE_KEYS = new Set(["v", "id", "seq", "prev", "t", "by", "sum"]);
const SUM_TAIL = /,"sum":"([0-9a-f]{64})"\}$/;

/** Appends one line as `by`, under the home's lock, and returns it as written. */
export async function appendLine<L extends LineBase>(home: string, file: LogFile, by: string, nowMs: number,
  prefix: IdPrefix, fields: Fields<L>): Promise<L> {
  const line = await appendWith<L>(home, file, by, nowMs, prefix, () => fields as Built);
  return line!;
}

/** Reads a file: its lines, whether a partial last line was left aside, how many lines were not lines, the chain. */
export async function readLog<L extends LineBase>(home: string, file: LogFile): Promise<LogRead<L>> {
  await assertHome(home);
  const buf = await readFile(join(home, file));
  const { raws, partial } = split(buf);
  const lines = raws.flatMap((r) => (r.line ? [r.line as L] : []));
  return { lines, partial, skipped: raws.length - lines.length, chain: verify(buf, raws) };
}

/**
 * When a file's chain is broken, appends the owner's reseal line naming where it broke and the hash of every byte
 * before it, so the chain is verified from there on. A sound chain is left as it is: null.
 */
export async function resealLog(home: string, file: LogFile, nowMs: number): Promise<{ broke_at: number } | null> {
  const line = await appendWith<ResealLine>(home, file, "owner", nowMs, "s", (complete, raws) => {
    const chain = verify(complete, raws);
    return chain.ok ? null : { kind: "reseal", broke_at: chain.line, file_sha256: sha256Hex(complete) };
  });
  return line ? { broke_at: line.broke_at } : null;
}

/**
 * Inside the lock: reads the file, asks build for the fields given its complete lines (null appends nothing and
 * changes nothing), cuts a partial last line, and writes the new line and its newline in one write, then fsync.
 */
async function appendWith<L extends LineBase>(home: string, file: LogFile, by: string, nowMs: number, prefix: IdPrefix,
  build: (complete: Buffer, raws: Raw[]) => Built | null): Promise<L | null> {
  await assertHome(home);
  return withLock(home, async () => {
    const handle = await open(join(home, file), "r+");
    try {
      const buf = await handle.readFile();
      const { raws, cut } = split(buf);
      const fields = build(buf.subarray(0, cut), raws);
      if (!fields) return null;

      const last = raws.at(-1);
      const obj: Record<string, unknown> = {
        v: 1, kind: fields.kind, id: newId(prefix, nowMs), seq: nextSeq(raws),
        prev: last ? sha256Hex(last.text) : null, t: new Date(nowMs).toISOString(), by,
      };
      for (const [key, value] of Object.entries(fields)) {
        if (key === "kind") continue;
        if (BASE_KEYS.has(key)) throw new MemoryError("E_INPUT", `${key} is written by the log itself, not given`);
        obj[key] = value;
      }
      const text0 = JSON.stringify(obj);
      const sum = sha256Hex(text0);
      const text = `${text0.slice(0, -1)},"sum":"${sum}"}`;
      const size = Buffer.byteLength(text);
      if (size > LINE_MAX_BYTES) {
        throw new MemoryError("E_INPUT", `the line would be ${size} bytes: a line holds at most ${LINE_MAX_BYTES} bytes`);
      }

      if (cut < buf.length) await handle.truncate(cut);
      const out = Buffer.from(`${text}\n`);
      const { bytesWritten } = await handle.write(out, 0, out.length, cut);
      if (bytesWritten !== out.length) throw new Error(`${file}: wrote ${bytesWritten} of ${out.length} bytes`);
      await handle.sync();
      return JSON.parse(text) as L;
    } finally {
      await handle.close();
    }
  });
}

/** The complete lines of a file; a last line without its newline is partial and left out. */
function split(buf: Buffer): { raws: Raw[]; cut: number; partial: boolean } {
  const raws: Raw[] = [];
  let start = 0;
  for (let nl = buf.indexOf(0x0a); nl !== -1; nl = buf.indexOf(0x0a, start)) {
    const text = buf.toString("utf8", start, nl);
    raws.push({ text, start, line: parse(text) });
    start = nl + 1;
  }
  return { raws, cut: start, partial: start < buf.length };
}

function parse(text: string): LineBase | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)
      && typeof (value as { kind?: unknown }).kind === "string") return value as LineBase;
  } catch {
    // not JSON: counted as skipped by the caller
  }
  return null;
}

function nextSeq(raws: Raw[]): number {
  for (let i = raws.length - 1; i >= 0; i--) {
    const seq = raws[i]!.line?.seq;
    if (typeof seq === "number") return seq + 1;
  }
  return 1;
}

/** The first line, 1-based, where the chain fails, verifying from the last reseal line on. */
function verify(buf: Buffer, raws: Raw[]): Chain {
  let from = 0;
  for (let i = raws.length - 1; i >= 0; i--) {
    if (raws[i]!.line?.kind === "reseal") { from = i; break; }
  }
  for (let i = from; i < raws.length; i++) {
    const raw = raws[i]!;
    const line = raw.line;
    const before = i > 0 ? raws[i - 1]! : undefined;
    const prev = before ? sha256Hex(before.text) : null;
    let holds = line !== null && sumHolds(raw.text, line.sum) && line.prev === prev;
    if (holds && i === from && line!.kind === "reseal") {
      holds = (line as ResealLine).file_sha256 === sha256Hex(buf.subarray(0, raw.start));
    } else if (holds) {
      holds = line!.seq === (before ? before.line!.seq + 1 : 1);
    }
    if (!holds) return { ok: false, line: i + 1 };
  }
  return { ok: true };
}

/** A line's sum is the hash of its text with the trailing `,"sum":"…"` taken out. */
function sumHolds(text: string, sum: unknown): boolean {
  const tail = SUM_TAIL.exec(text);
  return tail !== null && tail[1] === sum && sha256Hex(`${text.slice(0, -tail[0].length)}}`) === sum;
}
