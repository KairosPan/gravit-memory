// src/texts.ts — the text of memory_status, memory_review and memory_reconcile: their content, each within its cap
//
// Some hosts show their model only a tool's text, so each text carries what its structure holds that a model needs.
// Built as the recall's (src/render.ts): every sentence the renderers write of their own is a piece of T; what comes
// from the store (the owner's words, a definition, a thesis, a reason, a source's refusal) is quoted with JSON's
// escapes, every unseen character made visible, and labelled, through the recall's own helpers. When a text would run
// over its cap it yields one step at a time, re-rendering each time, and the first text that fits is the answer.
//
// The status's text never holds the words, the definitions or the checks of a card that does not apply: such a card
// is its id, its state and its fault, whatever Status it is handed. A changed card applies as armed, and its content
// is the armed copy's (src/cards.ts parses the armed bytes). An applying card's words are never cut; when the cap
// forces it, whole cards go from the end, with their facts, and are counted.
import { IDS_SHOWN, LESSON_ID, MEASURED_SHOWN, RECONCILE_MAX_BYTES, REFUSALS_SHOWN, REVIEW_MAX_BYTES, STATUS_MAX_BYTES,
  UNMEASURED_SHOWN, URL_SHOWN, WHY_SHOWN, WRITTEN_SHOWN } from "./limits.js";
import type { CardState } from "./cards.js";
import type { ReconcileReport, Written } from "./reconcile.js";
import { cutTo, decisions, pct, quote, short } from "./render.js";
import type { Review, Status } from "./review.js";
import type { Card, Check } from "./types.js";

const T = {
  // the status
  lessonInAll: "lesson in all,",
  lessonsInAll: "lessons in all,",
  applying: "applying.",
  chains: "Chains:",
  holds: "holds",
  brokenAt: "broken at line",
  partial: "Partial last line:",
  applyHead: "Lessons that apply:",
  factsHead: "Facts they need:",
  othersHead: "Other lessons, not applied:",
  tagsHead: "Tags in use:",
  pricesHead: "Prices:",
  noneArmed: "none: no lesson is armed.",
  ownerBroken: "none: the owner's log chain is broken, so no lesson is applied until the owner reseals.",
  redLine: "red line",
  caveat: "caveat",
  says: "says",
  on: "on",
  scope: "scope:",
  market: "market",
  symbols: "symbols",
  changed: "(changed since armed; applies as armed)",
  ownersWords: "owner's words:",
  definition: "definition:",
  checks: "checks:",
  noCheck: "no check names it",
  factsNotShown: "the facts of the lessons not shown are left out.",
  fault: "fault:",
  tagLeftOut: "tag, left out for length.",
  tagsLeftOut: "tags, left out for length.",
  source: "source:",
  noSource: "no price source is set.",
  lastAsked: "last asked",
  answered: "answered",
  refusals: "refusals:",
  neverAsked: "never asked.",
  lastRunAt: "the last run, at",
  askedNothing: "asked the source nothing.",
  // the review
  since: "Since",
  fromStart: "From the start.",
  measuredHead: "Measured since:",
  lessonsHead: "Lessons:",
  tagsSharedHead: "Tags shared:",
  pastHorizonHead: "Past their own horizon, not reviewed:",
  withoutWrongIfHead: "Without wrong_if since:",
  voidedHead: "Voided since:",
  proposalsHead: "Proposals waiting:",
  ownerSide: "owner:",
  agentsSide: "agents:",
  fired: "fired",
  followed: "followed",
  overridden: "overridden",
  seen: "seen",
  backfilled: "backfilled",
  noDecision: "no decision",
  quiet: "quiet for 90 days",
  overriddenOften: "overridden 3 times or more",
  median: "median",
  decisionsWord: "decisions",
  decisionsCount: "decisions:",
  by: "by",
  lesson: "lesson",
  reason: "reason:",
  // the reconcile
  noSourceRun: "No price source is set: nothing was measured.",
  askedAt: "The price source was asked at",
  againAfter: "it will be asked again after",
  nothingDone: "Nothing was read or written this time.",
  refusedThenOne: "symbol was refused by the source then.",
  refusedThenMany: "symbols were refused by the source then.",
  dueOne: "decision may have something due.",
  dueMany: "decisions may have something due.",
  measured: "Measured",
  closedCount: "closed",
  stillDue: "still due",
  refusedCount: "refused",
  unmeasured: "unmeasured",
  wrote: "wrote",
  horizon: "horizon",
  leg: "leg",
  notTaken: "not taken",
  closed: "closed",
  refused: "refused",
  in: "in",
  notMeasured: "not measured",
  writtenNotShownOne: "more line written, not shown.",
  writtenNotShown: "more lines written, not shown.",
  refusalNotShown: "more refusal, not shown.",
  refusalsNotShown: "more refusals, not shown.",
  unmeasuredNotShown: "more not measured, not shown.",
  earlierNotShown: "earlier not shown.",
  // shared
  none: "none.",
  notShown: "more not shown.",
} as const;

