import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
