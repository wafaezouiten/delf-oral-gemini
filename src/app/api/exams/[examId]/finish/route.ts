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

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { evaluations, getDb, isDatabaseConfigured, oralExams } from "@/lib/db";
import { findTopic } from "@/lib/delf/topics";
import { candidateWordCount, type TranscriptEntry } from "@/lib/delf/transcript";
import { evaluateExam, type EvaluationMode } from "@/lib/gemini/evaluate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A full audio evaluation is slow; the default serverless budget is not enough. */
export const maxDuration = 300;

interface FinishPayload {
  topicSlug: string;
  transcript: TranscriptEntry[];
  monologueSeconds: number;
  debateSeconds: number;
  reconnectCount: number;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ examId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const { examId } = await context.params;

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

  let payload: FinishPayload;
  try {
    payload = JSON.parse(payloadRaw) as FinishPayload;
  } catch {
    return NextResponse.json({ error: "payload invalide" }, { status: 400 });
  }

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

    if (isDatabaseConfigured() && /^\d+$/.test(examId)) {
      try {
        const db = getDb();
        await db
          .update(oralExams)
          .set({
            phase: "finished",
            monologueSeconds: payload.monologueSeconds,
            debateSeconds: payload.debateSeconds,
            reconnectCount: payload.reconnectCount,
            transcript: payload.transcript,
            finishedAt: new Date(),
          })
          .where(eq(oralExams.id, Number(examId)));

        await db.insert(evaluations).values({
          examId: Number(examId),
          mode: result.mode,
          criteria: result.criteria,
          rawScore25: result.rawScore25,
          score25: result.score25,
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
