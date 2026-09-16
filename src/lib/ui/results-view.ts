import { COMPETENCY_FLOOR, COMPETENCY_MAX } from "@/lib/delf/constants";
import {
  ORAL_CRITERIA,
  ORAL_CRITERIA_COMPETENCE,
  ORAL_CRITERIA_LABELS,
  ORAL_CRITERIA_SUMMARIES,
  type OralCriterion,
} from "@/lib/delf/criteria";
import {
  BAND_LABELS,
  BAND_TONE,
  scoreTone,
  type BandTone,
  type GrilleBand,
  type ScoreTone,
} from "@/lib/delf/grille";
import { meetsCompetencyFloor } from "@/lib/delf/orale-rubric";

import { correctionNotices, earlyClosingNotice } from "./correction-notices";
import {
  breakdownDeductions,
  scoreBreakdown,
  type BreakdownDeduction,
} from "./criterion-breakdown";
import { formatScore25 } from "./format-score";
import { resultMetaLine, scoreToneLabel } from "./score-verdict";
import type { PlayableRecording } from "./correction-transcript";
import type { StoredResult } from "./stored-result";

/**
 * Everything the results page decides, decided here, so the components print
 * it and `node --test` reads it (#234). The rules themselves live where they
 * always did — `correction-notices.ts`, `criterion-breakdown.ts`,
 * `score-verdict.ts`, the grille — and this composes them into the two panes
 * the page draws: the verdict, and the evaluation under it.
 *
 * What moved out of the component is every `?:` and `&&` that chose a word or
 * a figure: which notes appear under the mark and in what order, what a row
 * says aloud when the clock took a point, whether the totals box prints at
 * all, what its last line is called, who is named on the provenance line.
 */

/** One criterion as the pane draws it, both figures and the sentence between them. */
export interface CriterionRowView {
  key: OralCriterion;
  label: string;
  description: string;
  /** The band the corrector set, and the one `justification` is about. */
  earned: GrilleBand;
  /** The band after the duration charge, the one the total is built from. */
  awarded: GrilleBand;
  /** `earned − awarded`; zero on every criterion the clock did not reach. */
  charged: number;
  /** Colour, band name and bar length all read the AWARDED band (#203). */
  tone: BandTone;
  bandLabel: string;
  low: boolean;
  barPercent: number;
  /** The row's figures as one spoken sentence, for a screen reader. */
  spoken: string;
  /** The arithmetic beside the two figures, when the clock moved the row. */
  chargeNote: string | null;
  justification: string | undefined;
  note: string | undefined;
}

export interface CriterionGroupView {
  competence: string;
  rows: CriterionRowView[];
}

/** The footer under the rows — only when something happened between them and the mark. */
export interface TotalsView {
  /** The first line and the deductions, or nothing: on a sitting with a charge
   *  but no deduction the rows already show what moved. */
  deductions: BreakdownDeduction[];
  criteriaTotal: string;
  finalLabel: "Note finale" | "Total";
  final: string;
}

export interface ResultsView {
  score25: string;
  outOf: number;
  passed: boolean;
  tone: ScoreTone;
  toneLabel: string;
  meta: string;
  /** The sentences under the mark, in the order they are read. */
  notes: string[];
  /** Graded from the transcript alone: the warning about the audio. */
  textMode: boolean;
  floorNote: string;
  groups: CriterionGroupView[];
  totals: TotalsView | null;
  feedback: StoredResult["evaluation"]["feedback"];
  provenance: { examinerModel: string | null; correctorModel: string };
  /** The halves with audio to stream back — none for a stash, which never carries uris. */
  playable: PlayableRecording[];
}

const PHONOLOGY_NOTE =
  "La phonologie n'a pas pu être évaluée de façon fiable sur cette production.";

/**
 * The five criteria in their two grille groups, in the grille's order.
 *
 * Derived from `ORAL_CRITERIA_COMPETENCE` rather than written out, so a
 * criterion that moves competence on the official grid moves here too. Keyed
 * by competence rather than by comparing against the previous group: a
 * run-length grouping would be correct by coincidence, printing the same
 * competence header twice the day somebody reorders the list.
 */
export const CRITERIA_GROUPS: ReadonlyArray<{ competence: string; criteria: OralCriterion[] }> =
  (() => {
    const groups = new Map<string, OralCriterion[]>();
    for (const criterion of ORAL_CRITERIA) {
      const competence = ORAL_CRITERIA_COMPETENCE[criterion];
      const existing = groups.get(competence);
      if (existing) existing.push(criterion);
      else groups.set(competence, [criterion]);
    }
    return [...groups].map(([competence, criteria]) => ({ competence, criteria }));
  })();

function points(n: number): string {
  return n === 1 ? "1 point" : `${n} points`;
}

