import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GRILLE_BANDS,
  MIN_TOTAL_SPEAKING_SECONDS,
  SCORE_MAX,
  applyDurationPenalty,
  criteriaToScore25,
  meetsFloor,
  snapCriteria,
  snapToBand,
} from "./rubric";

describe("DELF grille", () => {
  it("only ever produces legal bands", () => {
    for (const raw of [-3, 0, 0.4, 1, 1.6, 2, 2.4, 3, 3.9, 4, 4.6, 5, 12, Number.NaN]) {
      assert.ok(
        (GRILLE_BANDS as readonly number[]).includes(snapToBand(raw)),
        `${raw} snapped outside the grille`,
      );
    }
  });

  it("rounds an ambiguous 2 and 4 down, never up", () => {
    // The upper band is a claim about the candidate that a hedged score has not earned.
    assert.equal(snapToBand(2), 1);
    assert.equal(snapToBand(4), 3);
  });

  it("sums the five bands into the /25 score", () => {
    const scores = snapCriteria({
      realisationTache: 5,
      interaction: 3,
      lexique: 3,
      morphosyntaxe: 1,
      phonologie: 0,
    });
    assert.equal(criteriaToScore25(scores), 12);
  });

  it("reaches the full 25 for a perfect performance", () => {
    const perfect = snapCriteria({
      realisationTache: 5,
      interaction: 5,
      lexique: 5,
      morphosyntaxe: 5,
      phonologie: 5,
    });
    assert.equal(criteriaToScore25(perfect), SCORE_MAX);
  });

  it("does not penalise an exam of full length", () => {
    assert.equal(applyDurationPenalty(20, MIN_TOTAL_SPEAKING_SECONDS), 20);
    assert.equal(applyDurationPenalty(20, MIN_TOTAL_SPEAKING_SECONDS + 600), 20);
  });

  it("penalises a short exam, and a very short one harder", () => {
    assert.equal(applyDurationPenalty(20, MIN_TOTAL_SPEAKING_SECONDS - 60), 17);
    assert.equal(applyDurationPenalty(20, 60), 15);
  });

  it("never drives a score below zero", () => {
    assert.equal(applyDurationPenalty(2, 10), 0);
  });

  it("applies the DELF competency floor at 5/25", () => {
    assert.equal(meetsFloor(4), false);
    assert.equal(meetsFloor(5), true);
  });
});
