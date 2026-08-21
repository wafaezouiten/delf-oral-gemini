/**
 * Telling the server which examiner the candidate chose (#99).
 *
 * A module for the same reason `abandon.ts` is one: the part with rules — what
 * counts as applied, and what the picker should do when it is not — is testable
 * against a fake `fetch`, and those rules are not obvious:
 *
 * The row is authoritative. The token route mints for the model stored on the
 * sitting whenever the sitting can be read, so a choice that did not reach the
 * row DOES NOT APPLY — a picker that kept showing it would be promising a voice
 * the token route will never mint. That is why `refused` and `unreachable` both
 * come back `applied: false`: the caller must revert to what the row still
 * says.
 *
 * The one exception is a sitting that was never persisted (`persisted: false`
 * — no database, a degraded `local-…` id). There is no row to win, the gate
 * honours the model the client sends with each mint, and the local choice is
 * the only record there is. So that outcome applies.
 */

/** What happened, in the terms the picker needs to decide what it now shows. */
export type ExaminerChoiceOutcome =
  /** The choice governs the sitting: stored on the row, or held locally where
   *  no row exists and the mint-time fallback is the mechanism. */
  | { applied: true; persisted: boolean }
  /** The server answered and deliberately wrote nothing — the sitting has left
   *  the préparation, or the id was refused. The row's model still governs. */
  | { applied: false; reason: "refused" }
  /** No answer: offline, a dropped request, or slower than the wait allows.
   *  The row was not written, so the row's model still governs. */
  | { applied: false; reason: "unreachable" };

/**
 * Bounded like the abandon call, and looser: the candidate is thirty minutes
 * from needing the answer, but a picker that hangs in « Enregistrement… »
 * past a few seconds reads as broken rather than slow.
 */
export const EXAMINER_CHOICE_TIMEOUT_MS = 6_000;

export async function requestExaminerChoice(
  examId: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = EXAMINER_CHOICE_TIMEOUT_MS,
): Promise<ExaminerChoiceOutcome> {
  try {
    const response = await fetchImpl(`/api/exams/${examId}/examiner`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) return { applied: false, reason: "refused" };

    /**
     * A 200 does not mean it was written — the route answers 200 for the
     * degraded no-row case and for a sitting already past the préparation.
     * The body tells those apart, and an unexpected shape is treated as not
     * applied rather than assumed: what rides on this answer is which voice
     * the candidate will actually hear.
     */
    const body = (await response.json().catch(() => null)) as {
      recorded?: unknown;
      persisted?: unknown;
    } | null;

    if (body?.recorded === true) return { applied: true, persisted: true };
    if (body?.persisted === false) return { applied: true, persisted: false };
    return { applied: false, reason: "refused" };
  } catch {
    // `AbortSignal.timeout` rejects here too, deliberately not told apart from
    // a network failure: both mean the row was not proven written.
    return { applied: false, reason: "unreachable" };
  }
}
