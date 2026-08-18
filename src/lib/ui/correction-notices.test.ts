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
    assert.match(notices.duration!, /Note avant pénalité de durée.: 20\/25\./);
    assert.match(notices.duration!, /Votre débat a été nettement plus court/);
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

    assert.match(notices.absence!, /^Vous n'avez pas participé au débat\./);
    assert.match(notices.absence!, /sur celle que vous avez réalisée \(25\/25\)/);
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

    assert.match(notices.absence!, /\(25\/25\)/, "the halving is explained from the full sum");
    // 12, not 25 — and 12 − 3 is the 9 printed above both paragraphs.
    assert.match(notices.duration!, /Note avant pénalité de durée.: 12\/25\./);
    assert.match(notices.duration!, /Votre monologue a été/);
  });

  it("does not offer a part the candidate completed when neither was completed", () => {
    // Reachable in production, not merely defensive: the finish route counts
    // the WHOLE transcript against the floor, so 10 candidate words in the
    // monologue and 15 in the débat clear the gate at 25 and land under the
    // per-part floor twice. « la note obtenue sur celle que vous avez
    // réalisée » would name a part that does not exist.
    const notices = correctionNotices({
      rawScore25: 20,
      score25: 10,
      durationPenalty: 0,
      absencePenalty: 10,
      absentParts: ["monologue", "debate"],
    });

    assert.match(notices.absence!, /^Vous n'avez pris la parole dans aucune des deux parties/);
    assert.match(notices.absence!, /La note obtenue \(20\/25\) est donc divisée par deux\./);
    assert.doesNotMatch(
      notices.absence!,
      /que vous avez réalisée/,
      "there is no part they realised",
    );
  });

  it("names both parts when both ran short", () => {
    assert.match(
      correctionNotices({
        rawScore25: 20,
        score25: 17,
        durationPenalty: 3,
        shortParts: ["monologue", "debate"],
      }).duration!,
      /Vos deux prises de parole ont été/,
    );
  });

  it("still explains the halving when the correction forgot which part", () => {
    // A second submission returns the stored row, which carries the penalty and
    // not the corrector's working — `absent_parts` has no column. The paragraph
    // must still account for the missing points, and must not guess.
    const notices = correctionNotices({
      rawScore25: 25,
      score25: 12,
      durationPenalty: 0,
      absencePenalty: 13,
    });

    assert.match(notices.absence!, /^Une partie de l'épreuve n'a pas été réalisée\./);
    assert.match(notices.absence!, /La note obtenue \(25\/25\) est donc divisée par deux\./);
    assert.doesNotMatch(notices.absence!, /que vous avez réalisée/);
  });

  it("never promises a completed part it cannot point at", () => {
    // The sweep behind the two cases above: the phrase is allowed only when
    // exactly one part is named, which is the only time there is another one.
    for (const absentParts of [
      undefined,
      [] as const,
      ["monologue"] as const,
      ["debate"] as const,
      ["monologue", "debate"] as const,
    ]) {
      const notice = correctionNotices({
        rawScore25: 20,
        score25: 10,
        durationPenalty: 0,
        absencePenalty: 10,
        absentParts,
      }).absence!;

      assert.equal(
        /que vous avez réalisée/.test(notice),
        absentParts?.length === 1,
        `with ${JSON.stringify(absentParts)}: ${notice}`,
      );
    }
  });

  it("falls back to the difference on a correction graded before the fields existed", () => {
    // No `durationPenalty`, no `absencePenalty`: a sitting from before either
    // column, where the only evidence of a penalty is that the mark is under
    // the sum of the bands. There was no halving then, so the difference is
    // the duration penalty and nothing else.
    const notices = correctionNotices({ rawScore25: 20, score25: 17 });

    assert.equal(notices.absence, null);
    assert.match(notices.duration!, /Note avant pénalité de durée.: 20\/25\./);
    assert.match(notices.duration!, /Votre temps de parole a été/);
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

    assert.match(notices.absence!, /Vous n'avez pas participé au débat/);
    assert.equal(notices.duration, null);
  });
});