/** Every sentence and fixed phrase these renderers write of their own; the decision lines they share are FRAME's. */
export const TEXT_FRAME: readonly string[] = Object.freeze(Object.values(T));

/** The head lines among them, one per part: each stands alone on its line. */
export const TEXT_HEADS: readonly string[] = Object.freeze([T.applyHead, T.factsHead, T.othersHead, T.tagsHead,
  T.pricesHead, T.measuredHead, T.lessonsHead, T.tagsSharedHead, T.pastHorizonHead, T.withoutWrongIfHead,
  T.voidedHead, T.proposalsHead]);

/** The review's start when since was absent: the epoch. */
const EPOCH = "1970-01-01T00:00:00.000Z";

/** The first text within max bytes, or the last one tried. */
function firstFit(texts: Iterable<string>, max: number): string {
  let last = "";
  for (const text of texts) {
    last = text;
    if (Buffer.byteLength(text) <= max) return text;
  }
  return last;
}

/** A number and the frame's words for it: the one for 1, the other for any other number. */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The first cap items as lines, then how many more there are, in the words of tail: [for one, for more]. */
function capped<X>(xs: readonly X[], cap: number, line: (x: X) => string[],
  tail: readonly [string, string] = [T.notShown, T.notShown]): string[] {
  const lines = xs.slice(0, cap).flatMap(line);
  if (xs.length > cap) lines.push(count(xs.length - cap, ...tail));
  return lines;
}

/** A card's id as given, or quoted when it is not a lesson id (a refused file's name). */
function idOf(id: string): string {
  return LESSON_ID.test(id) ? id : quote(id);
}

// ---- the status ------------------------------------------------------------------------------------------------

interface StatusShape { tags: boolean; others: boolean; cut: boolean }
type Applying = CardState & { card: Card };

/** The status's text, at most STATUS_MAX_BYTES. */
export function statusText(s: Status): string {
  return firstFit(statusSteps(s), STATUS_MAX_BYTES);
}

/** Its texts in yielding order: tags to a count, other lessons to a count per state, definitions cut, cards from the end. */
function* statusSteps(s: Status): Generator<string> {
  const ownerHolds = s.chains.find((c) => c.file === "owner.jsonl")?.ok !== false;
  const applying = s.cards.filter((c): c is Applying => ownerHolds && (c.state === "armed" || c.state === "changed")
    && c.card !== undefined);
  const others = s.cards.filter((c) => !applying.includes(c as Applying));
  const view = { s, ownerHolds, applying, others, all: applying.length };
  const shapes: StatusShape[] = [{ tags: true, others: true, cut: false }, { tags: false, others: true, cut: false },
    { tags: false, others: false, cut: false }, { tags: false, others: false, cut: true }];
  for (const shape of shapes) yield renderStatus(view, shape);
  for (let n = applying.length - 1; n >= 0; n--) yield renderStatus({ ...view, applying: applying.slice(0, n) }, shapes.at(-1)!);
}

interface StatusView { s: Status; ownerHolds: boolean; applying: Applying[]; others: CardState[]; all: number }

