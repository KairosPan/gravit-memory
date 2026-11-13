// src/schema.ts — every input's fields and limits, in one file; zod, strict (an unknown field is refused by name)
//
// A message a schema gives itself starts in lower case and reads after the field's name ("holds at most 12 tags");
// issueSentence turns any issue into one plain sentence that names the field.
import { z } from "zod";
import { MemoryError } from "./errors.js";
import {
  CARD_WORDS_MAX, EVIDENCE_MAX, FACT_NAME, FACT_SOURCE_MAX, FACTS_MAX, HORIZON_MAX, HORIZON_MIN, LESSON_ID, NOTE_MAX,
  REASON_MAX, SIZE_MAX, TAGS_MAX, THESIS_MAX, WORDS_MAX, WRONG_IF_MAX,
} from "./limits.js";

export const ACTIONS = ["buy", "add", "trim", "sell", "short", "cover", "hold", "pass"] as const;
const TAG = /^[^\s:]{1,32}:\S{1,48}$/;
const DECISION_ID = /^d-\d{8}-[0-9a-f]{8}$/;
const RECALL_ID = /^r-\d{8}-[0-9a-f]{8}$/;

/** A string of min to max characters, counted as code points. */
function chars(max: number, min = 1) {
  const what = min === 0 ? `at most ${max} characters` : `${min} to ${max} characters`;
  return z.string().refine((s) => { const n = [...s].length; return n >= min && n <= max; }, `must hold ${what}`);
}

const action = z.enum(ACTIONS);
const whose = z.enum(["owner", "agent"]);
const tri = z.enum(["yes", "no", "unclear"]);
const isoTime = z.iso.datetime({ offset: true, error: "must be an ISO time, such as 2026-03-02T15:00:00Z" });
const code = z.string().regex(/^\S{1,32}$/, "must be 1 to 32 characters with no spaces");
const factName = z.string().regex(FACT_NAME, "must be lower-case letters, digits or underscores, at most 40");
const scalar = z.union([z.number(), z.string(), z.boolean()], { error: "must be a number, a string or a boolean" });
const factValue = z.union([z.number(), chars(FACT_SOURCE_MAX, 0), z.boolean()],
  { error: `must be a number, a string of at most ${FACT_SOURCE_MAX} characters or a boolean` });
const facts = z.record(factName, factValue)
  .refine((o) => Object.keys(o).length <= FACTS_MAX, `holds at most ${FACTS_MAX} facts`);
const factSources = z.record(factName, chars(FACT_SOURCE_MAX));
const tags = z.array(z.string().regex(TAG, "must be key:value with no spaces")
  .refine((s) => s === s.toLowerCase(), "must be lower case")).max(TAGS_MAX, `holds at most ${TAGS_MAX} tags`);
const evidence = z.array(chars(NOTE_MAX)).max(EVIDENCE_MAX, `holds at most ${EVIDENCE_MAX} items`);
const distinct = (xs: readonly unknown[]) => new Set(xs).size === xs.length;

/** fact_sources may only name facts given in facts. */
function sourcesNameFacts(v: { facts?: Record<string, unknown>; fact_sources?: Record<string, string> },
  ctx: z.RefinementCtx): void {
  for (const name of Object.keys(v.fact_sources ?? {})) {
    if (!v.facts || !(name in v.facts)) {
      ctx.addIssue({ code: "custom", path: ["fact_sources", name], message: "names no fact given in facts" });
    }
  }
}

export const decisionInput = z.strictObject({
  action,
  whose,
  thesis: chars(THESIS_MAX),
  symbol: code.optional(),
  market: code.optional(),
  wrong_if: chars(WRONG_IF_MAX).optional(),
  horizon: z.number().int("must be a whole number")
    .min(HORIZON_MIN, `must be ${HORIZON_MIN} to ${HORIZON_MAX}`).max(HORIZON_MAX, `must be ${HORIZON_MIN} to ${HORIZON_MAX}`)
    .optional(),
  words: chars(WORDS_MAX).optional(),
  decided_at: isoTime.optional(),
  price: z.number().positive("must be above 0").optional(),
  price_source: chars(FACT_SOURCE_MAX).optional(),
  size: chars(SIZE_MAX).optional(),
  tags: tags.optional(),
  facts: facts.optional(),
  fact_sources: factSources.optional(),
  evidence: evidence.optional(),
  recall: z.string().regex(RECALL_ID, "must be a recall id, such as r-20260302-0f3a9c21").optional(),
}).superRefine((v, ctx) => {
  if ((v.symbol === undefined) !== (v.market === undefined)) {
    const [missing, given] = v.symbol === undefined ? ["symbol", "market"] : ["market", "symbol"];
    ctx.addIssue({ code: "custom", path: [missing], message: `and ${given} come together or not at all` });
  }
  if (v.words !== undefined && v.whose !== "owner") {
    ctx.addIssue({ code: "custom", path: ["words"], message: "are the owner's own words: give them only when whose is \"owner\"" });
  }
  sourcesNameFacts(v, ctx);
});

const decisionId = z.string().regex(DECISION_ID, "must be a decision id, such as d-20260302-0f3a9c21");
const note = chars(NOTE_MAX).optional();
const correctable = Object.keys(decisionInput.shape) as [keyof typeof decisionInput.shape, ...(keyof typeof decisionInput.shape)[]];

