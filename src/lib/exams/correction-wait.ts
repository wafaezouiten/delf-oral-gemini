/**
 * Waiting for a correction that is being attached behind an answered finish
 * (#86).
 *
 * The finish route says 202 the moment the sitting is safe, and the grading
 * runs after its response. What « Épreuve terminée » does next is this
 * module's: ask the status route every few seconds whether the correction has
 * landed, until it has or until waiting longer would be dishonest.
 *
 * The limit is not a guess. The route's whole invocation — response plus the
 * `after()` grading — lives inside `maxDuration = 300` seconds, so a
 * correction that has not landed by then is not still coming from THAT
 * request. The wait runs to that budget plus slack, and then stops claiming
 * anything is in progress: the screen offers « Réessayer l'envoi », which
 * re-runs the whole finish — and whose first act is a duplicate check, so a
 * correction that did land late is returned instantly, ungraded twice.
 *
 * Kept pure and out of the component for the reason `finish-progress.ts` is:
 * the loop is the part with edges — a poll that errors must read as "not yet"
 * rather than abort a wait the audio has already paid for — and `node --test`
 * should hold it to that without a network or a clock.
 */

/** How often to ask. Threes seconds is invisible next to a thirty-second
 *  grading, and twenty-odd requests over a minute is nothing. */
export const CORRECTION_POLL_MS = 3_000;

/**
 * The finish route's own ceiling (`maxDuration` 300 s) plus slack for the
 * answer to travel: past this, the grading request is dead by definition.
 *
 * "By definition" is the PLATFORM's definition — this app deploys on Vercel,
 * which enforces `maxDuration` by killing the invocation. A self-hosted
 * `next start` enforces nothing, so there a slow grading could still be
 * attaching when this limit gives up and the candidate retries — two
 * concurrent paid model calls on one sitting, and the documented
 * instant-race window on the correction insert. Whoever ports this off
 * Vercel must re-derive this limit from whatever bounds their invocations,
 * not inherit the number.
 */
export const CORRECTION_WAIT_LIMIT_MS = 330_000;

export interface CorrectionWaitOptions {
  pollMs?: number;
  limitMs?: number;
  /** Injectable so the tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Answering true ends the wait with `"cancelled"` — the screen that started
   * it is gone. Checked before every poll, so a candidate who navigated away
   * mid-wait does not leave a loop hammering the status route for five more
   * minutes on behalf of nobody.
   */
  cancelled?: () => boolean;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the correction exists, or until the limit says it never will.
 *
 * A poll that THROWS is counted as "not yet", deliberately: the candidate may
 * be on hotel wifi that blinks, and a wait whose audio is already safe must
 * not be aborted by one failed GET. The limit bounds the pathological case
 * where every poll fails.
 */
export async function waitForCorrection(
  isCorrected: () => Promise<boolean>,
  options: CorrectionWaitOptions = {},
): Promise<"corrected" | "timed-out" | "cancelled"> {
  const pollMs = options.pollMs ?? CORRECTION_POLL_MS;
  const limitMs = options.limitMs ?? CORRECTION_WAIT_LIMIT_MS;
  const sleep = options.sleep ?? wait;

  for (let waited = 0; waited < limitMs; waited += pollMs) {
    await sleep(pollMs);
    // After the sleep as well as implicitly before the next one: the common
    // cancellation arrives mid-sleep, and a dead screen's wait must neither
    // fire one more request nor report anything to the nobody watching it.
    if (options.cancelled?.()) return "cancelled";
    const corrected = await isCorrected().catch(() => false);
    if (corrected) return "corrected";
  }
  return options.cancelled?.() ? "cancelled" : "timed-out";
}

/** One status poll: the route's boolean, or a throw the loop reads as "not
 *  yet". Injectable transport for the same reason the sleeper is. */
export async function fetchCorrectionStatus(
  examId: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetcher(`/api/exams/${examId}/status`, { cache: "no-store" });
  if (!response.ok) throw new Error(`the status route answered ${response.status}`);
  const body = (await response.json()) as { corrected?: unknown };
  return body.corrected === true;
}