function renderStatus(v: StatusView, shape: StatusShape): string {
  const { s } = v;
  const more = v.all - v.applying.length;
  const out = [opening(s, v.all), T.applyHead];
  if (!v.ownerHolds) out.push(T.ownerBroken);
  else if (v.all === 0) out.push(T.noneArmed);
  for (const c of v.applying) out.push(...applyingCard(c));
  if (more > 0) out.push(`${more} ${T.notShown}`);

  out.push(T.factsHead);
  const shown = new Set(v.applying.map((c) => c.id));
  const facts = s.facts.filter((f) => shown.has(f.card));
  for (const f of facts) {
    out.push(`- ${f.card}: ${f.fact}, ${T.definition} ${quote(short(f.definition, shape.cut))}, ${T.checks} ${checks(f.checked)}`);
  }
  if (more > 0) out.push(T.factsNotShown);
  else if (facts.length === 0) out.push(T.none);

  out.push(T.othersHead);
  if (v.others.length === 0) out.push(T.none);
  else if (shape.others) for (const c of v.others) out.push(otherCard(c));
  else for (const [state, n] of countBy(v.others.map((c) => c.state))) out.push(`- ${state}: ${n}`);

  out.push(T.tagsHead);
  if (s.tags.length === 0) out.push(T.none);
  else if (shape.tags) for (const t of s.tags) out.push(`- ${quote(t.tag)} ${t.count}`);
  else out.push(`- ${count(s.tags.length, T.tagLeftOut, T.tagsLeftOut)}`);

  out.push(T.pricesHead, ...prices(s.prices));
  return out.join("\n");
}

/**
 * The price source and its last asking: with no source, that none is set and nothing more; else the source's URL, cut
 * to URL_SHOWN characters, and when it was last asked and whether it answered, or that the last run asked it nothing
 * (asked 0). A file v0.1 wrote has no asked, and is read as a run that asked.
 */
function prices(p: Status["prices"]): string[] {
  if (p.url === "") return [`- ${T.noSource}`];
  const last = p.last;
  const when = last === undefined ? T.neverAsked
    : last.asked === 0 ? `${T.lastRunAt} ${last.t}, ${T.askedNothing}`
    : `${T.lastAsked} ${last.t}, ${last.ok ? T.answered : `${T.refusals} ${last.refused}`}`;
  return [`- ${T.source} ${quote(cutTo(p.url, URL_SHOWN))}`, `- ${when}`];
}

/** The opening line: how many lessons, how many apply, each chain, the partial last lines. */
function opening(s: Status, applying: number): string {
  const chains = s.chains.map((c) => (c.ok ? `${c.file} ${T.holds}` : `${c.file} ${T.brokenAt} ${c.line ?? "?"}`)).join(", ");
  const partial = s.partial.length > 0 ? ` ${T.partial} ${s.partial.join(", ")}.` : "";
  return `${count(s.cards.length, T.lessonInAll, T.lessonsInAll)} ${applying} ${T.applying} ${T.chains} ${chains}.${partial}`;
}

function applyingCard(c: Applying): string[] {
  const card = c.card;
  const strength = card.strength === "red-line" ? T.redLine : T.caveat;
  const scope: string[] = [];
  if (card.scope?.market !== undefined) scope.push(`${T.market} ${card.scope.market.map(quote).join(", ")}`);
  if (card.scope?.symbols !== undefined) scope.push(`${T.symbols} ${card.scope.symbols.map(quote).join(", ")}`);
  const scoped = scope.length > 0 ? `, ${T.scope} ${scope.join("; ")}` : "";
  const changed = c.state === "changed" ? ` ${T.changed}` : "";
  return [`- ${strength} ${card.id}, ${T.says} ${card.says} ${T.on} ${card.actions.join(", ")}${scoped}${changed}`,
    `  ${T.ownersWords} ${quote(card.words)}`];
}

function otherCard(c: CardState): string {
  return `- ${idOf(c.id)} ${c.state}${c.fault !== undefined ? `, ${T.fault} ${quote(c.fault)}` : ""}`;
}