export const amendInput = z.discriminatedUnion("what", [
  z.strictObject({ decision: decisionId, what: z.literal("ref"), ref: chars(NOTE_MAX) }),
  z.strictObject({ decision: decisionId, what: z.literal("close"), closed_at: isoTime,
    price: z.number().positive("must be above 0").optional(), note }),
  z.strictObject({ decision: decisionId, what: z.literal("review"), thesis_held: tri, wrong_if_hit: tri, whose, note }),
  z.strictObject({ decision: decisionId, what: z.literal("correction"), field: z.enum(correctable),
    value: chars(THESIS_MAX), note }),
  z.strictObject({ decision: decisionId, what: z.literal("void"), reason: chars(REASON_MAX) }),
]);

export const recallInput = z.strictObject({
  considering: z.array(action).min(1, "names 1 to 3 actions").max(3, "names 1 to 3 actions")
    .refine(distinct, "names each action once"),
  symbol: code.optional(),
  market: code.optional(),
  facts: facts.optional(),
  fact_sources: factSources.optional(),
  tags: tags.optional(),
  note,
}).superRefine(sourcesNameFacts);

const check = z.discriminatedUnion("op", [
  z.strictObject({ fact: factName, op: z.literal("in"), value: z.array(scalar).min(1, "lists at least one value") }),
  z.strictObject({ fact: factName, op: z.enum([">=", ">", "<=", "<"]), value: z.number({ error: "must be a number" }) }),
  z.strictObject({ fact: factName, op: z.enum(["==", "!="]), value: scalar }),
]);
const nonEmptyList = z.array(z.string().min(1, "must not be empty")).min(1, "lists at least one");

export const cardSchema = z.strictObject({
  id: z.string().regex(LESSON_ID, "must be a lesson id: lower-case letters, digits and dashes, 2 to 40"),
  says: z.enum(["dont", "do", "careful"]),
  actions: z.array(action).min(1, "names at least one action").refine(distinct, "names each action once"),
  strength: z.enum(["caveat", "red-line"]),
  scope: z.strictObject({ market: nonEmptyList.optional(), symbols: nonEmptyList.optional() }).optional(),
  check: z.array(check).optional(),
  facts: z.record(factName, chars(NOTE_MAX)).optional(),
  source: z.array(z.string()).optional(),
  words: chars(CARD_WORDS_MAX),
}).superRefine((v, ctx) => {
  (v.check ?? []).forEach((c, i) => {
    if (!v.facts || !(c.fact in v.facts)) {
      ctx.addIssue({ code: "custom", path: ["check", i, "fact"], message: `names ${c.fact}, which facts does not define` });
    }
  });
});

export const proposalInput = z.strictObject({
  what: z.enum(["new", "change", "retire"]),
  lesson: z.string().regex(LESSON_ID, "must be a lesson id: lower-case letters, digits and dashes, 2 to 40"),
  card: cardSchema.optional(),
  reason: chars(REASON_MAX),
  evidence: evidence.optional(),
}).superRefine((v, ctx) => {
  if (v.what === "retire" && v.card !== undefined) {
    ctx.addIssue({ code: "custom", path: ["card"], message: "is not given when retiring a lesson" });
  } else if (v.what !== "retire" && v.card === undefined) {
    ctx.addIssue({ code: "custom", path: ["card"], message: `is required for a ${v.what} lesson` });
  } else if (v.card && v.card.id !== v.lesson) {
    ctx.addIssue({ code: "custom", path: ["card", "id"], message: `must equal lesson, ${v.lesson}` });
  }
});

/** Parses input against schema, or throws E_INPUT with one sentence per issue; `what` names the input. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown, what: string): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const sentences = result.error.issues.map((issue) => issueSentence(issue, input, what));
  throw new MemoryError("E_INPUT", sentences.join(" "));
}

/** One plain sentence for a zod issue, naming the field: "thesis must hold 1 to 1000 characters." */
export function issueSentence(issue: z.core.$ZodIssue, input: unknown, what: string): string {
  const field = fieldName(issue.path);
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map((k) => fieldName([...issue.path, k]));
    return `${keys.join(", ")} ${keys.length === 1 ? "is not a field" : "are not fields"} of ${what}.`;
  }
  if (issue.code === "invalid_key") {
    const inner = issue.issues[0]?.message ?? "";
    const parent = fieldName(issue.path.slice(0, -1));
    const name = String(issue.path.at(-1));
    return /^[a-z]/.test(inner) ? `${parent} names "${name}": a name ${inner}.` : `${parent} names "${name}", which is not allowed.`;
  }
  if (issue.code !== "custom" && valueAt(input, issue.path) === undefined) return `${field} is required.`;
  if (/^[a-z]/.test(issue.message)) return `${field} ${issue.message}.`;
  switch (issue.code) {
    case "invalid_type":
      return `${field} must be ${article(issue.expected)}.`;
    case "invalid_value":
      return `${field} must be one of ${issue.values.map((x) => JSON.stringify(x)).join(", ")}.`;
    case "invalid_union":
      return "options" in issue && Array.isArray(issue.options)
        ? `${field} must be one of ${issue.options.map((x) => JSON.stringify(x)).join(", ")}.`
        : `${field} is not a value it takes.`;
    case "too_big":
      return `${field} must be at most ${String(issue.maximum)}.`;
    case "too_small":
      return `${field} must be at least ${String(issue.minimum)}.`;
    default:
      return `${field} is not valid: ${issue.message}.`;
  }
}

function fieldName(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "the input";
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : `${i === 0 ? "" : "."}${String(p)}`)).join("");
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input;
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

function article(expected: string): string {
  if (expected === "int") return "a whole number";
  if (expected === "object" || expected === "array") return `an ${expected}`;
  return `a ${expected}`;
}
