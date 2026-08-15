import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { muxOggOpus } from "@/lib/audio/ogg-opus";
import { pcm16ToWav } from "@/lib/audio/pcm";
import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import {
  MAX_RECORDING_BYTES,
  MAX_REQUEST_BYTES,
  fitsInOneRequest,
  measureUploadedRecording,
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

  it("stays under the platform's own limit, which is the point of the number", () => {
    // Vercel documents 4.5 MB for a function's request body. Ours has to be
    // below it, or the rejection is the platform's and carries no message.
    assert.ok(MAX_REQUEST_BYTES < 4_500_000);
  });

  it("counts the multipart wrapping, not just the parts", () => {
    assert.equal(fitsInOneRequest([MAX_REQUEST_BYTES]), false);
    assert.ok(fitsInOneRequest([MAX_REQUEST_BYTES - 8 * 1024]));
  });
});
