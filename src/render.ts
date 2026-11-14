// src/render.ts — a recall's text: its five parts in order, within RECALL_MAX_BYTES
//
// Every sentence the renderer writes of its own is a piece of FRAME; what comes from the store (the owner's words, a
// thesis, a condition, a fact's definition) is quoted with JSON's escapes, every unseen character made visible, and
// labelled. When the text would run over, it yields one step at a time, re-rendering each time: records shrink to
// their counts and one line a group; theses, conditions and untold cards' definitions are cut short with a mark; like
// decisions go; the same instrument's go; untold cards go from the end; last, applying cards are shown fewer, caveats
// before red lines. An applying card's words are never cut, and an applying card goes only when nothing else is left
// to yield.
//
// The answer's structure is the text's, never more: what the text leaves out is left out of it, what it cuts is cut,
// a record's case lists hold only the cases the text names (its counts stay whole), and the whole answer is held
// within RECALL_STRUCT_MAX_BYTES as the text is within RECALL_MAX_BYTES.
//
// A value from the store printed unquoted (an id, a writer's name, a symbol, a market, an action, a date, a fact's
// name) passes `ident`: printed as it is only when it has its shape, else quoted. The command line and the tools'
// texts (src/texts.ts) use the same guard and the same shapes.
import { AGENT_NAME, FACT_NAME, IDENT_MAX, IDENT_MAX_BYTES, LESSON_ID, RECALL_MAX_BYTES, RECALL_STRUCT_MAX_BYTES } from "./limits.js";
import type { Case, CardRecord, Figure } from "./records.js";
import type { AppliedCard, House, PastDecision, RecallAnswer, UntoldCard } from "./recall.js";
import { ACTIONS, MARKET, SYMBOL } from "./schema.js";

/** The shapes of the values a text prints unquoted; a decision's id in a tool's text is a word of the id's letters. */
export const DECISION_ID = /^d-\d{8}-[0-9a-f]{8}$/;
export const ID_WORD = /^[a-z][a-z0-9-]{1,63}$/;
export const PROPOSAL_ID = /^p-\d{8}-[0-9a-f]{8}$/;
export const ISO_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;
export const WRITER = new RegExp(`^owner$|${AGENT_NAME.source}`);
export const ACTION = new RegExp(`^(${ACTIONS.join("|")})$`);
export const SAYS = /^(dont|do|careful)$/;

const F = {
  applyHead: "Lessons that apply:",
  untoldHead: "Lessons it cannot tell:",
  sameHead: "The same instrument before:",
  likeHead: "Like decisions:",
  houseHead: "The house:",
  none: "none.",
  noneArmed: "none: no lesson is armed.",
  noneApply: "none of the armed lessons applies to what was asked.",
  ownerBroken: "none: the owner's log chain is broken, so no lesson is applied until the owner reseals.",
  notShown: "more not shown.",
  leftOut: "left out for length.",
  redLine: "red line",
  caveat: "caveat",
  says: "says",
  on: "on",
  changed: "(changed since armed; applies as armed)",
  ownersWords: "owner's words:",
  record: "record:",
  fired: "fired",
  ownerSide: "owner:",
  agentsSide: "agents:",
  followed: "followed",
  overridden: "overridden",
  seen: "seen",
  backfilled: "backfilled",
  noDecision: "no decision",
  cases: "cases, latest",
  median: "median",
  lacksMarket: "lacks the market",
  lacksFact: "lacks the fact",
  definition: "definition:",
  atEntry: "your condition at entry:",
  wrongIf: "wrong if:",
  soFar: "so far:",
  nothingMeasured: "nothing measured yet",
  vsBenchmark: "vs benchmark",
  ownersDecision: "the owner's",
  agentsDecision: "an agent's",
  by: "by",
  cut: "…",
  armed: "lessons armed:",
  mayBeDue: "decisions whose outcomes may be due:",
  noPriceSource: "outcomes: no price source is set.",
  proposals: "proposals waiting for the owner:",
  changedCards: "changed since armed:",
  brokenCards: "broken, not applied:",
  ownerChain: "the owner's log chain is broken: no lesson is applied until the owner reseals.",
  chainBroken: "chain broken:",
  atLine: "at line",
  partial: "partial last line:",
  andMore: "and",
  moreTail: "more",
} as const;

