/**
 * What a correction cost, in tokens, read off the API's own response.
 *
 * Its own module for the same reason as `evaluation-response.ts` and
 * `phonology-instruction.ts`: `evaluate.ts` imports `server-only` and cannot be
 * loaded by the unit suite, and this reading has edges worth asserting rather
 * than eyeballing — an absent count must not become a zero, and the audio slice
 * has to be found in a list rather than read off a field.
 *
 * These numbers are never persisted — `evaluations` has no column for them — but
 * they do travel to the browser on a fresh grading, alongside the other
 * diagnostics the finish route returns. See `EvaluationResult.usage` for the
 * exact boundary and why it is drawn there. They exist because #12 asks for cost
 * per sitting measured rather than estimated, and a harness that counted the
 * prompt itself would be measuring its own arithmetic instead of the call.
 */

import { MediaModality, type GenerateContentResponse } from "@google/genai";

/** Token counts for one correction. Audio arrives as tokens too, and separately. */
export interface EvaluationUsage {
  promptTokens: number | null;
  responseTokens: number | null;
  /**
   * Reasoning tokens. Billed as output, absent from the response, and on this
   * corrector they are the LARGER part of it — across the #12 comparison runs, a
   * mean of 1 697 reasoning tokens behind 634 tokens of returned JSON. Costing a
   * correction from prompt + response alone understates it by about 73%, which is
   * why this is a field rather than a subtraction nobody would think to make.
   */
  thoughtsTokens: number | null;
  totalTokens: number | null;
  /** Of the prompt tokens, the ones that came from uploaded audio (`audio` mode). */
  audioPromptTokens: number | null;
}

/**
 * The modality the Files API reports uploaded recordings under. The SDK's own
 * enum rather than the string `"AUDIO"`: the two are equal at runtime, and only
 * one of them fails to compile when the SDK renames a member.
 */
const AUDIO_MODALITY = MediaModality.AUDIO;

/**
 * Pull the token counts off a response, keeping "absent" distinct from "zero".
 *
 * Every field is optional in the SDK's typing and genuinely missing in practice
 * — a response can arrive with no `usageMetadata` at all. `?? null` rather than
 * `?? 0` throughout, so a cost computed from these is visibly incomplete instead
 * of quietly cheap.
 */
export function readEvaluationUsage(
  metadata: GenerateContentResponse["usageMetadata"],
): EvaluationUsage {
  // `promptTokensDetails` breaks the prompt down by modality; the audio slice is
  // the entire cost difference between the two evaluation modes, and it is
  // nowhere near proportional to the prose it accompanies.
  const audio = metadata?.promptTokensDetails?.find(
    (detail) => detail.modality === AUDIO_MODALITY,
  );

  return {
    promptTokens: metadata?.promptTokenCount ?? null,
    responseTokens: metadata?.candidatesTokenCount ?? null,
    thoughtsTokens: metadata?.thoughtsTokenCount ?? null,
    totalTokens: metadata?.totalTokenCount ?? null,
    audioPromptTokens: audio?.tokenCount ?? null,
  };
}

/**
 * What the correction is billed for as output: the answer plus the thinking.
 *
 * Separated out because it is the number that gets compared. The reference
 * implementation's SDK reports its model's `outputTokens` as the TOTAL output
 * with reasoning already inside it, so comparing that against this system's
 * `responseTokens` alone would flatter this system by the larger half of its own
 * bill. Null only when neither figure was reported.
 */
export function billedOutputTokens(usage: EvaluationUsage): number | null {
  if (usage.responseTokens === null && usage.thoughtsTokens === null) return null;
  return (usage.responseTokens ?? 0) + (usage.thoughtsTokens ?? 0);
}
