import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import type { Code } from "../src/errors.js";
import { DEFAULT_CONFIG } from "../src/home.js";
import { sha256Hex } from "../src/ids.js";
import { appendLine } from "../src/log.js";
import { openMemory, type Memory } from "../src/index.js";
import type { OwnerLine } from "../src/types.js";
import { STAND_IN_CARD, candleStub, cboeAnswer, clock, tempHome, weekdays, writeCard } from "./helpers.js";

const ID = "no-chasing-after-a-run";
const WORDS = "No new position in a name that ran 20% in five sessions.";
const ask = { considering: ["buy"], symbol: "NVDA", market: "US", facts: { sector: "software", change_5d_pct: 34.1 } };
const nvda = { action: "buy", whose: "agent", thesis: "Data-centre orders keep rising.", symbol: "NVDA", market: "US" } as const;

let home: string;
let c: ReturnType<typeof clock>;
let memory: Memory;

beforeEach(async () => {
  home = await tempHome();
  c = clock("2026-03-03T15:00:00Z");                                             // Tue 10:00 in New York
  memory = openMemory(home, { now: c.now, fetch });
});

async function fails(p: Promise<unknown>, code: Code): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected ${code}, but it succeeded`).not.toBeNull();
  expect((err as { code?: string }).code).toBe(code);
  return (err as Error).message;
}

/** A second card, the stand-in under another id. */
const other = (id: string) => STAND_IN_CARD.replace(`id: ${ID}`, `id: ${id}`);

test("an armed lesson: the armed text, the file, the record", async () => {
  const id = await writeCard(home);
  const { sha256 } = await memory.owner.arm(id);
  await memory.recall("agent-one", ask);
  const { lessons, ownerChainBroken } = await memory.lessons();
  expect(ownerChainBroken).toBe(false);
  expect(lessons).toMatchObject([{ id, state: "armed", armed: { sha256, text: STAND_IN_CARD }, file: { sha256, text: STAND_IN_CARD } }]);
  expect(lessons[0]!.armed!.card.words).toBe(WORDS);
  expect(lessons[0]!.file!.card!.words).toBe(WORDS);
  expect(lessons[0]!.file).not.toHaveProperty("fault");
  expect(lessons[0]!.armedAt).toBe("2026-03-03T15:00:00.000Z");
  expect(lessons[0]!.record!.owner.fired).toBe(1);
});

test("a changed lesson shows both texts and their hashes", async () => {
  await writeCard(home);
  const { sha256 } = await memory.owner.arm(ID);
  const changed = STAND_IN_CARD.replace("No new position", "Never a new position");
  await writeCard(home, changed);
  const [lesson] = (await memory.lessons()).lessons;
  expect(lesson).toMatchObject({ id: ID, state: "changed", armed: { sha256, text: STAND_IN_CARD } });
  expect(lesson!.armed!.card.words).toBe(WORDS);
  expect(lesson!.file).toMatchObject({ sha256: sha256Hex(changed), text: changed });
  expect(lesson!.file!.card!.words).toBe("Never a new position in a name that ran 20% in five sessions.");
  expect(lesson!.record).not.toBeNull();                                         // a changed card applies as armed
  expect(await memory.owner.arm(ID, lesson!.file!.sha256)).toEqual({ sha256: sha256Hex(changed) });
});

test("unarmed, retired, refused, broken", async () => {
  await writeCard(home, other("a-unarmed"));
  await writeCard(home, other("b-retired"));
  await memory.owner.arm("b-retired");
  await memory.owner.retire("b-retired", "The market changed.");
  await writeCard(home, other("c-refused").replace("says: dont\n", "says: dont\ncolour: red\n"));
  await writeCard(home, other("d-broken"));
  await memory.owner.arm("d-broken");
  const [copy] = (await readdir(join(home, "armed"))).filter((n) => n.startsWith("d-broken."));
  await writeFile(join(home, "armed", copy!), other("d-broken").replace("No new position", "Never a new position"));

  const { lessons } = await memory.lessons();
  expect(lessons.map((l) => [l.id, l.state])).toEqual(
    [["a-unarmed", "unarmed"], ["b-retired", "retired"], ["c-refused", "refused"], ["d-broken", "broken"]]);
  const [unarmed, retired, refused, broken] = lessons;

  expect(unarmed).toMatchObject({ file: { text: other("a-unarmed"), sha256: sha256Hex(other("a-unarmed")) }, record: null });
  expect(unarmed!.file!.card!.id).toBe("a-unarmed");
  expect(unarmed).not.toHaveProperty("armed");

  expect(retired).toMatchObject({ file: { text: other("b-retired") }, record: null });
  expect(retired).not.toHaveProperty("armed");

  expect(refused!.record).toBeNull();
  expect(refused!.fault).toContain("colour");
  expect(refused!.file!.fault).toContain("colour");
  expect(refused!.file).not.toHaveProperty("card");
  expect(refused).not.toHaveProperty("armed");

  expect(broken).toMatchObject({ fault: "Its armed copy does not hash to what the owner armed.", record: null });
  expect(broken).not.toHaveProperty("armed");
  expect(broken!.file!.card!.id).toBe("d-broken");
});

test("an empty file and one that is not UTF-8 are answered, not thrown", async () => {
  await writeCard(home);
  await writeFile(join(home, "lessons", "empty-card.md"), "");
  const latin1 = Buffer.concat([Buffer.from(other("not-utf8").replace("No new position", "No new position caf")),
    Buffer.from([0xe9, 0x0a])]);
  await writeFile(join(home, "lessons", "not-utf8.md"), latin1);

  const { lessons } = await memory.lessons();
  expect(lessons.map((l) => l.id)).toEqual(["empty-card", ID, "not-utf8"]);
  const [empty, stand, bad] = lessons;

  expect(empty!.file).toMatchObject({ sha256: sha256Hex(""), text: "" });
  expect(empty!.file!.fault).toContain("has no front matter");
  expect(empty!.file).not.toHaveProperty("card");

  expect(bad!.file!.sha256).toBe(sha256Hex(latin1));
  expect(bad!.file!.text).toContain("�");
  expect(bad!.file!.fault).toContain("not UTF-8");
  expect(bad!.file).not.toHaveProperty("card");

  expect(stand).toMatchObject({ id: ID, state: "unarmed", file: { text: STAND_IN_CARD } });
});

test("a working file that is not UTF-8 is a refused card, and cannot be armed", async () => {
  await writeCard(home);
  await memory.owner.arm(ID);
  const latin1 = Buffer.concat([Buffer.from(other("not-utf8").replace("No new position", "No new position caf")),
    Buffer.from([0xe9, 0x0a])]);
  await writeFile(join(home, "lessons", "not-utf8.md"), latin1);

  expect(await fails(memory.owner.arm("not-utf8", sha256Hex(latin1)), "E_CARD")).toContain("not UTF-8");
  expect(await readdir(join(home, "armed"))).toHaveLength(1);                     // nothing was copied
  const status = await memory.status();
  expect(status.cards.find((x) => x.id === "not-utf8")).toEqual({ id: "not-utf8", state: "refused",
    fault: "card not-utf8 is not UTF-8 text: a card file is read as UTF-8." });
  const bad = (await memory.lessons()).lessons.find((l) => l.id === "not-utf8")!;
  expect(bad).toMatchObject({ state: "refused", fault: "card not-utf8 is not UTF-8 text: a card file is read as UTF-8.",
    record: null, file: { sha256: sha256Hex(latin1), fault: "card not-utf8 is not UTF-8 text: a card file is read as UTF-8." } });
  expect(bad.file!.text.endsWith("\ufffd\n")).toBe(true);                          // decoded for showing
  expect(bad.file).not.toHaveProperty("card");
  expect(status.cards.find((x) => x.id === ID)).toMatchObject({ state: "armed" });
});

test("an armed copy that is not UTF-8 is a broken card", async () => {
  const latin1 = Buffer.concat([Buffer.from(other("latin-card").replace("No new position", "No new position caf")),
    Buffer.from([0xe9, 0x0a])]);
  const sha256 = sha256Hex(latin1);
  await writeFile(join(home, "lessons", "latin-card.md"), latin1);
  await writeFile(join(home, "armed", `latin-card.${sha256.slice(0, 12)}.md`), latin1);
  await appendLine<OwnerLine>(home, "owner.jsonl", "owner", c.now(), "w", { kind: "owner", act: "arm", lesson: "latin-card", sha256 });
  expect((await memory.status()).cards).toEqual([{ id: "latin-card", state: "broken", sha256, armedAt: "2026-03-03T15:00:00.000Z",
    fault: "card latin-card is not UTF-8 text: a card file is read as UTF-8." }]);
  expect((await memory.recall("agent-one", ask)).house.cards_broken).toEqual(["latin-card"]);
});

test("a directory named like a card is that card's fault: every read answers", async () => {
  await writeCard(home);
  await memory.owner.arm(ID);
  await mkdir(join(home, "lessons", "a-folder.md"));
  const before = await memory.recall("agent-one", ask);

  const status = await memory.status();
  expect(status.cards).toEqual([{ id: "a-folder", state: "refused", fault: "Its file is a directory, not a card file." },
    expect.objectContaining({ id: ID, state: "armed" })]);
  const after = await memory.recall("agent-one", ask);
  expect(after.applies.map((x) => x.id)).toEqual([ID]);
  expect(after.applies).toEqual(before.applies);
  const { lessons } = await memory.lessons();
  expect(lessons.map((l) => [l.id, l.state])).toEqual([["a-folder", "refused"], [ID, "armed"]]);
  expect(lessons[0]).not.toHaveProperty("file");
  expect(lessons[1]).toMatchObject({ file: { text: STAND_IN_CARD }, armed: { text: STAND_IN_CARD } });
});

test("an armed copy that is a directory is a broken card", async () => {
  await writeCard(home);
  const { sha256 } = await memory.owner.arm(ID);
  const copy = join(home, "armed", `${ID}.${sha256.slice(0, 12)}.md`);
  await rm(copy);
  await mkdir(copy);
  expect((await memory.status()).cards).toEqual([expect.objectContaining({ id: ID, state: "broken",
    fault: "Its armed copy is a directory, not a file." })]);
  expect((await memory.lessons()).lessons[0]).toMatchObject({ id: ID, state: "broken", record: null, file: { text: STAND_IN_CARD } });
  expect((await memory.recall("agent-one", ask)).house.cards_broken).toEqual([ID]);
});

test("a broken owner log: every record is null", async () => {
  await writeCard(home);
  await writeCard(home, other("another-card"));
  await memory.owner.arm(ID);
  await memory.owner.arm("another-card");
  await memory.recall("agent-one", ask);
  const path = join(home, "owner.jsonl");
  await writeFile(path, (await readFile(path, "utf8")).replace("\"t\":\"2026-", "\"t\":\"2025-"));

  const read = await memory.lessons();
  expect(read.ownerChainBroken).toBe(true);
  expect(read.lessons).toHaveLength(2);
  for (const lesson of read.lessons) {
    expect(lesson.record).toBeNull();
    expect(lesson.armed).toBeDefined();
  }
});

test("decisions come newest first, with what followed", async () => {
  const stub = await candleStub();
  stub.set("NVDA", cboeAnswer(weekdays("2026-03-02", [100, 104, 102, 110, 99, 120, 130])));
  stub.set("SPY", cboeAnswer(weekdays("2026-03-02", [500, 510, 520, 505, 530, 540, 525])));
  const config = { ...DEFAULT_CONFIG, prices: { ...DEFAULT_CONFIG.prices, url: stub.url, every_minutes: 0 } };
  await writeFile(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

  const first = await memory.record("agent-one", nvda);
  const second = await memory.record("agent-one", { ...nvda, action: "add" });
  const third = await memory.record("agent-one", { ...nvda, action: "hold" });
  c.set("2026-03-11T12:00:00Z");
  await memory.reconcile("agent-one");

  const { items, more } = await memory.decisions();
  expect(more).toBe(false);
  expect(items.map((i) => i.view.line.id)).toEqual([third.id, second.id, first.id]);
  expect(items[0]!.figures.map((f) => f.k)).toEqual([1, 5, 20, 60]);
  expect(items[2]!.figures[0]!.change_pct).not.toBeNull();
});

test("by symbol, by limit, and before an id", async () => {
  const one = await memory.record("agent-one", nvda);
  const amd = await memory.record("agent-one", { ...nvda, symbol: "AMD" });
  const two = await memory.record("agent-one", { ...nvda, action: "add" });
  const three = await memory.record("agent-one", { ...nvda, action: "hold" });

  expect((await memory.decisions({ symbol: "AMD" })).items.map((i) => i.view.line.id)).toEqual([amd.id]);

  const nvdaOnly = await memory.decisions({ symbol: "NVDA", limit: 2 });
  expect(nvdaOnly.items.map((i) => i.view.line.id)).toEqual([three.id, two.id]);
  expect(nvdaOnly.more).toBe(true);

  const older = await memory.decisions({ symbol: "NVDA", before: nvdaOnly.items[1]!.view.line.id });
  expect(older).toEqual({ items: [expect.objectContaining({ view: expect.objectContaining({ line: one }) })], more: false });

  const all = await memory.decisions({ limit: 4 });
  expect(all.items).toHaveLength(4);
  expect(all.more).toBe(false);
});

test("both reads answer on a decisions file with a broken chain and a partial last line", async () => {
  await writeCard(home);
  await memory.owner.arm(ID);
  const one = await memory.record("agent-one", nvda);
  const two = await memory.record("agent-one", { ...nvda, symbol: "AMD", thesis: "Another filler thesis." });
  const path = join(home, "decisions.jsonl");
  await writeFile(path, (await readFile(path, "utf8")).replace("Data-centre orders", "Data-centre ORDERS"));   // breaks line 1
  await appendFile(path, `{"v":1,"kind":"decision","id":"d-2026`);                                      // a partial last line

  const { items, more } = await memory.decisions();
  expect(more).toBe(false);
  expect(items.map((i) => i.view.line.id)).toEqual([two.id, one.id]);
  expect((await memory.decisions({ before: two.id })).items.map((i) => i.view.line.id)).toEqual([one.id]);
  const { lessons } = await memory.lessons();
  expect(lessons).toMatchObject([{ id: ID, state: "armed", file: { text: STAND_IN_CARD } }]);
  expect(lessons[0]!.record).not.toBeNull();
});

