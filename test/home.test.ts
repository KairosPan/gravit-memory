import { mkdir, readFile, stat, writeFile, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_CONFIG, FILES, assertHome, initHome, readConfig, resolveHome } from "../src/home.js";
import { tempHome } from "./helpers.js";

test("init makes the home the spec draws", async () => {
  const home = await tempHome({ init: false });
  expect(await initHome(home)).toEqual({ created: true });
  expect(await readFile(join(home, "VERSION"), "utf8")).toBe("1\n");
  expect(await readConfig(home)).toEqual(DEFAULT_CONFIG);
  expect(DEFAULT_CONFIG.prices.url).toBe("");
  expect(DEFAULT_CONFIG.prices.markets.US).toEqual({ venue: "cboe", benchmark: "SPY", zone: "America/New_York", close: "16:00" });
  expect(DEFAULT_CONFIG.prices.markets.CN).toEqual({ venue: "china", zone: "Asia/Shanghai", close: "15:00" });
  expect(DEFAULT_CONFIG.horizons).toEqual([1, 5, 20, 60]);
  for (const f of Object.values(FILES)) expect((await stat(join(home, f))).size).toBe(0);
  for (const d of ["lessons", "armed"]) expect((await stat(join(home, d))).isDirectory()).toBe(true);
});

test("init makes a home whose directory does not exist yet", async () => {
  const home = join(await tempHome({ init: false }), "deeper", "home");
  expect(await initHome(home)).toEqual({ created: true });
  await assertHome(home);
});

test("init twice changes nothing", async () => {
  const home = await tempHome();
  await appendFile(join(home, FILES.decisions), "{\"a\":1}\n");
  const before = await Promise.all(["VERSION", "config.json", ...Object.values(FILES)].map((f) => readFile(join(home, f), "utf8")));
  expect(await initHome(home)).toEqual({ created: false });
  const after = await Promise.all(["VERSION", "config.json", ...Object.values(FILES)].map((f) => readFile(join(home, f), "utf8")));
  expect(after).toEqual(before);
});

test("init refuses a path inside a git work tree", async () => {
  const tmp = await tempHome({ init: false });
  await mkdir(join(tmp, ".git"));
  await expect(initHome(join(tmp, "a", "home"))).rejects.toMatchObject({ code: "E_HOME_IN_REPO" });
});

test("init refuses a directory that holds something else", async () => {
  const home = await tempHome({ init: false });
  await writeFile(join(home, "notes.txt"), "mine\n");
  await expect(initHome(home)).rejects.toMatchObject({ code: "E_HOME_NOT_EMPTY" });
  expect(await readFile(join(home, "notes.txt"), "utf8")).toBe("mine\n");
});

test("no home", async () => {
  const missing = join(await tempHome({ init: false }), "missing");
  await expect(assertHome(missing)).rejects.toMatchObject({
    code: "E_NO_HOME", message: "no memory here: run gravit-memory init",
  });
  await expect(readConfig(missing)).rejects.toMatchObject({ code: "E_NO_HOME" });
});

test("a later VERSION is refused", async () => {
  const home = await tempHome();
  await writeFile(join(home, "VERSION"), "2\n");
  await expect(assertHome(home)).rejects.toMatchObject({ code: "E_VERSION" });
  await expect(initHome(home)).rejects.toMatchObject({ code: "E_VERSION" });
});

test("a faulty config is refused naming the key", async () => {
  const home = await tempHome();
  const bad = { ...DEFAULT_CONFIG, horizons: [1, "five"] };
  await writeFile(join(home, "config.json"), JSON.stringify(bad));
  await expect(readConfig(home)).rejects.toMatchObject({ code: "E_INPUT", message: expect.stringContaining("horizons.1") });
  await writeFile(join(home, "config.json"), "{ not json");
  await expect(readConfig(home)).rejects.toMatchObject({ code: "E_INPUT", message: expect.stringContaining("config.json") });
});

test("a home under a path with a space and non-ASCII characters", async () => {
  const home = await tempHome({ under: "张 三 home" });
  expect(home).toContain("张 三 home");
  await assertHome(home);
  expect(await readConfig(home)).toEqual(DEFAULT_CONFIG);
});

test.skipIf(process.platform === "win32")("modes", async () => {
  const home = await tempHome();
  expect((await stat(home)).mode & 0o777).toBe(0o700);
  for (const f of ["VERSION", "config.json", ...Object.values(FILES)]) {
    expect((await stat(join(home, f))).mode & 0o777).toBe(0o600);
  }
});

test("resolveHome", () => {
  expect(resolveHome({ GRAVIT_MEMORY_HOME: "/x" })).toBe("/x");
  expect(resolveHome({})).toBe(join(homedir(), ".gravit-memory"));
});
