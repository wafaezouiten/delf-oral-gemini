/**
 * What `POST /api/exams/:examId/finish` will accept as its binary half: how
 * large a recording may be, and how its length is read out of it.
 *
 * The companion to `finish-payload.ts`, and here for the same reason — nothing
 * in the route can be loaded by `node --test`, so the checks standing between an
 * authenticated stranger and the server's memory would otherwise be the only
 * uncovered code on it.
 *
 * **The ceiling is the platform's, not a preference.** A serverless function
 * accepts a 4.5 MB request body; a 20-minute sitting recorded as 16 kHz PCM16
 * WAV is about 38 MB, so before #24 the upload was rejected by the platform
 * before the route ever ran — audio grading, the whole premise of the project,
 * could not succeed on a deployed URL. The recordings are Opus now
 * (`audio/opus-encoder.ts`), which puts the same sitting at about 2.4 MB. The
 * numbers below are what keeps that true: a limit low enough to fire as this
 * route's own 413, with its own message, rather than as an opaque platform
 * rejection nobody can read.
 */

import { checkOggOpusFormat, readOggOpus } from "@/lib/audio/ogg-opus";
import { checkWavFormat, readWavFormat } from "@/lib/audio/pcm";

/**
 * The largest single recording this endpoint will read.
 *
 * Measured, not guessed: the shipped encoding is 16 kbit/s constant, which came
 * out at 2 060 bytes a second over a 20-minute sitting (docs/AUDIO_UPLOAD.md).
 * 3 MiB is therefore about 25 minutes of one task — comfortably past the
 * ~13-minute débat and past any plausible overrun — and a recording larger than
 * that did not come from this application.
 */
export const MAX_RECORDING_BYTES = 3 * 1024 * 1024;

/**
 * And the whole request, which is the number that actually matters.
 *
 * 4 MiB is 4 194 304 bytes, under the platform's documented 4.5 MB, and above
 * everything a real sitting produces: two recordings totalling ~2.4 MB plus a
 * transcript bounded at 200 000 characters by `finish-payload.ts`.
 */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** Boundary lines, headers and field names around each part of the form. A
 *  kilobyte each is an order of magnitude over what they measure. */
const MULTIPART_OVERHEAD_BYTES = 1024;

/**
 * Whether these parts can be sent as one finish request.
 *
 * Exported for the browser, which is where the question is worth asking: a
 * client that knows the recording will be refused can send the transcript alone
 * and have the sitting graded from text, instead of losing the correction to a
 * 413 the candidate cannot act on.
 */
export function fitsInOneRequest(parts: readonly number[]): boolean {
  const overhead = MULTIPART_OVERHEAD_BYTES * (parts.length + 1);
  return parts.reduce((total, part) => total + part, overhead) <= MAX_REQUEST_BYTES;
}

/** One artefact, as the server reads it rather than as the client labels it. */
export interface MeasuredRecording {
  /** Taken from the bytes, not from the multipart headers. */
  mimeType: "audio/ogg" | "audio/wav";
  /** Measured from the artefact's own contents. See the two readers. */
  durationSeconds: number;
}

/**
 * Measure an uploaded recording, or refuse it.
 *
 * The format is decided by the bytes, never by the `Content-Type` the browser
 * attached: this number feeds the DELF duration penalty, so the one thing that
 * must not be possible is a client choosing which arithmetic gets applied to its
 * file.
 *
 * Two formats are accepted, and they are not equals. **Ogg Opus** is what the
 * exam produces and the only one a real sitting can arrive as. **WAV** is what
 * the archive falls back to when a browser cannot encode Opus, and what the
 * repository's own tools write; it is still measured exactly, but a full sitting
 * as WAV is eight times the request ceiling and will have been refused above
 * before it gets here. Keeping it accepted means a short sitting, and local
 * development, still grade from audio.
 *
 * Null for anything else — including a WAV or an Opus stream that is not the
 * mono, capture-rate audio this application writes. `pcm16ToWav` and
 * `encodePcm16ToOggOpus` are the only things that produce these files, so
 * something else's file would mean grading a duration somebody else chose.
 */
export function measureUploadedRecording(
  bytes: ArrayBuffer,
  sampleRate: number,
): MeasuredRecording | null {
  const opus = readOggOpus(bytes);
  if (opus) {
    return checkOggOpusFormat(opus, sampleRate)
      ? { mimeType: "audio/ogg", durationSeconds: opus.durationSeconds }
      : null;
  }

  const wav = readWavFormat(bytes);
  if (wav) {
    return checkWavFormat(wav, sampleRate)
      ? { mimeType: "audio/wav", durationSeconds: wav.durationSeconds }
      : null;
  }

  return null;
}
