// src/home.ts — where the memory lives: making it, finding it, reading its config
import { chmod, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { MemoryError } from "./errors.js";
import { DEFAULT_HORIZONS, EVERY_MINUTES_MAX, HORIZON_MAX, HORIZON_MIN } from "./limits.js";
import type { Config } from "./types.js";

export const FILES = { decisions: "decisions.jsonl", recalls: "recalls.jsonl", outcomes: "outcomes.jsonl",
  proposals: "proposals.jsonl", owner: "owner.jsonl" } as const;

export const DEFAULT_CONFIG: Config = {
  prices: {
    url: "",
    markets: {
      US: { venue: "cboe", benchmark: "SPY", zone: "America/New_York", close: "16:00" },
      CN: { venue: "china", zone: "Asia/Shanghai", close: "15:00" },
    },
  },
  horizons: [...DEFAULT_HORIZONS],
};

const VERSION = "1";
const DIRS = ["lessons", "armed"] as const;
const POSIX = process.platform !== "win32";

const configSchema = z.object({
  prices: z.object({
    url: z.string(),
    markets: z.record(z.string(), z.object({
      venue: z.string().min(1),
      benchmark: z.string().min(1).optional(),
      zone: z.string().min(1),
      close: z.string().regex(/^\d{2}:\d{2}$/, "must be HH:MM"),
    })),
    every_minutes: z.number().int().min(0).max(EVERY_MINUTES_MAX).optional(),
  }),
  horizons: z.array(z.number().int().min(HORIZON_MIN).max(HORIZON_MAX)).min(1),
});

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GRAVIT_MEMORY_HOME || join(homedir(), ".gravit-memory");
}

export async function initHome(home: string): Promise<{ created: boolean }> {
  const dir = resolve(home);
  await refuseInsideRepo(dir);
  const entries = await listing(dir);
  if (entries?.includes("VERSION")) {
    await assertHome(dir);
    return { created: false };
  }
  if (entries && entries.length > 0) {
    throw new MemoryError("E_HOME_NOT_EMPTY", `${dir} holds something else: choose an empty or new directory for the memory`);
  }

  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (POSIX) await chmod(dir, 0o700);
  for (const d of DIRS) await mkdir(join(dir, d), { mode: 0o700 });
  await create(join(dir, "config.json"), `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  for (const f of Object.values(FILES)) await create(join(dir, f), "");
  await create(join(dir, "VERSION"), `${VERSION}\n`); // last: a home counts as made once VERSION is there
  return { created: true };
}

export async function assertHome(home: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(home, "VERSION"), "utf8");
  } catch (err) {
    if (isCode(err, "ENOENT") || isCode(err, "ENOTDIR")) {
      throw new MemoryError("E_NO_HOME", "no memory here: run gravit-memory init");
    }
    throw err;
  }
  const found = text.trim();
  if (found !== VERSION) {
    throw new MemoryError("E_VERSION",
      `this memory is version ${JSON.stringify(found)} and this gravit-memory reads version ${VERSION}: use a gravit-memory that reads it`);
  }
}

export async function readConfig(home: string): Promise<Config> {
  await assertHome(home);
  const text = await readFile(join(home, "config.json"), "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new MemoryError("E_INPUT", "config.json is not valid JSON");
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue ? issue.path.map(String).join(".") : "";
    throw new MemoryError("E_INPUT", `config.json: ${key || "the file"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

/** "Inside a git work tree": the home or any parent directory holds an entry named .git. */
async function refuseInsideRepo(dir: string): Promise<void> {
  for (let at = dir; ; at = dirname(at)) {
    if (await exists(join(at, ".git"))) {
      throw new MemoryError("E_HOME_IN_REPO", `${dir} is inside a git work tree (${at}): the memory never lives in a repository`);
    }
    if (dirname(at) === at) return;
  }
}

/** The entries of dir, or null when it does not exist. */
async function listing(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir);
  } catch (err) {
    if (isCode(err, "ENOENT")) return null;
    if (isCode(err, "ENOTDIR")) {
      throw new MemoryError("E_HOME_NOT_EMPTY", `${dir} is a file, not a directory: choose an empty or new directory for the memory`);
    }
    throw err;
  }
}

async function create(file: string, text: string): Promise<void> {
  await writeFile(file, text, { flag: "wx", mode: 0o600 });
  if (POSIX) await chmod(file, 0o600);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (isCode(err, "ENOENT") || isCode(err, "ENOTDIR")) return false;
    throw err;
  }
}

function isCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}
