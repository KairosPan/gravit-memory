// Races appenders on homes left with a stale lock: node --import tsx racer.ts <homes.json> <start ms> <slot ms> <k> <name>
// For home i, at start + i * slot by the wall clock (so every racer process starts on the same home at once), fires k
// appends at once, and prints how many of each home's appends reported success, as a JSON array.
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { appendLine } from "../../src/log.js";
import type { RecallLine } from "../../src/types.js";

const [file, start, slot, k, name] = process.argv.slice(2);
if (!file || !start || !slot || !k || !name) throw new Error("usage: racer.ts <homes.json> <start ms> <slot ms> <k> <name>");
const homes = JSON.parse(await readFile(file, "utf8")) as string[];

const trials = homes.map(async (home, i) => {
  const at = Number(start) + i * Number(slot);
  if (at > Date.now()) await sleep(at - Date.now());
  const results = await Promise.allSettled(Array.from({ length: Number(k) }, () =>
    appendLine<RecallLine>(home, "recalls.jsonl", name, Date.now(), "r", { kind: "recall", considering: ["buy"], applied: [], untold: [] })));
  return results.filter((r) => r.status === "fulfilled").length;
});
process.stdout.write(JSON.stringify(await Promise.all(trials)));
