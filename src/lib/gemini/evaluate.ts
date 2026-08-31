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

import { ORAL_CRITERIA, type OralCriterion } from "@/lib/delf/criteria";
import { buildEvaluationPrompt } from "@/lib/delf/evaluation-prompt";
import { scoreSitting, type CriteriaBands } from "@/lib/delf/orale-rubric";
import {
  criterionJustifications,
  criterionScores,
  parseEvaluationResponse,
  type EvaluationResponse,
} from "./evaluation-response";
import { EvaluationFailure } from "./evaluation-failure";
import { readEvaluationUsage, type EvaluationUsage } from "./evaluation-usage";
import { waitForFileActive } from "./file-activation";
import { transientStatus, withTransientRetry } from "./transient";
import { candidateWordCount, type TranscriptEntry } from "@/lib/delf/transcript";
import type { OralTopic } from "@/lib/delf/topics";
import type { EvaluationFeedback, EvaluationMode, OralSpeakingPhase } from "@/lib/db/schema";
import { earlyClosingInstruction } from "./early-closing-instruction";
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
 *
 * `2026-08-21.0` adds the early-closing paragraph (#92): a sitting where the
 * examiner said goodbye mid-débat now tells the corrector so, instead of
 * leaving the goodbye in the transcript as if it were the shape of the
 * exchange. The paragraph is conditional — an ordinary sitting's prompt is
 * byte-identical to the previous version's — but the version is bumped
 * unconditionally, because "could this correction have carried the paragraph?"
 * is exactly the question the column answers.
 *
 * `2026-08-31.0` is the re-port (#173): the whole prompt is now the main
 * project's, in the main project's order, from `delf/evaluation-prompt.ts`.
 * Every block moved — the criterion prose became the FEI explicitation, the two
 * pragmatic criteria took the grid's two-part-sitting wording, the band scale
 * absorbed this file's `SCALE_USE`, the rules grew the fairness and
 * self-correction bullets, and the complete-stage contract is appended last.
 * This is the widest single change the column has ever recorded: scores either
 * side of it are not comparable, which is exactly what the column is for.
 */
export const EVAL_PROMPT_VERSION = "2026-08-31.0";

/** Re-exported, not redeclared: the mode is a stored column, and `evaluations.mode`
 *  is where its legal values are defined. */
export type { EvaluationMode };

/**
 * The corrector's prompt for one sitting.
 *
 * A thin adapter since #173: the words are the main project's and live in
 * `lib/delf/evaluation-prompt.ts`, which is pure and unit-tested. What this
 * function still decides is the two paragraphs that depend on the artefacts —
 * which recordings exist and how the phonologie criterion may therefore be
 * judged, and whether the examiner tried to close the épreuve early — and it
 * hands them over as directives, appended after the stage contract.
 */
function buildPrompt(params: {
  mode: EvaluationMode;
  topic: OralTopic;
  transcript: readonly TranscriptEntry[];
  monologueSeconds: number;
  debateSeconds: number;
  /** How many times the examiner tried to close the épreuve early (#92). */
  earlyClosingCount: number;
  /** Which tasks the attached audio actually covers. See `phonology-instruction.ts`. */
  recordings?: readonly AttachedRecording[];
}): string {
  return buildEvaluationPrompt({
    topic: params.topic,
    transcript: params.transcript,
    monologueSeconds: params.monologueSeconds,
    debateSeconds: params.debateSeconds,
    directives: [
      phonologyInstruction(params.mode, params.recordings),
      earlyClosingInstruction(params.earlyClosingCount),
    ],
  });
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
  /**
   * What halving the mark cost, and which parts the candidate never produced.
   * Zero and empty for a sitting where both parts happened; on a walk-out from
   * the débat this is the largest single thing that moved the mark, so it is
   * reported rather than left to be reversed out of `rawScore25 − score25`
   * (which cannot separate it from the duration penalty). See
   * `applyAbsentPartPenalty`.
   */
  absencePenalty: number;
  absentParts: Array<"monologue" | "debate">;
  /**
   * Which parts a penalty would have reached and did not, because the examiner
   * closed the épreuve early (#92). Corrector's working, like `shortParts` —
   * no column, never stored; the persisted fact is the sitting's
   * `early_closing_count`, which is what the results page keys its note on.
   */
  excusedParts: Array<"monologue" | "debate">;
  /**
   * Whether « phonologie » was held to the ceiling because this correction had no
   * audio (#29). Surfaced so a 3 can be explained as "not heard" rather than read
   * as "heard, and merely adequate".
   */
  phonologyCapped: boolean;
  score25: number;
  /** Whether the mark clears the ≥ 5/25 competency floor. Computed by the
   *  rubric, so the route no longer needs its own copy of the threshold. */
  meetsFloor: boolean;
  feedback: EvaluationFeedback;
  model: string;
  promptVersion: string;
  /**
   * The whole of this call, wall-clock: uploads, corrector, parsing. The stored
   * column (`evaluations.latency_seconds`), so its meaning must not move — rows
   * written before and after #86 have to stay comparable.
   */
  latencySeconds: number;
  /**
   * The split of {@link latencySeconds} that #86 asked for, because a fix
   * chosen against one undifferentiated number is chosen blind: how long the
   * Files API uploads took, and how long the corrector itself did. Diagnostics
   * like `rawCriteria` and `usage` below — they travel in the response and are
   * deliberately not columns; the operator's copy is the `[evaluate]` log line.
   */
  uploadSeconds: number;
  modelSeconds: number;
  /**
   * What the correction actually cost, in tokens, as the API reported it.
   *
   * Exists because #12 asks for cost per sitting measured rather than estimated,
   * and a harness that counted the prompt itself would be measuring its own
   * arithmetic instead of the call. The reading lives in `evaluation-usage.ts`
   * so it can be tested.
   *
   * WHERE IT GOES, precisely — an earlier version of this comment claimed it
   * went nowhere, which was half true and is the kind of half that misleads:
   *
   *  - **Not stored.** `toCorrectionRow` omits it and `evaluations` has no
   *    column for it. That boundary is real and enforced by the schema.
   *  - **Does reach the browser.** The finish route returns the whole
   *    `EvaluationResult` on a fresh grading, so these token counts land in the
   *    JSON next to `rawCriteria`, `modelTotal25` and `latencySeconds` — the
   *    three diagnostics that have always travelled that way. Deliberately not
   *    stripped: removing one of four would imply a boundary the route does not
   *    have, and none of them is sensitive. Nothing in the UI reads any of them.
   */
  usage: EvaluationUsage;
}

export interface EvaluateParams {
  mode: EvaluationMode;
  topic: OralTopic;
  transcript: readonly TranscriptEntry[];
  monologueSeconds: number;
  debateSeconds: number;
  /**
   * How many times the examiner tried to close the épreuve early (#92), as the
   * controller counted it, the finish payload carried it, and the route
   * corroborated it against the transcript before handing it here
   * (`resolveEarlyClosingCount`). Positive, it adds the incident paragraph to
   * the prompt and excuses the débat from both penalties
   * (`SittingConditions.examinerClosedEarly`).
   *
   * Optional, defaulting to 0, unlike the rubric's own flag — the callers that
   * omit it are the verification scripts and the audio-versus-text experiment,
   * which grade artefacts no examiner ever misbehaved in, and for them "not
   * counted" and "none heard" are honestly the same answer.
   */
  earlyClosingCount?: number;
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
 *
 * A *transient* failure is ridden out here rather than handed up, because the
 * caller's retry is a button in front of a candidate who has already finished
 * (see `transient.ts`). What still reaches the caller is a correction that
 * genuinely could not be produced.
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

  // Resolved once, here, so the prompt and the rubric cannot read the default
  // differently: the paragraph and the waiver describe one incident and must
  // fire together or not at all.
  const earlyClosingCount = params.earlyClosingCount ?? 0;

  const parts: Part[] = [{ text: buildPrompt({ ...params, earlyClosingCount, recordings }) }];

  const uploadStartedAt = Date.now();
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
    // Concurrent since #86, reversing a deliberate "sequential, the free tier
    // rate-limits uploads" trade. Decided rather than drifted into: the free
    // tier's Files API limit is a request *rate*, not a concurrency cap, the
    // fan-out here is bounded at the two speaking phases, and a candidate is
    // sitting at « Épreuve terminée » for the whole of this — `uploadSeconds`
    // below is what says how much the change bought. A 429, if one ever
    // arrives, gets the one extra attempt below before it surfaces to the
    // candidate as it did sequentially — the route's 502 and the retry button —
    // though `Promise.all` fails fast, so the sibling upload is abandoned
    // mid-flight rather than never started; a small quota waste on a partial
    // failure, cleaned up by the Files API's own TTL. `map` preserves exam
    // order, which the prompt promises the model about the files it is handed.
    //
    // Three additions since #73, each answering one way the old code turned an
    // explainable failure into « sometimes »:
    //
    //  1. **The upload is retried once**, transient statuses only — the same
    //     policy the corrector call rides on, held to two attempts because the
    //     re-send is the expensive half and `maxDuration` has to fit the model
    //     call after it.
    //  2. **The file is waited into `ACTIVE`** before it is referenced. The
    //     upload resolving does not mean the service has finished with the
    //     bytes, and referencing a `PROCESSING` file is refused — that race is
    //     the best fit for #73's intermittence. See `file-activation.ts`.
    //     The wait sits OUTSIDE the retry on purpose, so a file that ends
    //     `FAILED` fails once, with its own status, rather than buying a
    //     re-upload: processing rejected these exact bytes, re-sending them is
    //     the expensive half `transient.ts` already argues against spending
    //     twice, and #73's own ask is to surface the file's verdict — the
    //     candidate's retry button re-runs the whole sequence anyway.
    //  3. **Whatever fails in here is tagged `upload`**, so the route's 502 can
    //     say which part of the pipeline died instead of only that one did.
    parts.push(
      ...(await Promise.all(
        recordings.map(async (recording) => {
          const label = recording.phase ?? "sitting";
          try {
            const uploaded = await withTransientRetry(
              () =>
                ai.files.upload({
                  file: recording.blob,
                  config: { mimeType: recording.mimeType },
                }),
              {
                attempts: 2,
                onRetry: (error, attempt, delayMs) =>
                  console.warn(
                    `[evaluate] ${label} upload attempt ${attempt} failed ` +
                      `(${transientStatus(error)}), retrying in ${delayMs}ms`,
                  ),
              },
            );
            const active = await waitForFileActive(uploaded, (name) => ai.files.get({ name }), {
              onPoll: (state, poll) =>
                console.info(`[evaluate] ${label} recording is ${state}, poll ${poll}`),
            });
            if (!active.uri || !active.mimeType) {
              throw new Error("File upload returned no usable URI");
            }
            return createPartFromUri(active.uri, active.mimeType);
          } catch (error) {
            throw new EvaluationFailure(
              "upload",
              `The ${label} recording could not be made available to the corrector`,
              { cause: error },
            );
          }
        }),
      )),
    );
  }
  const uploadSeconds = (Date.now() - uploadStartedAt) / 1000;

  /**
   * Retried on a busy corrector, and only on a busy corrector.
   *
   * `gemini-3.6-flash` answers 503 « This model is currently experiencing high
   * demand » under load, and the identical request goes through moments later.
   * Without this the throw reaches the finish route, becomes a 502, and asks a
   * candidate who has just sat a twenty-minute exam to press a button — or, if
   * they close the tab instead, leaves a sitting marked finished with no
   * correction attached.
   *
   * Which failures qualify, and why a 404 must not, is `transient.ts`'s;
   * nothing about the decision is taken here. The prompt and the uploads are
   * outside the retry deliberately: re-sending the audio is the expensive half
   * and a failed upload leaves nothing to reuse.
   */
  const modelStartedAt = Date.now();
  const response = await withTransientRetry(
    () =>
      ai.models.generateContent({
        model: EVAL_MODEL,
        contents: [{ role: "user", parts }],
        config: {
          responseMimeType: "application/json",
          responseSchema,
          // Grading must be as reproducible as the model allows; the experiment
          // compares two modes and needs the difference to be the audio, not sampling.
          temperature: 0.2,
        },
      }),
    {
      onRetry: (error, attempt, delayMs) =>
        console.warn(
          `[evaluate] attempt ${attempt} failed (${transientStatus(error)}), ` +
            `retrying in ${delayMs}ms`,
        ),
    },
  ).catch((error) => {
    // Tagged after the retry, not inside it: what reaches here is a corrector
    // that genuinely would not answer, and the original error rides in `cause`.
    throw new EvaluationFailure("model", "The corrector did not answer", { cause: error });
  });

  const modelSeconds = (Date.now() - modelStartedAt) / 1000;
  // The split #86 asked for, where an operator will actually see it: which half
  // of the corrector's latency was the network and which was the model. One
  // line per correction, so a slow sitting can be read off the deployment logs
  // rather than re-argued from guesses.
  console.info(
    `[evaluate] uploads ${uploadSeconds.toFixed(1)}s (${recordings.length} file(s)), ` +
      `corrector ${modelSeconds.toFixed(1)}s (${EVAL_MODEL})`,
  );

  const text = response.text;
  if (!text) throw new EvaluationFailure("empty", "The evaluator returned no output");

  // Checked, not coerced. The previous reading defaulted a missing criterion to
  // zero, so a truncated or refused generation cost the candidate five points
  // silently; a breach of the contract now throws and the caller can retry.
  let raw: EvaluationResponse;
  try {
    raw = parseEvaluationResponse(text);
  } catch (error) {
    throw new EvaluationFailure("contract", "The evaluator's reply was not a complete correction", {
      cause: error,
    });
  }
  const rawCriteria = criterionScores(raw);

  // The whole rubric, in one call. Snapping, the sum, the per-part duration
  // penalty and the competency floor are all `orale-rubric.ts`'s, in the order
  // it defines — nothing about the mark is computed here.
  const scored = scoreSitting(rawCriteria, {
    monologueSeconds: params.monologueSeconds,
    debateSeconds: params.debateSeconds,
    // Counted here rather than asked of the caller: the transcript is already a
    // parameter, and a route free to report its own participation figures is a
    // route that can talk a walk-out back up to a full mark.
    monologueWords: candidateWordCount(params.transcript, "monologue"),
    debateWords: candidateWordCount(params.transcript, "debate"),
    // The one place the mode reaches the rubric. `audio` is the only mode that
    // puts the recording in front of the corrector, so it is the only one that
    // may award the top phonologie band (#29).
    phonologyHeard: params.mode === "audio",
    // And the one place the count does (#92): the rubric takes the fact, not
    // the figure, because one goodbye and three are the same waiver.
    examinerClosedEarly: earlyClosingCount > 0,
  });

  return {
    mode: params.mode,
    criteria: scored.criteria,
    rawCriteria,
    modelTotal25: raw.total25,
    rawScore25: scored.rawScore25,
    absencePenalty: scored.absencePenalty,
    absentParts: scored.absentParts,
    durationPenalty: scored.durationPenalty,
    shortParts: scored.shortParts,
    excusedParts: scored.excusedParts,
    phonologyCapped: scored.phonologyCapped,
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
    uploadSeconds,
    modelSeconds,
    usage: readEvaluationUsage(response.usageMetadata),
  };
}
