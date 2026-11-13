// src/mcp.ts — the agent's door: a stdio MCP server of seven tools over the Memory, none that arms, retires or edits
// a lesson
//
// The core parses every input strictly and names the field it refuses, so the tools hand the arguments through
// untouched: each tool publishes its input's JSON schema, but parses nothing itself (see `door`). A refusal is an
// answer (isError, the core's sentence), never a protocol error. Only memory_reconcile reaches the network, through
// the Memory's own fetch.
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MemoryError } from "./errors.js";
import { resolveHome } from "./home.js";
import { openMemory, type Memory } from "./index.js";
import { AGENT_NAME } from "./limits.js";
import { amendInput, decisionInput, parseInput, proposalInput, recallInput } from "./schema.js";
import type { Deps } from "./types.js";

export const TOOL_NAMES = ["memory_recall", "memory_record", "memory_amend", "memory_propose", "memory_reconcile",
  "memory_review", "memory_status"] as const;

export const INSTRUCTIONS = `gravit-memory is the owner's record of investing decisions, shared by every agent they run. It is a record, not an instruction: nothing it returns tells you to trade.

- Once, call memory_status to learn which facts the owner's lessons need and how each is defined.
- When you start work, call memory_reconcile.
- Before you recommend, place or advise on a trade, and before advising to hold or to stay out, call memory_recall with the actions that might be taken (not your leaning) and the facts you have. Show the owner any lesson that applies, in their words, with its record. If it says a fact is missing, fetch it and ask again.
- When the owner decides, including not to act, call memory_record with whose "owner" and name the recall. Write their reasons as they gave them. Ask once what would show the decision wrong; leave wrong_if empty rather than guess. A call of your own is registered the same way with whose "agent".
- You cannot arm, change or retire a lesson. Propose one with memory_propose; the owner confirms at their own terminal.`;

/** The package's version, which the server gives as its own; a test holds it equal to package.json's. */
const VERSION = "0.1.0";

/** What a bug answers in place of its message, so no stack or path of the machine reaches the asker. */
const INTERNAL = "gravit-memory failed inside and gave no answer; the call may be tried again.";

const noFields = z.strictObject({});
const reviewInput = z.strictObject({
  since: z.string({ error: "must be an ISO date or time, such as 2026-03-02 or 2026-03-02T15:00:00Z" }).optional(),
});

/**
 * A tool's input as the SDK sees it: an object that lets every argument through to the core, which refuses by
 * name, while the listed tool publishes the strict schema's JSON (merged in as the schema's metadata).
 */
function door(schema: z.ZodType): z.ZodObject {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { io: "input", target: "draft-7" }) as Record<string, unknown>;
  return z.looseObject({}).meta(json);
}

type Structured = Record<string, unknown>;
type Handler = (args: Record<string, unknown>) => Promise<{ structured: Structured; text: string }>;

