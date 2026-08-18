import assert from "node:assert/strict";
import { test } from "node:test";

import { ORAL_CRITERIA } from "../criteria";
import { GRILLE_BANDS } from "../grille";
import {
  DEBATE_FLOOR_SECONDS,
  MONOLOGUE_FLOOR_SECONDS,
  applyDurationPenalty,
  applySittingDurationPenalty,
  capUnheardPhonology,
  clampCriterion,
  criteriaToScore25,
  meetsCompetencyFloor,
  normalizeCriteria,
  applyAbsentPartPenalty,
  partsAbsent,
  partsUnderFloor,
  PARTICIPATION_WORD_FLOOR,
  scoreSitting,
  snapCriteria,
  UNHEARD_PHONOLOGY_CEILING,
  type OralCriteriaScores,
} from "../orale-rubric";

const full: OralCriteriaScores = {
  realisationTache: 5,
  interaction: 5,
  lexique: 5,
  morphosyntaxe: 5,
  phonologie: 5,
};

test("clampCriterion rounds and clamps to 0–5", () => {
  assert.equal(clampCriterion(3.4), 3);
  assert.equal(clampCriterion(3.6), 4);
  assert.equal(clampCriterion(-2), 0);
  assert.equal(clampCriterion(9), 5);
  assert.equal(clampCriterion(Number.NaN), 0);
});

test("normalizeCriteria clamps every field", () => {
  const normalized = normalizeCriteria({
    realisationTache: 7,
    interaction: -1,
    lexique: 4.5,
    morphosyntaxe: 2,
    phonologie: 100,
  });
  assert.deepEqual(normalized, {
    realisationTache: 5,
    interaction: 0,
    lexique: 5, // 4.5 rounds to 5
    morphosyntaxe: 2,
    phonologie: 5,
  });
});

test("criteriaToScore25 sums the five criteria to a /25", () => {
  assert.equal(criteriaToScore25(full), 25);
  assert.equal(
    criteriaToScore25({
      realisationTache: 3,
      interaction: 1,
      lexique: 3,
      morphosyntaxe: 3,
      phonologie: 1,
    }),
    11,
  );
  assert.equal(
    criteriaToScore25({
      realisationTache: 0,
      interaction: 0,
      lexique: 0,
      morphosyntaxe: 0,
      phonologie: 0,
    }),
    0,
  );
});

test("criteriaToScore25 clamps out-of-range input to [0,25]", () => {
  // Every field over-max would sum to 100 but must clamp to 25.
  assert.equal(
    criteriaToScore25({
      realisationTache: 20,
      interaction: 20,
      lexique: 20,
      morphosyntaxe: 20,
      phonologie: 20,
    }),
    25,
  );
});

test("applyDurationPenalty subtracts only when under the minimum", () => {
  assert.deepEqual(applyDurationPenalty(18, 120, 60), { score25: 18, penalty: 0 }); // over min
  assert.deepEqual(applyDurationPenalty(18, 30, 60), { score25: 15, penalty: 3 }); // under min
  assert.deepEqual(applyDurationPenalty(18, 60, 60), { score25: 18, penalty: 0 }); // exactly min
  assert.deepEqual(applyDurationPenalty(18, 10, 60, 5), { score25: 13, penalty: 5 }); // custom
});

test("applyDurationPenalty reports what it asked for, not what the score could absorb", () => {
  // The distinction #15's review asked for. A 2/25 docked 3 lands at 0, and the
  // record should say the rubric wanted 3 — otherwise a floored score reads as a
  // smaller penalty than the one that was actually applied.
  assert.deepEqual(applyDurationPenalty(2, 5, 60), { score25: 0, penalty: 3 });
});

test("meetsCompetencyFloor enforces the DELF ≥ 5/25 floor", () => {
  assert.equal(meetsCompetencyFloor(5), true);
  assert.equal(meetsCompetencyFloor(4), false);
  assert.equal(meetsCompetencyFloor(0), false);
  assert.equal(meetsCompetencyFloor(25), true);
});

// --------------------------------------------------------- the per-part rule

test("the floors are 40 % of each part, not a share of the sitting", () => {
  // 420 s of monologue and 780 s of débat (constants.ts). Pinned because the
  // deleted rubric measured an 8-minute sitting total instead, and 168 + 312 is
  // exactly that 480 — the two rules agree on the sum and disagree on every
  // sitting where one half carries the other.
  assert.equal(MONOLOGUE_FLOOR_SECONDS, 168);
  assert.equal(DEBATE_FLOOR_SECONDS, 312);
});

