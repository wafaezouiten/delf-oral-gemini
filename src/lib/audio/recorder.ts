/**
 * Microphone capture for the exam.
 *
 * Does two jobs at once from a single microphone stream:
 *
 *  1. **Streams** 16 kHz PCM16 frames to Gemini Live, as base64.
 *  2. **Records** the candidate, one artefact per speaking phase, so a
 *     correction can be defended and re-listened to. This is the point of §20 of
 *     the brief: phonologie graded from a transcript is guesswork (the reference
 *     implementation openly instructs the model to infer fluency from the number
 *     of "euh"s), whereas graded from audio it is an actual measurement.
 *
 * The two jobs share a microphone and a framer and nothing else. That
 * independence is deliberate and is the property Phase 6 is really about: the
 * Live socket goes away several times in a normal sitting — a GoAway at the
 * connection limit, a phase boundary that tears the session down and builds a
 * new one, ten seconds of bad hotel wifi — and none of that may punch a hole in
 * the recording. `sendAudio` on a closed session is a no-op; the archive keeps
 * filling either way. Conversely, a phase that has ended stops recording while
 * the socket is still open for the examiner's closing sentence.
 *
 * The recording itself lives in {@link PhaseArchive}, which owns the one number
 * this phase exists to get right: a duration measured from the samples rather
 * than assumed from the clock.
 *
 * The browser lives behind {@link MicrophoneOpener}. What is left here — framing,
 * the recording, and the lifetime of a device that a candidate can revoke, deny,
 * unplug or navigate away from mid-prompt — is then testable, which is what the
 * leak assertions in `recorder.test.ts` rest on.
 */

import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import type { RecorderLike } from "./ports";
import {
  PhaseArchive,
  type PhaseRecording,
  type RecordedPhase,
  type RecordingEncoder,
} from "./archive";
import { PcmFramer, frameSamplesAt } from "./framing";
import { opusRecordingEncoder } from "./opus-encoder";
import { int16ToBase64 } from "./pcm";

export type { PhaseRecording, RecordedPhase } from "./archive";

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
  /**
   * The device stopped producing audio on its own — a headset unplugged, a
   * permission revoked from the browser's site controls, an OS that handed the
   * microphone to another application.
   *
   * Worth a callback rather than silence because it is invisible otherwise: the
   * blocks simply stop, the clock keeps running, and the candidate carries on
   * speaking into a page that looks exactly like a working one for the rest of
   * the phase.
   */
  onLost: ((reason: string) => void) | null;
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
      onLost: null,
      async close() {
        node.port.onmessage = null;
        this.onBlock = null;
        this.onLost = null;
        // Detached before the tracks are stopped: `stop()` fires `ended` on some
        // engines and not others, and an ordinary teardown reported as a lost
        // device would tell the candidate their microphone failed at the exact
        // moment the épreuve ended well.
        stream.getTracks().forEach((track) => {
          track.onended = null;
          track.stop();
        });
        node.disconnect();
        source.disconnect();
        if (audio.state !== "closed") {
          await audio.close().catch(() => {
            /* already closing */
          });
        }
      },
    };

    // A track ends when the device goes away underneath us. There is normally
    // exactly one (mono capture), but the loss is reported from whichever ends
    // first — any of them ending means the capture is over.
    stream.getTracks().forEach((track) => {
      track.onended = () => capture.onLost?.(`the ${track.kind} track ended`);
    });

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
  /**
   * The device stopped mid-sitting. Fired once per capture; the recording so far
   * is intact and stays intact, so the caller's job is to say so, not to salvage
   * anything.
   */
  onLost?: (reason: string) => void;
}

export interface MicRecorderOptions extends RecorderCallbacks {
  openMicrophone?: MicrophoneOpener;
  /** How a phase's samples become the artefact that is uploaded. Defaults to
   *  Opus; injected so a test can archive without a codec. */
  encodeRecording?: RecordingEncoder;
}

export class MicRecorder implements RecorderLike {
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

  /**
   * The recording, cut per phase. Owned by the recorder rather than handed in,
   * because its lifetime is the microphone's: it must survive every reconnect
   * and every phase boundary, and die with the device.
   */
  private readonly archive: PhaseArchive;

