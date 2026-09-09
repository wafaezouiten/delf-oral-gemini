import "server-only";

/**
 * Transcribe the monologue's recording, mid-épreuve.
 *
 * Called once, at the handover from the exposé to the débat, because the Live
 * session cannot transcribe an exposé of the length the DELF asks for — see
 * `lib/gemini/transcribe-monologue.ts` for the measurements. The candidate is
 * listening to the débat's consigne while this runs.
 *
 * A separate route rather than part of the finish, and the reason is the
 * débat: its session is seeded with what the candidate argued in the monologue
 * (`debateSessionHistory`), so the words have to exist BEFORE the examiner
 * connects, not at the end of the sitting. Doing it here also means the wait is
 * spent on a consigne the candidate is listening to anyway rather than added to
 * the one they spend watching « Épreuve terminée » (#86).
 *
 * The API key never leaves the server, which is the same reason the Live
 * session is opened with a minted token rather than a key.
 */

import { NextResponse } from "next/server";

import { authorizeExam } from "@/lib/auth/exam-guard";
import { EXAM_ACCESS_DENIALS } from "@/lib/auth/exam-access";
// The same number one phase's artefact is held to when this very blob reaches
// the finish, with the platform arithmetic that sets it. The cap lives there
// rather than in the transcriber for the reason that module gives.
import { MAX_RECORDING_BYTES } from "@/lib/exams/uploaded-recording";
import { transcribeMonologue } from "@/lib/gemini/transcribe-monologue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Long enough for a seven-minute recording, short enough that a stuck call
 *  cannot outlive the consigne by much. The client stops waiting first. */
export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ examId: string }> }) {
  const { examId } = await context.params;

  /**
   * Ownership before anything else, exactly as the finish route argues it: exam
   * ids are sequential serials, and without the second check any signed-in user
   * could spend a model call against a neighbouring id's recording.
   *
   * `no-sitting` is not a refusal here either — a degraded `local-…` id has no
   * row to check and still has an exposé to transcribe.
   */
  const access = await authorizeExam(examId);
  if (access.status === "denied") {
    const { status, error } = EXAM_ACCESS_DENIALS[access.reason];
    return NextResponse.json({ error }, { status });
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RECORDING_BYTES) {
    return NextResponse.json({ error: "Enregistrement trop volumineux" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Requête illisible" }, { status: 400 });
  }

  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json({ error: "audio manquant" }, { status: 400 });
  }
  if (audio.size > MAX_RECORDING_BYTES) {
    return NextResponse.json({ error: "Enregistrement trop volumineux" }, { status: 413 });
  }

  // What the blob says it is, not what the form claims: the artefact is Ogg
  // Opus since #24, and a file offered under the wrong type transcribes silence.
  const mimeType = audio.type || "audio/ogg";

  const startedAt = Date.now();
  try {
    const text = await transcribeMonologue(audio, mimeType);
    console.info(
      `[monologue-transcript] ${audio.size} bytes of ${mimeType} -> ` +
        `${text.length} chars in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );
    return NextResponse.json({ text });
  } catch (error) {
    // Logged, and only logged: the caller is a candidate about to start their
    // débat, and a transcription that failed is a transcript that is missing,
    // not an épreuve that should stop. The finish route's participation refusal
    // is what catches the consequence, and it names the app.
    console.error(`[monologue-transcript] failed after ${Date.now() - startedAt}ms`, error);
    return NextResponse.json({ error: "La transcription a échoué" }, { status: 502 });
  }
}