test("a part under its own floor is short even when the sitting total is not", () => {
  // Eight minutes of monologue and nothing else passes a 480 s total rule and
  // fails this one, which is the whole reason the port measures per part.
  const lopsided = { monologueSeconds: 480, debateSeconds: 0 };

  assert.deepEqual(partsUnderFloor(lopsided), ["debate"]);
  assert.deepEqual(applySittingDurationPenalty(20, lopsided), {
    score25: 17,
    penalty: 3,
    shortParts: ["debate"],
  });
});

test("a full sitting is not penalised", () => {
  const full = { monologueSeconds: 400, debateSeconds: 700 };

  assert.deepEqual(partsUnderFloor(full), []);
  assert.deepEqual(applySittingDurationPenalty(20, full), {
    score25: 20,
    penalty: 0,
    shortParts: [],
  });
});

test("the penalty fires once, however many parts fell short", () => {
  // The decision this project had to make and the port could not: the incumbent
  // grades one task per correction, so it never produces a −6. Neither do we.
  const nothing = { monologueSeconds: 0, debateSeconds: 0 };

  assert.deepEqual(partsUnderFloor(nothing), ["monologue", "debate"]);
  assert.deepEqual(applySittingDurationPenalty(20, nothing), {
    score25: 17,
    penalty: 3,
    shortParts: ["monologue", "debate"],
  });
});

test("exactly at a floor is not short", () => {
  assert.deepEqual(
    partsUnderFloor({
      monologueSeconds: MONOLOGUE_FLOOR_SECONDS,
      debateSeconds: DEBATE_FLOOR_SECONDS,
    }),
    [],
  );
});

// ------------------------------------------------------------ the whole rule

/**
 * A candidate who was present in both parts, in words.
 *
 * Spread into every `scoreSitting` case that is about something else, because
 * participation is now a precondition of the ordinary scoring path: without it
 * every one of these fixtures would silently become a walk-out and be halved,
 * and the tests would still pass while measuring the wrong rule.
 */
const SPOKE = { monologueWords: 400, debateWords: 300 };

const bands = (value: number) =>
  Object.fromEntries(ORAL_CRITERIA.map((criterion) => [criterion, value])) as Record<
    (typeof ORAL_CRITERIA)[number],
    number
  >;

test("snapCriteria puts every criterion on a legal band", () => {
  // 2 and 4 are not bands; the grille's tie rule rounds them down.
  assert.deepEqual(snapCriteria(bands(2)), bands(1));
  assert.deepEqual(snapCriteria(bands(4)), bands(3));
  assert.deepEqual(snapCriteria(bands(99)), bands(5));
  assert.deepEqual(snapCriteria(bands(Number.NaN)), bands(0));
});

test("scoreSitting snaps before it sums", () => {
  // The order is the rule. Summing first would give 25 for five 5s and 10 for
  // five 2s; snapping first gives 5, because a 2 is a 1 on this grille.
  const scored = scoreSitting(bands(2), {
    monologueSeconds: 400,
    debateSeconds: 700,
    ...SPOKE,
    phonologyHeard: true,
  });

  assert.deepEqual(scored.criteria, bands(1));
  assert.equal(scored.rawScore25, 5);
  assert.equal(scored.score25, 5);
});

test("scoreSitting docks before it tests the floor", () => {
  // 5/25 clears the floor and 2/25 does not, so a sitting that is short lands on
  // the other side of it. Testing the floor against the pre-penalty score would
  // pass a candidate the rubric has just failed.
  const scored = scoreSitting(bands(1), {
    monologueSeconds: 400,
    debateSeconds: 10,
    ...SPOKE,
    phonologyHeard: true,
  });

  assert.equal(scored.rawScore25, 5);
  assert.equal(scored.durationPenalty, 3);
  assert.equal(scored.score25, 2);
  assert.equal(scored.meetsFloor, false);
  assert.deepEqual(scored.shortParts, ["debate"]);
});

test("scoreSitting keeps the nominal penalty when the score cannot absorb it", () => {
  const scored = scoreSitting(
    { ...bands(0), realisationTache: 1 },
    { monologueSeconds: 0, debateSeconds: 0, ...SPOKE, phonologyHeard: true },
  );

  assert.equal(scored.rawScore25, 1);
  assert.equal(scored.durationPenalty, 3, "what the rubric asked for");
  assert.equal(scored.score25, 0, "what the score could absorb");
});

// ------------------------------------------- phonologie without the sound (#29)

test("a correction that heard nothing cannot award the top phonologie band", () => {
  // The measured failure #29 records: a transcript with no « euh » in it read as
  // remarkable fluency, and five points were awarded for the absence of evidence.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 400,
    debateSeconds: 700,
    ...SPOKE,
    phonologyHeard: false,
  });

  assert.equal(scored.criteria.phonologie, UNHEARD_PHONOLOGY_CEILING);
  assert.equal(scored.phonologyCapped, true);
  // Two points, off a criterion worth five, on every text-mode sitting a strong
  // candidate produces.
  assert.equal(scored.rawScore25, 23);
});

