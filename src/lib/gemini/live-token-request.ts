/**
 * What `/api/live-token` accepts, and what it is allowed to mint — as pure
 * functions, so the decision can be unit-tested.
 *
 * The route itself cannot be: it reaches Clerk, Drizzle and Google, and it
 * transitively imports `server-only`, which makes it unloadable from a node
 * test. That is the same wall Phase 2 hit with `finish/route.ts` (#17), and the
 * same answer: the policy lives here and the route stays a thin binding.
 *
 * Two decisions are encoded below and neither is obvious.
 *
 * **The topic comes from the sitting, not from the request.** Until Phase 4 the
 * browser named its own `topicSlug` and the server built the examiner's prompt
 * from it, so a candidate could sit subject A on a row that says subject B. That
 * was never a cross-user hole — the slug is validated against the catalogue, so
 * it cannot inject instructions — but it is a data-integrity one, and the whole
 * point of grading against a stored sitting is that the sitting says what was
 * asked. When the row is readable, the row wins and the requested slug is
 * discarded without comment.
 *
 * **A database that cannot answer must not end a live exam.** A token is minted
 * on every connect, INCLUDING every reconnect, so a route that refuses whenever
 * Neon hiccups would end an épreuve mid-débat over a transient fault. So an
 * unanswered ownership question degrades to the requested slug rather than
 * denying — the same call `finish/route.ts` makes on the same outcome. A denial
 * (`not-found`) is different in kind: that is a positive answer, and it refuses.
 */

import type { ExamAccess } from "@/lib/auth/exam-access";
import { EXAM_ACCESS_DENIALS } from "@/lib/auth/exam-access";
import { findTopic } from "@/lib/delf/topics";

/** The two phases that open a Live session. `preparation` is silent by design. */
export type LiveTokenPhase = "monologue" | "debate";

/**
 * The largest resumption handle we will forward to Google.
 *
 * The handle is opaque to us and arrives from the browser, so it is bounded
 * rather than trusted. Observed handles are a few hundred bytes; 4 KiB is room
 * to spare and still refuses a request trying to use us as an amplifier.
 */
export const MAX_RESUMPTION_HANDLE_LENGTH = 4096;

/** A validated token request. Every field has been checked. */
export interface LiveTokenRequest {
  phase: LiveTokenPhase;
  /** The sitting this session belongs to. Unvalidated as an id — the guard owns that. */
  examId: string;
  /** What the client asked for. Only used when no sitting can be read. */
  requestedTopicSlug: string;
  /** Present only on a reconnect. Its presence is what makes the connect a resume. */
  resumptionHandle?: string;
}

export type LiveTokenParse =
  | { ok: true; request: LiveTokenRequest }
  | { ok: false; status: number; error: string };

/**
 * Validate the request body.
 *
 * Hand-rolled rather than zod: four fields, and the error messages are
 * candidate-facing French. The important part is that every field is checked
 * before anything reaches Google — an unvalidated `phase` would select a config
 * by falling through, and an unvalidated slug would reach the prompt builder.
 */
export function parseLiveTokenRequest(body: unknown): LiveTokenParse {
  const input = (body ?? {}) as Record<string, unknown>;

  const phase = input.phase;
  if (phase !== "monologue" && phase !== "debate") {
    return { ok: false, status: 400, error: "Phase invalide" };
  }

  const examId = input.examId;
  if (typeof examId !== "string" || examId.length === 0 || examId.length > 128) {
    return { ok: false, status: 400, error: "Épreuve non précisée" };
  }

  const requestedTopicSlug = input.topicSlug;
  if (typeof requestedTopicSlug !== "string" || !findTopic(requestedTopicSlug)) {
    return { ok: false, status: 400, error: "Sujet inconnu" };
  }

  const handle = input.resumptionHandle;
  const resumptionHandle =
    typeof handle === "string" && handle.length > 0 && handle.length <= MAX_RESUMPTION_HANDLE_LENGTH
      ? handle
      : undefined;

  return { ok: true, request: { phase, examId, requestedTopicSlug, resumptionHandle } };
}

export type LiveTokenGate =
  | { decision: "deny"; status: number; error: string }
  | {
      decision: "mint";
      topicSlug: string;
      /**
       * Where the subject came from. `sitting` is the authoritative path;
       * `request` means no row could be read and the client's choice stands.
       * The route logs the difference, because a production instance minting
       * from `request` means persistence is degraded.
       */
      source: "sitting" | "request";
    };

export interface LiveTokenGateInput {
  /**
   * The ownership answer for `examId`, from `authorizeExam`. It carries the
   * sitting's subject when there is one — the route used to read that with a
   * second query and pass it in beside this, which was both a round trip and a
   * way for the two to be about different sittings (#22).
   */
  access: ExamAccess;
  /** The subject the browser asked for. Already validated by {@link parseLiveTokenRequest}. */
  requestedTopicSlug: string;
}

/**
 * Whether to mint, and for which subject.
 *
 * Ownership is delegated to `lib/auth/exam-access.ts` rather than re-decided:
 * this route is the fifth caller of that module, and a second opinion about who
 * owns a sitting is exactly the kind of drift that reopens an IDOR quietly.
 */
export function gateLiveToken({ access, requestedTopicSlug }: LiveTokenGateInput): LiveTokenGate {
  if (access.status === "denied") {
    const { status, error } = EXAM_ACCESS_DENIALS[access.reason];
    return { decision: "deny", status, error };
  }

  // Owned, and the sitting says what was asked. The authoritative path.
  if (access.status === "owned" && access.topicSlug) {
    return { decision: "mint", topicSlug: access.topicSlug, source: "sitting" };
  }

  // Either there is no sitting to read (no database, or a degraded `local-…`
  // id), the lookup failed, or the row exists but its subject could not be
  // joined. None of those is a reason to end an exam in progress, and none of
  // them lets the caller reach another candidate's sitting.
  return { decision: "mint", topicSlug: requestedTopicSlug, source: "request" };
}
