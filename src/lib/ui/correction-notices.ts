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
import type { GrilleBand } from "@/lib/delf/grille";
import { FULL_DEVELOPMENT_SECONDS, type DurationCharge } from "@/lib/delf/orale-rubric";
import { chargesAreAttributable } from "@/lib/ui/criterion-breakdown";
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
  /** What the duration rule took, and where from (#189). Optional for the
   *  reason the halving's fields are: a stash or a row may predate them. */
  durationPenalty?: number;
  durationCharges?: readonly DurationCharge[];
  /**
   * The five bands, so a charge can be checked against the row it claims to
   * have come off (#203). Optional like the rest — without it the check falls
   * back to comparing totals, which is weaker and still catches the case that
   * produced the issue. See {@link chargesAreAttributable}.
   */
  criteria?: Record<string, GrilleBand>;
}

/** One paragraph, or the absence of one. */
export interface CorrectionNotices {
  /** The halving, when a part of the épreuve was not produced. */
  absence: string | null;
  /** The duration charge, when a part ran short of what the épreuve asks. */
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

/** How each part is named to the candidate. */
const PART_SUBJECT: Record<CorrectionPart, string> = {
  monologue: "votre monologue",
  debate: "votre débat",
};

/** Which criterion a part's charge came off, worded as the grille rows are. */
const CHARGED_CRITERION: Record<CorrectionPart, string> = {
  monologue: "la réalisation de la tâche",
  debate: "l'interaction",
};

/** Whole minutes, for a sentence a candidate reads rather than a measurement. */
function wholeMinutes(seconds: number): number {
  return Math.max(0, Math.round(seconds / 60));
}

/** The spoken half of the comparison, where the unit is said once. */
function minutes(seconds: number): string {
  const whole = wholeMinutes(seconds);
  return whole === 1 ? "1 minute" : `${whole} minutes`;
}

function points(n: number): string {
  return n === 1 ? "1 point" : `${n} points`;
}

/** « votre débat a duré 6 minutes sur les 10 attendues, ce qui a coûté 2 points
 *  au titre de l'interaction » — one part's share of the paragraph. */
function chargeClause(charge: DurationCharge): string {
  return (
    `${PART_SUBJECT[charge.part]} a duré ${minutes(charge.seconds)} ` +
    `sur les ${wholeMinutes(FULL_DEVELOPMENT_SECONDS[charge.part])} attendues, ` +
    `ce qui a coûté ${points(charge.points)} au titre de ${CHARGED_CRITERION[charge.part]}`
  );
}

/**
 * Explain the duration charge — the paragraph the user asked for in #189:
 * « the candidate should know why he got penalized ».
 *
 * **This is not the paragraph #137 removed, and the difference is the point.**
 * That one printed « Note avant pénalité de durée : N/25 » beside a mark it did
 * not explain, and the user had it taken off. What was missing then and is here
 * now is the *because*: which part fell short of which announced length, what
 * that cost, and — the half a candidate cannot infer — that the points came off
 * one pragmatic criterion and touched none of the three language ones.
 *
 * **What it used to promise, and no longer can.** Until #203 the paragraph ended
 * « et les notes affichées ci-dessus sont bien celles du correcteur », because
 * the charge was priced from the band and never written back onto it: the row
 * said 5 while the mark had paid 4. That was true and it was also the bug — the
 * reader added the five figures, got 25, and read 21 at the top of the page. The
 * row now carries both numbers (`criterion-breakdown.ts`), so the sentence points
 * at what changed instead of insisting nothing did. What it still must not claim
 * is that the *corrector* lowered anything: the earned band is on the row beside
 * the awarded one, and the justification inside it belongs to the earned one.
 *
 * Charges worth 0 points are dropped rather than listed: a criterion already at
 * the bottom of the grille loses nothing to the clock, and « cela a coûté 0
 * point » explains a penalty nobody received.
 *
 * **Silence when the charges do not add up to what was docked.** `durationCharges`
 * has no column and is rebuilt from the durations the page can still see, which
 * are not always the ones the mark was graded on. A rebuilt charge that cost
 * something other than `duration_penalty` is about a different sitting, and this
 * paragraph is where that used to surface as « 0 minutes … 4 points » over a mark
 * docked 2. The rows decline to attribute such a charge; so does this, and by
 * asking {@link chargesAreAttributable} rather than a second copy of the rule.
 * The points are still accounted for — the breakdown lists them under the rows —
 * they are simply no longer explained by a part and a duration nobody can vouch
 * for.
 */
function durationNotice(
  charges: readonly DurationCharge[],
  durationPenalty: number,
  criteria?: Record<string, GrilleBand>,
): string | null {
  if (!chargesAreAttributable(charges, durationPenalty, criteria)) return null;

  const charged = charges.filter((charge) => charge.points > 0);
  if (charged.length === 0) return null;

  const sentence =
    charged.length === 1
      ? capitalise(chargeClause(charged[0]))
      : `Les deux parties ont été plus courtes que ce que l'épreuve demande${NBSP}: ` +
        charged.map(chargeClause).join(`${NBSP}; `);

  return (
    `${sentence}. Sur la ligne concernée, la note du correcteur est suivie de celle ` +
    `retenue après cette pénalité. Votre lexique, votre morphosyntaxe et votre ` +
    `prononciation ne sont jamais pénalisés par la durée${NBSP}: ils portent sur ce ` +
    `que vous avez réellement dit.`
  );
}

function capitalise(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export function correctionNotices(scores: CorrectionScores): CorrectionNotices {
  const absencePenalty = scores.absencePenalty ?? 0;

  return {
    absence: absencePenalty > 0 ? absenceNotice(scores.absentParts ?? [], scores.rawScore25) : null,
    // Guarded on the penalty as the halving is, so a row written before the
    // duration rule could ever charge (or a stash that predates the field) is
    // never captioned with a charge it did not take.
    duration:
      (scores.durationPenalty ?? 0) > 0
        ? durationNotice(scores.durationCharges ?? [], scores.durationPenalty ?? 0, scores.criteria)
        : null,
  };
}
