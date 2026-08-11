/**
 * The official DELF B2 production orale grille — five criteria, /25.
 *
 * Ported (deliberately, as reference) from the France Éducation international
 * corrector grid: each criterion is scored on the discrete **0 / 1 / 3 / 5** band
 * scale, never a continuous 0-5, and the five bands sum to the /25 competency
 * score. 2 and 4 are not legal scores; a model that emits one is snapped, not
 * trusted.
 *
 * What differs from the reference implementation, on purpose: this product runs
 * the monologue AND the débat in one sitting, so it does not need the
 * "task-adaptive criterion" workaround where « interaction » is relabelled
 * « continuité du discours » for a solo part. Here both tasks really happen, so
 * both pragmatic criteria are genuinely earned — `realisationTache` is graded on
 * the monologue, `interaction` on the débat.
 *
 * Pure and side-effect free: the model call lives in `lib/gemini/evaluate.ts`.
 */

export const GRILLE_BANDS = [0, 1, 3, 5] as const;
export type GrilleBand = (typeof GRILLE_BANDS)[number];

export const ORAL_CRITERIA = [
  "realisationTache",
  "interaction",
  "lexique",
  "morphosyntaxe",
  "phonologie",
] as const;

export type OralCriterion = (typeof ORAL_CRITERIA)[number];

export type CriteriaScores = Record<OralCriterion, GrilleBand>;

export const CRITERION_LABELS: Record<OralCriterion, string> = {
  realisationTache: "Réalisation de la tâche",
  interaction: "Interaction / continuité du discours",
  lexique: "Lexique",
  morphosyntaxe: "Morphosyntaxe",
  phonologie: "Phonologie",
};

export const CRITERION_COMPETENCE: Record<OralCriterion, string> = {
  realisationTache: "Compétence pragmatique",
  interaction: "Compétence pragmatique",
  lexique: "Compétence linguistique",
  morphosyntaxe: "Compétence linguistique",
  phonologie: "Compétence linguistique",
};

/** What each criterion measures — shown in the report and given to the model. */
export const CRITERION_DESCRIPTIONS: Record<OralCriterion, string> = {
  realisationTache:
    "Le monologue suivi réalise la tâche : position claire, propos structuré, arguments et exemples pertinents, registre adapté.",
  interaction:
    "Le candidat tient un discours suivi puis gère le débat : il réagit aux objections, défend et nuance sa position, relance et maintient l'échange avec aisance.",
  lexique:
    "Le vocabulaire est étendu et précis sur les deux parties de l'épreuve, avec peu de lacunes ou de répétitions.",
  morphosyntaxe:
    "La morphosyntaxe est contrôlée : structures variées, temps et modes, accords ; les erreurs ne gênent pas la compréhension.",
  phonologie:
    "La prononciation, l'intonation et le rythme sont clairs et naturels ; l'écoute ne demande pas d'effort à l'interlocuteur.",
};

export const BAND_LABELS: Record<GrilleBand, string> = {
  0: "Insuffisant",
  1: "En dessous du niveau B2",
  3: "Au niveau B2",
  5: "B2+",
};

/** The highest possible score, and the DELF competency floor (5/25). */
export const SCORE_MAX = 25;
export const SCORE_FLOOR = 5;

/**
 * Snap a model's raw number onto the nearest legal band. Ties round DOWN — a 2
 * becomes a 1, a 4 becomes a 3 — because the grille's upper bands are explicit
 * claims about the candidate ("au niveau ciblé supérieur") that a hedged score
 * has not earned.
 */
export function snapToBand(raw: number): GrilleBand {
  if (!Number.isFinite(raw)) return 0;
  const clamped = Math.min(5, Math.max(0, raw));
  let best: GrilleBand = 0;
  let bestDistance = Infinity;
  for (const band of GRILLE_BANDS) {
    const distance = Math.abs(clamped - band);
    // `<` not `<=` keeps the FIRST (lower) band on an exact tie.
    if (distance < bestDistance) {
      best = band;
      bestDistance = distance;
    }
  }
  return best;
}

/** Snap all five criteria at once. */
export function snapCriteria(raw: Record<OralCriterion, number>): CriteriaScores {
  return {
    realisationTache: snapToBand(raw.realisationTache),
    interaction: snapToBand(raw.interaction),
    lexique: snapToBand(raw.lexique),
    morphosyntaxe: snapToBand(raw.morphosyntaxe),
    phonologie: snapToBand(raw.phonologie),
  };
}

/**
 * Sum the five bands into the /25 score.
 *
 * The evaluator also returns its own total; we ignore it and recompute here. A
 * model that scores five criteria correctly but adds them up wrong would
 * otherwise hand the candidate a wrong grade, and that failure is silent.
 */
export function criteriaToScore25(scores: CriteriaScores): number {
  const total = ORAL_CRITERIA.reduce((sum, key) => sum + scores[key], 0);
  return Math.min(SCORE_MAX, Math.max(0, total));
}

/**
 * The DELF B2 production orale minimum speaking time, in seconds: a 5-minute
 * monologue plus a meaningful débat. A candidate well under this has not sat the
 * épreuve, and scoring them as if they had is misleading.
 */
export const MIN_TOTAL_SPEAKING_SECONDS = 8 * 60;

/**
 * Dock the score when the candidate spoke for far less than the épreuve requires.
 *
 * Mirrors the reference implementation's duration penalty, and for the same
 * reason: without it a candidate who says three excellent sentences and stops
 * can score higher than one who sustains a real 20-minute exam, because every
 * criterion looks clean on a tiny sample. Never drops below 0.
 */
export function applyDurationPenalty(
  score25: number,
  actualSeconds: number,
  minSeconds: number = MIN_TOTAL_SPEAKING_SECONDS,
): number {
  if (actualSeconds >= minSeconds) return score25;
  // Below half the required time is a severe shortfall, otherwise a mild one.
  const penalty = actualSeconds < minSeconds / 2 ? 5 : 3;
  return Math.max(0, score25 - penalty);
}

/** Whether a /25 score clears the DELF competency floor. */
export function meetsFloor(score25: number): boolean {
  return score25 >= SCORE_FLOOR;
}
