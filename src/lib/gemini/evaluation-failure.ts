/**
 * Naming which part of the grading pipeline failed (#73).
 *
 * The finish route's catch-all turns every grading failure into one French
 * sentence and a 502, which is the right thing to show a candidate and a
 * useless thing to put in a bug report: five different failures arrive there
 * identically, and the one fact that would tell them apart — which throw site
 * fired — used to go to `console.error` and nowhere else. So each throw site in
 * `evaluate.ts` now tags what it throws, and the route reads the tag back into
 * a machine-readable `reason` beside the sentence.
 *
 * The vocabulary, in pipeline order:
 *
 *  - `upload`   — a recording could not be made available to the corrector: the
 *                 Files API refused it, or the file never became `ACTIVE`
 *                 (see `file-activation.ts`).
 *  - `model`    — the corrector itself failed, after `transient.ts` had already
 *                 ridden out what was worth riding out.
 *  - `empty`    — the corrector answered with no text at all.
 *  - `contract` — the corrector answered, and the reply was not a complete
 *                 correction (`parseEvaluationResponse`, #9).
 *  - `store`    — persistence. Listed for completeness of the taxonomy, but note
 *                 it can never reach the route's catch today: `correctSitting`
 *                 converts every store failure into a `graded-not-stored`
 *                 outcome, which answers 200 with the grade and logs the reason
 *                 instead. It exists so the log line for that path can use the
 *                 same word this module defines.
 *
 * Kept apart from `evaluate.ts` for the same reason `transient.ts` is: this is
 * the vocabulary, not the grading, and `node --test` must be able to reach it —
 * the route's catch is exactly the branch the issue found uncovered.
 */

export const EVALUATION_FAILURE_REASONS = [
  "upload",
  "model",
  "empty",
  "contract",
  "store",
] as const;

export type EvaluationFailureReason = (typeof EVALUATION_FAILURE_REASONS)[number];

/**
 * A grading failure that knows which part of the pipeline it is.
 *
 * Always constructed *around* the original error, never instead of it: the
 * `cause` is what carries the API's own message and stack to the log, and
 * « evaluation failed (reason=upload) » with nothing underneath would be a
 * worse thing to find there than what the route logs today.
 */
export class EvaluationFailure extends Error {
  readonly reason: EvaluationFailureReason;

  constructor(reason: EvaluationFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EvaluationFailure";
    this.reason = reason;
  }
}

/**
 * Read the reason off whatever was thrown, or admit there is none.
 *
 * Duck-typed rather than `instanceof`, for the reason `transientStatus` is: the
 * route and the evaluator can be bundled into different module instances, and a
 * classification that silently stopped matching after a build change would turn
 * every tagged failure back into the undifferentiated one this exists to
 * retire. A `reason` that is not in the vocabulary is treated as absent — some
 * other library's error carrying a `reason` field must not masquerade as ours.
 */
export function evaluationFailureReason(error: unknown): EvaluationFailureReason | null {
  if (typeof error !== "object" || error === null) return null;
  const reason = (error as { reason?: unknown }).reason;
  return typeof reason === "string" &&
    (EVALUATION_FAILURE_REASONS as readonly string[]).includes(reason)
    ? (reason as EvaluationFailureReason)
    : null;
}