test("the ceiling touches phonologie and nothing else", () => {
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 400,
    debateSeconds: 700,
    ...SPOKE,
    phonologyHeard: false,
  });

  for (const criterion of ORAL_CRITERIA) {
    if (criterion === "phonologie") continue;
    assert.equal(scored.criteria[criterion], 5, `${criterion} must be untouched`);
  }
});

test("a correction that heard the candidate may award the top band", () => {
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 400,
    debateSeconds: 700,
    ...SPOKE,
    phonologyHeard: true,
  });

  assert.equal(scored.criteria.phonologie, 5);
  assert.equal(scored.phonologyCapped, false);
  assert.equal(scored.rawScore25, 25);
});

test("a band already under the ceiling is left alone, and not reported as capped", () => {
  // The distinction the flag exists for: 1/5 from a hesitant transcript is the
  // corrector's judgement, not the rubric's intervention, and a candidate told
  // "we could not hear you" about it would be told something false.
  for (const band of [0, 1, 3] as const) {
    const scored = scoreSitting(
      { ...bands(5), phonologie: band },
      { monologueSeconds: 400, debateSeconds: 700, ...SPOKE, phonologyHeard: false },
    );

    assert.equal(scored.criteria.phonologie, band);
    assert.equal(scored.phonologyCapped, false, `band ${band} was not moved`);
  }
});

test("capUnheardPhonology only ever returns a legal grille band", () => {
  for (const band of GRILLE_BANDS) {
    // `snapCriteria` rather than `bands(3)`: this function takes bands that are
    // already legal, and the type says so.
    const capped = capUnheardPhonology({ ...snapCriteria(bands(3)), phonologie: band }, false);
    assert.ok(
      (GRILLE_BANDS as readonly number[]).includes(capped.phonologie),
      `${band} capped to ${capped.phonologie}, which no column accepts`,
    );
  }
});

test("the ceiling is applied after snapping, so an illegal 4 becomes 3 either way", () => {
  // A model emitting 4 is snapped to 3, which is already at the ceiling. The
  // result must be the same whether or not the correction heard anything —
  // otherwise the two orders would disagree and the mark would depend on one.
  const heard = scoreSitting({ ...bands(3), phonologie: 4 }, {
    monologueSeconds: 400,
    debateSeconds: 700,
    ...SPOKE,
    phonologyHeard: true,
  });
  const unheard = scoreSitting({ ...bands(3), phonologie: 4 }, {
    monologueSeconds: 400,
    debateSeconds: 700,
    ...SPOKE,
    phonologyHeard: false,
  });

  assert.equal(heard.criteria.phonologie, 3);
  assert.equal(unheard.criteria.phonologie, 3);
  assert.equal(unheard.phonologyCapped, false, "snapping moved it, not the ceiling");
});

test("the duration penalty still applies on top of a capped phonologie", () => {
  // Two independent rules, and a sitting can earn both. Neither is allowed to
  // swallow the other.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 400,
    debateSeconds: 10,
    ...SPOKE,
    phonologyHeard: false,
  });

  assert.equal(scored.rawScore25, 23, "capped before the sum");
  assert.equal(scored.durationPenalty, 3);
  assert.equal(scored.score25, 20);
  assert.deepEqual(scored.shortParts, ["debate"]);
  assert.equal(scored.phonologyCapped, true);
});

// ----------------------------------------------- a part that never happened

test("partsAbsent reads the word floor, not silence", () => {
  // « oui » is not a débat. The floor is what stops one syllable buying back
  // half a mark, and it is the same 20 the finish route already applies to a
  // whole transcript.
  assert.deepEqual(partsAbsent({ monologueWords: 400, debateWords: 0 }), ["debate"]);
  assert.deepEqual(partsAbsent({ monologueWords: 400, debateWords: 1 }), ["debate"]);
  assert.deepEqual(
    partsAbsent({ monologueWords: 400, debateWords: PARTICIPATION_WORD_FLOOR - 1 }),
    ["debate"],
  );
  assert.deepEqual(
    partsAbsent({ monologueWords: 400, debateWords: PARTICIPATION_WORD_FLOOR }),
    [],
    "at the floor the part happened",
  );
  assert.deepEqual(partsAbsent({ monologueWords: 0, debateWords: 300 }), ["monologue"]);
});

