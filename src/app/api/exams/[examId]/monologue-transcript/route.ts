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

import { examRoute } from "@/lib/auth/exam-route";
// The same number one phase's artefact is held to when this very blob reaches
// the finish, with the platform arithmetic that sets it. The cap lives there
// rather than in the transcriber for the reason that module gives.
import {
  MAX_RECORDING_BYTES,
  MIN_RECORDING_SECONDS,
  measureUploadedRecording,
} from "@/lib/exams/uploaded-recording";
import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import { transcribeMonologue } from "@/lib/gemini/transcribe-monologue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Long enough for a seven-minute recording, short enough that a stuck call
 *  cannot outlive the consigne by much. The client stops waiting first. */
export const maxDuration = 60;

/**
 * `no-sitting` is not a refusal here: a degraded `local-…` id has no row to
 * check and still has an exposé to transcribe, so `access` is taken for the
 * denial `examRoute` already answered and nothing more.
 */
export const POST = examRoute(async function transcribeExpose(request) {
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

  /**
   * What the BYTES are, not what the blob's `type` claims they are — the same
   * policy, and the same function, the finish route applies to this very
   * artefact when it arrives there. `Blob.type` is the client's label; a file
   * handed to the transcriber under the wrong one transcribes silence, and
   * silence here is indistinguishable from a candidate who said nothing.
   *
   * `null` is a file nothing here recognises. Refused rather than sent, for the
   * cost: an unmeasurable file is not going to become a transcript.
   */
  const bytes = await audio.arrayBuffer();
  const measured = measureUploadedRecording(bytes, INPUT_SAMPLE_RATE);
  if (!measured) {
    return NextResponse.json({ error: "Enregistrement illisible" }, { status: 400 });
  }
  // The same floor the finish route reads a stub against (#73): seconds of room
  // tone is an absence, and asking a model to transcribe one spends a call to
  // be told so. The empty answer is the honest one and costs nothing.
  if (measured.durationSeconds < MIN_RECORDING_SECONDS) {
    console.info(
      `[monologue-transcript] ${measured.durationSeconds.toFixed(1)}s is under the ` +
        `${MIN_RECORDING_SECONDS}s floor; nothing to transcribe`,
    );
    return NextResponse.json({ text: "" });
  }

  const startedAt = Date.now();
  try {
    const text = await transcribeMonologue(bytes, measured.mimeType);
    console.info(
      `[monologue-transcript] ${audio.size} bytes of ${measured.mimeType}, ` +
        `${measured.durationSeconds.toFixed(1)}s -> ` +
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
});
