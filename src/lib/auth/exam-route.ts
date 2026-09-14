import "server-only";

import { NextResponse } from "next/server";

import { EXAM_ACCESS_DENIALS, type ExamAccess } from "./exam-access";
import { authorizeExam } from "./exam-guard";

/**
 * The first move of every handler under `api/exams/[examId]/`, made once.
 *
 * Ownership before anything else, and before the body is even looked at: exam
 * ids are sequential serials, so without the check any signed-in user could
 * finish, overwrite, walk out of or listen to a neighbouring id's épreuve. Each
 * route used to open with the same nine lines saying so, and each argued for
 * them in its own words; the argument is the same, so it lives here now, and
 * a route that forgets it cannot exist — `examRoute` is the only way to get an
 * `access` at all.
 *
 * A denial answers as `EXAM_ACCESS_DENIALS` says it should — 401, or a 404
 * that does not distinguish a missing sitting from somebody else's — and the
 * handler never runs. Everything else is the handler's: `no-sitting` is legal
 * and each route decides what to do without a row (grade it anyway, answer
 * `persisted: false`, or 404), because that answer is different per route and
 * ought to be read there.
 */

/** What Next puts in `context.params` for a route under `[examId]`. */
export interface ExamRouteParams {
  examId: string;
}

/** An access that was not refused — the only kind a handler is ever given. */
export type GrantedExamAccess = Exclude<ExamAccess, { status: "denied" }>;

export interface ExamRequest<P extends ExamRouteParams> {
  access: GrantedExamAccess;
  /** The resolved path segments, `examId` as written in the URL. */
  params: P;
  /** `Date.now()` on entry, before the params were awaited or the row read —
   *  the finish route measures its total against it. */
  receivedAt: number;
}

export type ExamRouteHandler<P extends ExamRouteParams> = (
  request: Request,
  exam: ExamRequest<P>,
) => Promise<Response>;

export function examRoute<P extends ExamRouteParams = ExamRouteParams>(
  handler: ExamRouteHandler<P>,
): (request: Request, context: { params: Promise<P> }) => Promise<Response> {
  return async (request, context) => {
    const receivedAt = Date.now();
    const params = await context.params;

    const access = await authorizeExam(params.examId);
    if (access.status === "denied") {
      const { status, error } = EXAM_ACCESS_DENIALS[access.reason];
      return NextResponse.json({ error }, { status });
    }

    return handler(request, { access, params, receivedAt });
  };
}
