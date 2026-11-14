// src/mcp.ts — the agent's door: a stdio MCP server of seven tools over the Memory, none that arms, retires or edits
// a lesson
//
// The core parses every input strictly and names the field it refuses, so the tools hand the arguments through
// untouched: each tool publishes its input's JSON schema, flat (an object, never a top-level oneOf, which hosts that
// pass schemas to a model refuse) and with every field described, but parses nothing itself (see `door`). A refusal is an
// answer (isError, the core's sentence), never a protocol error. Each answer's text carries its content (src/texts.ts),
// for a host that shows its model the text alone. Only memory_reconcile reaches the network, through
// the Memory's own fetch.
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MemoryError } from "./errors.js";
import { resolveHome } from "./home.js";
import { openMemory, type CardState, type Memory, type Status } from "./index.js";
import { AGENT_NAME } from "./limits.js";
import { amendInput, decisionInput, parseInput, proposalInput, recallInput } from "./schema.js";
import { reconcileText, reviewText, statusText } from "./texts.js";
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

type Json = Record<string, unknown>;

/** What each field of every tool is, as the listed schemas say it. */
const FIELDS: Record<string, string> = {
  considering: "The actions that might be taken, 1 to 3 of buy, add, trim, sell, short, cover, hold, pass: not your leaning.",
  symbol: "The instrument's symbol as the price source names it, such as NVDA or 600519; given with market.",
  market: "The market the symbol trades in, as config.json names it, such as US; given with symbol.",
  facts: "The facts you have, by name (lower-case letters, digits, underscores): a number, a short string or a boolean each.",
  fact_sources: "Where each fact came from, by the fact's name: only facts given in facts.",
  tags: "Up to 12 lower-case key:value tags with no spaces, such as theme:ai.",
  note: "A note of yours, at most 500 characters.",
  action: "What was decided: buy, add, trim, sell, short, cover, hold or pass.",
  whose: "Whose decision it is: owner (the owner decided) or agent (a call of your own).",
  thesis: "Why, as it was given, 1 to 1000 characters.",
  wrong_if: "What would show the decision wrong, as the owner said it; leave it out rather than guess.",
  horizon: "Trading days after which the thesis should be reviewed, 1 to 250.",
  words: "The owner's own words, only when whose is owner.",
  decided_at: "When it was decided, an ISO time, when earlier than now; more than a day back marks it backfilled.",
  price: "The price taken or seen, above 0.",
  price_source: "Where the price came from.",
  size: "How much, in words or numbers, at most 80 characters.",
  evidence: "Up to 10 items of at most 500 characters each.",
  recall: "The recall_id of the memory_recall made before this decision.",
  since: "An ISO date or time: the review covers what is new since then; everything when left out.",
  what: "What is proposed: new (a lesson), change (to a card there is) or retire (a card there is).",
  lesson: "The lesson's id: lower-case letters, digits and dashes, 2 to 40.",
  card: "The proposed card's fields (id, says, actions, strength, scope, check, facts, source, words); not given when what is retire.",
  reason: "Why, 1 to 500 characters.",
};

/** What each field of memory_amend is, and which `what` it goes with. */
const AMEND_FIELDS: Record<string, string> = {
  decision: "The id of the decision amended, such as d-20260302-0f3a9c21.",
  what: "The kind of amendment: ref, close, review, correction or void; it decides which other fields are given.",
  ref: "With what ref, required: the reference, such as an order number, at most 500 characters.",
  closed_at: "With what close, required: when the position was closed, an ISO time.",
  price: "With what close, optional: the closing price, above 0.",
  note: "With what close, review or correction, optional: a note, at most 500 characters.",
  thesis_held: "With what review, required: whether the thesis held: yes, no or unclear.",
  wrong_if_hit: "With what review, required: whether the wrong_if condition came true: yes, no or unclear.",
  whose: "With what review, required: whose review it is, owner or agent.",
  field: "With what correction, required: the decision's field the correction is about.",
  value: "With what correction, required: the corrected value, as a note; nothing computed reads it.",
  reason: "With what void, required: why your own line is void, 1 to 500 characters.",
};

/**
 * A strict schema's JSON as one flat object: a top-level union (memory_amend's) becomes one object whose
 * discriminating field is an enum of its values, the other fields optional and required only where every branch
 * requires them. Every field takes its description from `descriptions`; one with none is a bug, found at boot.
 */
