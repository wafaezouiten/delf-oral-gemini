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

/**
 * An expired session, which is the one failure where the route's own words are
 * actively harmful and are replaced rather than shown.
 *
 * `/api/exams/[examId]/finish` answers a lost Clerk session with 401 and
 * « Non authentifié » (`EXAM_ACCESS_DENIALS` in `lib/auth/exam-access.ts`).
 * Two reasons that cannot be passed through:
 *
 *  - It is not a sentence a candidate can act on, and the action — sign in
 *    again — is not guessable from it.
 *  - The obvious way to sign in again is to click the link in this tab, and the
 *    recording exists only in this tab. Following that instinct destroys the
 *    épreuve more thoroughly than the failure did.
 *
 * A sitting runs about fifty minutes, so a session that lapses partway through
 * is an ordinary event and not an exotic one. It is entirely recoverable, which
 * is why 401 and 403 are retryable below — telling this candidate that retrying
 * would change nothing would be false, and would be false at the moment they
 * had the most to lose.
 */
const SESSION_EXPIRED =
  "Votre session a expiré pendant l'épreuve. Reconnectez-vous dans un NOUVEL onglet — " +
  "sans fermer ni quitter celui-ci, qui contient le seul exemplaire de votre " +
  "enregistrement — puis revenez ici et réessayez.";

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
 * 4xx that explicitly invite a second attempt. **401 and 403 join them**, and
 * that is the one entry here that is not obvious: an authentication failure is
 * about the caller's session rather than the request, and a session is exactly
 * the kind of thing that comes back. See `SESSION_EXPIRED` for why getting this
 * wrong would be expensive.
 *
 * Every other 4xx is a statement about this request — too large, unreadable,
 * nothing to grade — and the same bytes will earn the same refusal, which is
 * the whole reason `#24` weighs the upload before sending rather than retrying
 * after.
 */
function statusIsRetryable(status: number): boolean {
  if (status >= 500) return true;
  return status === 401 || status === 403 || status === 408 || status === 429;
}

/** Whether this failure is the session having lapsed rather than the request. */
function isAuthFailure(status: number | null): boolean {
  return status === 401 || status === 403;
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

  // Before the server's own words are considered, because this is the case
  // where they are worse than nothing.
  if (isAuthFailure(status)) return { message: SESSION_EXPIRED, retryable: true };

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
