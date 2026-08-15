import "server-only";

/**
 * The DELF /25 evaluator.
 *
 * Deliberately NOT part of the Live session. The examiner's job is to run a
 * convincing exam; the corrector's job is to grade one. Fusing them would mean
 * the model that spent 20 minutes being argued with also decides the mark, which
 * is both a conflict of interest and impossible to re-run. Here the evaluation
 * is a separate, stateless call over stored artefacts, so a graded exam can be
 * re-scored later with a better prompt or a different model — which is exactly
 * what the audio-versus-text experiment needs.
 *
 * Two modes:
 *   - `text`  — the transcript alone. What the reference implementation does.
 *   - `audio` — the transcript PLUS the candidate's actual recording, so
 *               phonologie is heard rather than inferred from the number of
 *               "euh"s in a transcript.
 */

import { GoogleGenAI, Type, createPartFromUri, type Part } from "@google/genai";

import {
  BAND_SCALE,
  EVALUATION_RULES,
  ORAL_CRITERIA,
  ORAL_CRITERIA_DESCRIPTIONS,
  type OralCriterion,
} from "@/lib/delf/criteria";
import { scoreSitting, type CriteriaBands } from "@/lib/delf/orale-rubric";
import {
  criterionJustifications,
  criterionScores,
  parseEvaluationResponse,
} from "./evaluation-response";
import { formatTranscript, type TranscriptEntry } from "@/lib/delf/transcript";
import type { OralTopic } from "@/lib/delf/topics";
import type { EvaluationFeedback, EvaluationMode, OralSpeakingPhase } from "@/lib/db/schema";
import { phonologyInstruction, type AttachedRecording } from "./phonology-instruction";

/**
 * The corrector model. Deliberately NOT the Live model: grading is a careful
 * reasoning task rather than a conversation, and it must accept audio input.
 *
 * Two lessons are baked into this default, both learned by calling the API:
 *
 *  - `gemini-3-pro-preview` returned 404: already retired. `pnpm models` lists
 *    what the key can actually reach, which beats guessing plausible ids.
 *  - `gemini-3.1-pro-preview` exists but has a FREE-TIER QUOTA OF ZERO, so on a
 *    free key it 429s on the very first call rather than degrading.
 *
 * So the default is the strongest model that a free key can actually run.
 * Override with `GEMINI_EVAL_MODEL` on a billed key — a pro model is a better
 * corrector, and grading is exactly the task worth spending capability on.
 */
export const EVAL_MODEL = process.env.GEMINI_EVAL_MODEL ?? "gemini-3.6-flash";

/**
 * Bumped whenever the prompt changes, so a stored score can be traced to the
 * words that produced it.
 *
 * `2026-08-15.0` is the first version whose band scale and evaluation rules are
 * the ported grille text (`delf/criteria.ts`) rather than this file's
 * paraphrase of it. Scores either side of this string are not strictly
 * comparable, which is the entire reason the column exists.
 */
export const EVAL_PROMPT_VERSION = "2026-08-15.0";

/** Re-exported, not redeclared: the mode is a stored column, and `evaluations.mode`
 *  is where its legal values are defined. */
export type { EvaluationMode };

/**
 * Using the whole scale — this project's addition, not the grille's words.
 *
 * Kept separate from {@link BAND_SCALE} on purpose: that block is the ported
 * definition of what each band *means*, and paraphrasing it would change what
 * the model grades. This is a behavioural instruction about how to use it,
 * learned by running the corrector: without it, models put 3 on everything and
 * the result stops telling a good candidate from a weak one (see
 * docs/EVALUATION_FINDINGS.md).
 */
const SCALE_USE = `UTILISEZ TOUTE L'ÉCHELLE. N'attribuez pas 3 par défaut. Un critère réellement réussi reçoit 5, un critère faible reçoit 1. Deux prestations de qualité différente DOIVENT recevoir des notes différentes. Des erreurs occasionnelles qui ne gênent pas la communication sont normales au niveau B2 et restent compatibles avec un 5 : n'exigez pas un niveau C1 pour l'accorder.`;

/**
 * Which task each criterion is judged on — also this project's, and for a
 * structural reason rather than a stylistic one.
 *
 * The reference implementation corrects ONE task per correction, so it never
 * has to say where a criterion's evidence lives. Here the monologue and the
 * débat are one sitting and one mark, and the two pragmatic criteria are earned
 * in different halves of it: a candidate who argues well alone and folds under
 * contradiction is a real, common profile, and a corrector not told where to
 * look grades both criteria off whichever half it read last.
 */
const TASK_ATTRIBUTION = `RÉPARTITION DES CRITÈRES SUR LES DEUX TÂCHES :
- « realisationTache » se juge principalement sur le MONOLOGUE SUIVI : prise de position, structure, qualité des arguments et des exemples.
- « interaction » se juge principalement sur le DEBAT : capacité à réagir aux objections, à défendre et à nuancer sa position, à apporter de NOUVEAUX exemples, à maintenir l'échange.
- « lexique » et « morphosyntaxe » se jugent sur l'ENSEMBLE des deux tâches.
- N'utilisez jamais de tiret cadratin ni de tiret demi-cadratin dans vos commentaires.`;

