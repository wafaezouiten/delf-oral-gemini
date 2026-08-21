import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import { FRAME_SAMPLES, PcmFramer, StreamResampler, frameSamplesAt } from "./framing";

/** Deterministic speech-ish signal: something with structure, so a sample lost
 *  at a block boundary shows up as a mismatch rather than as more silence. */
function tone(length: number, offset = 0): Float32Array {
  const block = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    block[i] = 0.6 * Math.sin((2 * Math.PI * 220 * (offset + i)) / INPUT_SAMPLE_RATE);
  }
  return block;
}

/** Feed `total` samples through a framer in ragged blocks, as the audio thread
 *  does. Returns every sample that came out, in order. */
function pushInBlocks(framer: PcmFramer, source: Float32Array, sizes: number[]): number[] {
  const out: number[] = [];
  let at = 0;
  let size = 0;
  while (at < source.length) {
    const take = Math.min(sizes[size % sizes.length], source.length - at);
    for (const frame of framer.push(source.subarray(at, at + take))) out.push(...frame);
    at += take;
    size += 1;
  }
  return out;
}

describe("frame sizing", () => {
  it("is 40 ms at the Live API's input rate", () => {
    assert.equal(FRAME_SAMPLES, 640);
    assert.equal(FRAME_SAMPLES, (40 * INPUT_SAMPLE_RATE) / 1000);
  });

  it("scales to whatever rate the capture context actually got", () => {
    assert.equal(frameSamplesAt(16000), 640);
    assert.equal(frameSamplesAt(44100), 1764);
    assert.equal(frameSamplesAt(48000), 1920);
  });
});

describe("PcmFramer", () => {
  it("emits frames of exactly one size, whatever size the blocks are", () => {
    const framer = new PcmFramer();
    const source = tone(10_000);
    const frames: Int16Array[] = [];
    let at = 0;
    for (const size of [128, 128, 377, 1, 999, 128]) {
      const take = Math.min(size, source.length - at);
      frames.push(...framer.push(source.subarray(at, at + take)));
      at += take;
    }
    assert.ok(frames.length > 0);
    for (const frame of frames) assert.equal(frame.length, FRAME_SAMPLES);
  });

  it("loses and duplicates nothing at a block boundary", () => {
    // The whole reason framing was moved out of the worklet. A remainder that
    // does not survive to the next call is a small, constant, CUMULATIVE loss:
    // it never looks like a bug, it just makes the examiner's transcription
    // slightly worse for twenty minutes.
    const source = tone(50_000);
    const ragged = pushInBlocks(new PcmFramer(), source, [128, 129, 1, 640, 257]);
    const whole = pushInBlocks(new PcmFramer(), source, [source.length]);

    const complete = Math.floor(source.length / FRAME_SAMPLES) * FRAME_SAMPLES;
    assert.equal(ragged.length, complete, "every complete frame came out");
    assert.deepEqual(ragged, whole, "and in exactly the order a single block gives");
  });

  it("hands back the last partial frame rather than dropping it", () => {
    const framer = new PcmFramer();
    framer.push(tone(FRAME_SAMPLES + 100));
    assert.equal(framer.pending, 100);

    const tail = framer.flush();
    assert.ok(tail);
    assert.equal(tail.length, 100, "short, not zero-padded: it goes into a graded recording");
    assert.equal(framer.flush(), null, "and only once");
  });

  it("clamps through to the emitted frame", () => {
    const framer = new PcmFramer({ frameSamples: 4 });
    const [frame] = framer.push(new Float32Array([1.4, -1.4, 1, -1]));
    assert.deepEqual([...frame], [32767, -32768, 32767, -32768]);
  });

  it("does not resample when the browser gave us the rate we asked for", () => {
    assert.equal(new PcmFramer({ inputRate: 16000, outputRate: 16000 }).isResampling, false);
    assert.equal(new PcmFramer({ inputRate: 48000, outputRate: 16000 }).isResampling, true);
  });

  it("emits 16 kHz frames from a 48 kHz device", () => {
    // The contract with the Live API is 16 kHz. A browser that refuses a 16 kHz
    // context must not therefore stream 48 kHz samples to an endpoint that will
    // read them as 16 kHz — that is not a degraded exam, it is an examiner
    // hearing a chipmunk say a third of the words.
    const framer = new PcmFramer({ inputRate: 48000, outputRate: 16000 });
    const oneSecond = new Float32Array(48_000);
    const emitted = framer.push(oneSecond).reduce((n, frame) => n + frame.length, 0);
    assert.equal(emitted + framer.pending, 16_000);
  });
});

