/**
 * The corrector's prompt, composed from the ported grille blocks in
 * `criteria.ts`.
 *
 * It lives here, in `lib/delf`, rather than inside `gemini/evaluate.ts`, for the
 * same reason `examiner-prompt.ts` and `phonology-instruction.ts` do: that file
 * imports `server-only` and therefore cannot be loaded by the unit suite, and
 * the words that decide a candidate's marks are exactly the kind of string that
 * should be asserted rather than read. Nothing here talks to the model, reads
 * the environment or knows what a `Blob` is.
 *
 * PORT NOTE (#173). The order of the blocks is the main project's
 * (`delf-preps@5170f0dd`, `DEFAULT_ORAL_EVAL_TEMPLATE` and
 * `renderOralEvaluationPrompt`): header, attendus, partie évaluée, échelle,
 * critères, style, règles, appréciation and conseil, durée, transcription,
 * contrat de réponse — then the directives, appended last and unremovable. The
 * reference appends its own that way (the stage contract, and the audio
 * phonologie judgment when the passation produced one); this project appends the
 * stage contract, the phonologie instruction for the mode being run, and the
 * early-closing incident paragraph when there was one.
 *
 * What is this project's rather than the reference's, and why:
 *
 *  - **Two durations, not one.** The reference corrects one task per correction
 *    and reports one figure. Here the épreuve is one sitting of two parts and
 *    the parts are timed separately, so the model is given both — for context
 *    only, so it can read a thin monologue as thin rather than as a bad one. The
 *    measured seconds, from the recordings.
 *  - **A document déclencheur**, where the reference has a one-line « Sujet /
 *    situation ». The B2 subject IS a document, the candidate spent thirty
 *    minutes preparing against it, and « dégage une problématique à partir du
 *    document » cannot be judged by a corrector that has not seen it.
 *  - **The `directives` list**, which is how the two mode-dependent paragraphs
 *    reach the prompt without this module having to know what audio is.
 *
 * Note what the prompt does NOT contain: any arithmetic. The band scale states
 * which four numbers the model may return, and nothing else about the mark is
 * asked of it — the sum, the duration penalty, the absent-part halving and the
 * competency floor are all computed from what it returns, by `orale-rubric.ts`
 * (#9).
 */

import {
  BAND_SCALE,
  COMPLETE_STAGE_DIRECTIVE,
  B2_EXPECTATION,
  EVALUATION_RULES,
  ORAL_CRITERIA,
  SITTING_FOCUS,
  STYLE_RULE,
  renderOralCriteriaList,
} from "./criteria";
import type { OralTopic } from "./topics";
import { formatTranscript, type TranscriptEntry } from "./transcript";

/** How the prompt names the épreuve being corrected. */
const PART_TITLE = "Épreuve complète en deux parties (monologue suivi puis débat)";

export interface EvaluationPromptParams {
  topic: OralTopic;
  transcript: readonly TranscriptEntry[];
  /** Measured seconds of the monologue, from the recording. */
  monologueSeconds: number;
  /** Measured seconds of the débat, from the recording. */
  debateSeconds: number;
  /**
   * Paragraphs appended after the stage contract, in order, empty ones dropped.
   *
   * The phonologie instruction for the mode being corrected, and the
   * early-closing incident paragraph when the examiner said goodbye mid-débat.
   * Both are the caller's because both depend on artefacts this module has no
   * business knowing about; both are appended rather than interleaved because
   * the reference appends its own directives, and because a paragraph that has
   * to win is one that comes last.
   */
  directives?: readonly string[];
}

/**
 * Build the corrector's prompt for one complete sitting.
 *
 * Every sitting this project grades is the complete two-part épreuve, so there
 * is one shape here where the reference has three (a single-part level, a
 * partial /20 monologue correction, a complete /25 sitting). The one it renders
 * is the reference's complete-sitting shape.
 */
export function buildEvaluationPrompt(params: EvaluationPromptParams): string {
  const { topic, transcript, monologueSeconds, debateSeconds } = params;
  const totalSeconds = Math.round(monologueSeconds) + Math.round(debateSeconds);

  const body = `Vous êtes un correcteur officiel du DELF B2 (production orale). Vous évaluez la performance d'un candidat en appliquant STRICTEMENT la grille d'évaluation officielle de la production orale (France Éducation international), notée sur 25 points, à partir de la transcription ci-dessous.

${B2_EXPECTATION}

PARTIE ÉVALUÉE : ${PART_TITLE}
${SITTING_FOCUS}
Sujet / situation : ${topic.title}
Document déclencheur : ${topic.document}

${BAND_SCALE}

LES ${ORAL_CRITERIA.length} CRITÈRES DE LA GRILLE À NOTER (chacun noté 0, 1, 3 ou 5 ; leur somme = total25) :
${renderOralCriteriaList()}

${STYLE_RULE}

${EVALUATION_RULES}

APPRÉCIATION GLOBALE (« appreciationGlobale ») : un paragraphe de correcteur (3 à 5 phrases) synthétisant le niveau global de la prestation, ce qui la situe à B2 ou non, et l'impression d'ensemble.

CONSEIL (« conseil ») : une seule recommandation d'entraînement, concrète et actionnable, la plus utile pour progresser.

Durée de production du candidat : ${totalSeconds} secondes (monologue suivi : ${Math.round(
    monologueSeconds,
  )} s ; débat : ${Math.round(debateSeconds)} s).

Transcript :
${formatTranscript(transcript) || "(aucune production)"}

Répondez avec : pour chacun des ${ORAL_CRITERIA.length} critères listés ci-dessus, un objet { score (0/1/3/5), justification } ; le total25 (0 à 25) ; « phonologieNonEvaluable » (true/false) ; l'appreciationGlobale ; 2 à 4 points forts (pointsForts) ; 2 à 6 axes d'amélioration prioritaires (axesPrioritaires) ; et le conseil.`;

  // Blank directives are dropped rather than joined: an ordinary sitting has no
  // incident to report, and an unconditional slot would leave a stray empty
  // paragraph in every prompt that never had one.
  return [body, COMPLETE_STAGE_DIRECTIVE, ...(params.directives ?? [])]
    .filter((block) => block.trim().length > 0)
    .join("\n\n");
}
