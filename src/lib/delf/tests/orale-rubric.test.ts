import assert from "node:assert/strict";
import { test } from "node:test";

import { ORAL_CRITERIA } from "../criteria";
import {
  DEBATE_FLOOR_SECONDS,
  MONOLOGUE_FLOOR_SECONDS,
  applyDurationPenalty,
  applySittingDurationPenalty,
  clampCriterion,
  criteriaToScore25,
  meetsCompetencyFloor,
  normalizeCriteria,
  partsUnderFloor,
  scoreSitting,
  snapCriteria,
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
  const scored = scoreSitting(bands(2), { monologueSeconds: 400, debateSeconds: 700 });

  assert.deepEqual(scored.criteria, bands(1));
  assert.equal(scored.rawScore25, 5);
  assert.equal(scored.score25, 5);
});

test("scoreSitting docks before it tests the floor", () => {
  // 5/25 clears the floor and 2/25 does not, so a sitting that is short lands on
  // the other side of it. Testing the floor against the pre-penalty score would
  // pass a candidate the rubric has just failed.
  const scored = scoreSitting(bands(1), { monologueSeconds: 400, debateSeconds: 10 });

  assert.equal(scored.rawScore25, 5);
  assert.equal(scored.durationPenalty, 3);
  assert.equal(scored.score25, 2);
  assert.equal(scored.meetsFloor, false);
  assert.deepEqual(scored.shortParts, ["debate"]);
});

test("scoreSitting keeps the nominal penalty when the score cannot absorb it", () => {
  const scored = scoreSitting(
    { ...bands(0), realisationTache: 1 },
    { monologueSeconds: 0, debateSeconds: 0 },
  );

  assert.equal(scored.rawScore25, 1);
  assert.equal(scored.durationPenalty, 3, "what the rubric asked for");
  assert.equal(scored.score25, 0, "what the score could absorb");
});
