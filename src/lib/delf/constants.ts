/**
 * DELF Production Orale — B2 part structure, timings, and the two scoring
 * constants the /25 grille is built on.
 *
 * PORT NOTE: assembled from two files in the reference implementation
 * (`delf-preps@chore/240-remove-unused-series-actions`):
 *
 *  - `src/lib/constants/orale.ts` → `OralPartSpec`, the **B2 rows only**. The
 *    reproduction audit ("Simplify") keeps exactly those and drops the
 *    A1/A2/B1 definitions, `partCountForLevel()` and the whole `DelfLevel`
 *    generalisation — this project is B2-only, so the level parameter has
 *    nowhere to come from. `minDurationSeconds()` was ported too and has since
 *    gone (#189); the rule it carried is written down below.
 *  - `src/lib/scoring.ts` → `COMPETENCY_MAX` and `COMPETENCY_FLOOR`, **extracted
 *    rather than imported**, because importing that file would drag in the whole
 *    multi-épreuve scoring model.
 *
 * The B2 numbers (420 s monologue after 1800 s of preparation; 780 s débat with
 * no preparation) are DELF business rules: reproduce them, do not re-derive
 * them.
 *
 * Sources: docs/DELF_EXAM_REFERENCE.md §4–5.
 */

/** The highest /25 competency score. Five criteria × the top band of 5. */
export const COMPETENCY_MAX = 25;

/**
 * The DELF per-competency floor. A competency scored below this is
 * éliminatoire, regardless of how the other épreuves went.
 */
export const COMPETENCY_FLOOR = 5;

/**
 * The kind of speaking task a part represents (drives the examiner behaviour).
 * Narrowed to the two B2 parts; the reference union also carried the A1/A2/B1
 * task types (`entretien`, `echange`, `interaction`, `point_de_vue`).
 */
export type OralPartType =
  | "monologue" // continuous monologue on a topic
  | "debat"; // defend a position against the examiner (B2)

export interface OralPartSpec {
  /** 1-based part number (matches `oralTopics.tache`). */
  tache: number;
  type: OralPartType;
  title: string;
  /** Short candidate-facing description of what to do. */
  description: string;
  /** Expected candidate speaking duration, in seconds (drives the timer). */
  durationSeconds: number;
  /** Preparation time before this part, in seconds (0 = none). */
  preparationSeconds: number;
}

/**
 * The two ordered B2 parts: monologue suivi, then débat. Durations follow the
 * official B2 format (approximate speaking time).
 */
export const ORAL_PARTS_B2: readonly OralPartSpec[] = [
  {
    tache: 1,
    type: "monologue",
    title: "Monologue suivi : présenter et défendre un point de vue",
    description:
      "À partir d'un document déclencheur, présentez votre point de vue de façon construite (~5–7 min).",
    durationSeconds: 420,
    preparationSeconds: 1800,
  },
  {
    tache: 2,
    type: "debat",
    title: "Débat : exercice en interaction",
    description:
      "Défendez votre position face à l'examinateur qui vous conteste, dans un débat argumenté (~10–13 min).",
    durationSeconds: 780,
    preparationSeconds: 0,
  },
];

/** Look up the spec for a given B2 part number, or null if out of range. */
export function getOralPartSpec(tache: number): OralPartSpec | null {
  return ORAL_PARTS_B2.find((p) => p.tache === tache) ?? null;
}

/*
 * The incumbent's duration rule, for the record rather than for the code.
 *
 * `minDurationSeconds(tache)` — ~40 % of the part's expected speaking time,
 * floored at 30 s: 168 s for the monologue, 312 s for the débat — was the single
 * per-part threshold behind a flat −3. It stopped being this project's grading
 * rule in #189, when the sitting began to be placed in one of three tiers
 * against `FULL_DEVELOPMENT_SECONDS` and `SHORT_DEVELOPMENT_SECONDS` in
 * `orale-rubric.ts`, absolute figures rather than a fraction of the part.
 *
 * The function itself was kept for a while as a statement of what the other
 * side still uses; it is gone now because nothing here called it.
 * `scripts/comparison/incumbent-runner.ts` runs inside the incumbent's own tree
 * and reads the rule from there. Do not wire it back into the rubric without
 * reopening #189.
 */
