/**
 * Asking the server to start the candidate's record over (#69).
 *
 * A module rather than a `fetch` in a click handler, for the reason `abandon.ts`
 * gives: the part with rules — what counts as done, what the button may claim
 * afterwards — is worth testing against a fake `fetch`, and a handler is where
 * that coverage goes to die.
 *
 * **No timeout, deliberately, and this is the one place it differs from
 * `requestAbandon`.** That call races a candidate who is already leaving, so
 * giving up after four seconds costs a stamp nobody is waiting on. This one is
 * awaited by someone watching a dialog, and abandoning it early would report a
 * failure for a write that then lands — sending them to a tableau de bord that
 * has emptied itself under a message saying it did not. A slow answer is a
 * spinner; a wrong answer is a lie about their record.
 */

/** What happened, in the terms the button needs to say something true. */
export type ResetOutcome =
  /** Archived, and how many sittings moved. `0` is a success: nothing was left. */
  | { reset: true; archived: number }
  /** The server answered and refused. Signed out, or the write failed. */
  | { reset: false; reason: "refused"; status: number }
  /** No answer at all: offline, or a dropped connection. */
  | { reset: false; reason: "unreachable" };

export async function requestRecordReset(
  fetchImpl: typeof fetch = fetch,
): Promise<ResetOutcome> {
  try {
    const response = await fetchImpl("/api/account/reset", { method: "POST" });

    if (!response.ok) {
      return { reset: false, reason: "refused", status: response.status };
    }

    /**
     * The count decides, not the status.
     *
     * A 200 whose body is not the shape this expects means something other than
     * the reset route answered — a proxy, an error page, a redirect that landed
     * on HTML. Treating that as done would empty the screen on the strength of a
     * guess, and the candidate would have no way to tell that nothing moved.
     */
    const body = (await response.json().catch(() => null)) as { archived?: unknown } | null;

    return typeof body?.archived === "number"
      ? { reset: true, archived: body.archived }
      : { reset: false, reason: "refused", status: response.status };
  } catch {
    return { reset: false, reason: "unreachable" };
  }
}
