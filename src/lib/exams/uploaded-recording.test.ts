import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { muxOggOpus } from "@/lib/audio/ogg-opus";
import { MONOLOGUE_MIN_SECONDS } from "@/lib/delf/phases";
import { pcm16ToWav } from "@/lib/audio/pcm";
import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import {
  MAX_RECORDING_BYTES,
  MAX_REQUEST_BYTES,
  fitsInOneRequest,
  measureUploadedRecording,
  selectDeliverable,
} from "./uploaded-recording";

/**
 * What the finish route will accept as the recording, and how large.
 *
 * Two properties, and #24 is what happens when the second is not checked: a
 * duration that comes out of the artefact rather than off a label, and a request
 * that the platform will actually deliver.
 */

/** Bytes a second of the shipped encoding — measured in a real browser over a
 *  20-minute sitting, see docs/AUDIO_UPLOAD.md. */
const OPUS_BYTES_PER_SECOND = 2_060;

/** One 20 ms Opus packet: config 19 (fullband, 20 ms), one frame. */
function packet(bytes = 40): Uint8Array {
  const data = new Uint8Array(bytes);
  data[0] = 19 << 3;
  return data;
}

async function opus(seconds: number, options?: { inputSampleRate?: number; channels?: number }) {
  const blob = muxOggOpus(Array.from({ length: Math.round(seconds * 50) }, () => packet()), {
    inputSampleRate: options?.inputSampleRate ?? INPUT_SAMPLE_RATE,
    channels: options?.channels ?? 1,
  });
  return blob.arrayBuffer();
}

async function wav(seconds: number, rate = INPUT_SAMPLE_RATE) {
  return pcm16ToWav(new Int16Array(Math.round(seconds * rate)), rate).arrayBuffer();
}

describe("measuring what was uploaded", () => {
  it("measures an Opus recording from its packets", async () => {
    const measured = measureUploadedRecording(await opus(300), INPUT_SAMPLE_RATE);

    assert.deepEqual(measured, { mimeType: "audio/ogg", durationSeconds: 300 });
  });

  it("still measures a WAV, which is what a browser without a codec sends", async () => {
    const measured = measureUploadedRecording(await wav(90), INPUT_SAMPLE_RATE);

    assert.deepEqual(measured, { mimeType: "audio/wav", durationSeconds: 90 });
  });

  it("decides the format from the bytes, not from what the form called them", async () => {
    // The multipart part's filename and content type are the client's to choose,
    // and the duration penalty is not. An Opus stream posted as `.wav` measures
    // as Opus; anything else would let a caller pick which arithmetic applies.
    const bytes = await opus(10);
    assert.equal(measureUploadedRecording(bytes, INPUT_SAMPLE_RATE)?.mimeType, "audio/ogg");
  });

  it("refuses audio this application could not have produced", async () => {
    // Not mono at the capture rate, so not something `pcm16ToWav` or
    // `encodePcm16ToOggOpus` wrote — and measuring it would be answering a
    // question nobody asked.
    assert.equal(measureUploadedRecording(await opus(10, { inputSampleRate: 48_000 }), INPUT_SAMPLE_RATE), null);
    assert.equal(measureUploadedRecording(await opus(10, { channels: 2 }), INPUT_SAMPLE_RATE), null);
    assert.equal(measureUploadedRecording(await wav(10, 44_100), INPUT_SAMPLE_RATE), null);
  });

  it("refuses something that is not audio at all", () => {
    const junk = new Uint8Array(2_048).fill(0x41);
    assert.equal(measureUploadedRecording(junk.buffer as ArrayBuffer, INPUT_SAMPLE_RATE), null);
    assert.equal(measureUploadedRecording(new ArrayBuffer(0), INPUT_SAMPLE_RATE), null);
  });
});

