import { expect, test } from "vitest";
import { parseCard, renderCard } from "../src/cards.js";
import type { Card } from "../src/types.js";
import { STAND_IN_CARD } from "./helpers.js";

const ID = "no-chasing-after-a-run";

/** Expects parseCard to fail with E_CARD; returns its message. */
function refused(text: string, fileId = ID): string {
  let err: unknown = null;
  try {
    parseCard(text, fileId);
  } catch (e) {
    err = e;
  }
  expect(err, "expected E_CARD, but the card parsed").not.toBeNull();
  expect((err as { code?: string }).code).toBe("E_CARD");
  return (err as Error).message;
}

const swap = (from: string | RegExp, to: string) => STAND_IN_CARD.replace(from, to);

test("the stand-in card parses", () => {
  const card = parseCard(STAND_IN_CARD, ID);
  expect(card.id).toBe(ID);
  expect(card.says).toBe("dont");
  expect(card.actions).toEqual(["buy", "add"]);
  expect(card.strength).toBe("caveat");
  expect(card.scope?.market).toEqual(["US"]);
  expect(card.check).toEqual([
    { fact: "sector", op: "in", value: ["semiconductors", "software"] },
    { fact: "change_5d_pct", op: ">=", value: 20 },
  ]);
  expect(card.source).toEqual(["owner, 2026-01-05"]);
  expect(card.words).toBe("No new position in a name that ran 20% in five sessions.");
});

test("render and parse agree", () => {
  const card = parseCard(STAND_IN_CARD, ID);
  expect(parseCard(renderCard(card), card.id)).toEqual(card);
  const bare: Card = { id: "bare-card", says: "careful", actions: ["sell"], strength: "red-line", words: "Mind the gap." };
  expect(parseCard(renderCard(bare), bare.id)).toEqual(bare);
});

test("refused, in words", () => {
  const words201 = "x".repeat(201);
  const cases: [string, string, string[]][] = [
    ["an unknown key", swap("says: dont\n", "says: dont\ncolour: red\n"), ["colour", "not a field"]],
    ["an id that is not the file's name", swap(`id: ${ID}`, "id: other-id"), ["other-id", ID]],
    ["a check on a fact facts does not define", swap("fact: change_5d_pct", "fact: volume"), ["volume", "facts does not define"]],
    ["words of 201 characters", swap(/^No new position.*$/m, words201), ["words", "200"]],
    ["no words", swap(/^No new position.*$/m, ""), ["words"]],
    ["op in with a scalar", swap("value: [semiconductors, software]", "value: semiconductors"), ["check[0].value", "array"]],
    ["op >= with a string", swap("value: 20", "value: twenty"), ["check[1].value", "number"]],
    ["says never", swap("says: dont", "says: never"), ["says", "dont"]],
    ["actions empty", swap("actions: [buy, add]", "actions: []"), ["actions", "at least one"]],
    ["strength hard", swap("strength: caveat", "strength: hard"), ["strength", "red-line"]],
    ["no front matter", "No new position in a name that ran 20% in five sessions.\n", ["front matter"]],
  ];
  for (const [what, text, says] of cases) {
    const message = refused(text);
    for (const s of says) expect(message, what).toContain(s);
  }
});

test("CRLF and a byte-order mark parse the same", () => {
  const lf = parseCard(STAND_IN_CARD, ID);
  expect(parseCard(STAND_IN_CARD.replaceAll("\n", "\r\n"), ID)).toEqual(lf);
  expect(parseCard(`﻿${STAND_IN_CARD}`, ID)).toEqual(lf);
  expect(parseCard(Buffer.from(`﻿${STAND_IN_CARD.replaceAll("\n", "\r\n")}`, "utf8"), ID)).toEqual(lf);
});
