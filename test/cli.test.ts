import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { beforeEach, expect, test } from "vitest";
import { cardStates } from "../src/cards.js";
import { charWidth, isEntry, makeAsk, rows, runCli, visible, type Io } from "../src/cli.js";
import { appendLine } from "../src/log.js";
import type { ProposalLine } from "../src/types.js";
import { openMemory, type Card, type Memory } from "../src/index.js";
import { DAY, STAND_IN_CARD, candleStub, cboeAnswer, clock, tempHome, weekdays, writeCard } from "./helpers.js";
import { DEFAULT_CONFIG } from "../src/home.js";

const ID = "no-chasing-after-a-run";
const WORDS = "No new position in a name that ran 20% in five sessions.";
const nvda = { action: "buy", whose: "owner", thesis: "Data-centre orders keep rising.", symbol: "NVDA", market: "US" } as const;
const OWNERS_ACT = "this is the owner's act: run it at a terminal";

interface FakeIo extends Io { asked: string[]; printed(): string; errors(): string; seen(): string }

/** An Io that records what is printed and asked, and answers from a list; each asked entry holds what was printed since the last question, then the question. */
function fakeIo(opts: { isTTY?: boolean; answers?: Array<string | (() => Promise<string>)>; env?: NodeJS.ProcessEnv; columns?: number } = {}): FakeIo {
  const outs: string[] = [];
  const errs: string[] = [];
  const asked: string[] = [];
  const transcript: string[] = [];
  const answers = [...(opts.answers ?? [])];
  let mark = 0;
  return {
    isTTY: opts.isTTY ?? false,
    env: opts.env ?? {},
    columns: opts.columns ?? 400,                                   // a wide terminal, unless the test names one
    asked,
    out(text) { outs.push(text); transcript.push(text); },
    err(text) { errs.push(text); transcript.push(text); },
    async ask(question) {
      asked.push([...transcript.slice(mark), question].join("\n"));
      transcript.push(question);
      mark = transcript.length;
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`the test gave no answer to: ${question}`);
      return typeof answer === "string" ? answer : answer();
    },
    printed: () => outs.join("\n"),
    errors: () => errs.join("\n"),
    seen: () => transcript.join("\n"),
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
  expect(io.asked[0]).toContain(`Type yes to arm ${ID} (caveat, dont buy/add, sha `);
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
  expect(io.asked[0]).toContain(`Type yes to retire ${ID}: `);
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
  expect(io.asked[0]).toContain(`Type yes to void ${d.id}: `);
  const shown = await memory.show(d.id);
  expect(shown).toMatchObject({ decision: { void: true, amends: [{ what: "void", by: "owner", reason: "Registered by mistake." }] } });
});

test("review: accept, edit, reject, skip", async () => {
  const ps: ProposalLine[] = [];
  for (const lesson of ["lesson-a", "lesson-b", "lesson-c", "lesson-d"]) {
    ps.push(await memory.propose("agent-one", { what: "new", lesson, card: card(lesson), reason: `Seen twice: ${lesson}.` }));
  }
  const io = fakeIo({ isTTY: true, answers: ["accept", "yes", "edit", "reject", "Not how I see it.", "yes", "skip"] });
  expect(await runCli(["review", "--home", home], io, deps)).toBe(0);

  expect(io.asked[0]).toContain("Proposals waiting: 4");          // the material comes first
  expect(io.asked[0]).toContain("lesson-a");
  expect(io.asked[0]).toContain(WORDS);
  expect(io.asked[0]).toContain("Seen twice: lesson-a.");
  expect(io.asked[1]).toContain(`Type yes to arm lesson-a (caveat, dont buy/add, sha `);
  expect(io.asked[1]).toContain(`) from proposal ${ps[0]!.id}: `);
  expect(io.printed()).toContain(join(home, "lessons", "lesson-b.md"));
  expect(io.asked.some((q) => q.includes(`Type yes to reject proposal ${ps[2]!.id}: `))).toBe(true);
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
  expect(io.errors().split("\n")).toEqual(["gravit-memory:", `  | proposal ${retire.id} retires a lesson: it has no card to edit; accept or reject it.`]);
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
  expect(io.asked[1]).toContain(`Type yes to arm ${ID} (caveat, dont buy/add, sha `);
  expect(io.asked[2]).toContain("+ No new position in a name that ran 30% in five sessions.");
  expect(io.asked[3]).toContain("Type yes to discard the edit of second-look: ");

  const states = (await cardStates(home)).cards;
  expect(states.map((s) => [s.id, s.state])).toEqual([[ID, "armed"], ["second-look", "armed"]]);
  expect(states[0]!.sha256).not.toBe(first);
  expect(states[0]!.card!.words).toContain("25%");
  expect(await readFile(join(home, "lessons", "second-look.md"), "utf8")).toBe(second);
});

