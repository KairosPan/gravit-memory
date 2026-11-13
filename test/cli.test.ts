import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { beforeEach, expect, test } from "vitest";
import { cardStates } from "../src/cards.js";
import { isEntry, makeAsk, runCli, visible, type Io } from "../src/cli.js";
import { appendLine } from "../src/log.js";
import type { ProposalLine } from "../src/types.js";
import { openMemory, type Card, type Memory } from "../src/index.js";
import { DAY, STAND_IN_CARD, clock, tempHome, writeCard } from "./helpers.js";

const ID = "no-chasing-after-a-run";
const WORDS = "No new position in a name that ran 20% in five sessions.";
const nvda = { action: "buy", whose: "owner", thesis: "Data-centre orders keep rising.", symbol: "NVDA", market: "US" } as const;
const OWNERS_ACT = "this is the owner's act: run it at a terminal";

interface FakeIo extends Io { asked: string[]; printed(): string; errors(): string }

/** An Io that records what is printed and asked, and answers from a list; each asked entry holds what was printed since the last question, then the question. */
function fakeIo(opts: { isTTY?: boolean; answers?: Array<string | (() => Promise<string>)>; env?: NodeJS.ProcessEnv } = {}): FakeIo {
  const outs: string[] = [];
  const errs: string[] = [];
  const asked: string[] = [];
  const transcript: string[] = [];
  const answers = [...(opts.answers ?? [])];
  let mark = 0;
  return {
    isTTY: opts.isTTY ?? false,
    env: opts.env ?? {},
    asked,
    out(text) { outs.push(text); transcript.push(text); },
    err(text) { errs.push(text); transcript.push(text); },
    async ask(question) {
      asked.push([...transcript.slice(mark), question].join("\n"));
      mark = transcript.length;
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`the test gave no answer to: ${question}`);
      return typeof answer === "string" ? answer : answer();
    },
    printed: () => outs.join("\n"),
    errors: () => errs.join("\n"),
  };
}

let home: string;
let c: ReturnType<typeof clock>;
let deps: { now: () => number; fetch: typeof fetch };
let memory: Memory;

beforeEach(async () => {
  home = await tempHome();
  c = clock("2026-03-02T15:00:00Z");
  deps = { now: c.now, fetch: (async () => { throw new Error("no bars in this test"); }) as typeof fetch };
  memory = openMemory(home, deps);
});

/** Every file of the home with its bytes, to see that nothing was written. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path] = await readFile(path, "utf8");
  }
  return out;
}

/** Changes the first occurrence of from in a file of the home, so its chain no longer holds. */
async function tamper(file: string, from: string, to: string): Promise<void> {
  const path = join(home, file);
  const text = await readFile(path, "utf8");
  expect(text).toContain(from);
  await writeFile(path, text.replace(from, to));
}

function card(id: string): Card {
  return { id, says: "dont", actions: ["buy", "add"], strength: "caveat", words: WORDS };
}

test("init, then status", async () => {
  const fresh = await tempHome({ init: false });
  const io = fakeIo();
  expect(await runCli(["init", "--home", fresh], io)).toBe(0);
  expect(io.printed()).toContain(fresh);

  const io2 = fakeIo();
  expect(await runCli(["status", "--home", fresh], io2)).toBe(0);
  expect(io2.printed()).toContain(fresh);
  expect(io2.printed()).toContain("0 decisions");
  expect(io2.printed()).toContain("no price source");
  expect(io2.errors()).toBe("");
});

test("init takes the home from the environment when no --home is given", async () => {
  const fresh = await tempHome({ init: false });
  const io = fakeIo({ env: { GRAVIT_MEMORY_HOME: fresh } });
  expect(await runCli(["init"], io)).toBe(0);
  expect(io.printed()).toContain(fresh);
  expect(await readFile(join(fresh, "VERSION"), "utf8")).toBe("1\n");
});

