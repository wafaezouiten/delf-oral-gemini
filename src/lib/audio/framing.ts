/**
 * Framing: the arithmetic between "the audio thread handed us some floats" and
 * "Gemini received 40 ms of 16 kHz PCM16".
 *
 * This used to live inside `public/worklets/pcm-capture.js`, where it could not
 * be imported, could not be tested, and could not be reasoned about except by
 * reading it. That mattered more than it sounds: the two things this file does —
 * carrying a partial frame across block boundaries, and carrying a fractional
 * resampling phase across block boundaries — are exactly the two places where a
 * per-block reset produces a fraction of a sample of error 125 times a second,
 * which over a twenty-minute épreuve is audible drift rather than a rounding
 * detail. Both properties are now asserted in `framing.test.ts`.
 *
 * The worklet keeps only what has to happen on the audio thread: copy the
 * incoming quanta into a buffer and post it. Everything below runs on the main
 * thread, where 16 kHz of arithmetic is free.
 */

import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import { floatToPcm16 } from "./pcm";

/**
 * How much audio goes into one message to Gemini.
 *
 * 128-sample quanta are far too small to send as individual WebSocket frames;
 * much larger than this and the examiner's turn-detection starts to lag the
 * candidate's speech by the size of the buffer.
 */
export const FRAME_MS = 40;

/** 640 samples: 40 ms at the Live API's 16 kHz input rate. */
export const FRAME_SAMPLES = (FRAME_MS * INPUT_SAMPLE_RATE) / 1000;

/** How many samples ~{@link FRAME_MS} is at some other rate — the capture
 *  context's, which is not always the one we asked for. */
export function frameSamplesAt(sampleRate: number): number {
  return Math.max(1, Math.round((FRAME_MS * sampleRate) / 1000));
}

const EMPTY = new Float32Array(0);

/**
 * A streaming rate converter, used only when the browser will not give us a
 * 16 kHz capture context.
 *
 * **This is the fallback, not the plan.** The primary path constructs the
 * `AudioContext` at 16 kHz and lets the browser's own (properly filtered)
 * resampler do the work — hand-rolling one in front of a *pronunciation* exam is
 * how you grade someone down for aliasing you added yourself. But Safari has
 * historically refused a requested rate outright, and a candidate on a browser
 * that hands back 48 kHz must not silently stream 48 kHz audio to an endpoint
 * that will interpret it as 16 kHz — that is not a degraded exam, it is an
 * examiner hearing a chipmunk speaking a third of the words.
 *
 * The filter is a box average over the input window each output sample covers.
 * That is a real (if gentle) anti-alias for downsampling and costs one multiply
 * per input sample; for the rarer upsampling case the window is narrower than a
 * sample and it degrades to a nearest-sample hold.
 *
 * The state that makes it *streaming* rather than per-block is {@link offset}:
 * the fractional position where the next output window begins, carried across
 * calls together with the input samples that window still needs.
 */
export class StreamResampler {
  /** Input samples consumed per output sample. 1 means pass-through. */
  private readonly ratio: number;
  /** Input the next window still needs, kept from the previous block. */
  private carry: Float32Array = EMPTY;
  /** Where inside `carry` the next window starts. Always in [0, 1). */
  private offset = 0;

  constructor(
    readonly inputRate: number,
    readonly outputRate: number,
  ) {
    if (!(inputRate > 0) || !(outputRate > 0)) {
      throw new RangeError(`Nonsensical resampling rates: ${inputRate} -> ${outputRate}`);
    }
    this.ratio = inputRate / outputRate;
  }

  /** Whether this converter actually does anything. */
  get isPassThrough(): boolean {
    return this.ratio === 1;
  }