test("an armed card whose working file is a directory: arm refuses in plain words, review says so and goes on", async () => {
  const second = STAND_IN_CARD.replace(`id: ${ID}`, "id: second-look");
  await writeCard(home);
  await writeCard(home, second);
  await memory.owner.arm(ID);
  await memory.owner.arm("second-look");
  await rm(join(home, "lessons", `${ID}.md`));
  await mkdir(join(home, "lessons", `${ID}.md`));
  await writeCard(home, second.replace("20%", "30%"));

  const a = fakeIo({ isTTY: true });
  expect(await runCli(["arm", ID, "--home", home], a, deps)).toBe(1);
  expect(a.errors()).toMatch(/^gravit-memory:\n {2}\| .*is a directory/);
  expect(a.errors()).not.toContain("failed:");
  expect(a.asked).toEqual([]);

  const r = fakeIo({ isTTY: true, answers: ["discard", "yes"] });
  expect(await runCli(["review", "--home", home], r, deps)).toBe(0);
  expect(r.errors()).toBe("");
  expect(r.printed().split("\n").filter((l) => l.includes(ID) && l.includes("is a directory, not a card file."))).toHaveLength(1);
  expect(r.asked).toHaveLength(2);
  expect(r.asked[0]).toContain("+ No new position in a name that ran 30% in five sessions.");
  expect(r.asked[1]).toContain("Type yes to discard the edit of second-look: ");
  expect(await readFile(join(home, "lessons", "second-look.md"), "utf8")).toBe(second);

  const l = fakeIo();
  expect(await runCli(["lessons", "--home", home], l, deps)).toBe(0);
  expect(l.printed()).toContain("  fault:\n  | Its working file is a directory, not a file.");
  const owner = await readFile(join(home, "owner.jsonl"), "utf8");
  expect(owner.split("\n").filter((x) => x.includes(`"act":"arm"`))).toHaveLength(2);   // the two arms before, no more
});

