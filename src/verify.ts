// src/verify.ts — whether the home holds together: every chain, every id a line points at, every armed copy
//
// A line that points at an id is looked up among the lines of the file that holds such ids: a decision's recall,
// an amendment's and an outcome's decision, a proposal's evidence, the proposal an owner's answer names. Line
// numbers are a file's, 1-based, counting every complete line.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type CardState } from "./cards.js";
import { status, type Status } from "./review.js";
import type { LogFile } from "./types.js";

export interface VerifyReport { ok: boolean; chains: Status["chains"]; dangling: Array<{ file: LogFile; line: number; points_at: string }>; cards: CardState[] }

type Obj = Record<string, unknown>;

/** Sound when every chain holds, no line points at an id that is gone, and no armed card is broken. */
export async function verify(home: string): Promise<VerifyReport> {
  const { chains, cards } = await status(home);
  const files = {
    decisions: await numbered(home, "decisions.jsonl"),
    recalls: await numbered(home, "recalls.jsonl"),
    outcomes: await numbered(home, "outcomes.jsonl"),
    proposals: await numbered(home, "proposals.jsonl"),
    owner: await numbered(home, "owner.jsonl"),
  };
  const idsOf = (lines: Array<{ obj: Obj }>, kind: string) =>
    new Set(lines.flatMap(({ obj }) => (obj.kind === kind && typeof obj.id === "string" ? [obj.id] : [])));
  const decisions = idsOf(files.decisions, "decision");
  const recalls = idsOf(files.recalls, "recall");
  const proposals = idsOf(files.proposals, "proposal");

  const dangling: VerifyReport["dangling"] = [];
  const check = (file: LogFile, line: number, id: unknown, among: Set<string>) => {
    if (typeof id === "string" && !among.has(id)) dangling.push({ file, line, points_at: id });
  };
  for (const { line, obj } of files.decisions) {
    if (obj.kind === "decision" && obj.recall !== undefined) check("decisions.jsonl", line, obj.recall, recalls);
    if (obj.kind === "amend") check("decisions.jsonl", line, obj.decision, decisions);
  }
  for (const { line, obj } of files.outcomes) {
    if (obj.kind === "outcome") check("outcomes.jsonl", line, obj.decision, decisions);
  }
  for (const { line, obj } of files.proposals) {
    if (obj.kind === "proposal" && Array.isArray(obj.evidence)) {
      for (const id of obj.evidence) check("proposals.jsonl", line, id, decisions);
    }
  }
  for (const { line, obj } of files.owner) {
    if (obj.kind === "owner" && (obj.act === "accept" || obj.act === "edit" || obj.act === "reject")) {
      check("owner.jsonl", line, obj.proposal, proposals);
    }
  }

  const ok = chains.every((c) => c.ok) && dangling.length === 0 && !cards.some((c) => c.state === "broken");
  return { ok, chains, dangling, cards };
}

/** The complete lines of a file that are JSON objects, each with its 1-based number in the file. */
async function numbered(home: string, file: LogFile): Promise<Array<{ line: number; obj: Obj }>> {
  const parts = (await readFile(join(home, file), "utf8")).split("\n");
  parts.pop();                                                         // a partial last line, or the empty tail
  return parts.flatMap((text, i) => {
    try {
      const obj: unknown = JSON.parse(text);
      return typeof obj === "object" && obj !== null && !Array.isArray(obj) ? [{ line: i + 1, obj: obj as Obj }] : [];
    } catch {
      return [];
    }
  });
}