function flatSchema(schema: z.ZodType, descriptions: Record<string, string>): Json {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { io: "input", target: "draft-7" }) as Json;
  let flat: Json = json;
  const branches = (json.oneOf ?? json.anyOf) as Json[] | undefined;
  if (branches !== undefined) {
    const properties: Record<string, Json> = {};
    let required: string[] | undefined;
    for (const branch of branches) {
      for (const [key, value] of Object.entries(branch.properties as Record<string, Json>)) {
        if ("const" in value) {
          const enumOf = (properties[key]?.enum as unknown[] | undefined) ?? [];
          properties[key] = { type: "string", enum: [...enumOf, value.const] };
        } else {
          properties[key] ??= value;
        }
      }
      const own = (branch.required as string[] | undefined) ?? [];
      required = required === undefined ? own : required.filter((k) => own.includes(k));
    }
    flat = { type: "object", properties, required: required ?? [], additionalProperties: false };
  }
  const properties = (flat.properties ?? {}) as Record<string, Json>;
  for (const key of Object.keys(properties)) {
    const description = descriptions[key];
    if (description === undefined) throw new Error(`gravit-memory: the field ${key} has no description`);
    properties[key] = { ...properties[key], description };
  }
  return { ...flat, type: "object", properties };
}

/**
 * A tool's input as the SDK sees it: an object that lets every argument through to the core, which refuses by
 * name, while the listed tool publishes the flat schema (merged in as the schema's metadata).
 */
function door(schema: z.ZodType, descriptions: Record<string, string> = FIELDS): z.ZodObject {
  return z.looseObject({}).meta(flatSchema(schema, descriptions));
}

type Structured = Json;
type Handler = (args: Record<string, unknown>) => Promise<{ structured: Structured; text: string }>;

/**
 * The server an agent named `as` connects to; it never touches the process's arguments or stdio. A fault inside (an
 * error that is not a MemoryError) is answered with a fixed sentence, and handed to `onFault` for the host's log.
 */
export function buildServer(memory: Memory, as: string, opts?: { onFault?: (err: unknown, tool: string) => void }): McpServer {
  if (as === "owner" || !AGENT_NAME.test(as)) {
    throw new MemoryError("E_INPUT", "the agent's name must be 2 to 32 lower-case letters, digits or dashes, and not owner.");
  }
  const server = new McpServer({ name: "gravit-memory", version: VERSION }, { instructions: INSTRUCTIONS });

  const tool = (name: (typeof TOOL_NAMES)[number], description: string, schema: z.ZodType, handler: Handler): void => {
    const inputSchema = door(schema, name === "memory_amend" ? AMEND_FIELDS : FIELDS);
    server.registerTool(name, { description, inputSchema }, async (args): Promise<CallToolResult> => {
      try {
        const { structured, text } = await handler(args as Record<string, unknown>);
        return { content: [{ type: "text", text }], structuredContent: structured };
      } catch (err) {
        if (!(err instanceof MemoryError)) opts?.onFault?.(err, name);
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
      return { structured: r as unknown as Structured, text: reconcileText(r) };
    });

  tool("memory_review",
    "Call when the owner reviews: decisions measured since a date, each lesson's record, decisions past their horizon, and proposals waiting.",
    reviewInput,
    async (args) => {
      const { since } = parseInput(reviewInput, args, "a review");
      const r = await memory.review(since);
      return { structured: r as unknown as Structured, text: reviewText(r) };
    });

  tool("memory_status",
    "Call once to learn which facts the owner's lessons need and how each is defined, and the state of the memory.",
    noFields,
    async (args) => {
      parseInput(noFields, args, "a status");
      const s = agentsStatus(await memory.status());
      return { structured: s as unknown as Structured, text: statusText(s) };
    });

  return server;
}

/**
 * The status as an agent is given it: a card that applies (armed, or changed since and applying as armed, while
 * owner.jsonl's chain holds) with its armed copy's content; any other card as its id, its state and its fault alone,
 * so no words the owner has not armed reach an agent. The core and the command line keep the full Status.
 */
export function agentsStatus(s: Status): Status {
  const ownerHolds = s.chains.find((c) => c.file === "owner.jsonl")?.ok !== false;
  const cards = s.cards.map((c): CardState => (ownerHolds && (c.state === "armed" || c.state === "changed")
    ? c : { id: c.id, state: c.state, ...(c.fault !== undefined ? { fault: c.fault } : {}) }));
  return { ...s, cards };
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
    server = buildServer(memory, as, { onFault: (err, tool) => {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ");
      stderr.write(`gravit-memory mcp: a fault inside ${tool}: ${why}\n`);
    } });
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
