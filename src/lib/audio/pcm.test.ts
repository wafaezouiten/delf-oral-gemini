import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  base64ToInt16,
  checkWavFormat,
  floatBlockToPcm16,
  floatToPcm16,
  int16ToBase64,
  pcm16ToWav,
  readWavFormat,
  wavDurationSeconds,
} from "./pcm";

describe("float -> PCM16", () => {
  it("uses the full int16 range at both extremes", () => {
    assert.equal(floatToPcm16(1), 32767);
    assert.equal(floatToPcm16(-1), -32768);
    assert.equal(floatToPcm16(0), 0);
  });

  it("clamps rather than wrapping", () => {
    // The failure this prevents: an int16 that overflows wraps to the OPPOSITE
    // polarity, so a transient slightly past full scale — which the browser's
    // own resampler can produce — becomes a full-scale click in the other
    // direction. Silent in a waveform, obvious in a pronunciation score.
    assert.equal(floatToPcm16(2), 32767);
    assert.equal(floatToPcm16(-2), -32768);
    assert.equal(floatToPcm16(1e9), 32767);
  });

  it("survives the round trip through an Int16Array", () => {
    const block = new Float32Array([0, 0.5, -0.5, 1, -1, 1.5, -1.5]);
    const pcm = floatBlockToPcm16(block);
    assert.deepEqual([...pcm], [0, 16383, -16384, 32767, -32768, 32767, -32768]);
  });
});

describe("base64 <-> PCM16", () => {
  it("round-trips a buffer larger than the fromCharCode argument limit", () => {
    // 0x8000 is where `String.fromCharCode(...bytes)` starts throwing, and it
    // takes about two seconds of speech to get there — which is to say the bug
    // this guards against would never appear in a smoke test and always appear
    // in an épreuve.
    const samples = new Int16Array(70_000);
    for (let i = 0; i < samples.length; i += 1) samples[i] = ((i * 37) % 65536) - 32768;

    const decoded = base64ToInt16(int16ToBase64(samples));
    assert.equal(decoded.length, samples.length);
    assert.deepEqual([...decoded], [...samples]);
  });

  it("encodes a view without dragging in the rest of its buffer", () => {
    // Frames come out of the framer as `.slice()`s today, but a subarray view is
    // the obvious optimisation and it must not silently encode its neighbours.
    const backing = new Int16Array([1, 2, 3, 4, 5, 6]);
    const view = backing.subarray(2, 4);
    assert.deepEqual([...base64ToInt16(int16ToBase64(view))], [3, 4]);
  });

  it("drops a trailing half-sample instead of throwing", () => {
    // `new Int16Array(oddLengthBuffer)` throws a RangeError, and this runs
    // inside the Live message handler — so one malformed chunk would take the
    // message pump down and with it the rest of the épreuve.
    const odd = btoa("abc");
    assert.equal(base64ToInt16(odd).length, 1);
  });

  it("treats an empty payload as no audio", () => {
    assert.equal(base64ToInt16("").length, 0);
  });
});

describe("WAV wrapping", () => {
  it("writes a canonical 44-byte header the declared rate can be read back from", async () => {
    const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const blob = pcm16ToWav(samples, 16000);
    const view = new DataView(await blob.arrayBuffer());

    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));

    assert.equal(blob.type, "audio/wav");
    assert.equal(view.byteLength, 44 + samples.byteLength);
    assert.equal(ascii(0, 4), "RIFF");
    assert.equal(ascii(8, 4), "WAVE");
    assert.equal(ascii(12, 4), "fmt ");
    assert.equal(ascii(36, 4), "data");

    assert.equal(view.getUint32(4, true), 36 + samples.byteLength, "RIFF size");
    assert.equal(view.getUint16(20, true), 1, "PCM");
    assert.equal(view.getUint16(22, true), 1, "mono");
    assert.equal(view.getUint32(24, true), 16000, "sample rate");
    assert.equal(view.getUint32(28, true), 32000, "byte rate");
    assert.equal(view.getUint16(32, true), 2, "block align");
    assert.equal(view.getUint16(34, true), 16, "bits per sample");
    assert.equal(view.getUint32(40, true), samples.byteLength, "data size");

    const payload = new Int16Array(view.buffer.slice(44));
    assert.deepEqual([...payload], [...samples]);
  });

  it("declares whatever rate it is given, so a resampled archive is not mislabelled", async () => {
    const view = new DataView(await pcm16ToWav(new Int16Array(4), 24000).arrayBuffer());
    assert.equal(view.getUint32(24, true), 24000);
    assert.equal(view.getUint32(28, true), 48000);
  });
});

/**
 * Measuring a WAV back.
 *
 * The server reads this out of the bytes it received rather than trusting the
 * duration a browser reported alongside them, because that number decides the
 * DELF duration penalty. So it has to be right on the files we write, and honest
 * about the ones we cannot read.
 */
