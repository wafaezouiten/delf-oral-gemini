/**
 * The arithmetic that has to hold between the five rows and the mark.
 *
 * **The bug this exists to make impossible (#203).** A candidate whose exposé
 * ran short read five criteria of 5/5 above a mark of 23/25 and, underneath,
 * a sentence saying the clock had cost them points. Every one of those three
 * statements was true on its own terms — the bands are the corrector's, the
 * mark is the rubric's, the sentence is the charge's — and together they are a
 * page that contradicts itself. #189 chose this deliberately: the charge is
 * priced FROM the bands and never written back onto them, so that a « réalisation
 * de la tâche » of 5 keeps sitting under the corrector's own praise of the
 * exposé. What that decision did not carry was the reader's arithmetic, and the
 * user has now reversed it: the rows must add up to the mark.
 *
 * **How both things can be true at once.** The row shows the band it earned AND
 * the band the clock left it — « 5 → 1 ». The corrector's justification still
 * belongs to the 5 it was written about, and the 1 is what the sum uses. Nothing
 * is silently rewritten, and nothing is left unexplained.
 *
 * **Why this is a view model and not part of the rubric.** `scoreSitting`
 * already decided every number here; none of them is recomputed. This turns
 * that decision into rows, and it is separated from `results-client.tsx` for
 * the reason `correction-notices.ts` is: it is arithmetic the page prints, and
 * `node --test` can reach it here.
 */

import { ORAL_CRITERIA, type OralCriterion } from "@/lib/delf/criteria";
import type { GrilleBand } from "@/lib/delf/grille";
import type { DurationCharge } from "@/lib/delf/orale-rubric";

/** One row of the grille, as the page has to print it. */
export interface CriterionLine {
  criterion: OralCriterion;
  /**
   * The band the corrector set — after the phonologie ceiling, which is applied
   * before anything is stored. This is the band the justification beside the row
   * was written about, and the row must keep showing it.
   */
  earned: GrilleBand;
  /**
   * The band after the duration charge, and the one the total is built from.
   * Equal to {@link earned} on every criterion the clock did not reach, which is
   * always at least the three language ones.
   */
  awarded: GrilleBand;
  /** `earned − awarded`. Zero unless the clock reached this criterion. */
  charged: number;
}

/** The five rows and the subtractions under them, in the order they print. */
export interface ScoreBreakdown {
  lines: CriterionLine[];
  /** Σ `awarded`. What the five printed figures actually add to. */
  criteriaTotal: number;
  /**
   * The duration points NO row carries — 0 whenever the charge could be
   * attributed. Non-zero on a correction stored before #189, whose penalty is
   * real and whose `durationCharges` were never written down: the points still
   * have to appear somewhere or the column of figures stops adding up.
   */
  unattributedDuration: number;
  /**
   * The halving, which no band can carry and which therefore always prints as
   * its own line (#absent-part). A criterion is a band out of the grille's four;
   * half a mark is not, so there is no honest way to spread 13 points across
   * five rows that each have to remain 0, 1, 3 or 5.
   */
  absencePenalty: number;
  /** The mark, taken as given rather than recomputed. */
  score25: number;
  /**
   * Whether the figures above actually reach it —
   * `criteriaTotal − unattributedDuration − absencePenalty === score25`.
   *
   * FALSE MEANS THE INPUTS DISAGREE WITH EACH OTHER, and the page must then say
   * less rather than print a sum that is wrong. It is reachable: `durationCharges`
   * has no column, so a stored correction has them REBUILT by re-running the
   * rubric over the durations the page can still see — and if those are not the
   * durations the mark was graded on, the rebuilt charge is about a different
   * sitting. When that happens {@link lines} come back unadjusted and the page
   * renders as it did before this module existed.
   */
  reconciles: boolean;
}

/** What the breakdown needs off a correction, fresh or stored. */
export interface BreakdownScores {
  criteria: Record<string, GrilleBand>;
  score25: number;
  /** Optional for the reason the notices' are: a stash or a row may predate the
   *  field, and the fallback is the reading that was true before it existed. */
  durationPenalty?: number;
  durationCharges?: readonly DurationCharge[];
  absencePenalty?: number;
}

