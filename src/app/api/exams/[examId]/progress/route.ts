/**
 * POST /api/exams/:examId/progress — record a speaking phase that has just ended.
 *
 * Called by the browser at a phase boundary, not at the end. Until Phase 8 the
 * server heard from a sitting exactly twice — once to create it, once to grade
 * it — which meant a crash, a refresh or a closed tab between those two points
 * destroyed the entire record of an épreuve that had actually happened, and left
 * behind a row still claiming to be in `preparation`.
 *
 * So each phase reports itself as it finalises: its turns are appended to the
 * stored transcript and the sitting moves on. Three things this deliberately is
 * not:
 *
 *  - **Not a way to finish an exam.** It never stamps `finished_at`, which is
 *    the finish route's alone, so nothing that arrives here can make a sitting
 *    read as a completed exam. A sitting whose progress was recorded and which
 *    was never submitted stays `in-progress`, which is the truth about it.
 *  - **Not a grade input.** No duration is accepted. Speaking time is measured
 *    from the uploaded audio at finish, and a number taken on trust here would
 *    be the browser's clock wearing the column that decides the penalty.
 *  - **Not required.** It is fire-and-forget from the client (see
 *    `use-exam-controller.ts`): a failure costs the insurance, not the épreuve,
 *    and the finish request re-sends the whole transcript regardless.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { examRoute } from "@/lib/auth/exam-route";
import { neonSittingStore } from "@/lib/db/sittings";
import { progressPayloadSchema } from "@/lib/exams/progress-payload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = examRoute(async (request, { access, params }) => {
  const parsed = progressPayloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "payload invalide", details: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }

  // No row to append to — no database, a degraded `local-…` id, or an ownership
  // question the database could not answer. The request is legal and there is
  // nothing to do about it; the exam in the tab carries on.
  if (access.status !== "owned") {
    return NextResponse.json({ recorded: false, persisted: false });
  }

  const report = parsed.data;

  try {
    const recorded = await neonSittingStore().appendFinalisedPhase(
      { examId: access.examId, userId: access.userId },
      {
        phase: report.phase,
        entries: report.entries,
        startedAt: new Date(report.startedAt),
        endedAt: new Date(report.endedAt),
      },
    );

    // `false` is not an error. It means the sitting had already moved past this
    // phase — a retried request, a double-fired transition — and the whole point
    // of the guard is that the second one writes nothing rather than appending
    // the monologue twice. 200 either way, so a client retrying on a 5xx cannot
    // be taught to retry on this.
    return NextResponse.json({ recorded, persisted: true });
  } catch (error) {
    // Logged rather than surfaced: nothing the candidate can do about it, and
    // failing the request would only make a fire-and-forget call noisy.
    console.error(
      "[progress] could not record phase",
      report.phase,
      "of exam",
      params.examId,
      error,
    );
    return NextResponse.json({ error: "Progression non enregistrée" }, { status: 503 });
  }
});