/** Every sentence and fixed phrase the renderer writes of its own. */
export const FRAME: readonly string[] = Object.freeze(Object.values(F));

type Answer = Omit<RecallAnswer, "text">;
interface Shape { fullRecords: boolean; cut: boolean; like: boolean; same: boolean }

/** Theses, conditions and definitions, once cut short, keep this many characters before the mark. */
const CUT_TO = 60;
/** A house list names at most this many cards; the rest are counted. */
const HOUSE_LIST = 10;

const SHAPES: Shape[] = [
  { fullRecords: true, cut: false, like: true, same: true },
  { fullRecords: false, cut: false, like: true, same: true },
  { fullRecords: false, cut: true, like: true, same: true },
  { fullRecords: false, cut: true, like: false, same: true },
  { fullRecords: false, cut: true, like: false, same: false },
];

/** The text of a recall, at most RECALL_MAX_BYTES. */
export function renderRecall(a: Answer, changed?: ReadonlySet<string>): string {
  return fitRecall(a, changed).text;
}

/**
 * The text, and the answer as the text shows it (`shownAs`): an untold card the last steps leave out moves into
 * `untold_more`, an applying one from `applies` into `applies_more`. `changed` is every card changed since armed, for
 * the mark on an applying card the house's bounded list may not name; the house's list when it is not given.
 */
export function fitRecall(a: Answer, changed: ReadonlySet<string> = new Set(a.house.cards_changed)): { answer: Answer; text: string } {
  let out = { answer: a, text: "" };
  for (const shape of SHAPES) {
    out = { answer: shownAs(a, shape), text: render(a, shape, changed) };
    if (fits(out)) return out;
  }
  const last = SHAPES.at(-1)!;
  let cur = a;
  while (cur.untold.length > 0) {
    cur = { ...cur, untold: cur.untold.slice(0, -1), untold_more: cur.untold_more + 1 };
    out = { answer: shownAs(cur, last), text: render(cur, last, changed) };
    if (fits(out)) return out;
  }
  while (cur.applies.length > 0) {
    const i = cur.applies.findLastIndex((c) => c.strength === "caveat");
    const at = i === -1 ? cur.applies.length - 1 : i;
    cur = { ...cur, applies: cur.applies.filter((_, j) => j !== at), applies_more: cur.applies_more + 1 };
    out = { answer: shownAs(cur, last), text: render(cur, last, changed) };
    if (fits(out)) return out;
  }
  return out;
}

function fits({ answer, text }: { answer: Answer; text: string }): boolean {
  return Buffer.byteLength(text) <= RECALL_MAX_BYTES
    && Buffer.byteLength(JSON.stringify({ ...answer, text })) < RECALL_STRUCT_MAX_BYTES;
}

/** The answer as a shape's text shows it: cases, theses, conditions and definitions as shown, groups left out gone. */
function shownAs(a: Answer, s: Shape): Answer {
  const cases = (xs: Case[]): Case[] => (s.fullRecords ? xs : xs.slice(-1));
  const past = (d: PastDecision): PastDecision => ({ ...d, thesis: short(d.thesis, s.cut),
    ...(d.wrong_if !== undefined ? { wrong_if: short(d.wrong_if, s.cut) } : {}) });
  return {
    ...a,
    applies: a.applies.map((c) => ({ ...c, record: { ...c.record, followed: cases(c.record.followed),
      overridden: cases(c.record.overridden), backfilled: cases(c.record.backfilled) } })),
    untold: a.untold.map((u) => ({ ...u, needs: u.needs.map((n) => (n.what === "market" ? n : { ...n, definition: short(n.definition, s.cut) })) })),
    same: s.same ? a.same.map(past) : [],
    like: s.like ? a.like.map(past) : [],
  };
}

