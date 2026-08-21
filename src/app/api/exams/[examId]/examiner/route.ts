/**
 * POST /api/exams/:examId/examiner — record which model plays the examiner (#99).
 *
 * Called from the préparation screen's picker, and only from there: the choice
 * is a pre-flight concern, and `chooseExaminerModel`'s WHERE clause makes it one
 * — a sitting past `preparation` accepts no write, so nothing can rename the
 * examiner once anyone has spoken.
 *
 * The row is what the token route reads on every mint, including every
 * reconnect. That is the whole reason this is a column rather than component
 * state: a choice held only in the tab dies with the tab, and a reconnect that
 * cannot re-read it would silently switch examiners mid-débat.
 *
 * The id is checked against the same allow-list the token route enforces, so
 * the two cannot disagree about what is choosable — and an id outside it is a
 * 400 here, at the picker, rather than a socket killed with 1011 and no
 * diagnostic twenty minutes later.
 */

import { NextResponse } from "next/server";

import { EXAM_ACCESS_DENIALS } from "@/lib/auth/exam-access";
import { authorizeExam } from "@/lib/auth/exam-guard";
import { chooseExaminerModel } from "@/lib/db/sittings";
import { isSelectableLiveModel } from "@/lib/gemini/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ examId: string }> }) {
  const { examId } = await context.params;

  // Ownership before anything else, exactly as the finish and progress routes
  // do it: exam ids are sequential serials, and this writes onto the row.
  const access = await authorizeExam(examId);
  if (access.status === "denied") {
    const { status, error } = EXAM_ACCESS_DENIALS[access.reason];
    return NextResponse.json({ error }, { status });
  }

  const body = (await request.json().catch(() => null)) as { model?: unknown } | null;
  const model = body?.model;
  if (typeof model !== "string" || !isSelectableLiveModel(model)) {
    return NextResponse.json({ error: "Modèle inconnu" }, { status: 400 });
  }

  // No row to write — no database, or a degraded `local-…` id. The choice
  // still works: the client forwards it on every token mint, and the gate
  // honours the request exactly when no sitting can be read.
  if (access.status !== "owned") {
    return NextResponse.json({ recorded: false, persisted: false });
  }

  try {
    const recorded = await chooseExaminerModel({ examId: access.examId, userId: access.userId }, model);

    // `false` is not an error: the sitting has already left the préparation —
    // a stale tab, a replayed request — and writing nothing is the point of
    // the guard. 200 either way, so a client cannot be taught to retry it.
    return NextResponse.json({ recorded, persisted: true });
  } catch (error) {
    console.error("[examiner] could not record the model choice for exam", examId, error);
    return NextResponse.json({ error: "Choix non enregistré" }, { status: 503 });
  }
}
