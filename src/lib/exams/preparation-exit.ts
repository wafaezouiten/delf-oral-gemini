/**
 * Telling the server the candidate left during the préparation (#113).
 *
 * A module for the reason `abandon.ts` is one — the rules are testable against a
 * fake `fetch` — but the rules themselves are lighter, and the difference is the
 * point. The abandon call backs a promise: the dialog said the épreuve would
 * count as a zero, so a failure to record it must be surfaced and retryable.
 * This call backs the *absence* of a promise: the préparation's dialog says the
 * épreuve will not count, and an exit that never reaches the server produces
 * exactly that — an unfinished sitting no screen shows. So the caller waits for
 * the outcome (the click's work should be done before the navigation, the #38
 * lesson), logs a failure, and leaves on any answer. There is no retry to offer
 * because nothing the candidate cares about went unwritten.
 */

import { ABANDON_TIMEOUT_MS } from "./abandon";

/** What happened — for the log line, since the candidate leaves either way. */
export type PreparationExitOutcome =
  | { recorded: true }
  /** The server answered, and deliberately wrote nothing. */
  | { recorded: false; reason: "refused"; status: number }
  /** No answer: offline, a dropped connection, or slower than the wait allows. */
  | { recorded: false; reason: "unreachable" };

/**
 * The abandon call's wait, borrowed with its rationale intact: the candidate has
 * already decided to go, and holding them on the exam screen while a request
 * hangs is a worse failure than losing the stamp — more so here, where the stamp
 * is bookkeeping rather than a promised zero.
 */
export const PREPARATION_EXIT_TIMEOUT_MS = ABANDON_TIMEOUT_MS;

export async function requestPreparationExit(
  examId: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PREPARATION_EXIT_TIMEOUT_MS,
): Promise<PreparationExitOutcome> {
  try {
    const response = await fetchImpl(`/api/exams/${examId}/leave`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return { recorded: false, reason: "refused", status: response.status };
    }

    /**
     * A 200 does not mean it was written — the route answers 200 for a sitting
     * already left, already walked out of, past the préparation, or never
     * persisted at all. The body decides, and an unexpected shape reads as "not
     * recorded" so the log line cannot claim a write on a guess.
     */
    const body = (await response.json().catch(() => null)) as
      | { archived?: unknown }
      | null;

    return body?.archived === true
      ? { recorded: true }
      : { recorded: false, reason: "refused", status: response.status };
  } catch {
    // `AbortSignal.timeout` rejects here too, and is deliberately not told
    // apart from a network failure: both mean "no answer", and the caller does
    // the same thing either way — logs it and leaves.
    return { recorded: false, reason: "unreachable" };
  }
}
