/**
 * What to tell a candidate whose finished épreuve would not send, and whether
 * offering them a retry is honest.
 *
 * The finish route already writes for candidates: « L'enregistrement du débat est
 * trop volumineux. », « La transcription ne contient presque aucune parole du
 * candidat. » Those sentences are better than anything a component could invent,
 * so they are shown as they arrive. What the route does not say is whether
 * trying again could possibly work — and a retry button under a 422 is a lie
 * that costs the candidate several more minutes of hoping.
 *
 * So the status decides the button and the body decides the words. Kept pure and
 * out of the component because the mapping is the part with edges: a network
 * failure has no status at all, a platform 502 arrives as HTML with no `error`
 * field, and both have to come out as something a candidate can read.
 */

/** The generic message, for a failure that arrived without words of its own. */
const FALLBACK =
  "Votre prestation n'a pas pu être envoyée pour correction. " +
  "Elle est toujours dans cet onglet : ne le fermez pas, et réessayez.";

/** A failure that will answer the same way however many times it is re-sent. */
const TERMINAL =
  "Votre prestation ne peut pas être corrigée. Réessayer donnerait le même résultat.";

export interface FinishFailure {
  /** Candidate-facing French. Never an exception message or a status code. */
  message: string;
  /** Whether to offer « Réessayer l'envoi ». */
  retryable: boolean;
}

/**
 * Statuses that mean "not now" rather than "not ever".
 *
 * Everything at 5xx is the server having a bad moment; 408 and 429 are the two
 * 4xx that explicitly invite a second attempt. Every other 4xx is a statement
 * about this request — too large, unreadable, nothing to grade — and the same
 * bytes will earn the same refusal, which is the whole reason `#24` weighs the
 * upload before sending rather than retrying after.
 */
function statusIsRetryable(status: number): boolean {
  if (status >= 500) return true;
  return status === 408 || status === 429;
}

/**
 * @param status The HTTP status, or null when the request never got an answer —
 *   an offline candidate, a dropped connection, a `fetch` that threw.
 * @param serverMessage The route's own `error` field, if it sent one.
 */
export function describeFinishFailure(
  status: number | null,
  serverMessage: unknown,
): FinishFailure {
  // A network failure is the most retryable thing there is: nothing was refused,
  // the request simply never arrived.
  const retryable = status === null ? true : statusIsRetryable(status);

  const fromServer =
    typeof serverMessage === "string" && serverMessage.trim().length > 0
      ? serverMessage.trim()
      : null;

  if (fromServer) {
    // The route's sentence, plus the one thing it cannot know: whether this is
    // worth another go. Not appended when it is retryable — the retry button is
    // right there and says so better than a clause would.
    return { message: retryable ? fromServer : `${fromServer} ${TERMINAL}`, retryable };
  }

  return { message: retryable ? FALLBACK : TERMINAL, retryable };
}
