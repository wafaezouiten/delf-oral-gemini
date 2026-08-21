/**
 * The two paragraphs that explain why the mark is lower than the marking.
 *
 * Extracted from `results-client.tsx` because what they say stopped being
 * trivial the moment there were two penalties. It was trivial before: one rule
 * could separate `score25` from `rawScore25`, so "the note before the penalty"
 * and "the sum of the bands" were the same number, and there was only ever one
 * shape of sentence to write.
 *
 * Neither of those still holds. A sitting can be halved for a part that never
 * happened and *then* docked for a short other part — 25 → 12 → 9 — and the
 * duration paragraph's baseline is the 12, not the 25. Printing the 25 leaves a
 * candidate reading "25/25, divided by two" above "25/25, minus the duration
 * penalty" with a 13-point gap between the two sentences and the 9 they were
 * actually given.
 *
 * That is what this module is for, and why it is a module rather than four more
 * `const`s in the component: it is the only part of the correction page that
 * does arithmetic, it is the part that went stale when a rule was layered in
 * front of it, and `node --test` can reach it here.
 *
 * The sentences are built here too, whole. The component renders a string; it
 * does not assemble one. That is not tidiness — the first version left the
 * trailing clause in the JSX, where it hard-coded « la note obtenue sur celle
 * que vous avez réalisée » and so quietly assumed exactly one part was missing.
 * See {@link absenceNotice} for why that assumption is false.
 */

import { COMPETENCY_MAX } from "@/lib/delf/constants";

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
  absence: string | null;
  /**
   * The short-duration penalty, measured against the score it was actually
   * taken off — which is the halved figure whenever both rules fired.
   */
  duration: string | null;
}

/** No-break space, as French typography wants it before a colon. */
const NBSP = " ";

/**
 * Explain the halving: which part is missing, and what it cost.
 *
 * Three shapes rather than one, because only the first can say « celle que vous
 * avez réalisée » without contradicting itself.
 *
 *  - **One part missing.** The ordinary case, and the only one with a part that
 *    was in fact realised to point at.
 *  - **Both parts missing.** Reachable in production, not merely defensively.
 *    The finish route's gate counts the WHOLE transcript against
 *    `PARTICIPATION_WORD_FLOOR`, so 10 candidate words in the monologue and 15
 *    in the débat total 25, clear the gate, and land under the per-part floor
 *    twice. Telling that candidate about « celle que vous avez réalisée » names
 *    a part that does not exist.
 *  - **Missing part unknown.** `absent_parts` has no column, so a *second*
 *    submission of the same sitting returns the penalty without the parts. The
 *    page still owes an explanation for the missing points, and this is the
 *    true thing it can say without inventing which half.
 */
function absenceNotice(parts: readonly CorrectionPart[], rawScore25: number): string {
  const halved = `est donc divisée par deux.`;

  if (parts.length === 1) {
    const named =
      parts[0] === "monologue"
        ? "Vous n'avez pas présenté votre monologue"
        : "Vous n'avez pas participé au débat";
    return (
      `${named}. L'épreuve compte deux parties${NBSP}: la note obtenue sur celle ` +
      `que vous avez réalisée (${rawScore25}/${COMPETENCY_MAX}) ${halved}`
    );
  }

  const named =
    parts.length === 2
      ? "Vous n'avez pris la parole dans aucune des deux parties de l'épreuve"
      : "Une partie de l'épreuve n'a pas été réalisée";
  return `${named}. La note obtenue (${rawScore25}/${COMPETENCY_MAX}) ${halved}`;
}

/**
 * Explain the short-duration penalty, and against which figure.
 *
 * The part is named rather than the penalty merely announced: « vous avez été
 * pénalisé » is an assertion, « votre débat a été plus court que ce que demande
 * l'épreuve » is something the candidate can check against the clock beside it.
 * Capitalised, because it opens the second sentence — it used to be spliced in
 * lowercase and read as a typo on the one paragraph that has to be believed.
 *
 * The unnamed fallback is reachable for the same reason as
 * {@link absenceNotice}'s: `short_parts` has no column either.
 */
function durationNotice(parts: readonly CorrectionPart[], beforePenalty: number): string {
  const named =
    parts.length === 2
      ? "Vos deux prises de parole ont été"
      : parts[0] === "monologue"
        ? "Votre monologue a été"
        : parts[0] === "debate"
          ? "Votre débat a été"
          : "Votre temps de parole a été";

  return (
    `Note avant pénalité de durée${NBSP}: ${beforePenalty}/${COMPETENCY_MAX}. ` +
    `${named} nettement plus court que ce que demande l'épreuve réelle.`
  );
}

/**
 * What the page should say about the two penalties, and against which numbers.
 *
 * The fallbacks matter as much as the arithmetic. `durationPenalty` undefined
 * means a correction from before the field existed, where the only evidence a
 * penalty was taken is that the score is lower than the sum of the bands — and
 * the absence has to come off first, or a halved sitting's 13-point difference
 * conjures a duration paragraph for a penalty nobody took.
 */
export function correctionNotices(scores: CorrectionScores): CorrectionNotices {
  const absencePenalty = scores.absencePenalty ?? 0;

  const penalisedForDuration =
    scores.durationPenalty !== undefined
      ? scores.durationPenalty > 0
      : scores.score25 < scores.rawScore25 - absencePenalty;

  return {
    absence: absencePenalty > 0 ? absenceNotice(scores.absentParts ?? [], scores.rawScore25) : null,
    duration: penalisedForDuration
      ? durationNotice(
          scores.shortParts ?? [],
          // The halved score, not the sum of the bands. They are the same
          // number on every sitting where both parts happened, which is why
          // this went unnoticed until the two rules could fire together.
          scores.rawScore25 - absencePenalty,
        )
      : null,
  };
}
