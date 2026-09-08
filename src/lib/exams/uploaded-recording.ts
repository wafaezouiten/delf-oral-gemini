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
 * ~13-minute débat and past any plausible overrun.
 *
 * It is a limit on Opus, and the WAV fallback is measured against the same
 * number without being sized for it: 3 MiB is 98 seconds of PCM16. That is
 * deliberate rather than an oversight — see `measureUploadedRecording` for what
 * it means for the sittings a WAV can represent — because the number this route
 * has to defend is the request's, and a per-recording cap generous enough for
 * uncompressed audio would not be one.
 */
export const MAX_RECORDING_BYTES = 3 * 1024 * 1024;

/**
 * The shortest recording worth handing to the corrector (#73). A measured file
 * under this many seconds is treated as if no file arrived for that phase.
 *
 * The files this exists for are stubs, and two of them are ordinary: a débat
 * ended before anything was said still records the candidate's (silent)
 * microphone through the examiner's closing line, and a typed dev exposé (#51)
 * carries the seconds of room noise captured before the panel was opened. Both
 * are legal little Opus files that pass every other check, get uploaded, and
 * then buy nothing but failure modes — the Files API is handed a two-second
 * fragment it may refuse, the corrector is told to listen to silence labelled
 * as a task, and one stub flips a whole sitting out of the text path.
 *
 * Dropping one is free where it matters, and that is why 10 seconds is safe:
 *
 *  - **The duration penalty cannot move.** The thresholds are minutes
 *    (`SHORT_DEVELOPMENT_SECONDS`, `FULL_DEVELOPMENT_SECONDS` in
 *    `orale-rubric.ts`), so a phase measuring 8 seconds and one measuring 0 are
 *    in the same tier — the same reading a dead microphone already gets.
 *  - **The absence halving (#71) is charged in words**, out of the transcript,
 *    and never reads the recording at all.
 *  - **Phonologie loses nothing it had.** Ten seconds of audio is not evidence
 *    of B2 phonology; if the stub was the sitting's only file, the grading
 *    falls back to text mode and the #29 ceiling — the honest reading of an
 *    épreuve the corrector cannot actually hear.
 */
export const MIN_RECORDING_SECONDS = 10;

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

/**
 * The recordings that can actually be delivered, out of the ones a sitting
 * produced.
 *
 * Both limits, in the order the route applies them: each artefact against
 * {@link MAX_RECORDING_BYTES}, then what survives against the request as a
 * whole, dropping the largest until it fits.
 *
 * Both, because the route refuses an oversized *file* with a 413 for the entire
 * request — and a 413 here does not degrade, it loses the sitting. The exam is
 * one-way (`preparation → monologue → débat → finished`), a retry re-sends the
 * same bytes for the same refusal, and there is nothing left to go back to. The
 * two limits are not the same question: two artefacts can each be legal and be
 * too much together, and one can be over the per-file cap while the pair is
 * comfortably under the request's. That second case is reachable — Opus is
 * encoded per phase, so one phase can fall back to WAV on a transient failure
 * while the other stays small.
 *
 * Dropping one recording is not free: the phase it belonged to then measures
 * zero seconds, and the DELF duration penalty is computed from measured audio.
 * That is the same rule a phase whose microphone never worked meets, and it is
 * the honest one — the server cannot grade audio it does not have. It is a
 * reason to drop as little as possible, which is why this drops per artefact
 * rather than all-or-nothing.
 *
 * Since #98 a delivered recording is also *kept* — the correction plays it
 * back — so a dropped artefact now loses the candidate a replay as well as the
 * grading of that half. Re-read in that light, the rule above still holds:
 * what cannot be delivered cannot be graded OR kept, both halves of the loss
 * come from the same missing bytes, and shedding the one oversized artefact is
 * still strictly better than a 413 that loses the sitting whole. What would
 * not survive #98 is any scheme that widens this transport's ceiling by
 * routing recordings around the finish request — whoever builds that must move
 * this selection with it, not delete it.
 */
export function selectDeliverable<T>(
  recordings: readonly T[],
  sizeOf: (recording: T) => number,
  payloadBytes: number,
): T[] {
  const kept = recordings.filter((recording) => sizeOf(recording) <= MAX_RECORDING_BYTES);

  // Largest first, so what is given up is the one artefact standing between the
  // request and the ceiling rather than the smallest two.
  const dropOrder = [...kept].sort((a, b) => sizeOf(b) - sizeOf(a));
  const dropped = new Set<T>();
  while (
    dropOrder.length > dropped.size &&
    !fitsInOneRequest([
      payloadBytes,
      ...kept.filter((recording) => !dropped.has(recording)).map(sizeOf),
    ])
  ) {
    dropped.add(dropOrder[dropped.size]);
  }

  // In the order they were recorded, which is what the evaluator's prompt
  // promises the model about the files it is handed.
  return kept.filter((recording) => !dropped.has(recording));
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
 * Two formats are accepted, and they are not equals.
 *
 * **Ogg Opus** is what the exam produces, and the only format a full sitting can
 * arrive as.
 *
 * **WAV** is what the archive falls back to when a browser cannot encode Opus.
 * It is measured just as exactly, but be clear about how little of it can get
 * here: at 32 kB a second, {@link MAX_RECORDING_BYTES} is **98 seconds** of it.
 * So the only WAV this route will ever accept is one whose capture failed inside
 * the first minute and a half — not "a capture that failed early" in general.
 * `archive.ts`'s own example, a headset unplugged four minutes in, is 7.7 MB as
 * WAV and does not fit; it fits as Opus, which is what it will be on any browser
 * that has WebCodecs at all. A candidate who spoke normally into a browser that
 * does not is graded from audio not at all: the client weighs each artefact and
 * sends what it can rather than a request that cannot be delivered.
 *
 * It stays accepted because refusing it would throw away the one audio a broken
 * capture does produce, and because it costs one branch to keep — not because it
 * is a working transport for a real sitting. It is not.
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