describe("reading a WAV's duration", () => {
  /** A WAV assembled by hand, so the chunk walk can be given something other
   *  than our own canonical 44-byte header. */
  function wav(options: {
    dataBytes: number;
    /** What the header claims, if that differs from what is there. */
    declaredDataBytes?: number;
    byteRate?: number;
    /** An extra chunk before `fmt `, of this many bytes. */
    extraChunk?: number;
  }): ArrayBuffer {
    const extra = options.extraChunk ?? 0;
    const extraTotal = extra === 0 ? 0 : 8 + extra + (extra % 2);
    const buffer = new ArrayBuffer(12 + extraTotal + 24 + 8 + options.dataBytes);
    const view = new DataView(buffer);
    const ascii = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };

    ascii(0, "RIFF");
    view.setUint32(4, buffer.byteLength - 8, true);
    ascii(8, "WAVE");

    let offset = 12;
    if (extra > 0) {
      ascii(offset, "LIST");
      view.setUint32(offset + 4, extra, true);
      offset += extraTotal;
    }

    ascii(offset, "fmt ");
    view.setUint32(offset + 4, 16, true);
    view.setUint16(offset + 8, 1, true);
    view.setUint16(offset + 10, 1, true);
    view.setUint32(offset + 12, 16000, true);
    view.setUint32(offset + 16, options.byteRate ?? 32000, true);
    view.setUint16(offset + 20, 2, true);
    view.setUint16(offset + 22, 16, true);
    offset += 24;

    ascii(offset, "data");
    view.setUint32(offset + 4, options.declaredDataBytes ?? options.dataBytes, true);
    return buffer;
  }

  it("measures what the recorder writes", async () => {
    const seconds = 6;
    const blob = pcm16ToWav(new Int16Array(seconds * 16000), 16000);
    assert.equal(wavDurationSeconds(await blob.arrayBuffer()), seconds);
  });

  it("agrees with the sample count at any rate", async () => {
    const blob = pcm16ToWav(new Int16Array(12_000), 24000);
    assert.equal(wavDurationSeconds(await blob.arrayBuffer()), 0.5);
  });

  it("walks past chunks it does not care about, pad byte included", () => {
    // Not something we write, but something a re-encode adds. An odd-sized chunk
    // carries a pad byte that is not part of it, and a walk that misses it lands
    // one byte into the next chunk id and finds nothing at all.
    assert.equal(wavDurationSeconds(wav({ dataBytes: 32_000, extraChunk: 5 })), 1);
  });

  it("believes the file over the header when the upload was truncated", () => {
    // A short upload is short audio. Trusting the declared size would report the
    // recording the candidate meant to send rather than the one that arrived,
    // and the penalty would be computed against audio nobody has.
    assert.equal(wavDurationSeconds(wav({ dataBytes: 16_000, declaredDataBytes: 32_000 })), 0.5);
  });

  it("returns null rather than a plausible zero for anything it cannot read", () => {
    assert.equal(wavDurationSeconds(new ArrayBuffer(0)), null);
    assert.equal(wavDurationSeconds(new ArrayBuffer(64)), null, "not RIFF/WAVE");
    assert.equal(wavDurationSeconds(wav({ dataBytes: 32_000, byteRate: 0 })), null);
  });

  it("refuses a header that contradicts itself", () => {
    // The attack this closes. `byteRate` is redundant with the three fields
    // beside it, and dividing by the declared one lets a hand-built header turn
    // a one-second file into an eight-minute recording — against an endpoint
    // whose whole premise is that it does not take the client's word for the
    // duration. A file whose two copies of the same fact disagree is refused;
    // there is no honest way to pick which half to believe.
    const forged = wav({ dataBytes: 32_000, byteRate: 64 });
    assert.equal(wavDurationSeconds(forged), null, "not 500 seconds from a one-second file");

    const honest = readWavFormat(wav({ dataBytes: 32_000 }));
    assert.equal(honest?.durationSeconds, 1);
  });

  it("reports the format, so a caller can ask whether the file is even ours", () => {
    const format = readWavFormat(wav({ dataBytes: 32_000 }));
    assert.ok(format);
    assert.equal(format.sampleRate, 16000);
    assert.equal(format.channels, 1);
    assert.equal(format.bitsPerSample, 16);
    assert.equal(format.dataBytes, 32_000);

    assert.equal(checkWavFormat(format, 16000), true);
    assert.equal(checkWavFormat(format, 24000), false, "a rate the recorder never captures at");
    assert.equal(
      checkWavFormat({ ...format, channels: 2 }, 16000),
      false,
      "and nothing in this codebase writes stereo",
    );
  });
});
