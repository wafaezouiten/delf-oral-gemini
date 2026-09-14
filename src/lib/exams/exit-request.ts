/**
 * The one transport under the two ways of leaving an épreuve early.
 *
 * `abandon.ts` and `preparation-exit.ts` back different promises — a zero the
 * dialog announced, and the absence of one — and each says so in its own words.
 * What they do not differ on is the mechanics: one POST, one bounded wait, a
 * body flag that outranks the status, and the same two ways of not being
 * recorded. Written once here so the two modules can stay about their rules.
 */

/** What happened, in the terms the caller needs to make a decision. */
export type ExitOutcome =
  | { recorded: true }
  /** The server answered, and deliberately wrote nothing. */
  | { recorded: false; reason: "refused"; status: number }
  /** No answer: offline, a dropped connection, or slower than the wait allows. */
  | { recorded: false; reason: "unreachable" };

/** The body flag each route answers with. Closed, so a misspelt one cannot compile. */
export type ExitFlag = "abandoned" | "archived";

/**
 * POST `path`, and read the answer through `flag`.
 *
 * A 200 does not mean it was written. Both routes answer 200 for cases that
 * wrote nothing — a sitting already stamped, a correction that landed first,
 * ownership the database could not establish — because none of them is
 * something a departing candidate can act on. So the body is what decides, and
 * a response whose shape is unexpected is treated as "not recorded" rather than
 * assumed successful: whatever the caller tells the candidate or the log, it
 * should not be said on a guess.
 */
export async function requestExitStamp(
  path: string,
  flag: ExitFlag,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ExitOutcome> {
  try {
    const response = await fetchImpl(path, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return { recorded: false, reason: "refused", status: response.status };
    }

    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

    return body?.[flag] === true
      ? { recorded: true }
      : { recorded: false, reason: "refused", status: response.status };
  } catch {
    // `AbortSignal.timeout` rejects here too, and is deliberately not told apart
    // from a network failure: both mean "no answer", and every caller does the
    // same thing either way.
    return { recorded: false, reason: "unreachable" };
  }
}