function render(a: Answer, s: Shape, changed: ReadonlySet<string>): string {
  const out: string[] = [F.applyHead];
  if (a.house.owner_chain_broken) out.push(F.ownerBroken);
  else if (a.house.armed === 0) out.push(F.noneArmed);
  else if (a.applies.length === 0 && a.applies_more === 0) out.push(F.noneApply);
  for (const card of a.applies) out.push(...applied(card, changed, s));
  if (a.applies_more > 0) out.push(`${a.applies_more} ${F.notShown}`);

  out.push(F.untoldHead);
  if (a.untold.length === 0 && a.untold_more === 0) out.push(F.none);
  for (const card of a.untold) out.push(...untold(card, s.cut));
  if (a.untold_more > 0) out.push(`${a.untold_more} ${F.notShown}`);

  out.push(F.sameHead, ...decisions(a.same, s.same, s.cut));
  out.push(F.likeHead, ...decisions(a.like, s.like, s.cut));
  out.push(F.houseHead, ...house(a.house));
  return out.join("\n");
}

function applied(card: AppliedCard, changedSince: ReadonlySet<string>, s: Shape): string[] {
  const strength = card.strength === "red-line" ? F.redLine : F.caveat;
  const changed = changedSince.has(card.id) ? ` ${F.changed}` : "";
  return [
    `- ${strength} ${ident(card.id, LESSON_ID)}, ${F.says} ${ident(card.says, SAYS)} ${F.on} `
      + `${card.actions.map((a) => ident(a, ACTION)).join(", ")}${changed}`,
    `  ${F.ownersWords} ${quote(card.words)}`,
    ...record(card.record, s.fullRecords),
  ];
}

function record(r: CardRecord, full: boolean): string[] {
  const o = r.owner;
  const g = r.agents;
  const lines = [`  ${F.record} ${F.fired} ${o.fired} · ${F.ownerSide} ${F.followed} ${o.followed}, ${F.overridden} ${o.overridden}, `
    + `${F.seen} ${o.seen}, ${F.backfilled} ${o.backfilled}, ${F.noDecision} ${o.no_decision} · ${F.agentsSide} `
    + `${F.followed} ${g.followed}, ${F.overridden} ${g.overridden}, ${F.seen} ${g.seen}`];
  const groups: Array<[string, Case[], number, Record<number, number> | undefined]> = [
    [F.followed, r.followed, o.followed, r.medians.followed],
    [F.overridden, r.overridden, o.overridden, r.medians.overridden],
    [F.backfilled, r.backfilled, o.backfilled, undefined],
  ];
  for (const [name, cases, count, medians] of groups) {
    if (cases.length === 0) continue;
    const median = medians && Object.keys(medians).length > 0
      ? `; ${F.median} ${Object.entries(medians).map(([k, v]) => `${k}d ${pct(v)}`).join(", ")}` : "";
    if (full) {
      for (const c of cases) lines.push(`  ${name} ${caseHead(c)}: ${figures(c.figures)}`);
      if (median !== "") lines.push(`  ${name}${median}`);
    } else {
      lines.push(`  ${name}: ${Math.max(count, cases.length)} ${F.cases} ${caseHead(cases.at(-1)!)}${median}`);
    }
  }
  return lines;
}

function caseHead(c: Case): string {
  return [ident(c.date, ISO_TIME), c.symbol === undefined ? undefined : ident(c.symbol, SYMBOL), ident(c.action, ACTION),
    ident(c.decision, ID_WORD)].filter((x) => x !== undefined).join(" ");
}