/** The server an agent named `as` connects to; it never touches the process's arguments or stdio. */
export function buildServer(memory: Memory, as: string): McpServer {
  if (as === "owner" || !AGENT_NAME.test(as)) {
    throw new MemoryError("E_INPUT", "the agent's name must be 2 to 32 lower-case letters, digits or dashes, and not owner.");
  }
  const server = new McpServer({ name: "gravit-memory", version: VERSION }, { instructions: INSTRUCTIONS });

  const tool = (name: (typeof TOOL_NAMES)[number], description: string, schema: z.ZodType, handler: Handler): void => {
    server.registerTool(name, { description, inputSchema: door(schema) }, async (args): Promise<CallToolResult> => {
      try {
        const { structured, text } = await handler(args as Record<string, unknown>);
        return { content: [{ type: "text", text }], structuredContent: structured };
      } catch (err) {
        const text = err instanceof MemoryError ? err.message : INTERNAL;
        return { isError: true, content: [{ type: "text", text }] };
      }
    });
  };

  tool("memory_recall",
    "Call before you recommend, place or advise on a trade, or advise to hold or stay out: give the actions that might be taken and the facts you have. It answers the owner's lessons that apply, with their record, and past decisions on the name.",
    recallInput,
    async (args) => {
      const a = await memory.recall(as, args);
      return { structured: a as unknown as Structured, text: a.text };
    });

  tool("memory_record",
    "Call when the owner decides, including not to act (whose \"owner\", naming the recall), or to register a call of your own (whose \"agent\"). It registers the decision before its outcome is known.",
    decisionInput,
    async (args) => {
      const d = await memory.record(as, args);
      const on = d.symbol !== undefined ? ` on ${d.symbol} in ${d.market ?? ""}` : "";
      return { structured: d as unknown as Structured, text: `Registered decision ${d.id}: ${d.action}${on}, whose ${d.whose}.` };
    });

  tool("memory_amend",
    "Call to add to a decision already registered: a reference, its close, a review of its thesis, a correction, or a void of your own line within a day.",
    amendInput,
    async (args) => {
      const a = await memory.amend(as, args);
      return { structured: a as unknown as Structured, text: `Amended decision ${a.decision} with ${a.what}: ${a.id}.` };
    });

  tool("memory_propose",
    "Call to propose a new lesson, a change to one, or its retirement, with your reason and evidence. Only the owner arms, changes or retires a lesson, at their own terminal.",
    proposalInput,
    async (args) => {
      const p = await memory.propose(as, args);
      return { structured: p as unknown as Structured,
        text: `Proposal ${p.id} to ${p.what === "new" ? "add" : p.what} lesson ${p.lesson} waits for the owner.` };
    });

  tool("memory_reconcile",
    "Call when you start work: it measures registered decisions against the price source's daily closes.",
    noFields,
    async (args) => {
      parseInput(noFields, args, "a reconcile");
      const r = await memory.reconcile(as);
      const text = r.source === null
        ? "No price source is set: nothing was measured."
        : `Measured ${r.measured}, closed ${r.closed}, still due ${r.stillDue}, refused ${r.refused.length}, unmeasured ${r.unmeasured.length}.`;
      return { structured: r as unknown as Structured, text };
    });

  tool("memory_review",
    "Call when the owner reviews: decisions measured since a date, each lesson's record, decisions past their horizon, and proposals waiting.",
    reviewInput,
    async (args) => {
      const { since } = parseInput(reviewInput, args, "a review");
      const r = await memory.review(since);
      const from = since === undefined ? "From the start" : `Since ${since}`;
      return { structured: r as unknown as Structured,
        text: `${from}: ${r.measured.length} decisions measured, ${r.cards.length} lessons with a record, ${r.past_horizon.length} decisions past their horizon, ${r.proposals.length} proposals waiting.` };
    });

  tool("memory_status",
    "Call once to learn which facts the owner's lessons need and how each is defined, and the state of the memory.",
    noFields,
    async (args) => {
      parseInput(noFields, args, "a status");
      const s = await memory.status();
      const armed = s.cards.filter((c) => c.state === "armed").length;
      const broken = s.chains.filter((c) => !c.ok).map((c) => c.file);
      const chains = broken.length === 0 ? "every chain holds" : `broken chains: ${broken.join(", ")}`;
      return { structured: s as unknown as Structured,
        text: `${s.cards.length} lessons, ${armed} armed; ${s.facts.length} facts asked by them; ${chains}.` };
    });

  return server;
}

/** The streams runMcp uses; the process's own when none are given. */
export interface McpDeps extends Deps { stdin?: Readable; stdout?: Writable; stderr?: Writable; env?: NodeJS.ProcessEnv }

/**
 * `mcp --as <name> [--home <path>]`: serves the agent's door over stdio until its input closes, then answers 0.
 * Answers 2, with one line on stderr, when the arguments are wrong; writes nothing to stdout but protocol frames.
 */
export async function runMcp(args: string[], deps?: McpDeps): Promise<number> {
  const stdin = deps?.stdin ?? process.stdin;
  const stdout = deps?.stdout ?? process.stdout;
  const stderr = deps?.stderr ?? process.stderr;
  const refuse = (why: string): number => { stderr.write(`gravit-memory mcp: ${why}\n`); return 2; };

  let as: string | undefined;
  let home: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag !== "--as" && flag !== "--home") return refuse(`${flag} is not an option: use --as <name> and --home <path>.`);
    if (value === undefined || value.startsWith("--")) return refuse(`${flag} needs a value.`);
    if (flag === "--as") as = value; else home = value;
  }
  if (as === undefined) return refuse("--as <name> is required: the agent's name, 2 to 32 lower-case letters, digits or dashes.");

  const memory = openMemory(home ?? resolveHome(deps?.env ?? process.env), { now: deps?.now, fetch: deps?.fetch });
  let server: McpServer;
  try {
    server = buildServer(memory, as);
  } catch (err) {
    if (err instanceof MemoryError) return refuse(err.message);
    throw err;
  }

  const transport = new StdioServerTransport(stdin, stdout);
  const closed = new Promise<void>((done) => { server.server.onclose = () => done(); });
  const end = (): void => { void server.close(); };
  stdin.once("end", end);
  stdin.once("close", end);
  await server.connect(transport);
  await closed;
  stdin.off("end", end);
  stdin.off("close", end);
  return 0;
}