/** The five criteria and what each measures, in the grille's own words. */
function criteriaBlock(): string {
  return ORAL_CRITERIA.map(
    (key, index) => `${index + 1}. ${key} : ${ORAL_CRITERIA_DESCRIPTIONS[key]}`,
  ).join("\n");
}

/**
 * The corrector's prompt.
 *
 * Note what it does NOT contain: any arithmetic. The band scale is stated so
 * the model knows which four numbers it may return, and nothing else about the
 * mark is asked of it — the sum, the duration penalty and the competency floor
 * are computed from what it returns, by `orale-rubric.ts`. A prompt that told
 * the model to subtract three points for a short épreuve would be a second
 * implementation of the rubric, written in French, unversioned and untestable
 * (#9).
 *
 * The durations are given for context only, so the model can read a thin
 * monologue as thin rather than as a bad one. They are the measured seconds,
 * from the recordings.
 */
function buildPrompt(params: {
  mode: EvaluationMode;
  topic: OralTopic;
  transcript: readonly TranscriptEntry[];
  monologueSeconds: number;
  debateSeconds: number;
  /** Which tasks the attached audio actually covers. See `phonology-instruction.ts`. */
  recordings?: readonly AttachedRecording[];
}): string {
  const { mode, topic, transcript, monologueSeconds, debateSeconds } = params;

  return `Vous êtes un correcteur officiel du DELF B2, épreuve de production orale. Vous appliquez STRICTEMENT la grille d'évaluation de France Éducation international, notée sur 25 points.

SUJET DE L'ÉPREUVE
Titre : ${topic.title}
Document déclencheur : ${topic.document}

STRUCTURE DE L'ÉPREUVE PASSÉE
L'épreuve comporte DEUX tâches, présentes toutes les deux dans la transcription ci-dessous :
1. MONOLOGUE SUIVI (${Math.round(monologueSeconds)} secondes) : le candidat présente seul son point de vue. L'examinateur n'intervient pas.
2. DEBAT (${Math.round(debateSeconds)} secondes) : l'examinateur conteste la position du candidat, qui doit la défendre et la nuancer.

${BAND_SCALE}

${SCALE_USE}

LES CINQ CRITÈRES (chacun noté 0, 1, 3 ou 5 ; leur somme = total25) :
${criteriaBlock()}

${EVALUATION_RULES}

${TASK_ATTRIBUTION}

${phonologyInstruction(mode, params.recordings)}

TRANSCRIPTION DE L'ÉPREUVE
${formatTranscript(transcript) || "(aucune production)"}`;
}

/** The structured output contract. */
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    ...Object.fromEntries(
      ORAL_CRITERIA.map((key) => [
        key,
        {
          type: Type.OBJECT,
          properties: {
            score: { type: Type.INTEGER, description: "0, 1, 3 ou 5 uniquement" },
            justification: { type: Type.STRING },
          },
          required: ["score", "justification"],
        },
      ]),
    ),
    total25: { type: Type.INTEGER },
    phonologieNonEvaluable: { type: Type.BOOLEAN },
    appreciationGlobale: { type: Type.STRING },
    pointsForts: { type: Type.ARRAY, items: { type: Type.STRING } },
    axesPrioritaires: { type: Type.ARRAY, items: { type: Type.STRING } },
    conseil: { type: Type.STRING },
  },
  required: [
    ...ORAL_CRITERIA,
    "total25",
    "phonologieNonEvaluable",
    "appreciationGlobale",
    "pointsForts",
    "axesPrioritaires",
    "conseil",
  ],
};

export interface EvaluationResult {
  mode: EvaluationMode;
  criteria: CriteriaBands;
  /** What the model literally returned, pre-snap. Kept because a model that
   *  starts emitting illegal 2s and 4s looks perfectly healthy once snapped. */
  rawCriteria: Record<OralCriterion, number>;
  /** The model's own arithmetic, for comparison only. Never shown. */
  modelTotal25: number;
  rawScore25: number;
  /**
   * What the rubric asked to dock for a short épreuve, nominal — and which
   * parts were short, so the figure can be explained rather than just applied.
   * Both come from `orale-rubric.ts`; neither is derived here.
   */
  durationPenalty: number;
  shortParts: Array<"monologue" | "debate">;
  score25: number;
  /** Whether the mark clears the ≥ 5/25 competency floor. Computed by the
   *  rubric, so the route no longer needs its own copy of the threshold. */
  meetsFloor: boolean;
  feedback: EvaluationFeedback;
  model: string;
  promptVersion: string;
  latencySeconds: number;
}

export interface EvaluateParams {
  mode: EvaluationMode;
  topic: OralTopic;
  transcript: readonly TranscriptEntry[];
  monologueSeconds: number;
  debateSeconds: number;
  /**
   * The candidate's recording. Required for `audio` mode, ignored otherwise.
   *
   * Two shapes, because there are two kinds of caller. Phase 6's exam produces
   * one artefact per task and passes them **labelled**, in exam order — the
   * corrector is then told which task each file is, which matters most in the
   * case where only one of them exists (see `phonology-instruction.ts`). A bare
   * `Blob` is a whole-sitting recording, which is what the verification scripts
   * and the audio-versus-text experiment hand over, and is described to the
   * corrector as covering the épreuve rather than a task.
   */
  audio?: Blob | readonly EvaluationRecording[];
}

