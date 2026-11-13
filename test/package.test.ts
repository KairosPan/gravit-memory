import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { TOOL_NAMES } from "../src/mcp.js";
import { STAND_IN_CARD } from "./helpers.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMMANDS = ["init", "status", "lessons", "show", "review", "arm", "retire", "void", "reconcile", "verify", "reseal", "mcp"];

/**
 * Every file of the repository as git lists it, tracked or new but not ignored (so node_modules, dist and scratch
 * are not read), as paths from the root; a file deleted from the work tree but still in the index is left out.
 */
async function trackedFiles(): Promise<string[]> {
  const { stdout } = await promisify(execFile)("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(stdout.split("\0").filter((f) => f !== ""))];
}

async function readIfThere(file: string): Promise<string | null> {
  try {
    return await readFile(join(ROOT, file), "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return null;
    throw err;
  }
}

/** The patterns are assembled from pieces, so this file does not hold what it forbids and is checked like any other. */
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const SLASH = "/", BACKSLASH = "\\";
const MACHINE_PATH = new RegExp([
  escape(`${SLASH}Users${SLASH}`),
  escape(`${BACKSLASH}Users${BACKSLASH}`),
  `${escape(`${SLASH}home${SLASH}`)}[a-z]`,
].join("|"));
const OPERATORS_WORD = new RegExp(String.fromCodePoint(0x66b4, 0x6da8));

test("the repository holds nobody's memory", async () => {
  const files = await trackedFiles();
  expect(files).toContain("package.json");
  expect(files).toContain("test/package.test.ts");
  for (const f of files) {
    const text = await readIfThere(f);
    if (text === null) continue;
    expect(text, f).not.toMatch(MACHINE_PATH);                       // no path of anyone's machine
    expect(text, f).not.toMatch(OPERATORS_WORD);                     // no sentence of the operator's
  }
});

test("the forbidden patterns catch what they forbid", () => {
  expect(`${SLASH}Users${SLASH}someone`).toMatch(MACHINE_PATH);
  expect(`C:${BACKSLASH}Users${BACKSLASH}someone`).toMatch(MACHINE_PATH);
  expect(`${SLASH}home${SLASH}someone`).toMatch(MACHINE_PATH);
  expect("~/.gravit-memory").not.toMatch(MACHINE_PATH);
  expect(`x${String.fromCodePoint(0x66b4, 0x6da8)}x`).toMatch(OPERATORS_WORD);
});

test("the README names every tool and every command", async () => {
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  for (const name of TOOL_NAMES) expect(readme, name).toContain(name);
  for (const cmd of COMMANDS) expect(readme, cmd).toContain(`gravit-memory ${cmd}`);
});

test("the README's card is the stand-in card", async () => {
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  expect(readme).toContain(STAND_IN_CARD);
});

test("package.json ships the built door", async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { bin?: Record<string, string>; files?: string[] };
  expect(pkg.bin?.["gravit-memory"]).toBe("dist/cli.js");
  expect(pkg.files).toContain("dist");
});

test("line endings are LF on every platform", async () => {
  expect((await readIfThere(".gitattributes"))?.split("\n")).toContain("* text=auto eol=lf");
});

test("the README connects an agent through the installed command, and pins the npx form", async () => {
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  expect(readme).toContain("npm install -g github:KairosPan/gravit-memory");
  expect(readme).toContain("gravit-memory mcp --as <name>");
  expect(readme).toContain('"command": "gravit-memory"');
  for (const npx of readme.match(/npx[^\n`]*github:KairosPan\/gravit-memory[^\s"`]*/g) ?? []) expect(npx, npx).toContain("#<ref>");
});
