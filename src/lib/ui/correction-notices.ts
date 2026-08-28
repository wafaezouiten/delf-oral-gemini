/**
 * The paragraph that explains why the mark is lower than the marking.
 *
 * Extracted from `results-client.tsx` because what it says is decided by which
 * rules fired, not by the component — and because it is the one part of the
 * correction page that does arithmetic, which `node --test` can reach here.
 *
 * There used to be a second paragraph: « Note avant pénalité de durée : N/25.
 * Votre débat a été nettement plus court que ce que demande l'épreuve
 * réelle. » It is gone by the user's call (#137), and the removal is the
 * PARAGRAPH only: the duration penalty itself still fires in the rubric
 * (`delf/orale-rubric.ts`), `durationPenalty` and `shortParts` are still
 * computed, persisted and handed to the corrector — the page just no longer
 * explains that part of the gap between the sum of the bands and the /25. The
 * halving keeps its sentence because a score divided by two with no
 * explanation reads as a grading error, which is a different kind of silence
 * from a few docked points.
 *
 * The sentence is built here, whole. The component renders a string; it does
 * not assemble one. That is not tidiness — an early version left a trailing
 * clause in the JSX, where it hard-coded « la note obtenue sur celle que vous
 * avez réalisée » and so quietly assumed exactly one part was missing. See
 * {@link absenceNotice} for why that assumption is false.
 */

import { COMPETENCY_MAX } from "@/lib/delf/constants";
import { formatScore25 } from "@/lib/ui/format-score";

export type CorrectionPart = "monologue" | "debate";

/**
 * The scoring fields the notices actually read.
 *
 * Both penalty fields are optional, and deliberately so: this object is read
 * back out of `sessionStorage` or rebuilt from a stored row, so a results page
 * opened after a deploy can be showing a sitting graded before the field
 * existed, and a second submission returns a correction that never carried the
 * corrector's working at all — `absent_parts` has no column. The fallbacks are
 * the readings that were true before each field existed.
 */
export interface CorrectionScores {
  rawScore25: number;
  absencePenalty?: number;
  absentParts?: readonly CorrectionPart[];
}

/** One paragraph, or the absence of one. */
export interface CorrectionNotices {
  /** The halving, when a part of the épreuve was not produced. */
  absence: string | null;
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
      `que vous avez réalisée (${formatScore25(rawScore25)}/${COMPETENCY_MAX}) ${halved}`
    );
  }

  const named =
    parts.length === 2
      ? "Vous n'avez pris la parole dans aucune des deux parties de l'épreuve"
      : "Une partie de l'épreuve n'a pas été réalisée";
  return `${named}. La note obtenue (${formatScore25(rawScore25)}/${COMPETENCY_MAX}) ${halved}`;
}

/**
 * The examiner's fault, told to the candidate it happened to (#92).
 *
 * A standalone export rather than a third field on {@link CorrectionNotices},
 * because it is not a fact about the correction's arithmetic: the count lives
 * on the sitting (`oral_exams.early_closing_count`), not on the evaluation, and
 * the page has it whether or not either penalty fired.
 *
 * Zero returns null — and so do the two states that read as zero: a stash from
 * before the field existed, and a row from before the column. Both are honest
 * silences: those corrections were graded by a corrector that was never told,
 * with the penalties standing, and this sentence would be false above them.
 *
 * What the sentence commits to is chosen to be true on every sitting it renders
 * over: the corrector WAS told (the paragraph and the count>0 gate share a
 * deploy), and the débat's shortfall was not charged (the waiver keys on the
 * same count). It deliberately does not say "no penalty was applied" — the
 * monologue's penalties still stand, and a candidate docked for a ninety-second
 * monologue must not read a sentence that says otherwise.
 */
export function earlyClosingNotice(earlyClosingCount: number | undefined): string | null {
  if (!earlyClosingCount || earlyClosingCount <= 0) return null;

  return (
    `Pendant le débat, l'examinateur a annoncé à tort la fin de l'épreuve avant la fin ` +
    `du temps imparti. Cette erreur de l'examinateur n'a pas été retenue contre vous${NBSP}: ` +
    `le correcteur a reçu pour consigne de ne pas en tenir compte, et un débat écourté ` +
    `par cette annonce n'a entraîné aucune pénalité.`
  );
}

export function correctionNotices(scores: CorrectionScores): CorrectionNotices {
  const absencePenalty = scores.absencePenalty ?? 0;

  return {
    absence: absencePenalty > 0 ? absenceNotice(scores.absentParts ?? [], scores.rawScore25) : null,
  };
}