describe("what one request may carry", () => {
  it("takes a full sitting encoded as Opus", () => {
    // The acceptance criterion of #24, in arithmetic: a ~7 minute monologue and
    // a ~13 minute débat, plus a long transcript.
    const monologue = 7 * 60 * OPUS_BYTES_PER_SECOND;
    const debate = 13 * 60 * OPUS_BYTES_PER_SECOND;
    const transcript = 200_000;

    assert.ok(monologue < MAX_RECORDING_BYTES);
    assert.ok(debate < MAX_RECORDING_BYTES);
    assert.ok(fitsInOneRequest([transcript, monologue, debate]));
  });

  it("does not take the same sitting as PCM, which is the whole bug", () => {
    // 16 kHz mono PCM16 is 32 kB a second: the monologue alone is 13 MB and the
    // pair is 38 MB, against a platform that stops at 4.5 MB.
    const asWav = (minutes: number) => 44 + minutes * 60 * INPUT_SAMPLE_RATE * 2;

    assert.ok(asWav(7) > MAX_RECORDING_BYTES);
    assert.equal(fitsInOneRequest([200_000, asWav(7), asWav(13)]), false);
  });

  it("carries about 98 seconds of WAV, whatever the monologue's own floor is", () => {
    // This test used to assert that a WAV of a minimum-length monologue could
    // never fit, and that was true while the floor was 300 seconds: the cap is
    // sized for Opus, so as PCM16 it is 98 seconds, and 300 > 98 by a wide
    // margin. Dropping the floor to 60 makes it false — one minute of PCM16 is
    // 1.9 MB and fits inside the 3 MB cap.
    //
    // The claim is therefore restated rather than deleted, because what it was
    // really pinning is the cap's size in seconds, and that has not moved. What
    // changed is a genuine consequence worth writing down: a browser without
    // WebCodecs that records a SHORT monologue can now upload it, where before
    // every WAV was dropped in the tab. That is an improvement — the audio gets
    // graded — and `selectDeliverable` still decides, in the tab, which
    // artefacts fit rather than discovering it at a 413.
    const asWav = (seconds: number) => 44 + seconds * INPUT_SAMPLE_RATE * 2;

    assert.equal(Math.floor(MAX_RECORDING_BYTES / (INPUT_SAMPLE_RATE * 2)), 98);
    assert.ok(asWav(98) < MAX_RECORDING_BYTES);
    assert.ok(asWav(99) > MAX_RECORDING_BYTES);

    // A monologue at the new floor now fits on its own…
    assert.ok(asWav(MONOLOGUE_MIN_SECONDS) < MAX_RECORDING_BYTES);
    // …but a full-length débat beside it still does not, which is the pairing
    // `selectDeliverable` exists to resolve.
    assert.equal(fitsInOneRequest([1_000, asWav(MONOLOGUE_MIN_SECONDS), asWav(600)]), false);
  });

  it("counts the multipart wrapping, not just the parts", () => {
    assert.equal(fitsInOneRequest([MAX_REQUEST_BYTES]), false);
    assert.ok(fitsInOneRequest([MAX_REQUEST_BYTES - 8 * 1024]));
  });

  it("stays under the platform's own limit, which is the point of the number", () => {
    // Vercel documents 4.5 MB for a function's request body. Ours has to be
    // below it, or the rejection is the platform's and carries no message.
    assert.ok(MAX_REQUEST_BYTES < 4_500_000);
  });

});

describe("choosing what to attach", () => {
  /** A recording, as the client weighs it: a size and which phase it is of. */
  const recording = (phase: "monologue" | "debate", bytes: number) => ({ phase, bytes });
  const sizeOf = (r: { bytes: number }) => r.bytes;
  const transcript = 30_000;

  /** The shipped encoding, at the measured 2 060 bytes a second. */
  const asOpus = (seconds: number) => seconds * 2_060;
  const asWav = (seconds: number) => 44 + seconds * INPUT_SAMPLE_RATE * 2;

  it("attaches both recordings of an ordinary sitting", () => {
    const sitting = [recording("monologue", asOpus(7 * 60)), recording("debate", asOpus(13 * 60))];

    assert.deepEqual(selectDeliverable(sitting, sizeOf, transcript), sitting);
  });

  it("drops only the phase that fell back to WAV, and keeps the one that did not", () => {
    // The case the aggregate check alone missed. Opus is encoded per phase, so a
    // transient failure in one leaves a WAV beside a perfectly good Opus file:
    // 110 s of WAV is 3.5 MB, over the per-file cap, while the pair plus the
    // transcript is 4.0 MB and under the request's. Attaching it would have been
    // a 413 for the whole sitting — and the exam is one-way, so that is the
    // correction lost rather than degraded.
    const monologue = recording("monologue", asWav(110));
    const debate = recording("debate", asOpus(60));

    assert.ok(monologue.bytes > MAX_RECORDING_BYTES);
    assert.ok(fitsInOneRequest([transcript, monologue.bytes, debate.bytes]), "the pair fits");
    assert.deepEqual(selectDeliverable([monologue, debate], sizeOf, transcript), [debate]);
  });

  it("gives up the larger recording when the pair is what does not fit", () => {
    // Both legal on their own, too much together. Keeping one is strictly better
    // than keeping neither: the corrector is told which task it is listening to,
    // so half a sitting is still graded from audio.
    const monologue = recording("monologue", 2_600_000);
    const debate = recording("debate", 2_000_000);

    assert.ok(monologue.bytes < MAX_RECORDING_BYTES && debate.bytes < MAX_RECORDING_BYTES);
    assert.equal(fitsInOneRequest([transcript, monologue.bytes, debate.bytes]), false);
    assert.deepEqual(selectDeliverable([monologue, debate], sizeOf, transcript), [debate]);
  });

  it("attaches nothing when nothing can be delivered", () => {
    // A browser with no codec at all: two full-length WAVs, 38 MB. The sitting is
    // graded from its transcript, which the results page reports and the
    // préparation warned about before the passation began.
    const sitting = [recording("monologue", asWav(7 * 60)), recording("debate", asWav(13 * 60))];

    assert.deepEqual(selectDeliverable(sitting, sizeOf, transcript), []);
  });

  it("keeps them in the order they were recorded", () => {
    // Not in size order, which is how they are considered for dropping: the
    // evaluator's prompt promises the model the monologue comes first.
    const monologue = recording("monologue", asOpus(60));
    const debate = recording("debate", asOpus(13 * 60));

    assert.deepEqual(selectDeliverable([monologue, debate], sizeOf, transcript), [
      monologue,
      debate,
    ]);
  });
});
