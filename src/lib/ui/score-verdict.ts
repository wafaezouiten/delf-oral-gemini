/**
 * The words beside the /25 on the correction (#190).
 *
 * PORT NOTE: `scoreToneLabel` and `resultMetaLine` from the main project's
 * `src/lib/ecrite-results.ts` (delf-preps@3901a2d6), on this project's five-step
 * scale. The pill that used to sit beside the mark said only whether the floor
 * was cleared (« Au-dessus du seuil de 5/25 »); the main project's names the
 * level the mark reached, and keeps the floor for the one case where it is
 * breached.
 *
 * Two facts about the same number, and they are kept apart on purpose (#50):
 * the *band* is where the mark sits on the five-step scale and it colours the
 * pill; the *floor* is the DELF's elimination rule and it is binary. A 5/25 is
 * in the reddest band without being éliminatoire, so it reads « Niveau très
 * insuffisant » in a red pill — true, and not the contradiction a « Sous le
 * seuil » label would be for a mark that clears it.
 */

import { COMPETENCY_FLOOR, COMPETENCY_MAX } from "@/lib/delf/constants";
import { scoreTone, type ScoreTone } from "@/lib/delf/grille";
import { meetsCompetencyFloor } from "@/lib/delf/orale-rubric";
import { formatClock } from "@/lib/delf/phases";

/** What each band is called, in the pill. The main project's words. */
export const SCORE_TONE_LABELS: Record<ScoreTone, string> = {
  green: "Très bon niveau",
  yellow: "Bon niveau",
  orange: "Niveau moyen",
  coral: "Niveau insuffisant",
  red: "Niveau très insuffisant",
};

/**
 * The pill's text for a /25: the band's name, or the floor when it is really
 * breached. The floor is worded here and nowhere else on the page's verdict.
 */
export function scoreToneLabel(score25: number): string {
  if (!meetsCompetencyFloor(score25)) {
    return `Sous le seuil éliminatoire (${COMPETENCY_FLOOR}/${COMPETENCY_MAX})`;
  }
  return SCORE_TONE_LABELS[scoreTone(score25)];
}

/**
 * The line under the mark: what was sat, how it was marked, how long it took,
 * and who marked it. « correction IA » is the honest last word — a candidate
 * reading a /25 three weeks later should not have to remember that no human
 * gave it.
 */
export function resultMetaLine(parts: { criteriaCount: number; totalSeconds: number }): string {
  return [
    "Monologue suivi et débat",
    `${parts.criteriaCount} critères`,
    formatClock(parts.totalSeconds),
    "correction IA",
  ].join(" · ");
}
