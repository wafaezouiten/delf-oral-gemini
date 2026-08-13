/**
 * DELF production orale rubric → /25 mapping (pure logic, unit-tested).
 *
 * The AI evaluator returns the five official grille criteria (realisationTache/
 * interaction/lexique/morphosyntaxe/phonologie), each a 0/1/3/5 band. Their sum
 * is the DELF production orale competency score out of 25. This module keeps
 * that mapping (and the short-duration penalty) side-effect-free and testable.
 *
 * PORT NOTE: copied from the reference implementation
 * (`delf-preps@chore/240-remove-unused-series-actions`, `src/lib/orale-rubric.ts`)
 * with two changes, both mandated by the reproduction audit:
 *
 *  - `COMPETENCY_MAX` / `COMPETENCY_FLOOR` now come from `./constants` instead
 *    of `@/lib/scoring`, which would drag in the multi-épreuve scoring model.
 *  - `normalizeOralDetails()` is **dropped** ("Reproduce minus one export"): it
 *    maps pre-grille keys (contenu/vocabulaire/grammaire/prononciation) onto the
 *    official five so legacy rows still render, and this project has no legacy
 *    rows. It also typed its argument as `OralCorrectionResult["details"]` from
 *    the reference `db/schema`, which this phase deliberately does not have.
 *
 * Everything else — the clamping, the sum, the flat −3 penalty, the ≥ 5/25
 * floor — is byte-for-byte the incumbent's, so scores stay comparable.
 */

import { COMPETENCY_MAX, COMPETENCY_FLOOR } from "./constants";

/** The five official grille criteria (each a 0/1/3/5 band). */
export interface OralCriteriaScores {
  realisationTache: number;
  interaction: number;
  lexique: number;
  morphosyntaxe: number;
  phonologie: number;
}

export const ORAL_RUBRIC_KEYS = [
  "realisationTache",
  "interaction",
  "lexique",
  "morphosyntaxe",
  "phonologie",
] as const;

export type OralRubricKey = (typeof ORAL_RUBRIC_KEYS)[number];

/** Clamp a single criterion to the valid 0–5 integer range. */
export function clampCriterion(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(5, Math.max(0, Math.round(n)));
}

/** Normalise raw (possibly out-of-range) criteria scores to 0–5 integers. */
export function normalizeCriteria(raw: OralCriteriaScores): OralCriteriaScores {
  return {
    realisationTache: clampCriterion(raw.realisationTache),
    interaction: clampCriterion(raw.interaction),
    lexique: clampCriterion(raw.lexique),
    morphosyntaxe: clampCriterion(raw.morphosyntaxe),
    phonologie: clampCriterion(raw.phonologie),
  };
}

/**
 * Sum the five criteria into the DELF /25 competency score. Input is normalised
 * first, and the result is clamped to [0, 25].
 */
export function criteriaToScore25(raw: OralCriteriaScores): number {
  const c = normalizeCriteria(raw);
  const sum = c.realisationTache + c.interaction + c.lexique + c.morphosyntaxe + c.phonologie;
  return Math.min(COMPETENCY_MAX, Math.max(0, sum));
}

/**
 * Apply a short-duration penalty: if the candidate spoke for less than the
 * expected minimum, subtract `penalty` points (default 3) from the /25 score,
 * floored at 0. Returns the adjusted score.
 */
export function applyDurationPenalty(
  score25: number,
  actualSeconds: number,
  minSeconds: number,
  penalty = 3,
): number {
  if (actualSeconds >= minSeconds) return score25;
  return Math.max(0, score25 - penalty);
}

/**
 * Whether a /25 score meets the DELF per-competency floor (≥ 5). A sub-floor
 * production orale score is éliminatoire regardless of other competencies.
 */
export function meetsCompetencyFloor(score25: number): boolean {
  return score25 >= COMPETENCY_FLOOR;
}
