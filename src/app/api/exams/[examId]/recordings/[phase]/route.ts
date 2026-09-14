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

import { type ExamRequest, examRoute } from "@/lib/auth/exam-route";
import type { OralSpeakingPhase } from "@/lib/db/schema";
import { disposeRecording, findRecording } from "@/lib/db/sittings";
import { decidePlayback, parseRecordedPhase } from "@/lib/exams/recording-playback";
import { isRecordingVaultConfigured, recordingVault } from "@/lib/storage/recording-vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RecordingParams = { examId: string; phase: string };

type OwnedPhase =
  | { ok: true; examId: number; userId: string; phase: OralSpeakingPhase }
  | { ok: false; response: NextResponse };

/**
 * The two questions both verbs ask after `examRoute` has asked the first, in
 * the one order they may be asked in.
 *
 * Authorisation came first, so the path is only parsed for a caller who may
 * see it: an unowned caller learns nothing about which path shapes exist. Then
 * persistence: a sitting that was never persisted (no database, a degraded
 * `local-…` id) has no recording row, so there is nothing either verb could
 * ever do for it. The finish route grades those anyway; these two have no such
 * fallback.
 */
function resolveOwnedPhase({ access, params }: ExamRequest<RecordingParams>): OwnedPhase {
  const phase = parseRecordedPhase(params.phase);
  if (!phase) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Enregistrement inconnu" }, { status: 404 }),
    };
  }

  if (access.status !== "owned") {
    return {
      ok: false,
      response: NextResponse.json({ error: "Enregistrement introuvable" }, { status: 404 }),
    };
  }

  return { ok: true, examId: access.examId, userId: access.userId, phase };
}

export const GET = examRoute<RecordingParams>(async (request, exam) => {
  const owned = resolveOwnedPhase(exam);
  if (!owned.ok) return owned.response;
  const { examId, userId, phase } = owned;

  const row = await findRecording({ examId, userId }, phase).catch((error: unknown) => {
    console.error("[recordings] could not read recording row", examId, phase, error);
    return null;
  });

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
      console.error("[recordings] could not open recording", examId, phase, error);
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

  // No `Accept-Ranges`, on purpose rather than by omission: a kept artefact is
  // a few megabytes of 16 kbit/s Opus (MAX_RECORDING_BYTES caps it at 3 MiB),
  // so the first play downloads it whole and every seek after that is local.
  // Range support earns its complexity the day recordings get larger than
  // that — and the cap is the thing that says they cannot.
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
});

/**
 * DELETE — the candidate removes one of their own recordings, for good (#98).
 *
 * « Supprimer » on the player card, after an inline confirmation. The order
 * inside is the one `decidePlayback` already trusts: the row is stamped first
 * (`disposeRecording`), the store is cleared second, so a crash between the
 * two leaves an unreachable orphan rather than a playable row pointing at
 * bytes the candidate was told were gone. Clearing the store is best-effort
 * for the same reason — once the row says deleted, the deletion has happened;
 * a failed `del` costs storage, never truth.
 *
 * Only the voice is deleted. The row keeps its duration, its size and its
 * stamp — the honest record every disposed recording has had since Phase 6 —
 * and the correction it fed is untouched: the grade was computed when the
 * bytes existed, and deleting the artefact afterwards does not un-hear it.
 *
 * 404 for "nothing to delete" covers a phase that never recorded, bytes
 * already gone, and a repeated press — the candidate asked for an absence,
 * and an absence is what there is.
 */
export const DELETE = examRoute<RecordingParams>(async (_request, exam) => {
  const owned = resolveOwnedPhase(exam);
  if (!owned.ok) return owned.response;
  const { examId, userId, phase } = owned;

  let disposed: { uri: string } | null;
  try {
    disposed = await disposeRecording({ examId, userId }, phase, new Date());
  } catch (error) {
    // Nothing was stamped, so nothing is claimed: the recording is still
    // there, and the card must keep saying so.
    console.error("[recordings] could not dispose recording", examId, phase, error);
    return NextResponse.json(
      { error: "La suppression a échoué. Réessayez dans un instant." },
      { status: 503 },
    );
  }

  if (!disposed) {
    return NextResponse.json({ error: "Enregistrement introuvable" }, { status: 404 });
  }

  // The row already says deleted; this is housekeeping, not the deletion.
  await recordingVault()
    ?.discard(disposed.uri)
    .catch((error: unknown) => {
      console.error(
        "[recordings] row stamped but the store still holds the bytes",
        examId,
        phase,
        error,
      );
    });

  return NextResponse.json({ deleted: true });
});
