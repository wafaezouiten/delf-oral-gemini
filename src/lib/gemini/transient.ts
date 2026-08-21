/**
 * Surviving a corrector that is momentarily busy.
 *
 * The evaluator throws rather than inventing a score, and the finish route turns
 * that throw into « L'évaluation a échoué. Réessayez dans un instant. » with a
 * button. That is the right behaviour for a correction that cannot be produced —
 * a fabricated grade is worse than a visible failure — and the wrong behaviour
 * for one that could have been produced two seconds later.
 *
 * The failure that prompted this, reproduced against the real service:
 *
 *     ApiError: {"error":{"code":503,"message":"This model is currently
 *     experiencing high demand. Spikes in demand are usually temporary.
 *     Please try again later.","status":"UNAVAILABLE"}}
 *
 * The same request succeeded unchanged on the next attempt. Between those two
 * attempts sat a candidate who had just finished a twenty-minute exam, being
 * asked to press a button — and, if they closed the tab instead, a sitting
 * marked finished with no correction attached.
 *
 * So: retry the transient ones, here, and let everything else through
 * untouched. This module knows nothing about grading; it is the *policy* of
 * which failures are worth a second attempt, kept apart from `evaluate.ts` so
 * `node --test` can reach it without a network or an API key.
 */

/**
 * HTTP statuses worth trying again, and nothing else.
 *
 * The distinction that matters is not "did it fail" but "would the identical
 * request plausibly succeed":
 *
 *  - **429 RESOURCE_EXHAUSTED** — rate limited. The free tier produces these in
 *    bursts, and the next window is usually seconds away.
 *  - **500 INTERNAL** / **503 UNAVAILABLE** — the model is busy or something
 *    broke on the far side. The observed case, and the service's own message
 *    says the spike is temporary.
 *  - **504** — a gateway timeout, which the request may simply outrun.
 *
 * Deliberately absent: **400** (a malformed request stays malformed), **403**
 * (a key that is not allowed does not become allowed), and **404** — which is
 * how a retired model id presents, and `EVAL_MODEL`'s own comment records two
 * of those. Retrying a permanent failure does not fix it; it delays the error
 * by the whole backoff and burns the route's budget on the way.
 */
const RETRYABLE_STATUS = new Set([429, 500, 503, 504]);

/**
 * Read the HTTP status off whatever the SDK threw.
 *
 * `ApiError` carries `status` as a number, but this is deliberately
 * duck-typed rather than an `instanceof` check: the class is not exported from
 * `@google/genai`'s public entry point, and a version bump that reshapes it
 * would otherwise turn every transient failure into a permanent one silently.
 * A thrown value with no numeric status is simply not retryable.
 */
export function transientStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/** Whether this failure is worth attempting again unchanged. */
export function isTransient(error: unknown): boolean {
  const status = transientStatus(error);
  return status !== null && RETRYABLE_STATUS.has(status);
}

export interface RetryOptions {
  /**
   * Total attempts, not retries. 3 by default: two extra chances at a busy
   * model, which is what the observed failure needed.
   *
   * Bounded by the route's own ceiling rather than by optimism. `maxDuration`
   * is 300 s and an audio correction is the slow case, so the backoff below has
   * to stay small enough that three attempts plus two waits still fit inside a
   * budget that one attempt can already spend most of.
   */
  attempts?: number;
  /** First wait, doubling each time: 2 s, then 4 s. */
  baseDelayMs?: number;
  /** Injectable so the tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each wait, so the caller can log what it is riding out. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `task`, retrying only failures {@link isTransient} recognises.
 *
 * The last attempt's error is rethrown unchanged rather than wrapped: the route
 * logs it, and « evaluation failed after 3 attempts: 503 » is a worse thing to
 * find in a log than the API's own error with its own message and stack.
 *
 * The Files API uploads that precede the correction ride this same policy, but
 * on a shorter leash — two attempts, not three (#73). Re-uploading is the
 * expensive half of the request and an upload that failed has left nothing
 * behind to reuse, so it gets exactly one second chance; the budget argument
 * lives at the call site in `evaluate.ts`.
 */
export async function withTransientRetry<T>(
  task: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2000;
  const sleep = options.sleep ?? wait;

  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      // The last attempt does not get a wait it cannot use, and a permanent
      // failure does not get one at all.
      if (attempt >= attempts || !isTransient(error)) throw error;

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}
