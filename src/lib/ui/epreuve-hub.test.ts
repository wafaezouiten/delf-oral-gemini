import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COMPETENCY_MAX, ORAL_PARTS_B2 } from "@/lib/delf/constants";
import { ORAL_CRITERIA } from "@/lib/delf/criteria";
import {
  buildHubFormat,
  buildHubSujets,
  buildHubView,
  buildShapePill,
  sujetMeta,
  sujetTeaser,
} from "./epreuve-hub";

describe("the format section", () => {
  it("draws one row per real partie, in the épreuve's order", () => {
    const rows = buildHubFormat();
    assert.equal(rows.length, ORAL_PARTS_B2.length);
    assert.deepEqual(
      rows.map((row) => row.pill),
      ["Partie 1", "Partie 2"],
    );
    assert.deepEqual(
      rows.map((row) => row.title),
      ORAL_PARTS_B2.map((spec) => spec.title),
    );
  });

  it("prints the duration off the spec, so the hub cannot promise a different épreuve", () => {
    const [monologue, debate] = buildHubFormat();
    assert.ok(monologue.facts.includes("≈ 7 min"));
    assert.ok(debate.facts.includes("≈ 13 min"));
  });

  it("names the preparation only on the partie that has one", () => {
    // The débat's spec says zero, which is true of the DELF and would print
    // « Sans préparation » — read on the hub as though it were an unprepared
    // task rather than the second half of one prepared sitting.
    const [monologue, debate] = buildHubFormat();
    assert.ok(monologue.facts.includes("Préparation : 30 min"));
    assert.ok(!debate.facts.some((fact) => /[Pp]réparation/.test(fact)));
  });

  it("states the marking on every row", () => {
    for (const row of buildHubFormat()) {
      assert.ok(row.facts.includes(`noté /${COMPETENCY_MAX}`));
    }
  });
});

describe("the masthead pill", () => {
  it("counts the parties and agrees the noun with them", () => {
    assert.equal(buildShapePill(), `DELF B2 · 2 parties · noté /${COMPETENCY_MAX}`);
  });
});

describe("the hub view", () => {
  it("states the five criteria the correction actually reports", () => {
    // Retyped, these drift: the hub would advertise an épreuve marked on
    // something the grille does not print.
    assert.equal(buildHubView().criteria.length, ORAL_CRITERIA.length);
    assert.ok(buildHubView().criteria.includes("Maîtrise phonologique"));
  });

  it("names its icons by role, never by glyph", () => {
    // The component owns the drawing; the view model owning it is how the copy
    // layer ends up importing an icon package.
    assert.deepEqual(
      buildHubView().capabilities.map((capability) => capability.icon),
      ["conditions", "correction", "score"],
    );
  });
});

describe("the sujet teaser", () => {
  it("leaves a short document alone", () => {
    assert.equal(sujetTeaser("Court."), "Court.");
  });

  it("cuts at a sentence end rather than mid-clause", () => {
    const document =
      "Une première phrase qui occupe une bonne part de la fenêtre. Une deuxième phrase qui déborde largement et continue encore un moment.";
    const teaser = sujetTeaser(document, 80);
    assert.equal(teaser, "Une première phrase qui occupe une bonne part de la fenêtre.");
  });

  it("ignores a sentence end so early that the teaser would say nothing", () => {
    // "Oui." is a legal sentence and a useless card. Below 40 % of the window
    // the word-boundary cut carries more of the document, so it wins.
    const document = `Oui. ${"un mot de plus ".repeat(20)}fin.`;
    const teaser = sujetTeaser(document, 80);
    assert.ok(teaser.length > 40, `teaser was ${JSON.stringify(teaser)}`);
    assert.ok(teaser.endsWith("…"));
  });

  it("falls back to a word boundary with an ellipsis when no sentence ends in range", () => {
    const document = `${"mot ".repeat(80)}fin.`;
    const teaser = sujetTeaser(document, 60);
    assert.ok(teaser.endsWith("…"));
    assert.ok(teaser.length <= 61);
    // Never a cut through the middle of a word.
    assert.doesNotMatch(teaser, /mo…$/);
  });
});

describe("the sujet cards", () => {
  const topics = [
    { slug: "a", title: "A ?", document: "Document A." },
    { slug: "b", title: "B ?", document: "Document B." },
  ];

  it("marks a sujet never sat as null, not as zero", () => {
    // Zero would read as "failed"; the card's whole CTA hangs off the
    // difference between Commencer and Refaire.
    const [a, b] = buildHubSujets(topics, new Map([["a", 18]]));
    assert.equal(a.score, 18);
    assert.equal(b.score, null);
  });

  it("gives every card the same real timings", () => {
    for (const sujet of buildHubSujets(topics, new Map())) {
      assert.equal(sujet.meta, sujetMeta());
    }
    assert.equal(sujetMeta(), "30 min de préparation · 20 min d'oral");
  });
});
