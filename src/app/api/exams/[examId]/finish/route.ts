/**
 * POST /api/exams/:examId/finish — grade a completed exam.
 *
 * Takes multipart form data (the transcript as JSON, the candidate's WAV as a
 * file) because a 20-minute recording is tens of megabytes and has no business
 * being base64'd into a JSON body.
 *
 * Grading runs here, on the server, well after the Live session has closed. The
 * evaluation is returned in the response as well as persisted, so the results
 * page can render even when no database is configured.
 */

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { EXAM_ACCESS_DENIALS } from "@/lib/auth/exam-access";
import { authorizeExam } from "@/lib/auth/exam-guard";
import { evaluations, getDb, oralExamPhases, oralExams } from "@/lib/db";
// The floor is the one rule the two rubric copies on `develop` agree on, so
// reading it from the ported module settles nothing that Phase 2 shouldn't.
import { meetsCompetencyFloor } from "@/lib/delf/orale-rubric";
import { findTopic } from "@/lib/delf/topics";
import { candidateWordCount, type TranscriptEntry } from "@/lib/delf/transcript";
import { evaluateExam, type EvaluationMode } from "@/lib/gemini/evaluate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A full audio evaluation is slow; the default serverless budget is not enough. */
export const maxDuration = 300;

/**
 * The client's payload, validated rather than asserted.
 *
 * The seconds fields end up in `oral_exam_phases.spoken_seconds`, a NOT NULL
 * integer with a `>= 0` constraint, so a missing field used to travel as far as
 * `Math.round(undefined)` → NaN and fail at the INSERT — after a paid model call
 * had already run, and inside a catch that only logs. Failing here costs
 * nothing and says what was wrong.
 *
 * `z.number()` rejects NaN and Infinity on its own in Zod 4; the explicit checks
 * below are the domain's, not the format's.
 */
const transcriptEntrySchema = z.object({
  phase: z.enum(["monologue", "debate"]),
  speaker: z.enum(["candidate", "examiner"]),
  timestamp: z.number(),
  text: z.string(),
}) satisfies z.ZodType<TranscriptEntry>;

const finishPayloadSchema = z.object({
  topicSlug: z.string().min(1),
  transcript: z.array(transcriptEntrySchema),
  monologueSeconds: z.number().nonnegative(),
  debateSeconds: z.number().nonnegative(),
  reconnectCount: z.number().int().nonnegative(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ examId: string }> },
) {
  const { examId } = await context.params;

  /**
   * Authentication and ownership, before anything else this route does.
   *
   * Exam ids are sequential serials, so without the second check any signed-in
   * user could finish — and overwrite the transcript of — a neighbouring id's
   * exam. It runs first rather than after validation for two reasons: a caller
   * who does not own the sitting learns nothing about the payload it would have
   * accepted, and the (paid, minutes-long) model call has not started yet.
   *
   * `no-sitting` is not a refusal. The request is legal, it just addresses no
   * row we can verify — no database, a degraded `local-…` id, or a lookup that
   * failed — so the exam is graded and nothing is written. That is the same
   * bargain the route has always made with a missing `DATABASE_URL`.
   */
  const access = await authorizeExam(examId);
  if (access.status === "denied") {
    const { status, error } = EXAM_ACCESS_DENIALS[access.reason];
    return NextResponse.json({ error }, { status });
  }
  const { userId } = access;
  const persistedExamId = access.status === "owned" ? access.examId : null;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Requête illisible" }, { status: 400 });
  }

  const payloadRaw = form.get("payload");
  if (typeof payloadRaw !== "string") {
    return NextResponse.json({ error: "payload manquant" }, { status: 400 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(payloadRaw);
  } catch {
    return NextResponse.json({ error: "payload invalide" }, { status: 400 });
  }

  const parsed = finishPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "payload invalide", details: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }
  const payload = parsed.data;

  const topic = findTopic(payload.topicSlug);
  if (!topic) return NextResponse.json({ error: "Sujet inconnu" }, { status: 404 });

  // Refuse to invent a grade for an exam that never happened. A model handed an
  // empty transcript will still confidently return five scores.
  if (candidateWordCount(payload.transcript) < 20) {
    return NextResponse.json(
      {
        error:
          "La transcription ne contient presque aucune parole du candidat. L'épreuve ne peut pas être évaluée.",
      },
      { status: 422 },
    );
  }

  const audioFile = form.get("audio");
  const audio = audioFile instanceof Blob ? audioFile : undefined;
  // Audio-aware grading whenever we actually have the recording; the text path
  // is the documented fallback, and the experiment harness can force either.
  const requestedMode = form.get("mode");
  const mode: EvaluationMode =
    requestedMode === "text" || !audio ? "text" : "audio";

  try {
    const result = await evaluateExam({
      mode,
      topic,
      transcript: payload.transcript,
      monologueSeconds: payload.monologueSeconds,
      debateSeconds: payload.debateSeconds,
      audio,
    });

    if (persistedExamId !== null) {
      // The three writes below are not atomic, and cannot be as written: this
      // driver is `neon-http`, whose `db.transaction()` throws. A failure after
      // the UPDATE leaves a sitting marked finished with no correction attached.
      // `db.batch()` — which neon-http implements as a real transaction — is the
      // fix, and belongs with the read path that would expose the inconsistency
      // in the first place. See #16.
      try {
        const db = getDb();
        const id = persistedExamId;

        await db
          .update(oralExams)
          .set({
            phase: "finished",
            reconnectCount: payload.reconnectCount,
            transcript: payload.transcript,
            finishedAt: new Date(),
          })
          // The ownership predicate is repeated here on purpose: the check above
          // is what makes the request legal, this is what keeps the statement
          // itself safe if the two ever drift apart.
          .where(and(eq(oralExams.id, id), eq(oralExams.userId, userId)));

        // Per-phase speaking time is a row per phase, not a column pair on the
        // sitting. `doNothing` because a repeated finish must not rewrite how
        // long the candidate spoke; the real duplicate guard is Phase 11.
        await db
          .insert(oralExamPhases)
          .values([
            {
              examId: id,
              phase: "monologue",
              spokenSeconds: Math.round(payload.monologueSeconds),
            },
            { examId: id, phase: "debate", spokenSeconds: Math.round(payload.debateSeconds) },
          ])
          .onConflictDoNothing();

        await db.insert(evaluations).values({
          examId: id,
          mode: result.mode,
          // The five bands are columns; `criteria` is keyed by the same five
          // criterion names, so it spreads straight in.
          ...result.criteria,
          rawScore25: result.rawScore25,
          durationPenalty: result.rawScore25 - result.score25,
          score25: result.score25,
          meetsFloor: meetsCompetencyFloor(result.score25),
          feedback: result.feedback,
          model: result.model,
          promptVersion: result.promptVersion,
          latencySeconds: result.latencySeconds,
        });
      } catch (error) {
        // The candidate has their grade; losing the row is a logging problem,
        // not a reason to show them an error.
        console.error("[finish] evaluation succeeded but persistence failed:", error);
      }
    }

    return NextResponse.json({ evaluation: result });
  } catch (error) {
    console.error("[finish] evaluation failed:", error);
    return NextResponse.json(
      { error: "L'évaluation a échoué. Réessayez dans un instant." },
      { status: 502 },
    );
  }
}
