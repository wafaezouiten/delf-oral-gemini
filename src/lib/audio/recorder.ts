/**
 * Microphone capture for the exam.
 *
 * Does two jobs at once from a single microphone stream:
 *
 *  1. **Streams** 16 kHz PCM16 frames to Gemini Live, as base64.
 *  2. **Archives** every frame in memory so the candidate's own audio can be
 *     handed to the evaluator afterwards. This is the point of §20 of the brief:
 *     phonologie graded from a transcript is guesswork (the reference
 *     implementation openly instructs the model to infer fluency from the number
 *     of "euh"s), whereas graded from audio it is an actual measurement.
 *
 * The archive is raw PCM, so it must be wrapped in a WAV header before anything
 * else can read it — see `pcm16ToWav`.
 *
 * The browser lives behind {@link MicrophoneOpener}. What is left here — framing,
 * the archive, and the lifetime of a device that a candidate can revoke, deny or
 * navigate away from mid-prompt — is then testable, which is what the leak
 * assertions in `recorder.test.ts` rest on.
 */

import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import { PcmFramer, frameSamplesAt } from "./framing";
import { int16ToBase64, pcm16ToWav } from "./pcm";

// ---------------------------------------------------------------- the seam

/** An open microphone, reduced to what capture actually needs from it. */
export interface CaptureStream {
  /**
   * The rate blocks actually arrive at — **not necessarily the one requested**.
   * Whether the browser honoured 16 kHz is the single fact that decides whether
   * the framer has to resample.
   */
  readonly sampleRate: number;
  /** Float32 blocks from the audio thread. Set to null to stop listening. */
  onBlock: ((block: Float32Array) => void) | null;
  /** Release the device and the audio graph. */
  close(): Promise<void>;
}

export type MicrophoneOpener = (request: { requestedRate: number }) => Promise<CaptureStream>;

/**
 * The real microphone.
 *
 * Two things here are load-bearing:
 *
 *  - **Echo cancellation.** The examiner's voice comes out of the same speakers
 *    the microphone hears, and without it Gemini transcribes its own questions as
 *    candidate speech and grades them.
 *  - **The catch.** Everything after `getUserMedia` resolves can throw — a
 *    missing worklet file, a context the browser refuses, a candidate revoking
 *    permission — and every one of those paths used to leave a LIVE microphone
 *    behind. The recording indicator stays lit on a page that has given up, which
 *    is both a leak and, to the candidate, a lie.
 */
export const browserMicrophone: MicrophoneOpener = async ({ requestedRate }) => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  let context: AudioContext | null = null;
  try {
    const audio = openContextAt(requestedRate);
    context = audio;
    await audio.audioWorklet.addModule("/worklets/pcm-capture.js");

    const source = audio.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(audio, "pcm-capture", {
      // Sized from the rate we actually got, so one message is ~40 ms of audio
      // whether the context runs at 16 kHz or fell back to 48.
      processorOptions: { frameSamples: frameSamplesAt(audio.sampleRate) },
    });

    const capture: CaptureStream = {
      sampleRate: audio.sampleRate,
      onBlock: null,
      async close() {
        node.port.onmessage = null;
        this.onBlock = null;
        node.disconnect();
        source.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        if (audio.state !== "closed") {
          await audio.close().catch(() => {
            /* already closing */
          });
        }
      },
    };

    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      capture.onBlock?.(new Float32Array(event.data));
    };

    // The worklet has no output worth hearing; connecting it to the destination
    // would echo the candidate's own voice back at them. Connecting
    // source -> node is enough to pull frames through the graph.
    source.connect(node);
    return capture;
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed") {
      await context.close().catch(() => {
        /* already closing */
      });
    }
    throw error;
  }
};

/**
 * An `AudioContext` at the rate we asked for, if the browser will give us one.
 *
 * Asking is much better than resampling ourselves — the browser's converter is
 * properly filtered and ours is a box average. But Safari has historically
 * rejected a requested rate by throwing, and a thrown constructor here would
 * present to the candidate as "le microphone n'est pas accessible" on a machine
 * whose microphone is fine.
 */
function openContextAt(sampleRate: number): AudioContext {
  try {
    return new AudioContext({ sampleRate });
  } catch {
    return new AudioContext();
  }
}

// ---------------------------------------------------------------- the recorder

export interface RecorderCallbacks {
  /** One ~40 ms frame of base64 PCM16, ready for `sendRealtimeInput`. */
  onChunk: (base64: string) => void;
  /** Diagnostics for the session log. */
  onEvent?: (name: string, detail?: unknown) => void;
}

export interface MicRecorderOptions extends RecorderCallbacks {
  openMicrophone?: MicrophoneOpener;
}

export class MicRecorder {
  private capture: CaptureStream | null = null;
  private framer: PcmFramer | null = null;

