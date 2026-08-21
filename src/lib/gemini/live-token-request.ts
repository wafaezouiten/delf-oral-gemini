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
import { LIVE_MODEL, isSelectableLiveModel } from "@/lib/gemini/constants";

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
  /**
   * The examiner the client asked for (#99). Optional — an absent model means
   * the default — and, like the slug, only used when no sitting can be read:
   * the stored choice outranks it whenever a row answers.
   */
  requestedModel?: string;
  /** Present only on a reconnect. Its presence is what makes the connect a resume. */
  resumptionHandle?: string;
}

export type LiveTokenParse =
  { ok: true; request: LiveTokenRequest } | { ok: false; status: number; error: string };

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

  // The one part of the pinned config a client may now have an opinion on, so
  // it is checked against the verified allow-list rather than merely
  // type-checked (#99). Refused loudly rather than coerced: an unknown id that
  // reached the constraint would not fail here — it would open a socket and
  // kill it with 1011 and no diagnostic, mid-épreuve.
  const model = input.model;
  if (model !== undefined && (typeof model !== "string" || !isSelectableLiveModel(model))) {
    return { ok: false, status: 400, error: "Modèle inconnu" };
  }

  const handle = input.resumptionHandle;
  const resumptionHandle =
    typeof handle === "string" && handle.length > 0 && handle.length <= MAX_RESUMPTION_HANDLE_LENGTH
      ? handle
      : undefined;

  return {
    ok: true,
    request: { phase, examId, requestedTopicSlug, requestedModel: model, resumptionHandle },
  };
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
      /** The examiner to pin into the token (#99). Always allow-listed. */
      model: string;
      /**
       * Where the examiner came from. `sitting` and `request` mean what they
       * mean for the subject. `default` is the untouched path — no row and no
       * request — AND the one fault worth a log line: a stored model that has
       * since left the allow-list is replaced by the default rather than
       * minted, because a constraint naming a retired id opens a socket that
       * dies with 1011 mid-épreuve.
       */
      modelSource: "sitting" | "request" | "default";
    };

export interface LiveTokenGateInput {
  /**
   * The ownership answer for `examId`, from `authorizeExam`. It carries the
   * sitting's subject when there is one — the route used to read that with a
   * second query and pass it in beside this, which was both a round trip and a
   * way for the two to be about different sittings (#22). Since #99 it carries
   * the sitting's examiner on the same read, for the same reason.
   */
  access: ExamAccess;
  /** The subject the browser asked for. Already validated by {@link parseLiveTokenRequest}. */
  requestedTopicSlug: string;
  /** The examiner the browser asked for, if any. Already allow-listed. */
  requestedModel?: string;
}

/**
 * Whether to mint, and for which subject.
 *
 * Ownership is delegated to `lib/auth/exam-access.ts` rather than re-decided:
 * this route is the fifth caller of that module, and a second opinion about who
 * owns a sitting is exactly the kind of drift that reopens an IDOR quietly.
 */
export function gateLiveToken({
  access,
  requestedTopicSlug,
  requestedModel,
}: LiveTokenGateInput): LiveTokenGate {
  if (access.status === "denied") {
    const { status, error } = EXAM_ACCESS_DENIALS[access.reason];
    return { decision: "deny", status, error };
  }

  /**
   * The examiner, decided by the same rule as the subject: the row wins
   * whenever there is one to read (#99). Two consequences are the point:
   *
   *  - a null column on an owned row means "nothing was ever chosen", so the
   *    default runs — NOT the requested model, because the row is the record
   *    of what the candidate heard, and honouring a request the row does not
   *    carry would make that record a lie;
   *  - with no row to read, the request stands, which is what keeps a
   *    reconnect on the SAME examiner through a database blip — the client
   *    re-sends its choice on every mint, so a mid-débat `lookup-failed` does
   *    not switch voices.
   *
   * A stored model that has since left the allow-list falls back to the
   * default: an épreuve on the wrong examiner beats one that dies at the
   * handshake with no diagnostic. The route logs it off `modelSource`.
   */
  const examinerModel = (): Pick<
    Extract<LiveTokenGate, { decision: "mint" }>,
    "model" | "modelSource"
  > => {
    if (access.status === "owned") {
      return access.examinerModel && isSelectableLiveModel(access.examinerModel)
        ? { model: access.examinerModel, modelSource: "sitting" }
        : { model: LIVE_MODEL, modelSource: "default" };
    }
    return requestedModel
      ? { model: requestedModel, modelSource: "request" }
      : { model: LIVE_MODEL, modelSource: "default" };
  };

  // Owned, and the sitting says what was asked. The authoritative path.
  if (access.status === "owned" && access.topicSlug) {
    return {
      decision: "mint",
      topicSlug: access.topicSlug,
      source: "sitting",
      ...examinerModel(),
    };
  }

  // Either there is no sitting to read (no database, or a degraded `local-…`
  // id), the lookup failed, or the row exists but its subject could not be
  // joined. None of those is a reason to end an exam in progress, and none of
  // them lets the caller reach another candidate's sitting.
  return { decision: "mint", topicSlug: requestedTopicSlug, source: "request", ...examinerModel() };
}
