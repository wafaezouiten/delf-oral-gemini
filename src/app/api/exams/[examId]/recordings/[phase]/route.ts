/**
 * GET /api/exams/:examId/recordings/:phase — play back one half of a sitting.
 *
 * The other end of what #98 stores: the correction page's two players point
 * here, one per speaking phase, and this route streams the kept bytes out of
 * the vault. It exists so the vault's own URL never has to leave the server —
 * the store is private, but "private plus never disclosed" is the property a
 * recording of somebody's voice deserves, and the way to never disclose a URL
 * is to serve the bytes yourself.
 *
 * Authorisation is the same first move the finish route makes, for the same
 * reason: exam ids are sequential serials, so without the ownership check any
 * signed-in user could listen to a neighbouring id's épreuve. `authorizeExam`
 * runs before the row is read, and the row is then read through the owner
 * anyway (`findRecording` joins on both), so a forgotten check upstream cannot
 * leave this query reachable with an id alone.
 *
 * What each answer means — decided in `lib/exams/recording-playback.ts`, where
 * `node --test` can reach it:
 *
 *  - **200**: the bytes, streamed, with the mime type the upload was measured
 *    to be (`audio/ogg` for the exam's own Opus, `audio/wav` for the fallback).
 *  - **404**: nothing to play — no such sitting, a phase that never produced
 *    audio, or a recording whose bytes were disposed of (every sitting from
 *    before #98). All true states, none of them errors.
 *  - **503**: the row promises bytes and this deployment cannot reach the
 *    vault, or the vault no longer has them. The one answer that is our fault.
 */

import { NextResponse } from "next/server";

import { EXAM_ACCESS_DENIALS } from "@/lib/auth/exam-access";
import { authorizeExam } from "@/lib/auth/exam-guard";
import { findRecording } from "@/lib/db/sittings";
import { decidePlayback, parseRecordedPhase } from "@/lib/exams/recording-playback";
import { isRecordingVaultConfigured, recordingVault } from "@/lib/storage/recording-vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ examId: string; phase: string }> },
) {
  const { examId, phase: phaseSegment } = await context.params;

  const access = await authorizeExam(examId);
  if (access.status === "denied") {
    const { status, error } = EXAM_ACCESS_DENIALS[access.reason];
    return NextResponse.json({ error }, { status });
  }

  // Before the row is read, not before the auth: an unowned caller learns
  // nothing about which path shapes exist, same order as the finish route.
  const phase = parseRecordedPhase(phaseSegment);
  if (!phase) {
    return NextResponse.json({ error: "Enregistrement inconnu" }, { status: 404 });
  }

  // A sitting that was never persisted (no database, a degraded `local-…` id)
  // has no recording row, so there is nothing this route could ever serve for
  // it. The finish route grades those anyway; this one has no such fallback.
  if (access.status !== "owned") {
    return NextResponse.json({ error: "Enregistrement introuvable" }, { status: 404 });
  }

  const row = await findRecording({ examId: access.examId, userId: access.userId }, phase).catch(
    (error: unknown) => {
      console.error("[recordings] could not read recording row", access.examId, phase, error);
      return null;
    },
  );

  const decision = decidePlayback(row, isRecordingVaultConfigured());
  switch (decision.status) {
    case "no-recording":
      return NextResponse.json({ error: "Enregistrement introuvable" }, { status: 404 });
    case "disposed":
      return NextResponse.json(
        { error: "Cet enregistrement n'a pas été conservé." },
        { status: 404 },
      );
    case "vault-unreachable":
      console.error("[recordings] a kept recording is unreachable: no vault configured");
      return NextResponse.json(
        { error: "L'enregistrement ne peut pas être lu pour le moment." },
        { status: 503 },
      );
    case "playable":
      break;
  }

  const opened = await recordingVault()
    ?.open(decision.uri, request.headers.get("if-none-match") ?? undefined)
    .catch((error: unknown) => {
      console.error("[recordings] could not open recording", access.examId, phase, error);
      return null;
    });
  if (!opened) {
    // The row says kept and the store disagrees. Server trouble, not a fact
    // about the recording — a retry may well succeed, and telling the
    // candidate their voice is gone on a blip would be the worse answer.
    return NextResponse.json(
      { error: "L'enregistrement ne peut pas être lu pour le moment." },
      { status: 503 },
    );
  }

  /**
   * `no-cache`, not a max-age, and the choice is about whose machine this is:
   * a DELF candidate is plausibly on a shared school or library computer, and
   * a max-age would let the next person at the same profile replay this voice
   * straight out of the disk cache with no request — and so no `authorizeExam`
   * — reaching this route at all. `no-cache` means every replay revalidates
   * here; the etag is what keeps that cheap, because the bytes are immutable
   * once kept and the common answer is the bodiless 304 below.
   */
  const headers: Record<string, string> = {
    "Cache-Control": "private, no-cache",
    ETag: opened.etag,
    // The type is served verbatim from our own row, but the platform's own
    // pattern for private blob delivery sets this, and it costs one line.
    "X-Content-Type-Options": "nosniff",
  };

  if (opened.status === 304) return new Response(null, { status: 304, headers });

  return new Response(opened.stream, {
    headers: {
      ...headers,
      // The measured type from the row, which is also what the vault was told
      // at upload — never anything the request influenced.
      "Content-Type": decision.mimeType,
      "Content-Length": String(opened.byteSize),
      "Content-Disposition": "inline",
    },
  });
}
