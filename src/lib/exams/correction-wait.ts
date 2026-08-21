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

/** The finish route's own ceiling (`maxDuration` 300 s) plus slack for the
 *  answer to travel: past this, the grading request is dead by definition. */
export const CORRECTION_WAIT_LIMIT_MS = 330_000;

export interface CorrectionWaitOptions {
  pollMs?: number;
  limitMs?: number;
  /** Injectable so the tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
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
): Promise<"corrected" | "timed-out"> {
  const pollMs = options.pollMs ?? CORRECTION_POLL_MS;
  const limitMs = options.limitMs ?? CORRECTION_WAIT_LIMIT_MS;
  const sleep = options.sleep ?? wait;

  for (let waited = 0; waited < limitMs; waited += pollMs) {
    await sleep(pollMs);
    const corrected = await isCorrected().catch(() => false);
    if (corrected) return "corrected";
  }
  return "timed-out";
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
