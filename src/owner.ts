// src/owner.ts — the owner's acts on a card: arm, retire, discard
//
// Only the owner's door calls these (the command line, Memory.owner); no agent-facing path reaches them. Each
// writes its file first and its owner.jsonl line, `by: "owner"`, after: a crash between leaves a file no line
// names, never a line naming a file that is not there.
import { chmod, writeFile } from "node:fs/promises";
import { armedPath, cardStates, lessonPath, parseCard, readBytes, readCardFile, unreadable } from "./cards.js";
import { MemoryError } from "./errors.js";
import { assertHome } from "./home.js";
import { sha256Hex } from "./ids.js";
import { LESSON_ID, REASON_MAX } from "./limits.js";
import { appendLine } from "./log.js";
import type { OwnerLine } from "./types.js";

const POSIX = process.platform !== "win32";

/**
 * Arms lessons/<lesson>.md as it is now: copies its bytes to armed/ and writes the owner's arm line. With `expect`, the
 * SHA-256 of the text the owner was shown, the bytes read (the ones copied) must hash to it, else nothing is armed. A
 * file that is a directory or cannot be read is refused as a file that is not a card is: E_CARD, saying why.
 */
export async function arm(home: string, lesson: string, nowMs: number, expect?: string): Promise<{ sha256: string }> {
  checkLesson(lesson);
  await assertHome(home);
  const bytes = await readCardFile(lessonPath(home, lesson));
  if (bytes === null) throw new MemoryError("E_NOT_FOUND", `lesson ${lesson} has no file: write lessons/${lesson}.md first.`);
  if (unreadable(bytes)) {
    throw new MemoryError("E_CARD", `card ${lesson} cannot be armed: lessons/${lesson}.md ${bytes.unreadable === "a directory"
      ? "is a directory, not a card file" : "cannot be read"}.`);
  }
  const sha256 = sha256Hex(bytes);
  if (expect !== undefined && sha256 !== expect) {
    throw new MemoryError("E_REFUSED", "the card changed while it was shown: nothing was armed.");
  }
  parseCard(bytes, lesson);
  await writePrivate(armedPath(home, lesson, sha256), bytes);
  await appendLine<OwnerLine>(home, "owner.jsonl", "owner", nowMs, "w", { kind: "owner", act: "arm", lesson, sha256 });
  return { sha256 };
}

/** Retires an armed card: it applies no more until armed again. */
export async function retire(home: string, lesson: string, reason: string, nowMs: number): Promise<void> {
  checkLesson(lesson);
  const n = [...reason].length;
  if (n < 1 || n > REASON_MAX) throw new MemoryError("E_INPUT", `reason must hold 1 to ${REASON_MAX} characters.`);
  const state = (await cardStates(home)).cards.find((c) => c.id === lesson);
  if (!state || !(state.state === "armed" || state.state === "changed" || state.state === "broken")) {
    throw new MemoryError("E_REFUSED", `lesson ${lesson} is not armed: only an armed card is retired.`);
  }
  await appendLine<OwnerLine>(home, "owner.jsonl", "owner", nowMs, "w", { kind: "owner", act: "retire", lesson, reason });
}

/** Puts a changed card's working file back as it was armed (D-g). */
export async function discard(home: string, lesson: string, nowMs: number): Promise<void> {
  checkLesson(lesson);
  const state = (await cardStates(home)).cards.find((c) => c.id === lesson);
  if (state?.state !== "changed") {
    throw new MemoryError("E_REFUSED", `lesson ${lesson} is not changed since it was armed: there is nothing to discard.`);
  }
  const bytes = await readBytes(armedPath(home, lesson, state.sha256!));
  if (bytes === null) throw new MemoryError("E_REFUSED", `lesson ${lesson} has lost its armed copy.`);
  await writePrivate(lessonPath(home, lesson), bytes);
  await appendLine<OwnerLine>(home, "owner.jsonl", "owner", nowMs, "w", { kind: "owner", act: "discard", lesson });
}

function checkLesson(lesson: string): void {
  if (!LESSON_ID.test(lesson)) {
    throw new MemoryError("E_INPUT", "lesson must be a lesson id: lower-case letters, digits and dashes, 2 to 40.");
  }
}

/** Writes a file of the home readable by its user alone. */
export async function writePrivate(path: string, bytes: Uint8Array | string): Promise<void> {
  await writeFile(path, bytes, { mode: 0o600 });
  if (POSIX) await chmod(path, 0o600);
}