test("status --json is the Status object", async () => {
  const io = fakeIo();
  expect(await runCli(["status", "--json", "--home", home], io)).toBe(0);
  const s = JSON.parse(io.printed()) as Record<string, unknown>;
  expect(s).toHaveProperty("lines");
  expect(s).toHaveProperty("chains");
  expect(s).toHaveProperty("cards");
  expect(io.errors()).toBe("");
});

test("lessons lists each card with its state and words", async () => {
  await writeCard(home);
  await memory.owner.arm(ID);
  await writeCard(home, STAND_IN_CARD.replace(`id: ${ID}`, "id: second-look"));
  const io = fakeIo();
  expect(await runCli(["lessons", "--home", home], io)).toBe(0);
  const text = io.printed();
  expect(text).toContain(ID);
  expect(text).toContain("second-look");
  expect(text).toMatch(new RegExp(`${ID}\\s+armed`));
  expect(text).toMatch(/second-look\s+unarmed/);
  expect(text).toContain(WORDS);

  const json = fakeIo();
  expect(await runCli(["lessons", "--json", "--home", home], json)).toBe(0);
  const cards = JSON.parse(json.printed()) as Array<{ id: string; state: string }>;
  expect(cards.map((x) => [x.id, x.state])).toEqual([[ID, "armed"], ["second-look", "unarmed"]]);
});

test("arm asks for the typed word", async () => {
  await writeCard(home);
  const io = fakeIo({ isTTY: true, answers: ["yes"] });
  expect(await runCli(["arm", ID, "--home", home], io)).toBe(0);
  expect(io.asked[0]).toContain(WORDS);                       // the card is shown before the question
  expect(io.asked[0]).toContain("Type yes to arm:");
  expect((await cardStates(home)).cards[0]!.state).toBe("armed");
});

test("arm of a changed card says it replaces the armed one", async () => {
  await writeCard(home);
  await memory.owner.arm(ID);
  await writeCard(home, STAND_IN_CARD.replace("20%", "25%"));
  const io = fakeIo({ isTTY: true, answers: ["yes"] });
  expect(await runCli(["arm", ID, "--home", home], io)).toBe(0);
  expect(io.asked[0]).toContain("replaces the card armed");
  expect(io.asked[0]).toContain("ran 25%");
  const s = (await cardStates(home)).cards[0]!;
  expect(s.state).toBe("armed");
  expect(s.card!.words).toContain("25%");
});

test("any other word changes nothing", async () => {
  await writeCard(home);
  for (const word of ["y", "Yes", "yes please", ""]) {
    const io = fakeIo({ isTTY: true, answers: [word] });
    expect(await runCli(["arm", ID, "--home", home], io)).toBe(1);
    expect(io.printed()).toContain("nothing changed");
  }
  expect(await readFile(join(home, "owner.jsonl"), "utf8")).toBe("");
  expect((await cardStates(home)).cards[0]!.state).toBe("unarmed");
});

test("an owner's act wants a terminal", async () => {
  await writeCard(home);
  await memory.owner.arm(ID);
  const d = await memory.record("agent-one", nvda);
  const before = await snapshot(home);
  for (const argv of [["arm", ID], ["retire", ID, "--reason", "Done with it."], ["void", d.id, "--reason", "Mistaken."],
    ["reseal"], ["review"]]) {
    const io = fakeIo({ isTTY: false, answers: ["yes", "yes", "yes"] });
    expect(await runCli([...argv, "--home", home], io), argv[0]).toBe(2);
    expect(io.errors()).toContain(OWNERS_ACT);
    expect(io.asked).toEqual([]);
    expect(io.printed()).toBe("");
  }
  expect(await snapshot(home)).toEqual(before);

  // Nothing is read either: a home that is not there gives the same answer, not E_NO_HOME.
  const none = await tempHome({ init: false });
  const io = fakeIo();
  expect(await runCli(["arm", ID, "--home", none], io)).toBe(2);
  expect(io.errors()).toContain(OWNERS_ACT);
});