/** A fact's checks: each operator and value, the value as JSON quotes it. */
function checks(list: Check[]): string {
  if (list.length === 0) return T.noCheck;
  const value = (x: Check["value"]): string => (Array.isArray(x) ? `[${x.map(value).join(", ")}]`
    : typeof x === "string" ? quote(x) : String(x));
  return list.map((ch) => `${ch.op} ${value(ch.value)}`).join("; ");
}

function countBy(xs: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts];
}

// ---- the review ------------------------------------------------------------------------------------------------

interface ReviewShape { measured: number; cut: boolean; medians: boolean; ids: number }

/** The review's text, at most REVIEW_MAX_BYTES. */
export function reviewText(r: Review): string {
  return firstFit(reviewSteps(r), REVIEW_MAX_BYTES);
}

/**
 * Its texts in yielding order, as a recall yields: theses, conditions and reasons cut; medians gone; measured
 * decisions beyond the newest MEASURED_SHOWN counted as earlier ones; id lists beyond IDS_SHOWN counted; then every
 * list shorter.
 */
function* reviewSteps(r: Review): Generator<string> {
  const all = Number.POSITIVE_INFINITY;
  yield renderReview(r, { measured: all, cut: false, medians: true, ids: all });
  yield renderReview(r, { measured: all, cut: true, medians: true, ids: all });
  yield renderReview(r, { measured: all, cut: true, medians: false, ids: all });
  yield renderReview(r, { measured: MEASURED_SHOWN, cut: true, medians: false, ids: all });
  for (let n = IDS_SHOWN; n >= 0; n--) yield renderReview(r, { measured: Math.min(n, MEASURED_SHOWN), cut: true, medians: false, ids: n });
}

function renderReview(r: Review, shape: ReviewShape): string {
  const out = [r.since === EPOCH ? T.fromStart : `${T.since} ${r.since}.`];
  const part = (head: string, lines: string[]): void => { out.push(head, ...(lines.length > 0 ? lines : [T.none])); };

  // The newest decisions are kept, in the order they were registered; the earlier ones are counted.
  const shown = r.measured.slice(Math.max(0, r.measured.length - shape.measured));
  const earlier = r.measured.length - shown.length;
  part(T.measuredHead, [...(earlier > 0 ? [`${earlier} ${T.earlierNotShown}`] : []),
    ...(shown.length > 0 ? decisions(shown, true, shape.cut) : [])]);
  part(T.lessonsHead, capped(r.cards, shape.ids, (c) => reviewCard(c, shape.medians)));
  part(T.tagsSharedHead, capped(r.tags_shared, shape.ids, (t) => [`- ${quote(t.tag)} ${t.decisions.length} ${T.decisionsWord}`]));
  part(T.pastHorizonHead, capped(r.past_horizon, shape.ids, (id) => [`- ${id}`]));
  out.push(T.withoutWrongIfHead, `- ${T.decisionsCount} ${r.without_wrong_if}`);
  part(T.voidedHead, capped(r.voided, shape.ids, (v) => [`- ${v.decision} ${T.by} ${v.by}`]));
  part(T.proposalsHead, capped(r.proposals, shape.ids, (p) =>
    [`- ${p.id}: ${p.what} ${T.lesson} ${p.lesson}, ${T.by} ${p.by}, ${T.reason} ${quote(short(p.reason, shape.cut))}`]));
  return out.join("\n");
}

function reviewCard(c: Review["cards"][number], medians: boolean): string[] {
  const o = c.record.owner;
  const g = c.record.agents;
  const flags = [...(c.quiet ? [T.quiet] : []), ...(c.overridden_often ? [T.overriddenOften] : [])];
  const lines = [`- ${c.id}: ${T.ownerSide} ${T.fired} ${o.fired}, ${T.followed} ${o.followed}, ${T.overridden} ${o.overridden}, `
    + `${T.seen} ${o.seen}, ${T.backfilled} ${o.backfilled}, ${T.noDecision} ${o.no_decision} · ${T.agentsSide} `
    + `${T.followed} ${g.followed}, ${T.overridden} ${g.overridden}, ${T.seen} ${g.seen}`
    + (flags.length > 0 ? `; ${flags.join("; ")}` : "")];
  if (medians) {
    const groups = ([[T.followed, c.record.medians.followed], [T.overridden, c.record.medians.overridden]] as const)
      .filter(([, m]) => Object.keys(m).length > 0)
      .map(([name, m]) => `${T.median} ${name} ${Object.entries(m).map(([k, x]) => `${k}d ${pct(x)}`).join(", ")}`);
    if (groups.length > 0) lines.push(`  ${groups.join("; ")}`);
  }
  return lines;
}

