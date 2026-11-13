import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { cardStates, type CardState } from "../src/cards.js";
import type { Code } from "../src/errors.js";
import { sha256Hex } from "../src/ids.js";
import { appendLine, readLog, resealLog } from "../src/log.js";
import { arm, discard, retire } from "../src/owner.js";
import type { OwnerLine } from "../src/types.js";
import { HOUR, STAND_IN_CARD, clock, tempHome, writeCard } from "./helpers.js";

const ARMED_WORDS = "No new position in a name that ran 20% in five sessions.";

let home: string;
let c: ReturnType<typeof clock>;

beforeEach(async () => {
  home = await tempHome();
  c = clock("2026-03-02T15:00:00Z");
});

/** Runs p and expects it to fail with a MemoryError of the given code; returns its message. */
async function fails(p: Promise<unknown>, code: Code): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected ${code}, but it succeeded`).not.toBeNull();
  expect((err as { code?: string }).code).toBe(code);
  return (err as Error).message;
}

async function stateOf(id: string): Promise<CardState> {
  const s = await cardStates(home);
  const one = s.cards.find((x) => x.id === id);
  expect(one).toBeDefined();
  return one!;
}

const lessonFile = (id: string) => join(home, "lessons", `${id}.md`);
const armedFile = (id: string, sha256: string) => join(home, "armed", `${id}.${sha256.slice(0, 12)}.md`);
const ownerLines = async () => (await readLog<OwnerLine>(home, "owner.jsonl")).lines.filter((l) => l.kind === "owner");

test("arm copies the card and writes the owner's line", async () => {
  const id = await writeCard(home);
  const { sha256 } = await arm(home, id, c.now());
  expect(sha256).toBe(sha256Hex(await readFile(join(home, "lessons", `${id}.md`))));
  expect(await readFile(join(home, "armed", `${id}.${sha256.slice(0, 12)}.md`), "utf8")).toBe(STAND_IN_CARD);
  expect((await readLog<OwnerLine>(home, "owner.jsonl")).lines[0]).toMatchObject({ kind: "owner", act: "arm", lesson: id, sha256, by: "owner" });
  const s = await cardStates(home);
  expect(s.cards).toMatchObject([{ id, state: "armed" }]);
  expect(s.applying.map((x) => x.id)).toEqual([id]);
  expect(s.ownerChainBroken).toBe(false);
  expect(s.cards[0]).toMatchObject({ sha256, armedAt: new Date(c.now()).toISOString() });
  if (process.platform !== "win32") expect((await stat(armedFile(id, sha256))).mode & 0o777).toBe(0o600);
});

test("armedAt is the time of the line that armed the card", async () => {
  const id = await writeCard(home);
  await arm(home, id, c.now());
  c.advance(HOUR);
  await writeCard(home, STAND_IN_CARD.replace(ARMED_WORDS, "A second sentence."));
  const { sha256 } = await arm(home, id, c.now());
  const one = await stateOf(id);
  expect(one).toMatchObject({ state: "armed", sha256, armedAt: new Date(c.now()).toISOString() });
  expect(one.card?.words).toBe("A second sentence.");
});

test("a card edited after arming applies as armed", async () => {
  const id = await writeCard(home);
  await arm(home, id, c.now());
  await writeCard(home, STAND_IN_CARD.replace(ARMED_WORDS, "Rewritten after arming."));
  expect((await stateOf(id)).state).toBe("changed");
  const s = await cardStates(home);
  expect(s.applying).toHaveLength(1);
  expect(s.applying[0]!.words).toBe(ARMED_WORDS);
});

test("re-saved with CRLF it is changed, not broken", async () => {
  const id = await writeCard(home);
  await arm(home, id, c.now());
  await writeCard(home, STAND_IN_CARD.replaceAll("\n", "\r\n"));
  expect((await stateOf(id)).state).toBe("changed");
  expect((await cardStates(home)).applying).toHaveLength(1);
});

test("an armed copy tampered with does not apply", async () => {
  const id = await writeCard(home);
  const { sha256 } = await arm(home, id, c.now());
  await writeFile(armedFile(id, sha256), STAND_IN_CARD.replace("strength: caveat", "strength: red-line"));
  const one = await stateOf(id);
  expect(one.state).toBe("broken");
  expect(one.fault).toBeTruthy();
  expect((await cardStates(home)).applying).toEqual([]);
});

test("an armed copy gone missing does not apply", async () => {
  const id = await writeCard(home);
  const { sha256 } = await arm(home, id, c.now());
  await rm(armedFile(id, sha256));
  expect((await stateOf(id)).state).toBe("broken");
  expect((await cardStates(home)).applying).toEqual([]);
});

test("a card never armed does not apply", async () => {
  const id = await writeCard(home);
  expect(await stateOf(id)).toMatchObject({ state: "unarmed", card: { id } });
  await writeFile(lessonFile("half-written"), "---\nid: half-written\nsays: dont\n");
  const bad = await stateOf("half-written");
  expect(bad.state).toBe("refused");
  expect(bad.fault).toContain("front matter");
  expect((await cardStates(home)).applying).toEqual([]);
});

test("arm refuses a card that does not parse", async () => {
  const id = await writeCard(home, STAND_IN_CARD.replace("says: dont", "says: never"));
  await fails(arm(home, id, c.now()), "E_CARD");
  expect(await readFile(join(home, "owner.jsonl"), "utf8")).toBe("");
});

test("arm arms only the bytes the owner was shown", async () => {
  const id = await writeCard(home);
  const shown = sha256Hex(STAND_IN_CARD);
  await writeCard(home, STAND_IN_CARD.replace("20%", "25%"));
  expect(await fails(arm(home, id, c.now(), shown), "E_REFUSED")).toBe("the card changed while it was shown: nothing was armed.");
  expect(await readFile(join(home, "owner.jsonl"), "utf8")).toBe("");
  expect(await readdir(join(home, "armed"))).toEqual([]);
  expect((await stateOf(id)).state).toBe("unarmed");

  const { sha256 } = await arm(home, id, c.now(), sha256Hex(STAND_IN_CARD.replace("20%", "25%")));
  expect(await readFile(armedFile(id, sha256), "utf8")).toContain("25%");
  expect((await stateOf(id)).state).toBe("armed");
});

test("arm refuses a lesson with no file", async () => {
  await fails(arm(home, "no-such-lesson", c.now()), "E_NOT_FOUND");
  expect(await readFile(join(home, "owner.jsonl"), "utf8")).toBe("");
});

test("retire, then arm again", async () => {
  const id = await writeCard(home);
  await arm(home, id, c.now());
  await retire(home, id, "The run rule fired on every rally.", c.now());
  expect((await stateOf(id)).state).toBe("retired");
  expect((await cardStates(home)).applying).toEqual([]);
  expect((await ownerLines()).at(-1)).toMatchObject({ act: "retire", lesson: id, reason: "The run rule fired on every rally.", by: "owner" });
  await arm(home, id, c.now());
  expect((await stateOf(id)).state).toBe("armed");
  expect((await cardStates(home)).applying).toHaveLength(1);
});

test("retire refuses a card that is not armed", async () => {
  const id = await writeCard(home);
  await fails(retire(home, id, "Never armed.", c.now()), "E_REFUSED");
  await arm(home, id, c.now());
  await retire(home, id, "Done with it.", c.now());
  await fails(retire(home, id, "Again.", c.now()), "E_REFUSED");
});

test("an accept with no sha256 retires the card", async () => {
  const id = await writeCard(home);
  await arm(home, id, c.now());
  await appendLine<OwnerLine>(home, "owner.jsonl", "owner", c.now(), "w",
    { kind: "owner", act: "accept", proposal: "p-20260302-0f3a9c21", lesson: id });
  expect((await stateOf(id)).state).toBe("retired");
  expect((await cardStates(home)).applying).toEqual([]);
});

test("an accept with a sha256 arms the card", async () => {
  const id = await writeCard(home);
  const sha256 = sha256Hex(await readFile(lessonFile(id)));
  await writeFile(armedFile(id, sha256), await readFile(lessonFile(id)));
  const line = await appendLine<OwnerLine>(home, "owner.jsonl", "owner", c.now(), "w",
    { kind: "owner", act: "accept", proposal: "p-20260302-0f3a9c21", lesson: id, sha256 });
  expect(await stateOf(id)).toMatchObject({ state: "armed", sha256, armedAt: line.t });
});

test("an owner's line not written by the owner counts for nothing", async () => {
  const id = await writeCard(home);
  const sha256 = sha256Hex(await readFile(lessonFile(id)));
  await writeFile(armedFile(id, sha256), await readFile(lessonFile(id)));
  await appendLine<OwnerLine>(home, "owner.jsonl", "agent-one", c.now(), "w", { kind: "owner", act: "arm", lesson: id, sha256 });
  expect((await stateOf(id)).state).toBe("unarmed");
  await arm(home, id, c.now());
  await appendLine<OwnerLine>(home, "owner.jsonl", "agent-one", c.now(), "w", { kind: "owner", act: "retire", lesson: id, reason: "Forged." });
  expect((await stateOf(id)).state).toBe("armed");
});

test("discard puts the file back as armed", async () => {
  const id = await writeCard(home);
  const { sha256 } = await arm(home, id, c.now());
  await writeCard(home, STAND_IN_CARD.replace(ARMED_WORDS, "Rewritten after arming."));
  await discard(home, id, c.now());
  expect(await readFile(lessonFile(id))).toEqual(await readFile(armedFile(id, sha256)));
  expect((await ownerLines()).at(-1)).toMatchObject({ act: "discard", lesson: id, by: "owner" });
  expect((await stateOf(id)).state).toBe("armed");
  if (process.platform !== "win32") expect((await stat(lessonFile(id))).mode & 0o777).toBe(0o600);
});

test("discard refuses a card that is not changed", async () => {
  const id = await writeCard(home);
  await fails(discard(home, id, c.now()), "E_REFUSED");
  await arm(home, id, c.now());
  await fails(discard(home, id, c.now()), "E_REFUSED");
  expect(await ownerLines()).toHaveLength(1);
});

test("a broken owner log applies no card until resealed", async () => {
  const id = await writeCard(home);
  await arm(home, id, c.now());
  const file = join(home, "owner.jsonl");
  const text = await readFile(file, "utf8");
  const at = text.indexOf('"id":"w-') + '"id":"w-'.length; // a digit of the line's id, not its sha256
  await writeFile(file, text.slice(0, at) + (text[at] === "1" ? "2" : "1") + text.slice(at + 1));
  let s = await cardStates(home);
  expect(s.ownerChainBroken).toBe(true);
  expect(s.brokeAt).toBe(1);
  expect(s.applying).toEqual([]);
  expect(s.cards).toMatchObject([{ id, state: "armed" }]);
  await resealLog(home, "owner.jsonl", c.now());
  s = await cardStates(home);
  expect(s.ownerChainBroken).toBe(false);
  expect(s.applying).toHaveLength(1);
});
