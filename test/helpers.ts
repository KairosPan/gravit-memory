import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { initHome } from "../src/home.js";

export { DAY, HOUR } from "../src/limits.js";

const made: string[] = [];

afterEach(async () => {
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