  /** Deduplicates concurrent `start()` calls. Without it, two of them open two
   *  microphones and only the second is ever closed. */
  private starting: Promise<void> | null = null;
  /**
   * Bumped by {@link stop}. A `getUserMedia` prompt can sit on screen for as
   * long as the candidate takes to click it, and the sitting can end in that
   * window; the device that arrives afterwards belongs to nobody.
   */
  private generation = 0;

  /** Every captured frame, kept for the post-exam audio evaluation. */
  private archive: Int16Array[] = [];
  private archivedSamples = 0;

  /** Paused capture archives nothing and streams nothing. */
  private paused = false;

  private readonly callbacks: RecorderCallbacks;
  private readonly openMicrophone: MicrophoneOpener;

  constructor(options: MicRecorderOptions) {
    this.callbacks = options;
    this.openMicrophone = options.openMicrophone ?? browserMicrophone;
  }

  /** Open the microphone and start streaming. Safe to call twice. */
  async start(): Promise<void> {
    if (this.capture) return;
    this.starting ??= this.open();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async open(): Promise<void> {
    const generation = this.generation;
    const capture = await this.openMicrophone({ requestedRate: INPUT_SAMPLE_RATE });

    if (generation !== this.generation) {
      await closeQuietly(capture);
      this.callbacks.onEvent?.("capture-discarded", "the sitting ended while the mic was opening");
      return;
    }

    const framer = new PcmFramer({
      inputRate: capture.sampleRate,
      outputRate: INPUT_SAMPLE_RATE,
    });
    if (framer.isResampling) {
      // Worth saying out loud. It is not an error — the audio still reaches
      // Gemini at 16 kHz — but it means the samples went through our box filter
      // rather than the browser's, on an exam that grades pronunciation.
      this.callbacks.onEvent?.("capture-rate-mismatch", {
        got: capture.sampleRate,
        want: INPUT_SAMPLE_RATE,
      });
    }

    this.framer = framer;
    this.capture = capture;
    this.paused = false;
    capture.onBlock = (block) => this.consume(block);
    this.callbacks.onEvent?.("capture-started", { sampleRate: capture.sampleRate });
  }

  private consume(block: Float32Array): void {
    if (this.paused || !this.framer) return;
    for (const frame of this.framer.push(block)) {
      this.archive.push(frame);
      this.archivedSamples += frame.length;
      this.callbacks.onChunk(int16ToBase64(frame));
    }
  }

  /** Stop streaming and archiving without releasing the microphone. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (this.capture) this.paused = false;
  }

  /** Seconds of audio archived so far. */
  get recordedSeconds(): number {
    return this.archivedSamples / INPUT_SAMPLE_RATE;
  }

  get isRecording(): boolean {
    return this.capture !== null && !this.paused;
  }

  /** The rate the microphone is running at, or null before it opens. Differs
   *  from {@link INPUT_SAMPLE_RATE} only when the browser refused our request. */
  get captureRate(): number | null {
    return this.capture?.sampleRate ?? null;
  }

  /** Everything captured so far, as one PCM16 buffer. */
  private flattenArchive(): Int16Array {
    const all = new Int16Array(this.archivedSamples);
    let offset = 0;
    for (const frame of this.archive) {
      all.set(frame, offset);
      offset += frame.length;
    }
    return all;
  }

  /**
   * The archived audio as a playable/uploadable WAV blob. Returns null when
   * nothing was captured, so callers can distinguish "silent exam" from "bug".
   *
   * Always at {@link INPUT_SAMPLE_RATE}, whatever the device ran at: the framer
   * has already converted, so the header is not a claim about the hardware.
   */
  toWavBlob(): Blob | null {
    if (this.archivedSamples === 0) return null;
    return pcm16ToWav(this.flattenArchive(), INPUT_SAMPLE_RATE);
  }

  /** Release the microphone and the audio graph. Safe to call twice, and safe
   *  to call while `start()` is still waiting on the permission prompt. */
  async stop(): Promise<void> {
    this.paused = true;
    this.generation += 1;

    // Awaited so a caller that awaits `stop()` really has released the device,
    // rather than releasing it a tick after the page decided it had. `open()`
    // sees the bumped generation and closes what it opened instead of
    // installing it.
    if (this.starting) {
      await this.starting.catch(() => {
        /* the failure is the caller of start()'s to report, not ours */
      });
    }

    const capture = this.capture;
    this.capture = null;
    if (capture) capture.onBlock = null;

    // The last partial frame is the candidate's final words. It is too late to
    // send — the session is closing — but it belongs in the archive that gets
    // graded, and dropping it silently loses up to 40 ms of every sitting.
    const tail = this.framer?.flush();
    if (tail && tail.length > 0) {
      this.archive.push(tail);
      this.archivedSamples += tail.length;
    }
    this.framer = null;

    if (capture) await closeQuietly(capture);
  }
}

async function closeQuietly(capture: CaptureStream): Promise<void> {
  try {
    await capture.close();
  } catch {
    /* already gone */
  }
}
