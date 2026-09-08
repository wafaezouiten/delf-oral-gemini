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

  it("stays silent about a sitting nothing was charged to", () => {
    assert.deepEqual(correctionNotices({ rawScore25: 20 }), { absence: null, duration: null });
  });

  it("says nothing about duration on a correction that predates the fields", () => {
    // The rows and stashes written before #189: `durationCharges` is absent and
    // `durationPenalty` reads 0, which is the truthful backfill. A sentence
    // above those would be inventing a charge.
    assert.equal(correctionNotices({ rawScore25: 20, durationPenalty: 0 }).duration, null);
    assert.equal(
      correctionNotices({ rawScore25: 20, durationPenalty: 4 }).duration,
      null,
      "a penalty with no charges to explain says nothing rather than guessing",
    );
  });

  describe("why the mark was docked for the clock (#189)", () => {
    // #137 removed « Note avant pénalité de durée : N/25 » by the user's call,
    // and for a long while the duration penalty fired unexplained. The user
    // reversed that on #189: « the candidate should know why he got
    // penalized ». What comes back is not the old paragraph — that one printed
    // a number beside a mark it did not account for — but the reason: which
    // part fell short of what, what it cost, and which criterion it came off.
    const shortDebate = () =>
      correctionNotices({
        rawScore25: 23,
        durationPenalty: 2,
        durationCharges: [
          {
            part: "debate",
            criterion: "interaction",
            tier: "moderate",
            seconds: 6 * 60,
            from: 5,
            to: 3,
            points: 2,
          },
        ],
      }).duration;

    it("names the part, both durations, the cost and the criterion", () => {
      const notice = shortDebate();

      assert.match(notice!, /^Votre débat a duré 6 minutes sur les 10 attendues/);
      assert.match(notice!, /coûté 2 points au titre de l'interaction/);
    });

    it("promises the language criteria were untouched, because they were", () => {
      assert.match(shortDebate()!, /lexique.+morphosyntaxe.+prononciation/);
      assert.match(shortDebate()!, /jamais pénalisés par la durée/);
    });

    it("never claims a band was lowered, because none was", () => {
      // The sentence sits on a page that prints « Interaction 5 » from the same
      // correction: the charge is priced from the band and the band is left as
      // the corrector set it. Saying otherwise would contradict the row above.
      const notice = shortDebate()!;

      assert.ok(!/abaiss/i.test(notice), notice);
      assert.ok(!/ramené/i.test(notice), notice);
      assert.match(notice, /les notes affichées ci-dessus sont bien celles du correcteur/);
    });

    it("names both parts when both ran short", () => {
      const notice = correctionNotices({
        rawScore25: 25,
        durationPenalty: 8,
        durationCharges: [
          {
            part: "monologue",
            criterion: "realisationTache",
            tier: "strong",
            seconds: 120,
            from: 5,
            to: 1,
            points: 4,
          },
          {
            part: "debate",
            criterion: "interaction",
            tier: "strong",
            seconds: 150,
            from: 5,
            to: 1,
            points: 4,
          },
        ],
      }).duration;

      assert.match(notice!, /^Les deux parties ont été plus courtes/);
      assert.match(notice!, /votre monologue a duré 2 minutes sur les 7 attendues/);
      assert.match(notice!, /votre débat a duré 3 minutes sur les 10 attendues/);
    });

    it("leaves out a part whose criterion had nothing left to lose", () => {
      // A criterion already at 0 is charged 0 points by the ladder. « Cela a
      // coûté 0 point » explains a penalty nobody received, so the clause is
      // dropped — and with only such clauses, the whole paragraph is.
      const mixed = correctionNotices({
        rawScore25: 6,
        durationPenalty: 1,
        durationCharges: [
          {
            part: "monologue",
            criterion: "realisationTache",
            tier: "strong",
            seconds: 60,
            from: 1,
            to: 0,
            points: 1,
          },
          {
            part: "debate",
            criterion: "interaction",
            tier: "strong",
            seconds: 60,
            from: 0,
            to: 0,
            points: 0,
          },
        ],
      }).duration;

      assert.match(mixed!, /^Votre monologue a duré 1 minute sur les 7 attendues/);
      assert.ok(!mixed!.includes("débat"), mixed!);

      const nothingToLose = correctionNotices({
        rawScore25: 0,
        durationPenalty: 0,
        durationCharges: [
          {
            part: "debate",
            criterion: "interaction",
            tier: "strong",
            seconds: 30,
            from: 0,
            to: 0,
            points: 0,
          },
        ],
      }).duration;

      assert.equal(nothingToLose, null);
    });
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