export function criterionRowView(
  key: OralCriterion,
  earned: GrilleBand,
  awarded: GrilleBand,
  feedback: StoredResult["evaluation"]["feedback"],
): CriterionRowView {
  const charged = earned - awarded;
  return {
    key,
    label: ORAL_CRITERIA_LABELS[key],
    description: ORAL_CRITERIA_SUMMARIES[key],
    earned,
    awarded,
    charged,
    tone: BAND_TONE[awarded],
    bandLabel: BAND_LABELS[awarded],
    low: awarded === 0,
    barPercent: (awarded / 5) * 100,
    // The two figures are SAID together: the visible pair reads « 5 → 1 »
    // across two spans, so the spoken sentence carries both numbers itself.
    spoken:
      charged > 0
        ? `note du correcteur ${earned} sur 5, note retenue ${awarded} sur 5`
        : `${awarded} sur 5`,
    // Said inside the row because the justification is about the EARNED band,
    // and a reader who has just been told the exposé was clear needs to know
    // why the row reads lower (#203).
    chargeNote:
      charged > 0
        ? `Note du correcteur : ${earned}/5. La durée de l'épreuve a coûté ${points(charged)} sur ce critère, d'où ${awarded}/5 dans le total.`
        : null,
    justification: feedback.justifications[key],
    note: key === "phonologie" && feedback.phonologieNonEvaluable ? PHONOLOGY_NOTE : undefined,
  };
}

export function resultsView(result: StoredResult): ResultsView {
  const { evaluation } = result;
  const score25 = evaluation.score25;

  // Two separate facts about the same number (#50). `passed` is the DELF's
  // elimination rule and it is binary; `tone` is where the mark sits on the
  // five-step scale, and 5/25 is in the reddest band.
  const passed = meetsCompetencyFloor(score25);

  // The paragraphs under the mark: the halving, the duration charge (#189),
  // the examiner's early goodbyes (#92) — each a whole sentence built where
  // it is tested, and only when it has something to say.
  const notices = correctionNotices(evaluation);
  const notes = [
    notices.absence,
    notices.duration,
    earlyClosingNotice(result.earlyClosingCount),
  ].filter((note): note is string => Boolean(note));

  // The five rows and the subtractions under them, reconciled with the mark
  // (#203). A row's figures fall back to the corrector's band — the reading
  // the row had before the breakdown existed — rather than to a zero.
  const breakdown = scoreBreakdown(evaluation);
  const groups = CRITERIA_GROUPS.map((group) => ({
    competence: group.competence,
    rows: group.criteria.map((key) => {
      const line = breakdown.lines.find((row) => row.criterion === key);
      const band = evaluation.criteria[key] ?? 0;
      return criterionRowView(
        key,
        line?.earned ?? band,
        line?.awarded ?? band,
        evaluation.feedback,
      );
    }),
  }));

  // Printed only when the figures add up (`reconciles` false means the
  // correction disagrees with itself, and a page that shows less is
  // recoverable where one that shows a wrong sum is not) AND only when
  // something happened between the rows and the mark: a charge that moved a
  // row, or a deduction no row could carry. On the ordinary sitting the five
  // bands already ARE the mark.
  const deductions = breakdownDeductions(breakdown);
  const somethingMoved = deductions.length > 0 || breakdown.lines.some((line) => line.charged > 0);
  const totals: TotalsView | null =
    breakdown.reconciles && somethingMoved
      ? {
          deductions,
          criteriaTotal: `${formatScore25(breakdown.criteriaTotal)}/${COMPETENCY_MAX}`,
          finalLabel: deductions.length > 0 ? "Note finale" : "Total",
          final: `${formatScore25(breakdown.score25)}/${COMPETENCY_MAX}`,
        }
      : null;

  return {
    score25: formatScore25(score25),
    outOf: COMPETENCY_MAX,
    passed,
    tone: scoreTone(score25),
    toneLabel: scoreToneLabel(score25),
    meta: resultMetaLine({
      criteriaCount: ORAL_CRITERIA.length,
      totalSeconds: result.monologueSeconds + result.debateSeconds,
    }),
    notes,
    textMode: evaluation.mode === "text",
    floorNote: passed
      ? `Note au-dessus du seuil éliminatoire du DELF (${COMPETENCY_FLOOR}/${COMPETENCY_MAX}).`
      : `Une note inférieure à ${COMPETENCY_FLOOR}/${COMPETENCY_MAX} est éliminatoire au DELF, quelle que soit la note globale.`,
    groups,
    totals,
    feedback: evaluation.feedback,
    // Raw ids on purpose — a readable label would make two sittings on the
    // same sujet quietly incomparable. The examiner is omitted rather than
    // guessed on sittings from before it was recorded (#99).
    provenance: { examinerModel: result.examinerModel ?? null, correctorModel: evaluation.model },
    playable: result.playable ?? [],
  };
}
