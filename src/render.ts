// src/render.ts — a recall's text: its five parts in order, within RECALL_MAX_BYTES
//
// Every sentence the renderer writes of its own is a piece of FRAME; what comes from the store (the owner's words, a
// thesis, a condition, a fact's definition) is quoted with JSON's escapes and labelled. When the text would run
// over, it yields one step at a time, re-rendering each time: records shrink to their counts and one line a group;
// theses and conditions are cut short with a mark; like decisions go; the same instrument's go; then cards are shown
// fewer, caveats before red lines, and last untold cards. An applying card's words are never cut.
import { RECALL_MAX_BYTES } from "./limits.js";
import type { Case, CardRecord, Figure } from "./records.js";
import type { AppliedCard, House, PastDecision, RecallAnswer, UntoldCard } from "./recall.js";

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

/** Theses and conditions, once cut short, keep this many characters before the mark. */
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
export function renderRecall(a: Answer): string {
  return fitRecall(a).text;
}

/**
 * The text, and the answer as the text shows it: a card the last steps leave out moves from `applies` into
 * `applies_more` (an untold one into `untold_more`).
 */
export function fitRecall(a: Answer): { answer: Answer; text: string } {
  let text = "";
  for (const shape of SHAPES) {
    text = render(a, shape);
    if (fits(text)) return { answer: a, text };
  }
  const last = SHAPES.at(-1)!;
  let cur = a;
  while (cur.applies.length > 0) {
    const i = cur.applies.findLastIndex((c) => c.strength === "caveat");
    const at = i === -1 ? cur.applies.length - 1 : i;
    cur = { ...cur, applies: cur.applies.filter((_, j) => j !== at), applies_more: cur.applies_more + 1 };
    text = render(cur, last);
    if (fits(text)) return { answer: cur, text };
  }
  while (cur.untold.length > 0) {
    cur = { ...cur, untold: cur.untold.slice(0, -1), untold_more: cur.untold_more + 1 };
    text = render(cur, last);
    if (fits(text)) return { answer: cur, text };
  }
  return { answer: cur, text };
}

function fits(text: string): boolean {
  return Buffer.byteLength(text) <= RECALL_MAX_BYTES;
}

function render(a: Answer, s: Shape): string {
  const out: string[] = [F.applyHead];
  if (a.house.owner_chain_broken) out.push(F.ownerBroken);
  else if (a.house.armed === 0) out.push(F.noneArmed);
  else if (a.applies.length === 0 && a.applies_more === 0) out.push(F.noneApply);
  for (const card of a.applies) out.push(...applied(card, a.house, s));
  if (a.applies_more > 0) out.push(`${a.applies_more} ${F.notShown}`);

  out.push(F.untoldHead);
  if (a.untold.length === 0 && a.untold_more === 0) out.push(F.none);
  for (const card of a.untold) out.push(...untold(card));
  if (a.untold_more > 0) out.push(`${a.untold_more} ${F.notShown}`);

  out.push(F.sameHead, ...decisions(a.same, s.same, s.cut));
  out.push(F.likeHead, ...decisions(a.like, s.like, s.cut));
  out.push(F.houseHead, ...house(a.house));
  return out.join("\n");
}

function applied(card: AppliedCard, h: House, s: Shape): string[] {
  const strength = card.strength === "red-line" ? F.redLine : F.caveat;
  const changed = h.cards_changed.includes(card.id) ? ` ${F.changed}` : "";
  return [
    `- ${strength} ${card.id}, ${F.says} ${card.says} ${F.on} ${card.actions.join(", ")}${changed}`,
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
  const groups: Array<[string, Case[], Record<number, number> | undefined]> = [
    [F.followed, r.followed, r.medians.followed],
    [F.overridden, r.overridden, r.medians.overridden],
    [F.backfilled, r.backfilled, undefined],
  ];
  for (const [name, cases, medians] of groups) {
    if (cases.length === 0) continue;
    const median = medians && Object.keys(medians).length > 0
      ? `; ${F.median} ${Object.entries(medians).map(([k, v]) => `${k}d ${pct(v)}`).join(", ")}` : "";
    if (full) {
      for (const c of cases) lines.push(`  ${name} ${caseHead(c)}: ${figures(c.figures)}`);
      if (median !== "") lines.push(`  ${name}${median}`);
    } else {
      lines.push(`  ${name}: ${cases.length} ${F.cases} ${caseHead(cases.at(-1)!)}${median}`);
    }
  }
  return lines;
}

function caseHead(c: Case): string {
  return [c.date, c.symbol, c.action, c.decision].filter((x) => x !== undefined).join(" ");
}

function untold(card: UntoldCard): string[] {
  return [`- ${card.id}`, ...card.needs.map((n) => (n.what === "market"
    ? `  ${F.lacksMarket}`
    : `  ${F.lacksFact} ${n.fact}, ${F.definition} ${quote(n.definition)}`))];
}

function decisions(list: PastDecision[], shown: boolean, cut: boolean): string[] {
  if (!shown && list.length > 0) return [F.leftOut];
  if (list.length === 0) return [F.none];
  return list.flatMap((d) => {
    const whose = d.whose === "owner" ? F.ownersDecision : F.agentsDecision;
    const head = [d.date, whose, d.action, d.symbol].filter((x) => x !== undefined).join(" ");
    const lines = [`- ${head}, ${F.by} ${d.by}, ${d.id}${d.backfilled ? ` (${F.backfilled})` : ""}`,
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
  if (h.cards_changed.length > 0) lines.push(`- ${F.changedCards} ${names(h.cards_changed)}`);
  if (h.cards_broken.length > 0) lines.push(`- ${F.brokenCards} ${names(h.cards_broken)}`);
  if (h.owner_chain_broken) lines.push(`- ${F.ownerChain}`);
  for (const c of h.chains_broken) lines.push(`- ${F.chainBroken} ${c.file} ${F.atLine} ${c.line}`);
  if (h.partial.length > 0) lines.push(`- ${F.partial} ${h.partial.join(", ")}`);
  return lines;
}

function names(ids: string[]): string {
  const shown = ids.slice(0, HOUSE_LIST).join(", ");
  return ids.length > HOUSE_LIST ? `${shown}, ${F.andMore} ${ids.length - HOUSE_LIST} ${F.moreTail}` : shown;
}

function figures(list: Figure[]): string {
  const measured = list.filter((f) => f.change_pct !== null);
  if (measured.length === 0) return F.nothingMeasured;
  return measured.map((f) => `${f.k}d ${pct(f.change_pct!)}`
    + (f.vs_benchmark_pct !== null ? ` (${pct(f.vs_benchmark_pct)} ${F.vsBenchmark})` : "")).join(", ");
}

function pct(x: number): string {
  return `${x > 0 ? "+" : ""}${x}%`;
}

function short(s: string, cut: boolean): string {
  const chars = [...s];
  return cut && chars.length > CUT_TO ? `${chars.slice(0, CUT_TO).join("")}${F.cut}` : s;
}

/** Store text, quoted: JSON's escapes keep a quote or a newline in it from passing for the renderer's own. */
function quote(s: string): string {
  return JSON.stringify(s);
}