/** One recording, and which task of the épreuve it is of. */
export interface EvaluationRecording {
  phase: OralSpeakingPhase;
  blob: Blob;
  /**
   * What the file is, as read out of its bytes by the caller. Optional because
   * the scripts hand over a WAV they just wrote; the finish route sniffs it,
   * because since #24 a sitting arrives as Ogg Opus and a file uploaded under
   * the wrong type is a correction of silence.
   */
  mimeType?: string;
}

/** A blob knows what it is; a blob built without a type does not, and the
 *  scripts' recordings are always the WAV `pcm16ToWav` wrote. */
function mimeTypeOf(blob: Blob): string {
  return blob.type || "audio/wav";
}

/**
 * Grade one exam.
 *
 * Throws rather than returning a fallback score: a fabricated grade is worse
 * than a visible failure, and the caller can retry.
 */
export async function evaluateExam(params: EvaluateParams): Promise<EvaluationResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const ai = new GoogleGenAI({ apiKey });
  const startedAt = Date.now();

  // A bare blob is a whole-sitting recording and belongs to no single task, so
  // it carries a null phase rather than being guessed at.
  const recordings: Array<{
    phase: OralSpeakingPhase | null;
    blob: Blob;
    mimeType: string;
  }> = !params.audio
    ? []
    : params.audio instanceof Blob
      ? [{ phase: null, blob: params.audio, mimeType: mimeTypeOf(params.audio) }]
      : params.audio.map((recording) => ({
          phase: recording.phase,
          blob: recording.blob,
          mimeType: recording.mimeType ?? mimeTypeOf(recording.blob),
        }));

  const parts: Part[] = [{ text: buildPrompt({ ...params, recordings }) }];

  if (params.mode === "audio") {
    if (recordings.length === 0) {
      throw new Error("Audio mode requires the candidate's recording");
    }
    // Uploaded via the Files API rather than inlined: a full B2 exam is 20
    // minutes of audio, past the inline request limit even compressed. The
    // upload also lets the same recording be re-scored later without re-sending
    // it. `audio/ogg` is accepted and transcribed — verified against the real
    // service, see docs/AUDIO_UPLOAD.md.
    //
    // Sequential rather than concurrent: the free tier rate-limits uploads, and
    // two files is not a latency problem worth a 429 for.
    for (const recording of recordings) {
      const uploaded = await ai.files.upload({
        file: recording.blob,
        config: { mimeType: recording.mimeType },
      });
      if (!uploaded.uri || !uploaded.mimeType) {
        throw new Error("File upload returned no usable URI");
      }
      parts.push(createPartFromUri(uploaded.uri, uploaded.mimeType));
    }
  }

  const response = await ai.models.generateContent({
    model: EVAL_MODEL,
    contents: [{ role: "user", parts }],
    config: {
      responseMimeType: "application/json",
      responseSchema,
      // Grading must be as reproducible as the model allows; the experiment
      // compares two modes and needs the difference to be the audio, not sampling.
      temperature: 0.2,
    },
  });

  const text = response.text;
  if (!text) throw new Error("The evaluator returned no output");

  // Checked, not coerced. The previous reading defaulted a missing criterion to
  // zero, so a truncated or refused generation cost the candidate five points
  // silently; a breach of the contract now throws and the caller can retry.
  const raw = parseEvaluationResponse(text);
  const rawCriteria = criterionScores(raw);

  // The whole rubric, in one call. Snapping, the sum, the per-part duration
  // penalty and the competency floor are all `orale-rubric.ts`'s, in the order
  // it defines — nothing about the mark is computed here.
  const scored = scoreSitting(rawCriteria, {
    monologueSeconds: params.monologueSeconds,
    debateSeconds: params.debateSeconds,
  });

  return {
    mode: params.mode,
    criteria: scored.criteria,
    rawCriteria,
    modelTotal25: raw.total25,
    rawScore25: scored.rawScore25,
    durationPenalty: scored.durationPenalty,
    shortParts: scored.shortParts,
    score25: scored.score25,
    meetsFloor: scored.meetsFloor,
    // No `?? ""` or `Boolean(...)` here any more: every one of these is required
    // by the response schema, so a default would be dead code that also implied
    // the field might be missing — which is exactly the reading that let a
    // missing criterion score zero.
    feedback: {
      justifications: criterionJustifications(raw),
      appreciationGlobale: raw.appreciationGlobale,
      pointsForts: raw.pointsForts,
      axesPrioritaires: raw.axesPrioritaires,
      conseil: raw.conseil,
      phonologieNonEvaluable: raw.phonologieNonEvaluable,
    },
    model: EVAL_MODEL,
    promptVersion: EVAL_PROMPT_VERSION,
    latencySeconds: (Date.now() - startedAt) / 1000,
  };
}
