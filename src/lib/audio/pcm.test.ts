import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  base64ToInt16,
  floatBlockToPcm16,
  floatToPcm16,
  int16ToBase64,
  pcm16ToWav,
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
      String.fromCharCode(
        ...Array.from({ length }, (_, i) => view.getUint8(offset + i)),
      );

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
