// Appends n recall lines to a home's recalls.jsonl as one writer: node --import tsx appender.ts <home> <n> <name>
import { MemoryError } from "../../src/errors.js";
import { appendLine } from "../../src/log.js";
import type { RecallLine } from "../../src/types.js";

const [home, count, name] = process.argv.slice(2);
if (!home || !count || !name) throw new Error("usage: appender.ts <home> <n> <name>");

for (let i = 0; i < Number(count); i++) {
  // The lock is not fair: a refused append is tried again, since this fixture tests lost and torn lines, not waiting.
  for (;;) {
    try {
      await appendLine<RecallLine>(home, "recalls.jsonl", name, Date.now(), "r",
        { kind: "recall", considering: ["buy"], applied: [], untold: [] });
      break;
    } catch (err) {
      if (!(err instanceof MemoryError && err.code === "E_LOCKED")) throw err;
    }
  }
}
