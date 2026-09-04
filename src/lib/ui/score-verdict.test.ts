import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COMPETENCY_FLOOR } from "@/lib/delf/constants";
import { SCORE_BANDS } from "@/lib/delf/grille";
import { SCORE_TONE_LABELS, resultMetaLine, scoreToneLabel } from "./score-verdict";

describe("the verdict pill's words (#190)", () => {
  it("names every band on the five-step scale", () => {
    for (const band of SCORE_BANDS) {
      // The reddest band starts at 0, under the floor, where the floor's own
      // wording wins; its name is asked for at the floor itself.
      const inBand = Math.max(band.min + 1, COMPETENCY_FLOOR);
      assert.equal(scoreToneLabel(inBand), SCORE_TONE_LABELS[band.tone]);
    }
    assert.equal(scoreToneLabel(25), "Très bon niveau");
    assert.equal(scoreToneLabel(16), "Bon niveau");
    assert.equal(scoreToneLabel(11), "Niveau moyen");
    assert.equal(scoreToneLabel(6), "Niveau insuffisant");
  });

  it("keeps the floor's wording for a mark under it, and only there", () => {
    assert.equal(scoreToneLabel(4), "Sous le seuil éliminatoire (5/25)");
    assert.equal(scoreToneLabel(0), "Sous le seuil éliminatoire (5/25)");
    // 5/25 clears the floor while sitting in the reddest band (#50): red pill,
    // band name, no éliminatoire.
    assert.equal(scoreToneLabel(5), "Niveau très insuffisant");
  });

  it("writes the meta line in the main project's order", () => {
    assert.equal(
      resultMetaLine({ criteriaCount: 5, totalSeconds: 760 }),
      "Monologue suivi et débat · 5 critères · 12:40 · correction IA",
    );
    assert.equal(
      resultMetaLine({ criteriaCount: 5, totalSeconds: 0 }),
      "Monologue suivi et débat · 5 critères · 0:00 · correction IA",
    );
  });
});