// ---- the reconcile ---------------------------------------------------------------------------------------------

interface ReconcileShape { written: number; refused: number; unmeasured: number }

/** The reconcile's text, at most RECONCILE_MAX_BYTES. */
export function reconcileText(r: ReconcileReport): string {
  if (r.source === null) return T.noSourceRun;
  if (r.fresh !== undefined) return freshText(r, r.fresh);
  return firstFit(reconcileSteps(r), RECONCILE_MAX_BYTES);
}

/** A fresh run's text: when the source was asked and may be again, what it refused then, and what may be due. */
function freshText(r: ReconcileReport, fresh: NonNullable<ReconcileReport["fresh"]>): string {
  const parts = [`${T.askedAt} ${fresh.asked_at}; ${T.againAfter} ${fresh.again_after}. ${T.nothingDone}`];
  if (fresh.refused > 0) parts.push(count(fresh.refused, T.refusedThenOne, T.refusedThenMany));
  if (r.stillDue > 0) parts.push(count(r.stillDue, T.dueOne, T.dueMany));
  return parts.join(" ");
}

/**
 * Its texts in yielding order: unmeasured decisions beyond UNMEASURED_SHOWN counted, then written lines beyond
 * WRITTEN_SHOWN, then refusals beyond REFUSALS_SHOWN, then every list shorter, one line at a time.
 */
function* reconcileSteps(r: ReconcileReport): Generator<string> {
  const all = Number.POSITIVE_INFINITY;
  yield renderReconcile(r, { written: all, refused: all, unmeasured: all });
  yield renderReconcile(r, { written: all, refused: all, unmeasured: UNMEASURED_SHOWN });
  yield renderReconcile(r, { written: WRITTEN_SHOWN, refused: all, unmeasured: UNMEASURED_SHOWN });
  yield renderReconcile(r, { written: WRITTEN_SHOWN, refused: REFUSALS_SHOWN, unmeasured: UNMEASURED_SHOWN });
  for (let n = WRITTEN_SHOWN - 1; n >= 0; n--) {
    yield renderReconcile(r, { written: n, refused: Math.min(n, REFUSALS_SHOWN), unmeasured: Math.min(n, UNMEASURED_SHOWN) });
  }
}

/** A refusal's why is cut to WHY_SHOWN characters, whatever the shape. */
function renderReconcile(r: ReconcileReport, shape: ReconcileShape): string {
  return [
    `${T.measured} ${r.measured}, ${T.closedCount} ${r.closed}, ${T.stillDue} ${r.stillDue}, ${T.refusedCount} ${r.refused.length}, `
      + `${T.unmeasured} ${r.unmeasured.length}.`,
    ...capped(r.written, shape.written, (w) => [`- ${T.wrote} ${w.decision} ${w.symbol}: ${writtenWhat(w)}`],
      [T.writtenNotShownOne, T.writtenNotShown]),
    ...capped(r.refused, shape.refused, (x) => [`- ${T.refused} ${x.symbol} ${T.in} ${x.market}: ${quote(cutTo(x.why, WHY_SHOWN))}`],
      [T.refusalNotShown, T.refusalsNotShown]),
    ...capped(r.unmeasured, shape.unmeasured, (u) => [`- ${T.notMeasured} ${u.decision}: ${u.why}`],
      [T.unmeasuredNotShown, T.unmeasuredNotShown]),
  ].join("\n");
}

function writtenWhat(w: Written): string {
  if (w.what === "closed") return T.closed;
  const figure = typeof w.pct === "number" ? pct(w.pct) : T.notTaken;
  return w.what === "horizon" ? `${T.horizon} ${w.k}d ${figure}` : `${T.leg} ${figure}`;
}
