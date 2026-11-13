// src/lock.ts — one writer at a time: the directory lock/ in the home
import { mkdir, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MemoryError } from "./errors.js";
import { LOCK_STALE_MS, LOCK_WAIT_MS } from "./limits.js";

const RETRY_MS = 25;

/**
 * Runs fn while holding the home's lock. A lock older than LOCK_STALE_MS is taken as left behind and broken;
 * a live one is waited on, every 25 ms, until waitMs has passed, then E_LOCKED.
 */
export async function withLock<T>(home: string, fn: () => Promise<T>, opts?: { waitMs?: number }): Promise<T> {
  const dir = join(home, "lock");
  const until = Date.now() + (opts?.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    try {
      await mkdir(dir);
      break;
    } catch (err) {
      if (codeOf(err) === "ENOENT") throw new MemoryError("E_NO_HOME", "no memory here: run gravit-memory init");
      if (codeOf(err) !== "EEXIST") throw err;
    }
    const age = await ageOf(dir);
    if (age === null) continue; // released meanwhile
    if (age > LOCK_STALE_MS) {
      await rmdir(dir).catch((err: unknown) => { if (codeOf(err) !== "ENOENT") throw err; });
      continue;
    }
    if (Date.now() >= until) throw new MemoryError("E_LOCKED", "the memory is busy: another process holds its lock");
    await sleep(RETRY_MS);
  }
  try {
    return await fn();
  } finally {
    // A lock that cannot be removed goes stale and is broken by the next writer; fn's own outcome stands.
    await rmdir(dir).catch(() => undefined);
  }
}

/** Milliseconds since the lock was taken, or null when it is gone. */
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
