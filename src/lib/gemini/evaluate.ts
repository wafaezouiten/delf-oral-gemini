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
  CRITERION_DESCRIPTIONS,
  ORAL_CRITERIA,
  applyDurationPenalty,
  criteriaToScore25,
  snapCriteria,
  type CriteriaScores,
  type OralCriterion,
} from "@/lib/delf/rubric";
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

/** Bumped whenever the prompt changes, so a stored score can be traced to the
 *  words that produced it. `.3` names which task each recording is, including
 *  when only one of the two exists (Phase 6). */
export const EVAL_PROMPT_VERSION = "2026-08-14.3";

/** Re-exported, not redeclared: the mode is a stored column, and `evaluations.mode`
 *  is where its legal values are defined. */
export type { EvaluationMode };

/**
 * The band scale, spelled out. The wording matters: without the explicit
 * instruction to use the whole scale, models converge on 3 for everything and
 * the result stops discriminating between a good candidate and a weak one.
 */
const BAND_SCALE = `ÉCHELLE DE NOTATION : chaque critère reçoit EXACTEMENT l'une de ces quatre notes : 0, 1, 3 ou 5. N'utilisez JAMAIS 2 ni 4.
- 0 = Rien d'évaluable pour ce critère.
- 1 = En dessous du niveau B2 : les lacunes gênent la communication.
- 3 = Au niveau B2 : critère globalement satisfait, avec des maladresses ponctuelles.
- 5 = B2 pleinement maîtrisé, voire B2+ : un vrai point fort, sans réserve majeure.

UTILISEZ TOUTE L'ÉCHELLE. N'attribuez pas 3 par défaut. Un critère réellement réussi reçoit 5, un critère faible reçoit 1. Deux prestations de qualité différente DOIVENT recevoir des notes différentes. Des erreurs occasionnelles qui ne gênent pas la communication sont normales au niveau B2 et restent compatibles avec un 5 : n'exigez pas un niveau C1 pour l'accorder.`;

function criteriaBlock(): string {
  return ORAL_CRITERIA.map(
    (key, index) => `${index + 1}. ${key} : ${CRITERION_DESCRIPTIONS[key]}`,
  ).join("\n");
}

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

LES CINQ CRITÈRES (chacun noté 0, 1, 3 ou 5 ; leur somme = total25) :
${criteriaBlock()}

RÈGLES D'ÉVALUATION (PRIORITÉ ABSOLUE)
- Seules les répliques « CANDIDAT: » sont notées. Les répliques « EXAMINATEUR: » sont du contexte : ne notez jamais le vocabulaire, les idées ou les structures de l'examinateur.
- « realisationTache » se juge principalement sur le MONOLOGUE : prise de position, structure, qualité des arguments et des exemples.
- « interaction » se juge principalement sur le DEBAT : capacité à réagir aux objections, à défendre et à nuancer sa position, à apporter de NOUVEAUX exemples, à maintenir l'échange. Abandonner sa position sans la défendre est une faiblesse à ce critère.
- « lexique » et « morphosyntaxe » se jugent sur l'ENSEMBLE des deux tâches.
- Évaluez la MANIÈRE de s'exprimer, JAMAIS l'opinion défendue.
- Si aucune réplique « CANDIDAT: » ne contient de contenu évaluable, mettez 0 à TOUS les critères.
- Chaque justification doit citer une tournure ou une réplique réelle du candidat, nommer la bande atteinte et dire pourquoi.
- N'utilisez jamais de tiret cadratin ni de tiret demi-cadratin dans vos commentaires.
- Restez bienveillant mais rigoureux.

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

interface RawEvaluation {
  total25: number;
  phonologieNonEvaluable: boolean;
  appreciationGlobale: string;
  pointsForts: string[];
  axesPrioritaires: string[];
  conseil: string;
  [criterion: string]: unknown;
}

export interface EvaluationResult {
  mode: EvaluationMode;
  criteria: CriteriaScores;
  /** What the model literally returned, pre-snap. Kept because a model that
   *  starts emitting illegal 2s and 4s looks perfectly healthy once snapped. */
  rawCriteria: Record<OralCriterion, number>;
  /** The model's own arithmetic, for comparison only. Never shown. */
  modelTotal25: number;
  rawScore25: number;
  score25: number;
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
  const recordings: Array<{ phase: OralSpeakingPhase | null; blob: Blob }> = !params.audio
    ? []
    : params.audio instanceof Blob
      ? [{ phase: null, blob: params.audio }]
      : params.audio.map((recording) => ({ phase: recording.phase, blob: recording.blob }));

  const parts: Part[] = [{ text: buildPrompt({ ...params, recordings }) }];

  if (params.mode === "audio") {
    if (recordings.length === 0) {
      throw new Error("Audio mode requires the candidate's recording");
    }
    // Uploaded via the Files API rather than inlined: a full B2 exam is roughly
    // 20 minutes of 16 kHz PCM, tens of megabytes, well past the inline request
    // limit. The upload also lets the same recording be re-scored later without
    // re-sending it.
    //
    // Sequential rather than concurrent: the free tier rate-limits uploads, and
    // two files is not a latency problem worth a 429 for.
    for (const recording of recordings) {
      const uploaded = await ai.files.upload({
        file: recording.blob,
        config: { mimeType: "audio/wav" },
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

  let raw: RawEvaluation;
  try {
    raw = JSON.parse(text) as RawEvaluation;
  } catch {
    throw new Error(`The evaluator returned invalid JSON: ${text.slice(0, 200)}`);
  }

  const rawCriteria = Object.fromEntries(
    ORAL_CRITERIA.map((key) => {
      const entry = raw[key] as { score?: number } | undefined;
      return [key, Number(entry?.score ?? 0)];
    }),
  ) as Record<OralCriterion, number>;

  const criteria = snapCriteria(rawCriteria);
  const rawScore25 = criteriaToScore25(criteria);
  const totalSpeaking = params.monologueSeconds + params.debateSeconds;
  const score25 = applyDurationPenalty(rawScore25, totalSpeaking);

  const justifications = Object.fromEntries(
    ORAL_CRITERIA.map((key) => {
      const entry = raw[key] as { justification?: string } | undefined;
      return [key, entry?.justification ?? ""];
    }),
  ) as Record<OralCriterion, string>;

  return {
    mode: params.mode,
    criteria,
    rawCriteria,
    modelTotal25: Number(raw.total25 ?? 0),
    rawScore25,
    score25,
    feedback: {
      justifications,
      appreciationGlobale: raw.appreciationGlobale ?? "",
      pointsForts: raw.pointsForts ?? [],
      axesPrioritaires: raw.axesPrioritaires ?? [],
      conseil: raw.conseil ?? "",
      phonologieNonEvaluable: Boolean(raw.phonologieNonEvaluable),
    },
    model: EVAL_MODEL,
    promptVersion: EVAL_PROMPT_VERSION,
    latencySeconds: (Date.now() - startedAt) / 1000,
  };
}
