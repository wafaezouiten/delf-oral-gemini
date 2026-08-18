/**
 * The two paragraphs that explain why the mark is lower than the marking.
 *
 * Extracted from `results-client.tsx` because the arithmetic in them stopped
 * being trivial the moment there were two penalties. It was trivial before:
 * one rule could separate `score25` from `rawScore25`, so "the note before the
 * penalty" and "the sum of the bands" were the same number and the paragraph
 * could print `rawScore25` and be right.
 *
 * They are no longer the same number. A sitting can be halved for a part that
 * never happened and *then* docked for a short other part — 25 → 12 → 9 — and
 * the duration paragraph's baseline is the 12, not the 25. Printing the 25
 * leaves a candidate reading "25/25, divided by two" above "25/25, minus the
 * duration penalty" with a 13-point gap between the two sentences and the 9
 * they were actually given.
 *
 * That is what this module is for, and why it is a module rather than four more
 * `const`s in the component: it is the only part of the correction page that
 * does arithmetic, it is the part that went stale when a rule was layered in
 * front of it, and `node --test` can reach it here.
 *
 * The labels are here too, for the same reason a sentence and the number it
 * explains belong together — a notice that says « vous n'avez pas participé au
 * débat » beside the wrong figure is not half right.
 */

export type CorrectionPart = "monologue" | "debate";

/**
 * The scoring fields of a correction, as the page actually has them.
 *
 * Everything but the two totals is optional, and deliberately so: this object
 * is read back out of `sessionStorage` or rebuilt from a stored row, so a
 * results page opened after a deploy can be showing a sitting graded before
 * the field existed, and a second submission returns a correction that never
 * carried the corrector's working at all. Each fallback below is the reading
 * that was true before the field existed.
 */
export interface CorrectionScores {
  rawScore25: number;
  score25: number;
  durationPenalty?: number;
  shortParts?: readonly CorrectionPart[];
  absencePenalty?: number;
  absentParts?: readonly CorrectionPart[];
}

/** One paragraph, or the absence of one. */
export interface CorrectionNotices {
  /** The halving, when a part of the épreuve was not produced. */
  absence: { label: string; rawScore25: number } | null;
  /**
   * The short-duration penalty, with the score it was actually taken off —
   * which is the halved figure whenever both rules fired.
   */
  duration: { label: string; beforePenalty: number } | null;
}

/**
 * Name the part that never happened.
 *
 * The last branch is reachable, and is not dead code: `absent_parts` has no
 * column, so a *second* submission of the same sitting returns a correction
 * carrying the penalty without the parts. The page must still explain the
 * missing 13 points, and « une partie de l'épreuve n'a pas été réalisée » is
 * the true thing it can say without inventing which one.
 */
function absenceLabel(parts: readonly CorrectionPart[]): string {
  if (parts.length === 2) return "Vous n'avez pris la parole dans aucune des deux parties";
  if (parts[0] === "monologue") return "Vous n'avez pas présenté votre monologue";
  if (parts[0] === "debate") return "Vous n'avez pas participé au débat";
  return "Une partie de l'épreuve n'a pas été réalisée";
}

/**
 * Name the part that ran short.
 *
 * Capitalised, because it opens a sentence. It used to be spliced in lowercase
 * after "Note avant pénalité de durée : 15/25." and read as a typo on the one
 * paragraph that has to be believed. Its last branch is reachable for the same
 * reason as {@link absenceLabel}'s.
 */
function shortLabel(parts: readonly CorrectionPart[]): string {
  if (parts.length === 2) return "Vos deux prises de parole ont été";
  if (parts[0] === "monologue") return "Votre monologue a été";
  if (parts[0] === "debate") return "Votre débat a été";
  return "Votre temps de parole a été";
}

/**
 * What the page should say about the two penalties, and against which numbers.
 *
 * The fallbacks matter as much as the arithmetic. `durationPenalty` undefined
 * means a correction from before the field existed, where the only evidence a
 * penalty was taken is that the score is lower than the sum of the bands — and
 * on such a correction there is no halving either, so that reading is still
 * exactly right.
 */
export function correctionNotices(scores: CorrectionScores): CorrectionNotices {
  const absencePenalty = scores.absencePenalty ?? 0;

  const penalisedForDuration =
    scores.durationPenalty !== undefined
      ? scores.durationPenalty > 0
      : scores.score25 < scores.rawScore25 - absencePenalty;

  return {
    absence:
      absencePenalty > 0
        ? { label: absenceLabel(scores.absentParts ?? []), rawScore25: scores.rawScore25 }
        : null,
    duration: penalisedForDuration
      ? {
          label: shortLabel(scores.shortParts ?? []),
          // The halved score, not the sum of the bands. They are the same
          // number on every sitting where both parts happened, which is why
          // this went unnoticed until the two rules could fire together.
          beforePenalty: scores.rawScore25 - absencePenalty,
        }
      : null,
  };
}