  /** Set once, when the device goes away under us. Terminal: a capture that
   *  ended does not come back, and a second report of it is noise. */
  private lost = false;

  /** Paused capture records nothing and streams nothing. */
  private paused = false;

  private readonly callbacks: RecorderCallbacks;
  private readonly openMicrophone: MicrophoneOpener;

  constructor(options: MicRecorderOptions) {
    this.callbacks = options;
    this.openMicrophone = options.openMicrophone ?? browserMicrophone;
    this.archive = new PhaseArchive(
      INPUT_SAMPLE_RATE,
      options.encodeRecording ??
        // A browser that cannot encode Opus produces a WAV that the finish route
        // will refuse as too large. Said out loud here rather than discovered as
        // a 413: this is the one path on which a sitting loses its audio.
        opusRecordingEncoder({
          onFallback: (reason) => this.callbacks.onEvent?.("recording-encode-fallback", reason),
        }),
    );
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
    capture.onLost = (reason) => this.handleLoss(reason);
    this.callbacks.onEvent?.("capture-started", { sampleRate: capture.sampleRate });
  }

  private consume(block: Float32Array): void {
    if (this.paused || !this.framer) return;
    for (const frame of this.framer.push(block)) {
      // Recorded first, sent second, and neither depends on the other: a frame
      // belongs in the artefact whether or not there is a socket to send it on.
      this.archive.append(frame);
      this.callbacks.onChunk(int16ToBase64(frame));
    }
  }

  /**
   * The device went away mid-sitting.
   *
   * Deliberately does NOT tear the capture down. Nothing more will arrive, so
   * there is nothing to stop; closing from inside the device's own event handler
   * would race whatever teardown the page is already running, and this file has
   * enough scars from exactly that shape of bug. What the recording has is kept,
   * and the measured duration then tells the truth about the phase without
   * anyone having to reconstruct it.
   */
  private handleLoss(reason: string): void {
    if (this.lost || !this.capture) return;
    this.lost = true;
    this.callbacks.onEvent?.("capture-lost", {
      reason,
      recordedSeconds: Number(this.archive.totalSeconds.toFixed(2)),
    });
    this.callbacks.onLost?.(reason);
  }

  /**
   * Start recording this phase. Streaming is unaffected — it never stopped.
   *
   * Called at the phase boundary rather than when the microphone opens, so the
   * moment or two of room tone between the permission prompt and the exposé does
   * not end up inside the monologue's artefact.
   */
  beginPhase(phase: RecordedPhase): void {
    this.archive.begin(phase);
    this.callbacks.onEvent?.("recording-phase-started", phase);
  }

  /**
   * Stop recording the current phase, keeping what it captured.
   *
   * Flushes the framer first: the partial frame it is holding is the last thing
   * the candidate said before the phase ended, and it belongs to the phase that
   * is closing rather than to the one about to open. Too late to send — the
   * session for that phase is being torn down — but never too late to record.
   */
  endPhase(): void {
    const phase = this.archive.openPhase;
    // Flushed unconditionally, so the framer never carries one phase's last
    // milliseconds into the next one's artefact. With no phase open the tail
    // belongs to nobody and the archive counts it as discarded.
    this.flushTail();
    if (!phase) return;
    this.archive.end();
    this.callbacks.onEvent?.("recording-phase-ended", {
      phase,
      seconds: Number(this.archive.measuredSeconds(phase).toFixed(2)),
    });
  }

  /** Move the framer's partial frame into the recording, if there is one. */
  private flushTail(): void {
    const tail = this.framer?.flush();
    if (tail && tail.length > 0) this.archive.append(tail);
  }

  /** Stop streaming and recording without releasing the microphone. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (this.capture) this.paused = false;
  }

  /** Seconds of audio recorded so far, across every phase. Measured from the
   *  samples; see {@link PhaseArchive}. */
  get recordedSeconds(): number {
    return this.archive.totalSeconds;
  }

  /** Seconds recorded for one phase — the number the duration penalty is
   *  computed from. */
  measuredSeconds(phase: RecordedPhase): number {
    return this.archive.measuredSeconds(phase);
  }

