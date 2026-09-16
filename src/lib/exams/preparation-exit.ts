/**
 * Telling the server the candidate left before saying anything (#113, #199).
 *
 * Named for the préparation because that is the only phase it could reach when
 * it was written, and still named for it because that is the phase the row's own
 * guard names — see the route. What it actually covers since #199 is the whole
 * window before the first « Enregistrer », the armed monologue included; the two
 * agree because `phase` only leaves `'preparation'` when a speaking part
 * finalises, which is strictly after the click this stops at.
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
import { type ExitOutcome, requestExitStamp } from "./exit-request";

/** What happened — for the log line, since the candidate leaves either way. */
export type PreparationExitOutcome = ExitOutcome;

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
  /**
   * The route answers 200 for a sitting already left, already walked out of,
   * past the préparation, or never persisted at all. `archived` in the body is
   * what decides, so the log line cannot claim a write on a guess.
   */
  return requestExitStamp(`/api/exams/${examId}/leave`, "archived", fetchImpl, timeoutMs);
}