test("walking out of the débat halves the mark", () => {
  // The case this rule exists for: a full monologue, then « Terminer » before
  // answering a single question. Under the duration penalty alone this was 25 −
  // 3 = 22/25 — a near-perfect mark for half an épreuve.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 400,
    debateSeconds: 0,
    monologueWords: 400,
    debateWords: 0,
    phonologyHeard: true,
  });

  assert.equal(scored.rawScore25, 25);
  assert.equal(scored.absencePenalty, 13);
  assert.deepEqual(scored.absentParts, ["debate"]);
  assert.equal(scored.score25, 12);
});

test("the halving is proportional, so a weak walk-out is not spared", () => {
  // What a cap at 12 would have missed entirely: every one of these is below it
  // to begin with, and a cap would have left all three untouched.
  const halved = (band: 0 | 1 | 3 | 5) =>
    scoreSitting(bands(band), {
      monologueSeconds: 400,
      debateSeconds: 0,
      monologueWords: 400,
      debateWords: 0,
      phonologyHeard: true,
    });

  assert.equal(halved(3).rawScore25, 15);
  assert.equal(halved(3).score25, 7, "floor(15 / 2)");
  assert.equal(halved(1).score25, 2, "floor(5 / 2) — and now under the floor");
  assert.equal(halved(1).meetsFloor, false);
  assert.equal(halved(0).score25, 0);
  assert.equal(halved(0).absencePenalty, 0, "nothing to halve");
});

test("an absent part is not also docked for being short", () => {
  // A part nobody produced is necessarily under its own floor. Charging the −3
  // as well would be two prices for one absence, and `shortParts` would name
  // the débat as the reason for a penalty the halving had already covered.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 400,
    debateSeconds: 0,
    monologueWords: 400,
    debateWords: 0,
    phonologyHeard: true,
  });

  assert.equal(scored.durationPenalty, 0);
  assert.deepEqual(scored.shortParts, []);
  assert.equal(scored.score25, 12, "12, not 9");
});

test("the other part is still docked for being short", () => {
  // The two rules are independent and a sitting can earn both: a ninety-second
  // monologue followed by an abandoned débat is halved *and* docked 3.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 90,
    debateSeconds: 0,
    monologueWords: 120,
    debateWords: 0,
    phonologyHeard: true,
  });

  assert.equal(scored.absencePenalty, 13);
  assert.deepEqual(scored.absentParts, ["debate"]);
  assert.equal(scored.durationPenalty, 3);
  assert.deepEqual(scored.shortParts, ["monologue"]);
  assert.equal(scored.score25, 9, "25 → 12 → 9");
});

test("halving happens before the duration penalty, not after", () => {
  // The order is the rule. Docking first would give floor((25 − 3) / 2) = 11,
  // which makes the flat −3 worth 1.5 points on exactly the sittings that
  // earned it.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 90,
    debateSeconds: 0,
    monologueWords: 120,
    debateWords: 0,
    phonologyHeard: true,
  });

  assert.equal(scored.score25, 9);
  assert.notEqual(scored.score25, 11);
});

test("a sitting where both parts happened is untouched by the rule", () => {
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 400,
    debateSeconds: 700,
    ...SPOKE,
    phonologyHeard: true,
  });

  assert.equal(scored.absencePenalty, 0);
  assert.deepEqual(scored.absentParts, []);
  assert.equal(scored.score25, 25);
});

test("the halving fires once, even when neither part happened", () => {
  // A quarter of a mark is a magnitude no rule here produces, and the finish
  // route refuses to grade this sitting at all — but the rubric is called
  // directly by scripts and must not invent one if it ever sees this.
  const { score25, penalty, absentParts } = applyAbsentPartPenalty(25, {
    monologueWords: 0,
    debateWords: 0,
  });

  assert.deepEqual(absentParts, ["monologue", "debate"]);
  assert.equal(score25, 12);
  assert.equal(penalty, 13);
});

test("the two penalties always reconstruct the score, as the CHECK constraint asserts", () => {
  // `evaluations_score_25_check` is `score_25 = greatest(raw − absence −
  // duration, 0)`. It is written as a sum, while `scoreSitting` applies the two
  // in sequence; this is the sweep that says the two readings never disagree.
  for (const band of [0, 1, 3, 5] as const) {
    for (const debateWords of [0, 300]) {
      for (const monologueSeconds of [90, 400]) {
        const scored = scoreSitting(bands(band), {
          monologueSeconds,
          debateSeconds: debateWords === 0 ? 0 : 700,
          monologueWords: 400,
          debateWords,
          phonologyHeard: true,
        });

        assert.equal(
          scored.score25,
          Math.max(scored.rawScore25 - scored.absencePenalty - scored.durationPenalty, 0),
          `band ${band}, débat ${debateWords} words, monologue ${monologueSeconds}s`,
        );
      }
    }
  }
});
