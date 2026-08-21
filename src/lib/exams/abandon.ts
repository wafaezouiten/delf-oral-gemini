/**
 * Telling the server the candidate walked out.
 *
 * A module rather than three lines inside a click handler, because the first
 * version *was* three lines inside a click handler and it did not work (#38):
 * it fired the request without awaiting it and navigated away in the same tick,
 * on the reasoning that "the router is tearing this page down". That reasoning
 * was wrong — `router.push` is a soft navigation, React stays mounted and the
 * document is never unloaded — so there was nothing to outrun, `keepalive` was
 * guarding against nothing, and the dashboard could render before the write
 * landed.
 *
 * Pulling it out here makes the part that actually has rules — what counts as
 * recorded, what is worth reporting, how long to wait — testable against a fake
 * `fetch`, which is the coverage the original had none of.
 */

/** What happened, in the terms the exit dialog needs to make a decision. */
export type AbandonOutcome =
  | { recorded: true }
  /** The server answered, and deliberately wrote nothing. Not worth retrying. */
  | { recorded: false; reason: "refused"; status: number }
  /** No answer: offline, a dropped connection, or slower than the wait allows. */
  | { recorded: false; reason: "unreachable" };

/**
 * How long the candidate waits before leaving matters more than the record.
 *
 * They have already decided to go; holding them on the exam screen while a
 * request hangs is a worse failure than losing the stamp. Four seconds is long
 * enough for any answer that is coming and short enough not to read as a freeze.
 */
export const ABANDON_TIMEOUT_MS = 4_000;

export async function requestAbandon(
  examId: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = ABANDON_TIMEOUT_MS,
): Promise<AbandonOutcome> {
  try {
    const response = await fetchImpl(`/api/exams/${examId}/abandon`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return { recorded: false, reason: "refused", status: response.status };
    }

    /**
     * A 200 does not mean it was written.
     *
     * The route answers 200 for three cases that wrote nothing — the sitting is
     * already abandoned, a correction landed first and outranks the walk-out, or
     * ownership could not be established — because none of them is something a
     * departing candidate can act on. So the body is what decides, and a
     * response whose shape is unexpected is treated as "not recorded" rather
     * than assumed successful: the whole point of this call is a claim the exit
     * dialog makes to the candidate, and it should not be made on a guess.
     */
    const body = (await response.json().catch(() => null)) as { abandoned?: unknown } | null;

    return body?.abandoned === true
      ? { recorded: true }
      : { recorded: false, reason: "refused", status: response.status };
  } catch {
    // `AbortSignal.timeout` rejects here too, and is deliberately not told apart
    // from a network failure: both mean "no answer", and the candidate is
    // offered the same two ways forward either way.
    return { recorded: false, reason: "unreachable" };
  }
}
