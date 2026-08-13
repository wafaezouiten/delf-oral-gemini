import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyDurationPenalty,
  clampCriterion,
  criteriaToScore25,
  meetsCompetencyFloor,
  normalizeCriteria,
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
  assert.equal(applyDurationPenalty(18, 120, 60), 18); // over min → unchanged
  assert.equal(applyDurationPenalty(18, 30, 60), 15); // under min → -3
  assert.equal(applyDurationPenalty(18, 60, 60), 18); // exactly min → unchanged
  assert.equal(applyDurationPenalty(2, 5, 60), 0); // never below 0
  assert.equal(applyDurationPenalty(18, 10, 60, 5), 13); // custom penalty
});

test("meetsCompetencyFloor enforces the DELF ≥ 5/25 floor", () => {
  assert.equal(meetsCompetencyFloor(5), true);
  assert.equal(meetsCompetencyFloor(4), false);
  assert.equal(meetsCompetencyFloor(0), false);
  assert.equal(meetsCompetencyFloor(25), true);
});