describe("StreamResampler", () => {
  it("passes through untouched at matching rates", () => {
    const resampler = new StreamResampler(16000, 16000);
    assert.equal(resampler.isPassThrough, true);
    const block = tone(64);
    assert.equal(resampler.process(block), block);
  });

  it("preserves a constant signal, edges included", () => {
    // A box average that gets its window weights wrong shows up here as ripple
    // on what should be a flat line.
    const resampler = new StreamResampler(48000, 16000);
    const out = resampler.process(new Float32Array(4800).fill(0.5));
    assert.equal(out.length, 1600);
    for (const sample of out) assert.ok(Math.abs(sample - 0.5) < 1e-6, `got ${sample}`);
  });

  it("gives the same output however the input is chopped up", () => {
    // Which is the definition of "streaming": the block boundaries the audio
    // thread happens to produce must not be audible in the result.
    const source = tone(44_100);
    const whole = new StreamResampler(44100, 16000).process(source);

    const chunked: number[] = [];
    const resampler = new StreamResampler(44100, 16000);
    let at = 0;
    for (const size of cycle([441, 1, 2048, 63], source.length)) {
      const take = Math.min(size, source.length - at);
      if (take <= 0) break;
      chunked.push(...resampler.process(source.subarray(at, at + take)));
      at += take;
    }

    assert.equal(chunked.length, whole.length);
    for (let i = 0; i < whole.length; i += 1) {
      assert.ok(Math.abs(chunked[i] - whole[i]) < 1e-6, `sample ${i}`);
    }
  });

  it("does not drift across a full monologue and débat", () => {
    // 30 000 blocks is a twenty-minute épreuve at 40 ms a block. 44.1 kHz is the
    // rate that matters here: 44100/16000 is not a whole number, so a resampler
    // that reset its phase every block would round the same fraction of a sample
    // away 30 000 times. That is the drift the DoD names, and it is worth about
    // fifteen thousand lost samples — a second of the candidate's speech — by
    // the end of the débat.
    const BLOCKS = 30_000;
    const BLOCK = 40;
    const resampler = new StreamResampler(44100, 16000);

    let produced = 0;
    for (let i = 0; i < BLOCKS; i += 1)
      produced += resampler.process(tone(BLOCK, i * BLOCK)).length;

    const expected = (BLOCKS * BLOCK * 16000) / 44100;
    assert.ok(
      Math.abs(produced - expected) <= 1,
      `drifted by ${(produced - expected).toFixed(2)} samples over ${BLOCKS} blocks`,
    );
  });

  it("keeps a whole framer in lockstep over a minute of real-rate capture", () => {
    // The same property one layer up, at the rate and block size a 48 kHz
    // fallback context actually produces.
    const framer = new PcmFramer({ inputRate: 48000, outputRate: 16000 });
    const block = frameSamplesAt(48000);
    let emitted = 0;
    for (let i = 0; i < (60 * 48000) / block; i += 1) {
      emitted += framer.push(tone(block, i * block)).reduce((n, f) => n + f.length, 0);
    }
    const captured = emitted + framer.pending;
    assert.ok(
      Math.abs(captured - 60 * 16000) <= 1,
      `60 s of capture produced ${captured} samples, wanted ${60 * 16000}`,
    );
  });
});

function* cycle(sizes: number[], limit: number): Generator<number> {
  let emitted = 0;
  let i = 0;
  while (emitted < limit) {
    const size = sizes[i % sizes.length];
    emitted += size;
    i += 1;
    yield size;
  }
}