test("no flag answers for the owner", async () => {
  await writeCard(home);
  const io = fakeIo({ isTTY: true, answers: ["yes"] });
  expect(await runCli(["arm", ID, "--yes", "--home", home], io)).toBe(2);
  expect(io.errors()).toMatch(/unknown option --yes/);
  expect(io.asked).toEqual([]);
  expect(await readFile(join(home, "owner.jsonl"), "utf8")).toBe("");
});

test("retire and void want their reason", async () => {
  await writeCard(home);
  await memory.owner.arm(ID);
  const d = await memory.record("agent-one", nvda);
  for (const argv of [["retire", ID], ["void", d.id], ["retire", ID, "--reason", "  "]]) {
    const io = fakeIo({ isTTY: true, answers: ["yes"] });
    expect(await runCli([...argv, "--home", home], io), argv.join(" ")).toBe(2);
    expect(io.errors()).toContain("--reason");
    expect(io.asked).toEqual([]);
  }
});

test("retire shows the card and the reason, then retires it", async () => {
  await writeCard(home);
  await memory.owner.arm(ID);
  const io = fakeIo({ isTTY: true, answers: ["yes"] });
  expect(await runCli(["retire", ID, "--reason", "It no longer fits.", "--home", home], io)).toBe(0);
  expect(io.asked[0]).toContain(WORDS);
  expect(io.asked[0]).toContain("It no longer fits.");
  expect(io.asked[0]).toContain("Type yes to retire:");
  expect((await cardStates(home)).cards[0]!.state).toBe("retired");
});

test("void at the command line is the owner's", async () => {
  const d = await memory.record("agent-one", nvda);
  c.advance(30 * DAY);
  const io = fakeIo({ isTTY: true, answers: ["yes"] });
  expect(await runCli(["void", d.id, "--reason", "Registered by mistake.", "--home", home], io, deps)).toBe(0);
  expect(io.asked[0]).toContain(d.id);
  expect(io.asked[0]).toContain("Data-centre orders keep rising.");
  expect(io.asked[0]).toContain("Registered by mistake.");
  expect(io.asked[0]).toContain("Type yes to void:");
  const shown = await memory.show(d.id);
  expect(shown).toMatchObject({ decision: { void: true, amends: [{ what: "void", by: "owner", reason: "Registered by mistake." }] } });
});

