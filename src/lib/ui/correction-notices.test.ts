import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { correctionNotices } from "./correction-notices";

describe("the correction's penalty notices", () => {
  it("says nothing about a sitting that earned neither penalty", () => {
    const notices = correctionNotices({
      rawScore25: 20,
      score25: 20,
      durationPenalty: 0,
      absencePenalty: 0,
      shortParts: [],
      absentParts: [],
    });

    assert.equal(notices.absence, null);
    assert.equal(notices.duration, null);
  });

  it("explains a short épreuve against the sum of the bands", () => {
    const notices = correctionNotices({
      rawScore25: 20,
      score25: 17,
      durationPenalty: 3,
      shortParts: ["debate"],
    });

    assert.equal(notices.absence, null);
    assert.equal(notices.duration?.beforePenalty, 20);
    assert.equal(notices.duration?.label, "Votre débat a été");
  });

  it("explains a walk-out against the half that was marked", () => {
    const notices = correctionNotices({
      rawScore25: 25,
      score25: 12,
      durationPenalty: 0,
      absencePenalty: 13,
      shortParts: [],
      absentParts: ["debate"],
    });

    assert.equal(notices.absence?.rawScore25, 25);
    assert.equal(notices.absence?.label, "Vous n'avez pas participé au débat");
    assert.equal(notices.duration, null, "the absent part is not also called short");
  });

  it("takes the duration penalty off the halved score, not the sum of the bands", () => {
    // The case both rules fire on: 25 → halved to 12 → docked 3 → 9. Printing
    // the 25 as the figure the −3 came off leaves the candidate reading
    // "25/25, divided by two" above "25/25, minus the penalty" and neither
    // sentence reaching the 9 they were given.
    const notices = correctionNotices({
      rawScore25: 25,
      score25: 9,
      durationPenalty: 3,
      absencePenalty: 13,
      shortParts: ["monologue"],
      absentParts: ["debate"],
    });

    assert.equal(notices.absence?.rawScore25, 25, "the halving is explained from the full sum");
    assert.equal(notices.duration?.beforePenalty, 12, "the dock is explained from the half");
    assert.equal(notices.duration?.label, "Votre monologue a été");
    // The two paragraphs and the mark now reconcile: 25 → 12, 12 − 3 = 9.
    assert.equal(notices.duration!.beforePenalty - 3, 9);
  });

  it("names both parts when both fall short, and when neither happened", () => {
    assert.equal(
      correctionNotices({
        rawScore25: 20,
        score25: 17,
        durationPenalty: 3,
        shortParts: ["monologue", "debate"],
      }).duration?.label,
      "Vos deux prises de parole ont été",
    );

    assert.equal(
      correctionNotices({
        rawScore25: 20,
        score25: 10,
        durationPenalty: 0,
        absencePenalty: 10,
        absentParts: ["monologue", "debate"],
      }).absence?.label,
      "Vous n'avez pris la parole dans aucune des deux parties",
    );
  });

  it("still explains the halving when the correction forgot which part", () => {
    // A second submission returns the stored row, which carries the penalty and
    // not the corrector's working — `absent_parts` has no column. The paragraph
    // must still account for the missing points.
    const notices = correctionNotices({
      rawScore25: 25,
      score25: 12,
      durationPenalty: 0,
      absencePenalty: 13,
    });

    assert.equal(notices.absence?.label, "Une partie de l'épreuve n'a pas été réalisée");
    assert.equal(notices.absence?.rawScore25, 25);
  });

  it("falls back to the difference on a correction graded before the fields existed", () => {
    // No `durationPenalty`, no `absencePenalty`: a sitting from before either
    // column, where the only evidence of a penalty is that the mark is under
    // the sum of the bands. There was no halving then, so the difference is
    // the duration penalty and nothing else.
    const notices = correctionNotices({ rawScore25: 20, score25: 17 });

    assert.equal(notices.absence, null);
    assert.equal(notices.duration?.beforePenalty, 20);
    assert.equal(notices.duration?.label, "Votre temps de parole a été");
  });

  it("does not invent a duration penalty out of the halving alone", () => {
    // The same old-correction fallback, on a sitting that WAS halved. Without
    // subtracting the absence first, `score25 < rawScore25` is true purely
    // because of the halving, and the page would print a duration paragraph
    // for a penalty that was never taken.
    const notices = correctionNotices({
      rawScore25: 25,
      score25: 12,
      absencePenalty: 13,
      absentParts: ["debate"],
    });

    assert.equal(notices.absence?.label, "Vous n'avez pas participé au débat");
    assert.equal(notices.duration, null);
  });
});
