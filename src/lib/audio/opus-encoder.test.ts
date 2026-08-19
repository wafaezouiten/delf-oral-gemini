import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readWavFormat } from "./pcm";
import {
  RECORDING_BITRATE,
  encodePcm16ToOggOpus,
  isOpusEncodingSupported,
  opusRecordingEncoder,
} from "./opus-encoder";

/**
 * What happens in a runtime with no WebCodecs.
 *
 * Which is this one: `node --test` has no `AudioEncoder`, so these tests can
 * only exercise the path a browser without one takes — and that is worth
 * pinning, because it is the single path on which a sitting loses its audio.
 * The encoding itself is verified in a real browser instead; the run is in
 * docs/AUDIO_UPLOAD.md.
 */

const pcm = new Int16Array(16_000).fill(1_000);

describe("a runtime that cannot encode Opus", () => {
  it("says so rather than being found out mid-sitting", async () => {
    assert.equal(typeof globalThis.AudioEncoder, "undefined", "no WebCodecs under node --test");
    assert.equal(await isOpusEncodingSupported(), false);
  });

  it("throws instead of returning something smaller and wrong", async () => {
    await assert.rejects(() => encodePcm16ToOggOpus(pcm, 16_000), /cannot encode Opus/);
  });

  it("falls back to a WAV, and reports the fallback", async () => {
    // The WAV cannot be uploaded — a full sitting is eight times what the route
    // accepts — so the point of the fallback is that the artefact still exists
    // and still measures. Whether it is small enough to send is the client's
    // question, and `fitsInOneRequest` is where it is asked.
    const reasons: string[] = [];
    const encode = opusRecordingEncoder({ onFallback: (reason) => reasons.push(reason) });

    const { blob, mimeType } = await encode(pcm, 16_000);

    assert.equal(mimeType, "audio/wav");
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /cannot encode Opus/);
    assert.equal(readWavFormat(await blob.arrayBuffer())?.durationSeconds, 1);
  });
});

describe("the bitrate the ceiling was chosen against", () => {
  it("is 16 kbit/s, which is 2 kB a second", () => {
    // Changing this changes whether a 20-minute sitting fits in a request. The
    // measured figure at this setting is 2 060 B/s; the arithmetic below is the
    // nominal one, and the two agree to within the container's overhead.
    assert.equal(RECORDING_BITRATE, 16_000);
    assert.equal((RECORDING_BITRATE / 8) * 20 * 60, 2_400_000);
  });
});