test("review: accept, edit, reject, skip", async () => {
  const ps = [];
  for (const lesson of ["lesson-a", "lesson-b", "lesson-c", "lesson-d"]) {
    ps.push(await memory.propose("agent-one", { what: "new", lesson, card: card(lesson), reason: `Seen twice: ${lesson}.` }));
  }
  const io = fakeIo({ isTTY: true, answers: ["accept", "yes", "edit", "reject", "Not how I see it.", "yes", "skip"] });
  expect(await runCli(["review", "--home", home], io, deps)).toBe(0);

  expect(io.asked[0]).toContain("Proposals waiting: 4");          // the material comes first
  expect(io.asked[0]).toContain("lesson-a");
  expect(io.asked[0]).toContain(WORDS);
  expect(io.asked[0]).toContain("Seen twice: lesson-a.");
  expect(io.asked[1]).toContain("Type yes to accept:");
  expect(io.printed()).toContain(join(home, "lessons", "lesson-b.md"));
  expect(io.asked.some((q) => q.includes("Type yes to reject:"))).toBe(true);
  expect(io.errors()).toBe("");

  const states = Object.fromEntries((await cardStates(home)).cards.map((s) => [s.id, s.state]));
  expect(states).toEqual({ "lesson-a": "armed", "lesson-b": "unarmed" });
  const owner = (await readFile(join(home, "owner.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(owner.map((l) => l.act)).toEqual(["accept", "edit", "reject"]);
  expect(owner[2]).toMatchObject({ proposal: ps[2]!.id, reason: "Not how I see it.", by: "owner" });
  expect((await memory.review()).proposals.map((p) => p.id)).toEqual([ps[3]!.id]);
});

test("review: a refusal on one item is one line, and the walk goes on", async () => {
  await writeCard(home);
  await memory.owner.arm(ID);
  const retire = await memory.propose("agent-one", { what: "retire", lesson: ID, reason: "Never fires." });
  const fresh = await memory.propose("agent-one", { what: "new", lesson: "lesson-e", card: card("lesson-e"), reason: "Seen." });
  const io = fakeIo({ isTTY: true, answers: ["edit", "accept", "yes"] });
  expect(await runCli(["review", "--home", home], io, deps)).toBe(1);
  expect(io.errors().split("\n")).toEqual([`gravit-memory: proposal ${retire.id} retires a lesson: it has no card to edit; accept or reject it.`]);
  expect((await memory.review()).proposals.map((p) => p.id)).toEqual([retire.id]);
  expect((await cardStates(home)).cards.find((s) => s.id === fresh.lesson)!.state).toBe("armed");
});

test("review: a changed card — arm or discard", async () => {
  const second = STAND_IN_CARD.replace(`id: ${ID}`, "id: second-look");
  await writeCard(home);
  await writeCard(home, second);
  const { sha256: first } = await memory.owner.arm(ID);
  await memory.owner.arm("second-look");
  await writeCard(home, STAND_IN_CARD.replace("20%", "25%"));
  await writeCard(home, second.replace("20%", "30%"));

  const io = fakeIo({ isTTY: true, answers: ["arm", "yes", "discard", "yes"] });
  expect(await runCli(["review", "--home", home], io, deps)).toBe(0);
  expect(io.asked[0]).toContain(`- ${WORDS}`);                       // the difference is printed
  expect(io.asked[0]).toContain("+ No new position in a name that ran 25% in five sessions.");
  expect(io.asked[0]).toContain("arm, discard or skip");
  expect(io.asked[1]).toContain("Type yes to arm:");
  expect(io.asked[2]).toContain("+ No new position in a name that ran 30% in five sessions.");
  expect(io.asked[3]).toContain("Type yes to discard:");

  const states = (await cardStates(home)).cards;
  expect(states.map((s) => [s.id, s.state])).toEqual([[ID, "armed"], ["second-look", "armed"]]);
  expect(states[0]!.sha256).not.toBe(first);
  expect(states[0]!.card!.words).toContain("25%");
  expect(await readFile(join(home, "lessons", "second-look.md"), "utf8")).toBe(second);
});

test("reseal shows where it broke", async () => {
  await memory.record("agent-one", nvda);
  await tamper("decisions.jsonl", "Data-centre", "Data-center");
  const io = fakeIo({ isTTY: true, answers: ["yes"] });
  expect(await runCli(["reseal", "--home", home], io, deps)).toBe(0);
  expect(io.asked[0]).toMatch(/decisions\.jsonl.*line 1/);
  expect(io.asked[0]).toContain("Type yes to reseal:");
  expect((await memory.verify()).chains.every((ch) => ch.ok)).toBe(true);

  const sound = fakeIo({ isTTY: true });
  expect(await runCli(["reseal", "--home", home], sound, deps)).toBe(0);
  expect(sound.printed()).toContain("nothing to reseal");
  expect(sound.asked).toEqual([]);
});

test("show a decision, show a card", async () => {
  await writeCard(home);
  await memory.owner.arm(ID);
  const d = await memory.record("agent-one", nvda);
  await memory.amend("agent-one", { decision: d.id, what: "ref", ref: "order 1" });

  const io = fakeIo();
  expect(await runCli(["show", d.id, "--home", home], io, deps)).toBe(0);
  const text = io.printed();
  expect(text).toContain(d.id);
  expect(text).toContain("NVDA");
  expect(text).toContain("Data-centre orders keep rising.");
  expect(text).toContain("order 1");
  expect(text).toMatch(/Figures:[\s\S]*5d/);

  const json = fakeIo();
  expect(await runCli(["show", d.id, "--json", "--home", home], json, deps)).toBe(0);
  expect(JSON.parse(json.printed())).toMatchObject({ decision: { line: { id: d.id } }, figures: expect.any(Array) });

  const io2 = fakeIo();
  expect(await runCli(["show", ID, "--home", home], io2, deps)).toBe(0);
  expect(io2.printed()).toMatch(new RegExp(`${ID}: armed`));
  expect(io2.printed()).toContain(WORDS);
  expect(io2.printed()).toContain("Record:");
});

test("reconcile and verify print their reports", async () => {
  const io = fakeIo();
  expect(await runCli(["reconcile", "--home", home], io, deps)).toBe(0);
  expect(io.printed()).toContain("No price source is set");

  const ok = fakeIo();
  expect(await runCli(["verify", "--home", home], ok)).toBe(0);
  expect(ok.printed()).toContain("Sound");

  await memory.record("agent-one", nvda);
  await tamper("decisions.jsonl", "Data-centre", "Data-center");
  const bad = fakeIo();
  expect(await runCli(["verify", "--home", home], bad)).toBe(1);
  expect(bad.printed()).toMatch(/decisions\.jsonl.*line 1/);

  const json = fakeIo();
  expect(await runCli(["verify", "--json", "--home", home], json)).toBe(1);
  expect(JSON.parse(json.printed())).toMatchObject({ ok: false });
});

test("mcp without --as", async () => {
  const io = fakeIo();
  expect(await runCli(["mcp", "--home", home], io)).toBe(2);
  expect(io.errors()).toContain("--as");
});

test("an unknown command", async () => {
  for (const argv of [["frobnicate"], [], ["--home", home]]) {
    const io = fakeIo();
    expect(await runCli(argv, io)).toBe(2);
    for (const name of ["init", "status", "lessons", "show", "review", "arm", "retire", "void", "reconcile", "verify", "reseal", "mcp"]) {
      expect(io.errors()).toContain(name);
    }
  }
  const io = fakeIo();
  expect(await runCli(["status", "extra", "--home", home], io)).toBe(2);
  const io2 = fakeIo();
  expect(await runCli(["lessons", "--reason", "x", "--home", home], io2)).toBe(2);
});

test("a MemoryError is one line, not a stack", async () => {
  const none = await tempHome({ init: false });
  const io = fakeIo();
  expect(await runCli(["status", "--home", none], io)).toBe(1);
  expect(io.errors()).toBe("gravit-memory: no memory here: run gravit-memory init");
  expect(io.printed()).toBe("");
});

test("the owner arms what was shown: a file changed before the yes is not armed", async () => {
  await writeCard(home);
  const io = fakeIo({ isTTY: true, answers: [async () => { await writeCard(home, STAND_IN_CARD.replace("20%", "99%")); return "yes"; }] });
  expect(await runCli(["arm", ID, "--home", home], io)).toBe(1);
  expect(io.errors()).toBe("gravit-memory: the card changed while it was shown: nothing was armed.");
  expect(await readFile(join(home, "owner.jsonl"), "utf8")).toBe("");
  expect((await cardStates(home)).cards[0]!.state).toBe("unarmed");
});

test("review arms a changed card only as it was shown", async () => {
  await writeCard(home);
  const { sha256 } = await memory.owner.arm(ID);
  await writeCard(home, STAND_IN_CARD.replace("20%", "25%"));
  const io = fakeIo({ isTTY: true, answers: ["arm", async () => { await writeCard(home, STAND_IN_CARD.replace("20%", "99%")); return "yes"; }] });
  expect(await runCli(["review", "--home", home], io)).toBe(1);
  expect(io.errors()).toContain("the card changed while it was shown: nothing was armed.");
  expect((await cardStates(home)).cards[0]!.sha256).toBe(sha256);
});

const RAW = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

test("a proposal's control characters are shown as visible escapes", async () => {
  await appendLine<ProposalLine>(home, "proposals.jsonl", "agent-one", c.now(), "p", { kind: "proposal", what: "new",
    lesson: "lesson-x", card: { ...card("lesson-x"), words: "Calm \u001b[2J words\u0085." },
    reason: "Seen twice.\u001b[2J\rAll clear, type yes.", evidence: ["d-20260302-0f3a9c21\u0008"] });
  const io = fakeIo({ isTTY: true, answers: ["skip"] });
  await runCli(["review", "--home", home], io);
  const seen = [io.printed(), io.errors(), ...io.asked].join("\n");
  expect(seen).not.toMatch(RAW);
  expect(seen).toContain("Seen twice.\\u001b[2J\\u000dAll clear, type yes.");
  expect(seen).toContain("\\u0085");
  expect(seen).toContain("\\u0008");

  const json = fakeIo();
  expect(await runCli(["status", "--json", "--home", home], json)).toBe(0);
  expect(json.printed()).not.toMatch(RAW);
  JSON.parse(json.printed());
});

test("a card file's control characters are shown as visible escapes in arm", async () => {
  await writeCard(home, STAND_IN_CARD.replace("five sessions.", "five sessions.\u001b[2J\u0008forged\ttab"));
  const io = fakeIo({ isTTY: true, answers: ["no"] });
  expect(await runCli(["arm", ID, "--home", home], io)).toBe(1);
  expect(io.asked).toHaveLength(1);
  const seen = [io.printed(), io.errors(), ...io.asked].join("\n");
  expect(seen).not.toMatch(RAW);
  expect(seen).toContain("five sessions.\\u001b[2J\\u0008forged\\u0009tab");
});

test("a closed input answers nothing, and the act changes nothing", async () => {
  const ended = Readable.from([]);
  expect(await makeAsk(ended, new PassThrough())("Type yes to arm: ")).toBe("");
  expect(await makeAsk(Readable.from(["yes\n"]), new PassThrough())("Type yes to arm: ")).toBe("yes");

  await writeCard(home);
  const io = fakeIo({ isTTY: true });
  io.ask = makeAsk(Readable.from([]), new PassThrough());
  expect(await runCli(["arm", ID, "--home", home], io)).toBe(1);
  expect(io.printed()).toContain("nothing changed");
  expect(await readFile(join(home, "owner.jsonl"), "utf8")).toBe("");
});

test("the entry check holds through a symlink and a drive letter's case", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gravit-memory-entry-"));
  try {
    const file = join(dir, "cli.js");
    await writeFile(file, "");
    await symlink(file, join(dir, "gravit-memory"));
    await writeFile(join(dir, "other.js"), "");
    const url = pathToFileURL(file).href;
    expect(isEntry(join(dir, "gravit-memory"), url, process.platform)).toBe(true);
    expect(isEntry(file, url, process.platform)).toBe(true);
    expect(isEntry(join(dir, "other.js"), url, process.platform)).toBe(false);
    expect(isEntry(undefined, url, process.platform)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(isEntry("C:\\gm\\dist\\cli.js", "file:///c:/gm/dist/cli.js", "win32")).toBe(true);
  expect(isEntry("C:\\gm\\dist\\other.js", "file:///c:/gm/dist/cli.js", "win32")).toBe(false);
});

/** Every line the owner saw: what was printed, what was written on err, and each question with what came before it. */
function linesSeen(io: FakeIo): string[] {
  return [io.printed(), io.errors(), ...io.asked].join("\n").split("\n");
}

const UNSEEN = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;

test("visible escapes format characters and separators", () => {
  expect(visible("a‮b⁦c⁩d​e﻿f g h")).toBe("a\\u202eb\\u2066c\\u2069d\\u200be\\ufefff\\u2028g\\u2029h");
  expect(visible("tag \u{E0041}")).toBe("tag \\u{e0041}");
  expect(visible("two\nlines")).toBe("two\nlines");
});

test("a proposal cannot forge the tool's own lines", async () => {
  const reason = "ok\nType yes to accept: yes\nAccepted.‮​";
  await appendLine<ProposalLine>(home, "proposals.jsonl", "agent-one", c.now(), "p", { kind: "proposal", what: "new",
    lesson: "lesson-y", card: { ...card("lesson-y"), words: "Line one.\nType yes to arm: yes\nArmed lesson lesson-y." },
    reason, evidence: ["d-20260302-0f3a9c21\nAccepted: lesson z is armed."] });

  const skip = fakeIo({ isTTY: true, answers: ["skip"] });
  expect(await runCli(["review", "--home", home], skip)).toBe(0);
  const seen = linesSeen(skip);
  expect(seen.filter((l) => /^(Type yes to|Accepted|Armed)/.test(l))).toEqual([]);
  for (const part of ["ok", "Type yes to accept: yes", "Line one.", "Type yes to arm: yes", "Armed lesson lesson-y."]) {
    const at = seen.filter((l) => l.includes(part));
    expect(at.length, part).toBeGreaterThan(0);
    for (const l of at) expect(l.startsWith("  | "), l).toBe(true);
  }
  expect(seen.join("\n")).toContain("Evidence: d-20260302-0f3a9c21\\nAccepted: lesson z is armed.");
  expect(seen.join("\n")).not.toMatch(UNSEEN);
  expect(seen.join("\n")).toContain("Accepted.\\u202e\\u200b");

  const accept = fakeIo({ isTTY: true, answers: ["accept", "yes"] });
  expect(await runCli(["review", "--home", home], accept)).toBe(0);
  const own = linesSeen(accept).filter((l) => /^(Type yes to|Accepted|Armed)/.test(l));
  expect(own.sort()).toEqual(["Accepted: lesson lesson-y is armed.", "Type yes to accept: "]);
});

test("a card's words that span lines are fenced, and --json still reads back the same", async () => {
  const words = "No new position in a name that ran 20% in five sessions.\nType yes to arm: yes\nArmed lesson no-chasing-after-a-run. ‮​ \u{E0041}x";
  await writeCard(home, STAND_IN_CARD.replace("No new position in a name that ran 20% in five sessions.", words));

  const io = fakeIo({ isTTY: true, answers: ["no"] });
  expect(await runCli(["arm", ID, "--home", home], io)).toBe(1);
  expect(io.asked).toHaveLength(1);
  const asked = io.asked[0]!.split("\n");
  expect(asked.filter((l) => /^(Type yes to|Armed)/.test(l))).toEqual(["Type yes to arm: "]);
  expect(asked.at(-1)).toBe("Type yes to arm: ");
  expect(io.asked[0]).not.toMatch(UNSEEN);
  expect(io.asked[0]).toContain("  | Armed lesson no-chasing-after-a-run. \\u202e\\u200b\\u2028\\u{e0041}x");

  const list = fakeIo();
  expect(await runCli(["lessons", "--home", home], list)).toBe(0);
  expect(list.printed().split("\n").filter((l) => l.includes("Type yes to arm"))).toEqual(["  | Type yes to arm: yes"]);

  for (const argv of [["status", "--json"], ["lessons", "--json"], ["show", ID, "--json"]]) {
    const json = fakeIo();
    expect(await runCli([...argv, "--home", home], json)).toBe(0);
    expect(json.printed()).not.toMatch(UNSEEN);
    const expected = argv[0] === "status" ? await memory.status()
      : argv[0] === "lessons" ? (await memory.status()).cards : await memory.show(ID);
    expect(JSON.parse(json.printed())).toEqual(JSON.parse(JSON.stringify(expected)));
  }
});