function untold(card: UntoldCard, cut: boolean): string[] {
  return [`- ${ident(card.id, LESSON_ID)}`, ...card.needs.map((n) => (n.what === "market"
    ? `  ${F.lacksMarket}`
    : `  ${F.lacksFact} ${ident(n.fact, FACT_NAME)}, ${F.definition} ${quote(short(n.definition, cut))}`))];
}

/** Past decisions as the recall writes them: date, whose, action, symbol, writer, id, the thesis, wrong_if, figures. */
export function decisions(list: PastDecision[], shown: boolean, cut: boolean): string[] {
  if (!shown && list.length > 0) return [F.leftOut];
  if (list.length === 0) return [F.none];
  return list.flatMap((d) => {
    const whose = d.whose === "owner" ? F.ownersDecision : F.agentsDecision;
    const head = [ident(d.date, ISO_TIME), whose, ident(d.action, ACTION), d.symbol === undefined ? undefined : ident(d.symbol, SYMBOL)]
      .filter((x) => x !== undefined).join(" ");
    const lines = [`- ${head}, ${F.by} ${ident(d.by, WRITER)}, ${ident(d.id, ID_WORD)}${d.backfilled ? ` (${F.backfilled})` : ""}`,
      `  ${F.record} ${quote(short(d.thesis, cut))}`];
    if (d.wrong_if !== undefined) lines.push(`  ${d.at_entry ? F.atEntry : F.wrongIf} ${quote(short(d.wrong_if, cut))}`);
    lines.push(`  ${F.soFar} ${figures(d.figures)}`);
    return lines;
  });
}

function house(h: House): string[] {
  const lines = [`- ${F.armed} ${h.armed}`,
    typeof h.may_be_due === "number" ? `- ${F.mayBeDue} ${h.may_be_due}` : `- ${F.noPriceSource}`,
    `- ${F.proposals} ${h.proposals_waiting}`];
  if (h.cards_changed.length > 0) lines.push(`- ${F.changedCards} ${names(h.cards_changed, h.cards_changed_more)}`);
  if (h.cards_broken.length > 0) lines.push(`- ${F.brokenCards} ${names(h.cards_broken, h.cards_broken_more)}`);
  if (h.owner_chain_broken) lines.push(`- ${F.ownerChain}`);
  for (const c of h.chains_broken) lines.push(`- ${F.chainBroken} ${c.file} ${F.atLine} ${c.line}`);
  if (h.partial.length > 0) lines.push(`- ${F.partial} ${h.partial.join(", ")}`);
  return lines;
}

/** A house list as the text writes it: the names it holds, then how many more, from its count or its own length. */
function names(ids: string[], more?: number): string {
  const left = (more ?? 0) + Math.max(0, ids.length - HOUSE_LIST);
  const shown = ids.slice(0, HOUSE_LIST).map((id) => ident(id, LESSON_ID)).join(", ");
  return left > 0 ? `${shown}, ${F.andMore} ${left} ${F.moreTail}` : shown;
}

/**
 * A house list as a recall's answer holds it: the first HOUSE_LIST names, a name that is not a lesson id cut as
 * `ident` cuts it (the text then quotes the same characters), and how many more there are. A name written by hand
 * that is not a string is held as the string `ident` would write for it: its JSON text, or "undefined".
 */
export function heldNames(ids: readonly unknown[]): { names: string[]; more: number } {
  return { names: ids.slice(0, HOUSE_LIST).map((id) => {
    const text = identText(id);
    return fitsShape(text, LESSON_ID) ? text : identCut(text);
  }), more: Math.max(0, ids.length - HOUSE_LIST) };
}

/** A value from the store as a string: itself when it is one, else its JSON text, or "undefined". */
function identText(value: unknown): string {
  return typeof value === "string" ? value : String(JSON.stringify(value));
}