test("reseal shows where it broke", async () => {
  await memory.record("agent-one", nvda);
  await tamper("decisions.jsonl", "Data-centre", "Data-center");
  const io = fakeIo({ isTTY: true, answers: ["yes"] });
  expect(await runCli(["reseal", "--home", home], io, deps)).toBe(0);
  expect(io.asked[0]).toMatch(/decisions\.jsonl.*line 1/);
  expect(io.asked[0]).toContain("Type yes to reseal decisions.jsonl: ");
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

test("reconcile holds back within the interval, and --force reads at once", async () => {
  const stub = await candleStub();
  const config = { ...DEFAULT_CONFIG, prices: { ...DEFAULT_CONFIG.prices, url: stub.url } };
  await writeFile(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  await memory.record("agent-one", nvda);
  stub.set("NVDA", cboeAnswer(weekdays("2026-03-02", [100, 101, 102, 103])));
  stub.set("SPY", cboeAnswer(weekdays("2026-03-02", [500, 501, 502, 503])));
  c.set("2026-03-05T15:00:00Z");
  const live = { ...deps, fetch };
  expect(await runCli(["reconcile", "--home", home], fakeIo(), live)).toBe(0);
  const asked = stub.requests.length;
  expect(asked).toBeGreaterThan(0);

  c.advance(60_000);
  const fresh = fakeIo({ columns: 80 });
  expect(await runCli(["reconcile", "--home", home], fresh, live)).toBe(0);
  expect(fresh.printed().split("\n")).toHaveLength(2);
  for (const line of fresh.printed().split("\n")) expect(line.length).toBeLessThan(80);
  expect(fresh.printed()).toContain("Fresh");
  expect(fresh.printed()).toContain("2026-03-05T15:00:00.000Z");
  expect(fresh.printed()).toContain("2026-03-05T16:00:00.000Z");
  expect(fresh.printed()).toContain("--force");
  expect(stub.requests.length).toBe(asked);

  const forced = fakeIo();
  expect(await runCli(["reconcile", "--force", "--home", home], forced, live)).toBe(0);
  expect(forced.printed()).toContain("Measured");
  expect(stub.requests.length).toBeGreaterThan(asked);

  const status = fakeIo();
  expect(await runCli(["status", "--force", "--home", home], status)).toBe(2);
  expect(status.errors()).toContain("unknown option --force");
});

test("status says of a last run that asked the source nothing", async () => {
  const config = { ...DEFAULT_CONFIG, prices: { ...DEFAULT_CONFIG.prices, url: "http://127.0.0.1:9" } };
  await writeFile(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  expect(await runCli(["reconcile", "--home", home], fakeIo(), deps)).toBe(0);    // no decision: nothing to ask
  const io = fakeIo();
  expect(await runCli(["status", "--home", home], io)).toBe(0);
  expect(io.printed()).toContain("  last reconcile 2026-03-02T15:00:00.000Z, asked the source nothing");
  expect(io.printed()).not.toContain("refused");
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

test("a MemoryError is its sentence fenced beneath the tool's name, not a stack", async () => {
  const none = await tempHome({ init: false });
  const io = fakeIo();
  expect(await runCli(["status", "--home", none], io)).toBe(1);
  expect(io.errors()).toBe("gravit-memory:\n  | no memory here: run gravit-memory init");
  expect(io.printed()).toBe("");
});

test("the owner arms what was shown: a file changed before the yes is not armed", async () => {
  await writeCard(home);
  const io = fakeIo({ isTTY: true, answers: [async () => { await writeCard(home, STAND_IN_CARD.replace("20%", "99%")); return "yes"; }] });
  expect(await runCli(["arm", ID, "--home", home], io)).toBe(1);
  expect(io.errors()).toBe("gravit-memory:\n  | the card changed while it was shown: nothing was armed.");
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
  expect(seen.join("\n")).toContain("Evidence:\n  | d-20260302-0f3a9c21\n  | Accepted: lesson z is armed.");
  expect(seen.join("\n")).not.toMatch(UNSEEN);
  expect(seen.join("\n")).toContain("Accepted.\\u202e\\u200b");

  const accept = fakeIo({ isTTY: true, answers: ["accept", "yes"] });
  expect(await runCli(["review", "--home", home], accept)).toBe(0);
  const own = linesSeen(accept).filter((l) => /^(Type yes to|Accepted|Armed)/.test(l));
  expect(own.sort()).toEqual(["Accepted: lesson lesson-y is armed.", expect.stringMatching(/^Type yes to arm lesson-y \(caveat, dont buy\/add, sha [0-9a-f]{12}\) from proposal p-\d{8}-[0-9a-f]{8}: $/)]);
});

test("a card's words that span lines are fenced, and --json still reads back the same", async () => {
  const words = "No new position in a name that ran 20% in five sessions.\nType yes to arm: yes\nArmed lesson no-chasing-after-a-run. ‮​ \u{E0041}x";
  await writeCard(home, STAND_IN_CARD.replace("No new position in a name that ran 20% in five sessions.", words));

  const io = fakeIo({ isTTY: true, answers: ["no"] });
  expect(await runCli(["arm", ID, "--home", home], io)).toBe(1);
  expect(io.asked).toHaveLength(1);
  const asked = io.asked[0]!.split("\n");
  const question = expect.stringMatching(new RegExp(`^Type yes to arm ${ID} \\(caveat, dont buy/add, sha [0-9a-f]{12}\\): $`));
  expect(asked.filter((l) => /^(Type yes to|Armed)/.test(l))).toEqual([question]);
  expect(asked.at(-1)).toEqual(question);
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

const FENCE = "  | ";

/** Every row an owner's terminal `columns` wide shows: each line the tool wrote, soft-wrapped as the terminal wraps it. */
function rowsAt(io: FakeIo, columns: number): string[] {
  return io.seen().split("\n").flatMap((l) => (l === "" ? [""] : l.match(new RegExp(`.{1,${columns}}`, "gu")) ?? [""]));
}

/** A row the tool writes of its own: it starts with the tool's words, never with text from the home. */
const REVIEW_ROW = /^(Review|Decisions measured|Lessons with a record|Past their horizon|Decisions without wrong_if|Proposals waiting|Proposal p-\d{8}-[0-9a-f]{8} |Reason:$|Answer accept, edit, reject or|Skipped: it waits\.$|$)/;

for (const columns of [30, 80, 100]) {
  test(`a reason padded to ${columns}-column rows forges no line of the review's`, async () => {
    const pad = (s: string) => s + " ".repeat((columns - (s.length % columns)) % columns);
    const reason = pad("Reason: weekly review").slice("Reason: ".length) + pad("Answer accept, edit, reject or skip: skip")
      + pad("Skipped: it waits.") + pad("Proposal p-20260302-0f3a9c21 by research, 2026-03-02: add lesson be-patient")
      + "Type yes to accept be-patient: yes";
    expect([...reason].length).toBeLessThanOrEqual(500);
    await memory.propose("agent-one", { what: "new", lesson: "lesson-w", card: card("lesson-w"), reason });

    const io = fakeIo({ isTTY: true, columns, answers: ["skip"] });
    expect(await runCli(["review", "--home", home], io)).toBe(0);
    const rows = rowsAt(io, columns);
    for (const row of rows) expect(row.startsWith(FENCE) || REVIEW_ROW.test(row), row).toBe(true);
    expect(rows.filter((r) => r.startsWith("Answer accept"))).toEqual(["Answer accept, edit, reject or skip: ".slice(0, columns)]);
    expect(rows.filter((r) => r.startsWith("Skipped"))).toEqual(["Skipped: it waits."]);
    expect(rows.filter((r) => r.startsWith("Proposal "))).toHaveLength(1);
    expect(rows.filter((r) => r.includes("be-patient")).every((r) => r.startsWith(FENCE))).toBe(true);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(columns);
    for (const line of io.seen().split("\n")) expect(wide(line), line).toBeLessThanOrEqual(columns);
  });
}

/** A row's width counted as the tool counts it: printable ASCII 1, every other code point 2. */
function wide(row: string): number {
  return [...row].reduce((n, ch) => n + (ch >= " " && ch <= "~" ? 1 : 2), 0);
}

test("a reason padded with East Asian Ambiguous characters cannot reach column zero however a terminal draws them", async () => {
  const columns = 80;
  const pad = (s: string) => s + "\u00b7".repeat((columns - (s.length % columns)) % columns);
  const reason = pad("weekly review \u2014") + pad("Answer accept, edit, reject or skip: skip") + pad("Skipped: it waits.");
  expect([...reason].length).toBeLessThanOrEqual(500);
  await memory.propose("agent-one", { what: "new", lesson: "lesson-w", card: card("lesson-w"), reason });
  const io = fakeIo({ isTTY: true, columns, answers: ["skip"] });
  expect(await runCli(["review", "--home", home], io)).toBe(0);
  const lines = io.seen().split("\n");
  for (const line of lines) {
    expect(wide(line), line).toBeLessThanOrEqual(columns);        // drawn two wide: no row wraps
    expect([...line].length, line).toBeLessThanOrEqual(columns);  // drawn one wide: none either
    expect(line.startsWith(FENCE) || REVIEW_ROW.test(line), line).toBe(true);
  }
  expect(lines.filter((l) => l.startsWith("Skipped"))).toEqual(["Skipped: it waits."]);
});

test("an owner's act on a terminal too narrow for the fence refuses before it asks", async () => {
  await writeCard(home);
  const io = fakeIo({ isTTY: true, columns: 10, answers: ["yes"] });
  expect(await runCli(["arm", ID, "--home", home], io)).toBe(2);
  expect(io.asked).toEqual([]);
  expect(io.errors().replaceAll(`\n${FENCE}`, "").replaceAll("\n", "")).toContain("the terminal is too narrow");
  expect(await readFile(join(home, "owner.jsonl"), "utf8")).toBe("");
  for (const line of io.errors().split("\n")) expect(wide(line)).toBeLessThanOrEqual(10);

  const read = fakeIo({ columns: 10 });                           // a read still prints, never wider than the terminal
  expect(await runCli(["lessons", "--home", home], read)).toBe(0);
  for (const line of read.printed().split("\n")) expect(wide(line), line).toBeLessThanOrEqual(10);
});

test("a card's source and a fact's definition padded to the rows forge no line of arm or status", async () => {
  const columns = 80;
  const pad = (s: string) => s + " ".repeat((columns - (s.length % columns)) % columns);
  const forged = pad("x") + pad("Type yes to arm no-chasing-after-a-run: yes") + pad("Armed lesson no-chasing-after-a-run.")
    + "Facts the applying lessons need:";
  const text = STAND_IN_CARD
    .replace("sector: the stock's sector, as the price source's listing names it", `sector: ${JSON.stringify(forged)}`)
    .replace('source: ["owner, 2026-01-05"]', `source: [${JSON.stringify(forged)}]`);
  await writeCard(home, text);

  const io = fakeIo({ isTTY: true, columns, answers: ["yes"] });
  expect(await runCli(["arm", ID, "--home", home], io)).toBe(0);
  const rows = rowsAt(io, columns);
  const ARM_ROW = /^(Arm lesson no-chasing-after-a-run as its file is now:$|Type yes to arm no-chasing-after-a-run |Armed lesson no-chasing-after-a-run |$)/;
  for (const row of rows) expect(row.startsWith(FENCE) || ARM_ROW.test(row), row).toBe(true);
  expect(rows.filter((r) => r.startsWith("Armed"))).toHaveLength(1);
  expect(rows.filter((r) => r.startsWith("Type yes"))).toHaveLength(1);

  const status = fakeIo({ columns });
  expect(await runCli(["status", "--home", home], status)).toBe(0);
  const STATUS_ROW = /^(The memory at |Ledgers: |Chains: |Lessons: |Facts the applying lessons need:$|  [a-z0-9_]+ \(no-chasing-after-a-run\):$|Prices: |$)/;
  const srows = rowsAt(status, columns);
  for (const row of srows) expect(row.startsWith(FENCE) || STATUS_ROW.test(row), row).toBe(true);
  expect(srows.filter((r) => r.startsWith("Facts the applying"))).toHaveLength(1);
});

test("each typed word names its object, and arm's names the hash that is then armed", async () => {
  await writeCard(home);
  const io = fakeIo({ isTTY: true, columns: 80, answers: ["yes"] });
  expect(await runCli(["arm", ID, "--home", home], io)).toBe(0);
  const s = (await cardStates(home)).cards[0]!;
  expect(s.state).toBe("armed");
  const question = io.asked[0]!.split("\n").filter((l) => !l.startsWith(FENCE)).at(-1)!;
  expect(question).toBe(`Type yes to arm ${ID} (caveat, dont buy/add, sha ${s.sha256!.slice(0, 12)}): `.slice(0, 80));
  expect(io.asked[0]!.replaceAll(`\n${FENCE}`, "")).toContain(`Type yes to arm ${ID} (caveat, dont buy/add, sha ${s.sha256!.slice(0, 12)}): `);

  const retire = fakeIo({ isTTY: true, answers: ["yes"] });
  expect(await runCli(["retire", ID, "--reason", "Done with it.", "--home", home], retire)).toBe(0);
  expect(retire.asked[0]).toContain(`Type yes to retire ${ID}: `);

  const d = await memory.record("agent-one", nvda);
  const v = fakeIo({ isTTY: true, answers: ["yes"] });
  expect(await runCli(["void", d.id, "--reason", "Mistaken.", "--home", home], v, deps)).toBe(0);
  expect(v.asked[0]).toContain(`Type yes to void ${d.id}: `);

  const p = await memory.propose("agent-one", { what: "new", lesson: "lesson-q", card: card("lesson-q"), reason: "Seen." });
  const r = fakeIo({ isTTY: true, answers: ["accept", "yes"] });
  expect(await runCli(["review", "--home", home], r, deps)).toBe(0);
  const armed = (await cardStates(home)).cards.find((x) => x.id === "lesson-q")!;
  expect(r.asked[1]).toContain(`Type yes to arm lesson-q (caveat, dont buy/add, sha ${armed.sha256!.slice(0, 12)}) from proposal ${p.id}: `);

  await tamper("decisions.jsonl", "Data-centre", "Data-center");
  const rs = fakeIo({ isTTY: true, answers: ["yes"] });
  expect(await runCli(["reseal", "--home", home], rs, deps)).toBe(0);
  expect(rs.asked[0]).toContain("Type yes to reseal decisions.jsonl: ");
});

test("rows count East Asian wide characters as two columns and fence every further row", () => {
  const width = (row: string) => [...row].reduce((n, ch) => n + charWidth(ch.codePointAt(0)!), 0);
  const line = `Reason ${"不追高".repeat(30)}`;
  const cut = rows(line, 40).split("\n");
  expect(cut.length).toBeGreaterThan(1);
  for (const row of cut) expect(width(row)).toBeLessThanOrEqual(40);
  expect(cut.slice(1).every((row) => row.startsWith(FENCE))).toBe(true);
  expect(cut.join("").replaceAll(FENCE, "")).toBe(line);
  expect(charWidth("a".codePointAt(0)!)).toBe(1);
  expect(charWidth("~".codePointAt(0)!)).toBe(1);
  for (const ch of ["高", "Ａ", "\u00b7", "\u2014", "\u00e9", "\u0301", "\u{1F600}"]) expect(charWidth(ch.codePointAt(0)!), ch).toBe(2);
});

test("the width is the Io's, read at each line, and 80 when it gives none", async () => {
  const reason = "x".repeat(300);
  await memory.propose("agent-one", { what: "new", lesson: "lesson-v", card: card("lesson-v"), reason });
  for (const [given, width] of [[undefined, 80], [30, 30], [120, 120]] as const) {
    const io = fakeIo({ isTTY: true, answers: ["skip"] });
    io.columns = given;
    expect(await runCli(["review", "--home", home], io)).toBe(0);
    const lines = io.seen().split("\n");
    expect(Math.max(...lines.map((l) => l.length))).toBe(width);
  }
});

test("a terminal resized between two questions is wrapped at its new width", async () => {
  for (const lesson of ["lesson-r", "lesson-s"]) {
    await memory.propose("agent-one", { what: "new", lesson, card: card(lesson), reason: `${lesson} ${"y".repeat(300)}` });
  }
  const io = fakeIo({ isTTY: true, columns: 120 });
  io.columns = 120;
  let asked = 0;
  io.ask = async () => { asked += 1; if (asked === 1) io.columns = 50; return "skip"; };
  const outs: string[] = [];
  io.out = (t) => { outs.push(t); };
  expect(await runCli(["review", "--home", home], io)).toBe(0);
  const text = outs.join("\n");
  const second = text.slice(text.indexOf("lesson-s"));
  expect(Math.max(...text.slice(0, text.indexOf("lesson-s")).split("\n").map((l) => l.length))).toBe(120);
  expect(Math.max(...second.split("\n").map((l) => l.length))).toBeLessThanOrEqual(50);
});

test("arm on a broken owner's chain says nothing applies until reseal; reseal shows the line and what will apply", async () => {
  await writeCard(home);
  await memory.owner.arm(ID);
  await writeCard(home, STAND_IN_CARD.replace(`id: ${ID}`, "id: second-look"));
  await tamper("owner.jsonl", `"lesson":"${ID}"`, `"lesson":"${ID}" `);
  const io = fakeIo({ isTTY: true, answers: ["yes"] });
  expect(await runCli(["arm", "second-look", "--home", home], io)).toBe(0);
  expect(io.printed()).toMatch(/Armed lesson second-look[^\n]*\nowner\.jsonl's chain is broken: no lesson applies until gravit-memory reseal\./);

  const p = await memory.propose("agent-one", { what: "new", lesson: "lesson-n", card: card("lesson-n"), reason: "Seen." });
  const rv = fakeIo({ isTTY: true, answers: ["accept", "yes"] });
  expect(await runCli(["review", "--home", home], rv)).toBe(0);
  expect(rv.printed()).toContain("Accepted: lesson lesson-n is armed.\nowner.jsonl's chain is broken: no lesson applies until gravit-memory reseal.");
  expect(p.id).toMatch(/^p-/);

  const rs = fakeIo({ isTTY: true, answers: ["yes"] });
  expect(await runCli(["reseal", "--home", home], rs)).toBe(0);
  const shown = rs.asked[0]!;
  expect(shown).toContain("owner.jsonl: broke at line 1:");
  expect(shown).toContain(`  | {"v":1,"kind":"owner"`);
  expect(shown).toContain(`"lesson":"${ID}" ,`);
  expect(shown).toContain(`After the reseal these lessons apply: lesson-n, ${ID}, second-look`);
  expect((await cardStates(home)).applying.map((x) => x.id).sort()).toEqual(["lesson-n", ID, "second-look"].sort());
});

test("review: a proposal whose card's working file is a directory is refused in one line, and the walk goes on", async () => {
  const second = STAND_IN_CARD.replace(`id: ${ID}`, "id: second-look");
  await writeCard(home);
  await writeCard(home, second);
  await memory.owner.arm(ID);
  await memory.owner.arm("second-look");
  await memory.propose("agent-one", { what: "change", lesson: ID, card: { ...card(ID), words: "Filler words, changed." }, reason: "Filler." });
  await rm(join(home, "lessons", `${ID}.md`));
  await mkdir(join(home, "lessons", `${ID}.md`));
  await writeCard(home, second.replace("20%", "30%"));

  const io = fakeIo({ isTTY: true, answers: ["accept", "yes", "skip"] });
  expect(await runCli(["review", "--home", home], io, deps)).toBe(1);
  expect(io.errors()).not.toContain("failed:");
  expect(io.errors()).toContain(`lessons/${ID}.md is a directory, not a card file.`);
  expect(io.asked.at(-1)).toContain("+ No new position in a name that ran 30% in five sessions.");
});
