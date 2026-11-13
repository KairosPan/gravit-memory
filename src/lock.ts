// src/lock.ts — one writer at a time: the directory lock/ in the home
//
// lock/ is made with mkdir, which only one process wins, and holds a token file naming the holder; release removes
// lock/ only while that token is still its own. A lock older than LOCK_STALE_MS is taken as left behind, and broken
// only by the process that holds lock.break/ (made the same way, and broken by the same rule), which checks the
// lock's age again inside it: so two waiters never both break a lock and both take the fresh one.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MemoryError } from "./errors.js";
import { LOCK_STALE_MS, LOCK_WAIT_MS } from "./limits.js";

const RETRY_MS = 25;
const TOKEN = "token";

/**
 * Runs fn while holding the home's lock. A lock older than LOCK_STALE_MS is taken as left behind and broken;
 * a live one is waited on, every 25 ms, until waitMs has passed, then E_LOCKED.
 */
export async function withLock<T>(home: string, fn: () => Promise<T>, opts?: { waitMs?: number }): Promise<T> {
  const dir = join(home, "lock");
  const token = randomBytes(16).toString("hex");
  const until = Date.now() + (opts?.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    if (await take(dir, token)) break;
    const age = await ageOf(dir);
    if (age === null) continue; // released meanwhile
    if (age > LOCK_STALE_MS) {
      await breakStale(home, dir);                                   // waits a retry itself when another is breaking
      if (await take(dir, token)) break;
    }
    if (Date.now() >= until) throw new MemoryError("E_LOCKED", "the memory is busy: another process holds its lock");
    if (age <= LOCK_STALE_MS) await sleep(RETRY_MS);
  }
  try {
    return await fn();
  } finally {
    // A lock that cannot be removed goes stale and is broken by the next writer; fn's own outcome stands.
    await release(dir, token).catch(() => undefined);
  }
}

/** Makes the lock directory and writes this holder's token in it; false when another holds it. */
async function take(dir: string, token: string): Promise<boolean> {
  try {
    await mkdir(dir);
  } catch (err) {
    if (codeOf(err) === "ENOENT") throw new MemoryError("E_NO_HOME", "no memory here: run gravit-memory init");
    if (codeOf(err) === "EEXIST") return false;
    throw err;
  }
  try {
    await writeFile(join(dir, TOKEN), token);
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return true;
}

/** Removes the lock only while its token is this holder's: a lock broken and taken by another is left to it. */
async function release(dir: string, token: string): Promise<void> {
  const held = await readFile(join(dir, TOKEN), "utf8").catch(() => null);
  if (held !== token) return;
  await unlink(join(dir, TOKEN));
  await rmdir(dir);
}

/**
 * Breaks the lock if it is still stale, while holding lock.break/; when another holds lock.break/ (and it is not
 * stale itself), does nothing, and the caller waits as for any lock.
 */
async function breakStale(home: string, dir: string): Promise<void> {
  const breaker = join(home, "lock.break");
  try {
    await mkdir(breaker);
  } catch (err) {
    if (codeOf(err) !== "EEXIST") throw err;
    const age = await ageOf(breaker);
    if (age !== null && age > LOCK_STALE_MS) await rm(breaker, { recursive: true, force: true });
    else await sleep(RETRY_MS);
    return;
  }
  try {
    const age = await ageOf(dir);
    if (age !== null && age > LOCK_STALE_MS) await rm(dir, { recursive: true, force: true });
  } finally {
    await rmdir(breaker).catch(() => undefined);
  }
}

/** Milliseconds since the directory was made or its token written, or null when it is gone. */
async function ageOf(dir: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(dir)).mtimeMs;
  } catch (err) {
    if (codeOf(err) === "ENOENT") return null;
    throw err;
  }
}

function codeOf(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}