test("a void decision is listed and marked", async () => {
  const d = await memory.record("agent-one", nvda);
  await memory.amend("agent-one", { decision: d.id, what: "void", reason: "Registered by mistake." });
  const { items } = await memory.decisions();
  expect(items).toHaveLength(1);
  expect(items[0]!.view).toMatchObject({ void: true, line: { id: d.id }, amends: [{ what: "void" }] });
});

test("a bad filter is refused by name", async () => {
  for (const limit of [0, 201, 1.5]) {
    expect(await fails(memory.decisions({ limit }), "E_INPUT")).toMatch(/^limit /);
  }
  expect(await fails(memory.decisions({ mood: 1 } as never), "E_INPUT")).toContain("mood");
  expect(await fails(memory.decisions({ symbol: "not a symbol" }), "E_INPUT")).toMatch(/^symbol /);
  expect(await fails(memory.decisions({ before: "yesterday" }), "E_INPUT")).toMatch(/^before /);
  await fails(memory.decisions({ before: "d-20260303-0f3a9c21" }), "E_NOT_FOUND");
  expect((await memory.decisions({ limit: 200 })).items).toEqual([]);
});

test("a missing home", async () => {
  const none = openMemory(await tempHome({ init: false }));
  const messages = [await fails(none.lessons(), "E_NO_HOME"), await fails(none.decisions(), "E_NO_HOME")];
  expect(messages[0]).toBe(messages[1]);
});