/** The measured figures: a horizon only when its change is a finite number, its benchmark figure only when it is one. */
function figures(list: Figure[]): string {
  const measured = list.filter((f) => Number.isFinite(f.change_pct));
  if (measured.length === 0) return F.nothingMeasured;
  return measured.map((f) => `${f.k}d ${pct(f.change_pct)}`
    + (Number.isFinite(f.vs_benchmark_pct) ? ` (${pct(f.vs_benchmark_pct)} ${F.vsBenchmark})` : "")).join(", ");
}

/** A percent figure, signed, when it is a finite number; anything else is the frame's phrase for nothing measured. */
export function pct(x: unknown): string {
  if (typeof x !== "number" || !Number.isFinite(x)) return F.nothingMeasured;
  return `${x > 0 ? "+" : ""}${x}%`;
}

/** Store text cut short with the mark, when cut is set and it is longer than CUT_TO characters. */
export function short(s: string, cut: boolean): string {
  return cut ? cutTo(s, CUT_TO) : s;
}

/** Store text cut to its first n characters and the mark, when it is longer than n; read no further than it keeps. */
export function cutTo(s: string, n: number): string {
  let at = 0;
  for (let kept = 0; kept < n && at < s.length; kept++) at += s.codePointAt(at)! > 0xffff ? 2 : 1;
  return at < s.length ? `${s.slice(0, at)}${F.cut}` : s;
}

/**
 * Store text, quoted: JSON's escapes keep a quote or a newline in it from passing for the renderer's own, and every
 * unseen character JSON leaves raw (DEL, the C1 controls, format characters, the line and paragraph separators) is
 * written as `visible` writes it, so none hides or reorders what a reader is shown.
 */
export function quote(s: string): string {
  return visible(JSON.stringify(s));
}

/** Whether a value from the store may be printed unquoted: a string of at most IDENT_MAX characters its shape takes. */
export function fitsShape(value: unknown, shape: RegExp): value is string {
  return typeof value === "string" && value.length <= IDENT_MAX && shape.test(value);
}

/**
 * A value from the store printed where a text's own words stand: itself when it fits its shape, else quoted and cut
 * first by `identCut` (at most IDENT_MAX characters, and IDENT_MAX_BYTES as written), so a line written by hand can
 * neither pass for the text's own nor run it long.
 */
export function ident(value: unknown, shape: RegExp): string {
  if (fitsShape(value, shape)) return value;
  return quote(identCut(identText(value)));
}

/** The bytes the cut mark takes as written. */
const MARK_BYTES = Buffer.byteLength(F.cut);

/**
 * A value without its shape cut at a character's boundary so that it keeps at most IDENT_MAX characters and, quoted
 * with its escapes and the mark, takes at most IDENT_MAX_BYTES; never inside an escape. A value cut once is cut the
 * same again.
 */
export function identCut(s: string): string {
  const kept: Array<{ bytes: number; units: number }> = [];
  let at = 0;
  let bytes = 2;                                                                   // the quotes
  while (at < s.length && kept.length < IDENT_MAX) {
    const ch = String.fromCodePoint(s.codePointAt(at)!);
    const w = Buffer.byteLength(quote(ch)) - 2;
    if (bytes + w > IDENT_MAX_BYTES) break;
    kept.push({ bytes: w, units: ch.length });
    bytes += w;
    at += ch.length;
  }
  if (at >= s.length) return s;
  while (bytes + MARK_BYTES > IDENT_MAX_BYTES) {
    const last = kept.pop()!;
    bytes -= last.bytes;
    at -= last.units;
  }
  return `${s.slice(0, at)}${F.cut}`;
}

/** C0 and C1 controls but the newline (tab included), DEL, format characters (bidi, zero-width, BOM), separators. */
export const UNSEEN = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/gu;

/** The text with every unseen character written as a visible \uXXXX escape, or \u{XXXXX} above U+FFFF. */
export function visible(text: string): string {
  return text.replace(UNSEEN, (ch) => {
    const cp = ch.codePointAt(0)!;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`;
  });
}
