import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { correctionNotices, earlyClosingNotice } from "./correction-notices";

describe("the correction's penalty notices", () => {
  it("says nothing about a sitting that earned no halving", () => {
    const notices = correctionNotices({
      rawScore25: 20,
      absencePenalty: 0,
      absentParts: [],
    });

    assert.equal(notices.absence, null);
  });

  it("has no duration paragraph left to print (#137)", () => {
    // « Note avant pénalité de durée : N/25 » is gone by the user's call. The
    // deep equality is the assertion: whatever a sitting was docked for its
    // length, the notices carry one field, and it is the halving's — there is
    // nothing here for the page to render about the duration penalty, which
    // still fires in the rubric and simply goes unexplained.
    assert.deepEqual(correctionNotices({ rawScore25: 20 }), { absence: null });
  });

  it("explains a walk-out against the half that was marked", () => {
    const notices = correctionNotices({
      rawScore25: 25,
      absencePenalty: 13,
      absentParts: ["debate"],
    });

    assert.match(notices.absence!, /^Vous n'avez pas participé au débat\./);
    assert.match(notices.absence!, /sur celle que vous avez réalisée \(25\/25\)/);
  });

  it("does not offer a part the candidate completed when neither was completed", () => {
    // Reachable in production, not merely defensive: the finish route counts
    // the WHOLE transcript against the floor, so 10 candidate words in the
    // monologue and 15 in the débat clear the gate at 25 and land under the
    // per-part floor twice. « la note obtenue sur celle que vous avez
    // réalisée » would name a part that does not exist.
    const notices = correctionNotices({
      rawScore25: 20,
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

  it("still explains the halving when the correction forgot which part", () => {
    // A second submission returns the stored row, which carries the penalty and
    // not the corrector's working — `absent_parts` has no column. The paragraph
    // must still account for the missing points, and must not guess.
    const notices = correctionNotices({
      rawScore25: 25,
      absencePenalty: 13,
    });

    assert.match(notices.absence!, /^Une partie de l'épreuve n'a pas été réalisée\./);
    assert.match(notices.absence!, /La note obtenue \(25\/25\) est donc divisée par deux\./);
    assert.doesNotMatch(notices.absence!, /que vous avez réalisée/);
  });

  it("prints a raw score under 10 on two digits, like every /25 (#161)", () => {
    const notices = correctionNotices({
      rawScore25: 9,
      absencePenalty: 5,
      absentParts: ["debate"],
    });

    assert.match(notices.absence!, /sur celle que vous avez réalisée \(09\/25\)/);
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
});

describe("the examiner-fault note (#92)", () => {
  it("says nothing when nothing was heard — including on every pre-column sitting", () => {
    // Zero, undefined and absent all read the same, and all three are real:
    // a fresh sitting with a well-behaved examiner, a stash from before the
    // field, a row from before the column. Their corrections were graded by a
    // corrector that was never told, so the sentence would be false above them.
    assert.equal(earlyClosingNotice(0), null);
    assert.equal(earlyClosingNotice(undefined), null);
  });

  it("blames the examiner and clears the candidate", () => {
    const notice = earlyClosingNotice(1)!;

    assert.match(notice, /l'examinateur a annoncé à tort la fin de l'épreuve/);
    assert.match(notice, /n'a pas été retenue contre vous/);
  });

  it("scopes the amnesty to the débat, where the waiver actually is", () => {
    // The monologue's penalties still stand — the goodbye is only ever heard
    // after the monologue is over — so the sentence must not promise more
    // than the rubric delivers to a candidate docked for a short monologue.
    const notice = earlyClosingNotice(2)!;

    assert.match(notice, /un débat écourté par cette annonce n'a entraîné aucune pénalité/);
    assert.doesNotMatch(notice, /monologue/);
  });
});
