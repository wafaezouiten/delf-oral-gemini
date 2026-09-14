/**
 * GET /api/exams/:examId/status — whether this sitting's correction exists yet.
 *
 * The poll behind « Épreuve terminée » (#86): the finish route answers 202 as
 * soon as the sitting is safe and grades behind the response, so the finished
 * screen asks this route, every few seconds, whether the correction has landed
 * — and navigates to the results the moment it has. One boolean, nothing else:
 * the results page owns rendering the correction, and a status route that
 * returned half of one would be a second reader to keep honest.
 *
 * Authenticated and owner-scoped exactly like every other sitting route — the
 * boolean is about somebody's exam, and exam ids are sequential serials.
 * `no-sitting` answers `corrected: false` rather than an error: the request is
 * legal, there is just no row to ask — though no caller should get here, since
 * the finish only answers 202 for sittings it persisted.
 */

import { NextResponse } from "next/server";

import { examRoute } from "@/lib/auth/exam-route";
import { neonSittingStore } from "@/lib/db/sittings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = examRoute(async (_request, { access }) => {
  if (access.status !== "owned") {
    return NextResponse.json({ corrected: false });
  }

  // A read that fails is "not yet", not an error the poll should abort on: the
  // poll's whole contract is that it keeps asking until its own time runs out.
  const correction = await neonSittingStore()
    .findCorrection({ examId: access.examId, userId: access.userId })
    .catch(() => null);

  return NextResponse.json({ corrected: correction !== null });
});