  /** Seconds of a phase that carried speech rather than an open microphone in a
   *  quiet room. See `PhaseArchive.voicedSeconds`. */
  voicedSeconds(phase: RecordedPhase): number {
    return this.archive.voicedSeconds(phase);
  }

  /** The same, counted only while the examiner was silent — the evidence the
   *  finish route weighs against an empty transcript. See
   *  `PhaseArchive.soloVoicedSeconds`, which is where the distinction is argued. */
  soloVoicedSeconds(phase: RecordedPhase): number {
    return this.archive.soloVoicedSeconds(phase);
  }

  /** And how long the candidate had to produce it — the seconds recorded with
   *  the examiner silent, speech or not. See `PhaseArchive.soloSeconds`. */
  soloSeconds(phase: RecordedPhase): number {
    return this.archive.soloSeconds(phase);
  }

  /** Whether the examiner is audible right now, which the microphone cannot
   *  tell from the candidate. Passed straight through; the archive owns what it
   *  does with it. */
  setPlaybackAudible(audible: boolean): void {
    this.archive.setPlaybackAudible(audible);
  }

  /** The phase currently being recorded, or null between phases. */
  get recordingPhase(): RecordedPhase | null {
    return this.archive.openPhase;
  }

  /** Discard one phase's recording entirely — the phase whose content was
   *  typed (#51). The decision is the controller's; what it costs and why the
   *  samples stay countable is `PhaseArchive.drop`'s. */
  dropPhase(phase: RecordedPhase): void {
    const samples = this.archive.drop(phase);
    if (samples > 0) {
      this.callbacks.onEvent?.("recording-dropped", {
        phase,
        seconds: Number((samples / this.archive.sampleRate).toFixed(2)),
      });
    }
  }

  /** Whether the device went away mid-sitting. */
  get isLost(): boolean {
    return this.lost;
  }

  get isRecording(): boolean {
    return this.capture !== null && !this.paused && !this.lost;
  }

  /** The rate the microphone is running at, or null before it opens. Differs
   *  from {@link INPUT_SAMPLE_RATE} only when the browser refused our request. */
  get captureRate(): number | null {
    return this.capture?.sampleRate ?? null;
  }

  /**
   * One phase's recording as a playable, uploadable file, or null when that
   * phase captured nothing — so a caller can tell a silent phase from a bug.
   *
   * Always at {@link INPUT_SAMPLE_RATE}, whatever the device ran at: the framer
   * has already converted, so what the file declares is not a claim about the
   * hardware.
   */
  recordingFor(phase: RecordedPhase): Promise<PhaseRecording | null> {
    return this.archive.recordingFor(phase);
  }

  /** Every phase that produced audio, in the order they were recorded.
   *  Compressing them is the slow part of finishing an exam; see
   *  {@link PhaseArchive.all}. */
  recordings(): Promise<PhaseRecording[]> {
    return this.archive.all();
  }

  /** Release the microphone and the audio graph. Safe to call twice, and safe
   *  to call while `start()` is still waiting on the permission prompt.
   *
   *  The recording SURVIVES: `stop()` releases a device, it does not discard an
   *  artefact. Callers read `recordings()` afterwards, and a stop that wiped
   *  them would make the ordering between "release the microphone" and "take the
   *  audio" a trap. Use `discard()` to actually free the memory. */
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
    if (capture) {
      capture.onBlock = null;
      capture.onLost = null;
    }

    // The last partial frame is the candidate's final words. It is too late to
    // send — the session is closing — but it belongs in the recording that gets
    // graded, and dropping it silently loses up to 40 ms of every sitting.
    // Flushed BEFORE the phase is closed, so those words land in the phase they
    // were spoken in rather than in nothing.
    this.endPhase();
    this.framer = null;

    if (capture) await closeQuietly(capture);
  }

  /** Release the recording's memory. Separate from {@link stop} on purpose: a
   *  sitting's PCM is tens of megabytes, and the page that no longer needs it is
   *  never the same code as the one releasing the device. */
  discard(): void {
    this.archive.clear();
  }
}

async function closeQuietly(capture: CaptureStream): Promise<void> {
  try {
    await capture.close();
  } catch {
    /* already gone */
  }
}
