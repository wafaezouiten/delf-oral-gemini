import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COMPETENCY_MAX, ORAL_PARTS_B2 } from "@/lib/delf/constants";
import { ORAL_CRITERIA } from "@/lib/delf/criteria";
import { zeroCriteria, type DashboardSitting } from "./dashboard-view";
import {
  buildHubFormat,
  buildHubSujets,
  buildHubView,
  buildShapePill,
  HUB_LINKS,
  isNavLinkActive,
  latestScoreBySujet,
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
    assert.ok(buildHubView().criteria.includes("Maîtrise du système phonologique"));
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

describe("the navigation's active link", () => {
  it("lights a link on its own page", () => {
    assert.equal(isNavLinkActive("/app", "/app"), true);
    assert.equal(isNavLinkActive(HUB_LINKS.sujets, HUB_LINKS.sujets), true);
  });

  it("does not light the index link on every page in the product", () => {
    // `/app` is a prefix of every route here, so the subtree rule would light
    // "L'épreuve" on the sujets page, the dashboard, the simulateur and the
    // correction — the rail then claims the candidate is somewhere they are
    // not. The index link is therefore matched exactly.
    assert.equal(isNavLinkActive(HUB_LINKS.sujets, "/app", true), false);
    assert.equal(isNavLinkActive(HUB_LINKS.tableauDeBord, "/app", true), false);
    assert.equal(isNavLinkActive("/app/oral/12", "/app", true), false);
    assert.equal(isNavLinkActive("/app", "/app", true), true);
  });

  it("lights a section link on its own children", () => {
    assert.equal(isNavLinkActive("/app/sujets/teletravail", HUB_LINKS.sujets), true);
  });

  it("does not match a sibling that merely shares a prefix string", () => {
    // "/app/sujets-archive" starts with "/app/sujets" as a string but is not
    // under it as a route.
    assert.equal(isNavLinkActive("/app/sujets-archive", HUB_LINKS.sujets), false);
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

/**
 * One sitting, as `readCandidateHistory` returns it. Only the slug and the score
 * are read by the reducer; the rest is filled so the fixture is a real
 * `DashboardSitting` and a field added to the type fails here rather than
 * drifting.
 */
function sitting(overrides: Partial<DashboardSitting> = {}): DashboardSitting {
  return {
    examId: 1,
    topicSlug: "teletravail",
    topicTitle: "Le télétravail a-t-il vraiment amélioré nos vies ?",
    outcome: "corrected",
    score25: 15,
    meetsFloor: true,
    mode: "audio",
    criteria: {
      realisationTache: 3,
      interaction: 3,
      lexique: 3,
      morphosyntaxe: 3,
      phonologie: 3,
    },
    spokenSeconds: 600,
    phase: "finished",
    endedAt: new Date("2026-08-16T10:00:00Z"),
    archivedAt: null,
    ...overrides,
  };
}

describe("the score on a sujet card", () => {
  it("is the last sitting's, not the best one's", () => {
    // Newest first, as `readCandidateHistory` returns them: 18 was the personal
    // best, 11 was this morning. The card answers « où j'en suis ? ».
    const scores = latestScoreBySujet([
      sitting({ examId: 2, score25: 11, endedAt: new Date("2026-08-17T10:00:00Z") }),
      sitting({ examId: 1, score25: 18, endedAt: new Date("2026-08-10T10:00:00Z") }),
    ]);
    assert.equal(scores.get("teletravail"), 11);
  });

  it("keeps one sujet's history out of another's", () => {
    const scores = latestScoreBySujet([
      sitting({ examId: 3, topicSlug: "ecrans", score25: 7 }),
      sitting({ examId: 2, topicSlug: "teletravail", score25: 20 }),
      sitting({ examId: 1, topicSlug: "teletravail", score25: 4 }),
    ]);
    assert.equal(scores.get("ecrans"), 7);
    assert.equal(scores.get("teletravail"), 20);
  });

  it("counts a walk-out, so a sujet last abandoned reads zero", () => {
    // The exit dialog told the candidate it would count. This is where that
    // promise is kept — the 18 is still in the historique and in the moyenne.
    const scores = latestScoreBySujet([
      sitting({
        examId: 2,
        outcome: "abandoned",
        score25: 0,
        meetsFloor: false,
        mode: null,
        criteria: zeroCriteria(),
        spokenSeconds: 0,
        phase: "monologue",
        endedAt: new Date("2026-08-17T10:00:00Z"),
      }),
      sitting({ examId: 1, score25: 18, endedAt: new Date("2026-08-10T10:00:00Z") }),
    ]);
    assert.equal(scores.get("teletravail"), 0);
  });

  it("leaves a sujet never sat out of the map entirely", () => {
    // Absent, not zero: `buildHubSujets` turns the miss into `null` and the card
    // into « Commencer ».
    const scores = latestScoreBySujet([sitting()]);
    assert.equal(scores.has("ecrans"), false);
    const [card] = buildHubSujets([{ slug: "ecrans", title: "É ?", document: "D." }], scores);
    assert.equal(card.score, null);
  });

  it("reads an empty history as no scores at all", () => {
    assert.equal(latestScoreBySujet([]).size, 0);
  });
});
