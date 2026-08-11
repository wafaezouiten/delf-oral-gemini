/**
 * Microphone capture for the exam.
 *
 * Does two jobs at once from a single microphone stream:
 *
 *  1. **Streams** 16 kHz PCM16 chunks to Gemini Live, as base64.
 *  2. **Archives** every chunk in memory so the candidate's own audio can be
 *     handed to the evaluator afterwards. This is the point of §20 of the brief:
 *     phonologie graded from a transcript is guesswork (the reference
 *     implementation openly instructs the model to infer fluency from the number
 *     of "euh"s), whereas graded from audio it is an actual measurement.
 *
 * The archive is raw PCM, so it must be wrapped in a WAV header before anything
 * else can read it — see `toWavBlob`.
 */

import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";

export interface RecorderCallbacks {
  /** One ~40 ms chunk of base64 PCM16, ready for `sendRealtimeInput`. */
  onChunk: (base64: string) => void;
}

export class MicRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  /** Every captured chunk, kept for the post-exam audio evaluation. */
  private archive: Int16Array[] = [];
  private archivedSamples = 0;

  /** Paused capture still archives nothing and streams nothing. */
  private paused = false;

  constructor(private readonly callbacks: RecorderCallbacks) {}

  /**
   * Open the microphone and start streaming.
   *
   * The AudioContext is created at 16 kHz so the browser resamples for us. Echo
   * cancellation matters more than usual here: the examiner's voice comes out of
   * the same speakers the microphone hears, and without it Gemini transcribes
   * its own questions as candidate speech and grades them.
   */
  async start(): Promise<void> {
    if (this.context) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.context = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
    await this.context.audioWorklet.addModule("/worklets/pcm-capture.js");

    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, "pcm-capture");

    this.node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (this.paused) return;
      const samples = new Int16Array(event.data);
      this.archive.push(samples);
      this.archivedSamples += samples.length;
      this.callbacks.onChunk(int16ToBase64(samples));
    };

    // The worklet has no output; connecting it to the destination would echo the
    // candidate's own voice back at them. Connecting source -> node is enough to
    // pull frames through the graph.
    this.source.connect(this.node);
  }

  /** Stop streaming and archiving without releasing the microphone. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** Seconds of audio archived so far. */
  get recordedSeconds(): number {
    return this.archivedSamples / INPUT_SAMPLE_RATE;
  }

  get isRecording(): boolean {
    return this.context !== null && !this.paused;
  }

  /** Everything captured so far, as one PCM16 buffer. */
  private flattenArchive(): Int16Array {
    const all = new Int16Array(this.archivedSamples);
    let offset = 0;
    for (const chunk of this.archive) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    return all;
  }

  /**
   * The archived audio as a playable/uploadable WAV blob. Returns null when
   * nothing was captured, so callers can distinguish "silent exam" from "bug".
   */
  toWavBlob(): Blob | null {
    if (this.archivedSamples === 0) return null;
    return pcm16ToWav(this.flattenArchive(), INPUT_SAMPLE_RATE);
  }

  /** Release the microphone and the audio graph. Safe to call twice. */
  async stop(): Promise<void> {
    this.paused = true;
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.context && this.context.state !== "closed") {
      await this.context.close().catch(() => {
        /* already closing */
      });
    }
    this.context = null;
  }
}

/**
 * Base64-encode PCM samples for the Live API's `audio.data` field.
 *
 * Chunked because `String.fromCharCode(...array)` blows the argument limit on
 * anything larger than a few tens of kB — a failure that only shows up once
 * someone speaks for a while, which is the worst time to find it.
 */
export function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode base64 PCM (Gemini's audio output) back into samples. */
export function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/**
 * Wrap raw PCM16 in a 44-byte canonical WAV header.
 *
 * Needed because the archive is headerless samples: Gemini's file API, an
 * <audio> element and every desktop player all need the header to know the
 * sample rate. Written by hand rather than pulled from a dependency — it is 44
 * bytes of well-specified format.
 */
export function pcm16ToWav(samples: Int16Array, sampleRate: number): Blob {
  const dataBytes = samples.byteLength;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // file size minus the first 8 bytes
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format 1 = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = rate * channels * 2
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  new Uint8Array(buffer, 44).set(
    new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
  );

  return new Blob([buffer], { type: "audio/wav" });
}
