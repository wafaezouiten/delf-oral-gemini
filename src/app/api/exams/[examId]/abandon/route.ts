/**
 * POST /api/exams/:examId/abandon — the candidate walked out.
 *
 * Sent when the exit dialog is confirmed, after the candidate has been told in
 * so many words that leaving scores the épreuve zero. That warning is what makes
 * this row meaningful: the column records a decision, not an absence, which is
 * why abandonment is written here rather than inferred from a sitting that went
 * quiet (see the note on `oral_exams.abandoned_at`).
 *
 * Three things this deliberately is not:
 *
 *  - **Not a finish.** It never stamps `finished_at` and never advances `phase`.
 *    Both mean "this épreuve ran its course", and the whole point of the row is
 *    that it did not: `phase` keeps saying where the candidate stopped, which is
 *    what the history page prints beside the zero.
 *  - **Not a grade.** No evaluation row is written. Inventing one would claim a
 *    model read a performance that does not exist; the zero is the *absence* of
 *    a correction on an abandoned sitting, computed where the history is read.
 *  - **Not required for the candidate to leave.** It is sent with `keepalive`
 *    and not awaited — the browser is navigating away as it goes. A failure
 *    costs the record of the walk-out, not the walk-out, and the sitting is then
 *    simply one that was never finished.
 *
 * It answers 200 for every legal request, including the ones that wrote
 * nothing — a sitting already abandoned, or one whose correction landed while
 * the dialog was open. None of those is an error the departing candidate could
 * act on, and a client leaving the page cannot retry anyway.
 *
 * Since #113 this route is only ever sent from the exposé onwards: quitting
 * during the préparation is not a walk-out (nothing has been said, so there is
 * no performance to score zero) and takes the leave route instead. That
 * boundary is deliberately the client's, not this route's — the row's `phase`
 * column advances when a speaking phase finalises, so it still reads
 * `preparation` through the whole live monologue, and a phase check here would
 * refuse the most ordinary walk-out there is. See `abandonSitting`.
 */

import { NextResponse } from "next/server";

import { EXAM_ACCESS_DENIALS } from "@/lib/auth/exam-access";
import { authorizeExam } from "@/lib/auth/exam-guard";
import { neonSittingStore } from "@/lib/db/sittings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ examId: string }> }) {
  const { examId } = await context.params;

  // Ownership before anything else, exactly as the progress and finish routes
  // do it: exam ids are sequential serials, and this one writes a zero onto
  // somebody's record.
  const access = await authorizeExam(examId);
  if (access.status === "denied") {
    const { status, error } = EXAM_ACCESS_DENIALS[access.reason];
    return NextResponse.json({ error }, { status });
  }

  // No row to mark — no database, a degraded `local-…` id, or an ownership
  // question the database could not answer. The candidate still leaves.
  if (access.status !== "owned") {
    return NextResponse.json({ abandoned: false, persisted: false });
  }

  try {
    const abandoned = await neonSittingStore().abandonSitting(
      { examId: access.examId, userId: access.userId },
      new Date(),
    );
    // `false` is not an error: it means the sitting was already abandoned, or a
    // correction had landed and outranks the walk-out. 200 either way, so a
    // client cannot be taught to retry on it.
    return NextResponse.json({ abandoned, persisted: true });
  } catch (error) {
    // Logged rather than surfaced. The candidate is already leaving, and the
    // cost is the record of the walk-out rather than anything they can fix.
    console.error("[abandon] could not mark exam", examId, "as abandoned", error);
    return NextResponse.json({ error: "Abandon non enregistré" }, { status: 503 });
  }
}