/**
 * Whether the rebuilt charges are about THIS correction.
 *
 * Two questions, and a charge set has to answer both before a band may be
 * rewritten from it — or before a sentence may name what it cost:
 *
 *  - **Do they cost what was actually docked?** `durationPenalty` is a stored
 *    column and the charges are not, so their sum is the only check available
 *    that the reconstruction landed on the same durations the grading did.
 *  - **Do they start where the row starts?** A charge carries the band it was
 *    priced from. If that is not the band on the row, the charge was priced off
 *    a different correction and its `to` is not this row's anything. Skipped
 *    when the caller has no bands to check against, which is the weaker test
 *    and still the useful one.
 *
 * Failing either, the honest answer is to attribute nothing: the points are real
 * (the column says so) but which criterion they came off is no longer known.
 *
 * Exported so `correction-notices.ts` asks the SAME question before printing the
 * paragraph. The two must not diverge: a page whose rows decline to attribute a
 * charge while the sentence under them names its cost is the contradiction this
 * whole module exists to remove — and it is exactly what #203 produced, where a
 * mark docked 2 sat under a sentence claiming 4.
 */
export function chargesAreAttributable(
  charges: readonly DurationCharge[],
  durationPenalty: number,
  criteria?: Record<string, GrilleBand>,
): boolean {
  if (charges.length === 0) return durationPenalty === 0;

  const total = charges.reduce((sum, charge) => sum + charge.points, 0);
  if (total !== durationPenalty) return false;

  if (!criteria) return true;
  return charges.every((charge) => criteria[charge.criterion] === charge.from);
}

/**
 * Turn a correction into the rows and subtractions the page prints.
 *
 * Recomputes nothing: `score25` is the mark as graded and stored, and the only
 * question asked here is whether the figures shown above it reach it. Where they
 * cannot, {@link ScoreBreakdown.reconciles} says so and the rows come back
 * exactly as the corrector set them — a page that shows less is recoverable, a
 * page that shows a wrong sum is not.
 */
export function scoreBreakdown(scores: BreakdownScores): ScoreBreakdown {
  const durationPenalty = scores.durationPenalty ?? 0;
  const absencePenalty = scores.absencePenalty ?? 0;
  const charges = scores.durationCharges ?? [];

  const attributed = chargesAreAttributable(charges, durationPenalty, scores.criteria);
  const chargeFor = new Map<string, DurationCharge>(
    attributed ? charges.map((charge) => [charge.criterion, charge]) : [],
  );

  const adjusted = ORAL_CRITERIA.map((criterion) => {
    const earned = scores.criteria[criterion] ?? 0;
    const awarded = chargeFor.get(criterion)?.to ?? earned;
    return { criterion, earned, awarded, charged: earned - awarded };
  });

  const criteriaTotal = adjusted.reduce((sum, line) => sum + line.awarded, 0);
  const unattributedDuration = attributed ? 0 : durationPenalty;

  // The same subtraction the database asserts on every stored row
  // (`evaluations_score_25_check`), which is what makes this a check rather
  // than a second opinion: raw − absence − duration, floored at 0.
  const reconciles =
    Math.max(0, criteriaTotal - unattributedDuration - absencePenalty) === scores.score25;

  if (!reconciles) {
    return {
      lines: adjusted.map(({ criterion, earned }) => ({
        criterion,
        earned,
        awarded: earned,
        charged: 0,
      })),
      criteriaTotal: adjusted.reduce((sum, line) => sum + line.earned, 0),
      unattributedDuration,
      absencePenalty,
      score25: scores.score25,
      reconciles: false,
    };
  }

  return {
    lines: adjusted,
    criteriaTotal,
    unattributedDuration,
    absencePenalty,
    score25: scores.score25,
    reconciles: true,
  };
}

/** One subtraction under the five rows: a label and the points it took. */
export interface BreakdownDeduction {
  key: "duration" | "absence";
  label: string;
  points: number;
}

/**
 * The deductions the page lists between the criteria total and the mark.
 *
 * Empty on the ordinary sitting, where the five figures already add to the mark
 * and a « total » line is the whole footer. Each entry is a subtraction no row
 * could carry — see {@link ScoreBreakdown.absencePenalty} and
 * {@link ScoreBreakdown.unattributedDuration} for why each of the two exists.
 */
export function breakdownDeductions(breakdown: ScoreBreakdown): BreakdownDeduction[] {
  const deductions: BreakdownDeduction[] = [];

  if (breakdown.unattributedDuration > 0) {
    deductions.push({
      key: "duration",
      label: "Durée de l'épreuve",
      points: breakdown.unattributedDuration,
    });
  }

  if (breakdown.absencePenalty > 0) {
    deductions.push({
      key: "absence",
      label: "Partie non réalisée",
      points: breakdown.absencePenalty,
    });
  }

  return deductions;
}