  /**
   * Convert one block. The result is only valid until the next call: on the
   * pass-through path it IS the caller's array, which is safe because the only
   * caller copies out of it immediately.
   */
  process(block: Float32Array): Float32Array {
    if (this.ratio === 1) return block;

    const input = this.carry.length === 0 ? block : concat(this.carry, block);

    // Only windows that fit ENTIRELY in what we hold may be emitted; a window
    // running off the end would be averaged over fewer samples than it covers
    // and come out quieter than its neighbours.
    const count = Math.max(0, Math.floor((input.length - this.offset) / this.ratio));
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      // Indexed from `offset` rather than accumulated, so the block's own
      // rounding error does not compound across it.
      const start = this.offset + i * this.ratio;
      out[i] = meanOver(input, start, start + this.ratio);
    }

    const next = this.offset + count * this.ratio;
    const consumed = Math.floor(next);
    this.carry = input.slice(consumed);
    this.offset = next - consumed;
    return out;
  }
}

/** Mean of the signal over the half-open input window [a, b), with fractional
 *  weights at both edges. */
function meanOver(x: Float32Array, a: number, b: number): number {
  const end = Math.min(b, x.length);
  let sum = 0;
  for (let i = Math.floor(a); i < end; i += 1) {
    const lo = a > i ? a : i;
    const hi = b < i + 1 ? b : i + 1;
    sum += x[i] * (hi - lo);
  }
  return sum / (b - a);
}

function concat(head: Float32Array, tail: Float32Array): Float32Array {
  const joined = new Float32Array(head.length + tail.length);
  joined.set(head);
  joined.set(tail, head.length);
  return joined;
}

export interface PcmFramerOptions {
  /** Samples per emitted frame, at the OUTPUT rate. */
  frameSamples?: number;
  /** The rate blocks arrive at. Defaults to the output rate (no conversion). */
  inputRate?: number;
  /** The rate frames are emitted at. The Live API's 16 kHz. */
  outputRate?: number;
}

/**
 * Float32 blocks of any size in, fixed-size PCM16 frames out.
 *
 * The invariant worth naming: **no sample is lost or duplicated at a block
 * boundary**. Blocks arrive in 128-sample quanta batched by the worklet into
 * whatever size the capture rate makes ~40 ms, which is essentially never a
 * whole number of output frames — so the remainder has to survive to the next
 * call, and if it does not, the loss is small, constant, and cumulative.
 */
export class PcmFramer {
  private readonly frame: Int16Array;
  private readonly resampler: StreamResampler | null;
  private offset = 0;

  constructor(options: PcmFramerOptions = {}) {
    const outputRate = options.outputRate ?? INPUT_SAMPLE_RATE;
    const inputRate = options.inputRate ?? outputRate;
    this.frame = new Int16Array(options.frameSamples ?? FRAME_SAMPLES);
    const resampler = new StreamResampler(inputRate, outputRate);
    this.resampler = resampler.isPassThrough ? null : resampler;
  }

  /** Whether incoming audio is being rate-converted by us rather than by the
   *  browser. Reported to the session log, because it is a quality caveat and a
   *  silent one. */
  get isResampling(): boolean {
    return this.resampler !== null;
  }

  /** Samples held back, waiting for the rest of their frame. */
  get pending(): number {
    return this.offset;
  }

  /** Push one block; get back every frame it completed, in order. */
  push(block: Float32Array): Int16Array[] {
    const samples = this.resampler ? this.resampler.process(block) : block;
    const frames: Int16Array[] = [];
    for (let i = 0; i < samples.length; i += 1) {
      this.frame[this.offset] = floatToPcm16(samples[i]);
      this.offset += 1;
      if (this.offset === this.frame.length) {
        // A copy: the frame buffer is reused for the next one.
        frames.push(this.frame.slice());
        this.offset = 0;
      }
    }
    return frames;
  }

  /**
   * The partial frame left over when capture stops, or null if there is none.
   *
   * Short by design rather than zero-padded: this is the last thing the
   * candidate said before the épreuve ended, and it goes into the archive that
   * gets graded. Padding it would put up to 40 ms of manufactured silence into a
   * recording used to assess fluency.
   */
  flush(): Int16Array | null {
    if (this.offset === 0) return null;
    const tail = this.frame.slice(0, this.offset);
    this.offset = 0;
    return tail;
  }
}
