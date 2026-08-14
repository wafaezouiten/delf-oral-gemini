/**
 * Examiner audio playback.
 *
 * Gemini streams the examiner's voice as base64 PCM16 at 24 kHz, in chunks that
 * arrive faster than real time. Playing each chunk with `start()` as it lands
 * produces overlapping, garbled speech, so this class keeps a scheduling cursor
 * and queues each buffer to begin exactly where the previous one ends.
 *
 * It also has to be able to stop mid-sentence: when the candidate interrupts,
 * Gemini sends `interrupted` and expects the client to drop everything already
 * queued. Without that, the examiner keeps talking over a question it has
 * already abandoned.
 *
 * The `AudioContext` arrives through {@link AudioContextFactory} rather than
 * being constructed here, for the same reason the Gemini socket does in
 * `session-manager.ts`: the interesting behaviour is all scheduling arithmetic
 * and lifetime bookkeeping, and none of it was reachable by a test while it sat
 * behind a global only a browser provides.
 */

import { OUTPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import { base64ToInt16 } from "./pcm";

// ---------------------------------------------------------------- the seam

/** The subset of `AudioBuffer` this module uses. */
export interface AudioBufferLike {
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
}

/** The subset of `AudioBufferSourceNode` this module uses. */
export interface AudioBufferSourceLike {
  buffer: AudioBufferLike | null;
  onended: (() => void) | null;
  connect(destination: unknown): void;
  disconnect(): void;
  start(when?: number): void;
  stop(when?: number): void;
}

/** The subset of `AudioContext` this module uses. */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: "suspended" | "running" | "closed";
  readonly destination: unknown;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export type AudioContextFactory = (sampleRate: number) => AudioContextLike;

/**
 * The real one.
 *
 * The cast is the single point where DOM types meet this module. It is not
 * laziness: `AudioBufferSourceNode.onended` takes an `Event` and `connect` takes
 * an `AudioNode`, so the browser's types are not *structurally* assignable to a
 * hand-written narrower interface — and widening this one until they were would
 * make the fake in the tests harder to write than the thing it stands in for.
 */
export const browserAudioContext: AudioContextFactory = (sampleRate) =>
  new AudioContext({ sampleRate }) as unknown as AudioContextLike;

// ---------------------------------------------------------------- the player

/**
 * How far ahead of "now" a chunk is scheduled when the queue has drained.
 *
 * Scheduling at exactly `currentTime` means scheduling at a moment the audio
 * thread has already begun rendering, and the browser silently drops whatever
 * part of the buffer that covers — an audible clip on the first syllable of
 * every sentence the examiner starts after a pause. 20 ms is under the
 * threshold at which a listener perceives delay and comfortably more than one
 * render quantum.
 */
const DEFAULT_LEAD_SECONDS = 0.02;

/**
 * Chunks held while the context is still opening. ~1.6 s of speech.
 *
 * Bounded for the same reason the session manager bounds its send buffer: this
 * only fills when something is wrong, and an unbounded buffer turns a stall into
 * a memory leak.
 */
const MAX_PREROLL_CHUNKS = 40;

export interface ExaminerAudioPlayerCallbacks {
  /** Whether the examiner is currently audible. */
  onSpeakingChange?: (speaking: boolean) => void;
  /** Diagnostics for the session log. */
  onEvent?: (name: string, detail?: unknown) => void;
}

export interface ExaminerAudioPlayerOptions extends ExaminerAudioPlayerCallbacks {
  createContext?: AudioContextFactory;
  leadSeconds?: number;
}

export class ExaminerAudioPlayer {
  private context: AudioContextLike | null = null;
  /** Deduplicates concurrent `resume()` calls, which would otherwise each build
   *  an `AudioContext` and leak all but the last. */
  private opening: Promise<void> | null = null;
  /**
   * Bumped by {@link close}. A context being resumed when the sitting ends
   * belongs to nobody by the time it is ready, and installing it would leave a
   * live audio context — and on some platforms a held output device — behind a
   * player that will never be called again.
   */
  private generation = 0;

  /** When the next chunk should start, in AudioContext time. */
  private cursor = 0;
  private queued = new Set<AudioBufferSourceLike>();
  /** Audio that arrived before the context was ready. */
  private preroll: string[] = [];
  private prerollOverflowed = false;
  private speaking = false;
  /**
   * Set once by {@link close}, never cleared — terminal, like the session's own
   * `closed`. Without it a chunk arriving after teardown lands in the pre-roll
   * buffer of a player that will never open a context again: audio held for a
   * playback that cannot happen, on a page that is on its way out.
   */
  private closed = false;

  private readonly createContext: AudioContextFactory;
  private readonly lead: number;
  private readonly callbacks: ExaminerAudioPlayerCallbacks;

  constructor(options: ExaminerAudioPlayerOptions = {}) {
    this.createContext = options.createContext ?? browserAudioContext;
    this.lead = options.leadSeconds ?? DEFAULT_LEAD_SECONDS;
    this.callbacks = options;
  }

  /**
   * Must be called from a user gesture (the "Commencer" click). Browsers start
   * an AudioContext suspended otherwise, and the examiner would be silent with
   * no error to show for it. Safe to call repeatedly.
   */
  async resume(): Promise<void> {
    if (this.closed) return;
    if (this.context) {
      if (this.context.state === "suspended") await this.context.resume();
      return;
    }
    this.opening ??= this.open();
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  private async open(): Promise<void> {
    const generation = this.generation;
    const context = this.createContext(OUTPUT_SAMPLE_RATE);
    try {
      if (context.state === "suspended") await context.resume();
    } catch (error) {
      await closeQuietly(context);
      throw error;
    }

    if (generation !== this.generation) {
      await closeQuietly(context);
      this.callbacks.onEvent?.("playback-context-discarded");
      return;
    }

    this.context = context;
    this.cursor = context.currentTime;
    this.flushPreroll();
  }

  /** Queue one base64 PCM16 chunk from Gemini. */
  enqueue(base64: string): void {
    if (this.closed) return;
    const context = this.context;
    if (!context) {
      this.holdForPlayback(base64);
      return;
    }
    if (context.state === "closed") return;

    const samples = base64ToInt16(base64);
    if (samples.length === 0) return;

    const buffer = context.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) {
      // int16 -> float32. 0x8000 (not 0x7fff) so full-scale negative doesn't clip.
      channel[i] = samples[i] / 0x8000;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    // Never schedule in the past: if the stream stalled, the cursor is behind
    // `currentTime` and the leading samples would be dropped without a word.
    const startAt = Math.max(context.currentTime + this.lead, this.cursor);
    this.queued.add(source);
    source.onended = () => {
      this.queued.delete(source);
      disconnectQuietly(source);
      this.setSpeaking(this.queued.size > 0);
    };
    source.start(startAt);
    this.cursor = startAt + buffer.duration;
    this.setSpeaking(true);
  }

  /** Whether the examiner is currently audible. */
  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Audio scheduled but not yet heard. The examiner's lead over real time —
   *  it should stay bounded across a 13-minute débat, not grow. */
  get bufferedSeconds(): number {
    if (!this.context) return 0;
    return Math.max(0, this.cursor - this.context.currentTime);
  }

  /**
   * Drop everything queued — the candidate interrupted, or the phase ended.
   *
   * The handler is detached before `stop()` rather than left to fire: stopping
   * raises `onended`, and letting it run mid-loop mutates the set being iterated
   * and reports the speaking state down one node at a time.
   */
  interrupt(): void {
    for (const source of this.queued) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* never started */
      }
      disconnectQuietly(source);
    }
    this.queued.clear();
    // Abandoned speech is abandoned whether it reached the audio thread or not.
    this.preroll = [];
    this.prerollOverflowed = false;
    this.cursor = this.context?.currentTime ?? 0;
    this.setSpeaking(false);
  }

  /** Release the audio context, for good. Safe to call twice, and safe to call
   *  while `resume()` is still in flight. */
  async close(): Promise<void> {
    this.closed = true;
    this.generation += 1;
    this.interrupt();
    const context = this.context;
    this.context = null;
    this.cursor = 0;
    if (context) await closeQuietly(context);
  }

  private setSpeaking(next: boolean): void {
    if (this.speaking === next) return;
    this.speaking = next;
    this.callbacks.onSpeakingChange?.(next);
  }

  private holdForPlayback(base64: string): void {
    if (this.preroll.length < MAX_PREROLL_CHUNKS) {
      this.preroll.push(base64);
      return;
    }
    if (!this.prerollOverflowed) {
      this.prerollOverflowed = true;
      this.callbacks.onEvent?.("playback-preroll-overflow", { cap: MAX_PREROLL_CHUNKS });
    }
  }

  private flushPreroll(): void {
    if (this.preroll.length === 0) return;
    const held = this.preroll;
    this.preroll = [];
    this.prerollOverflowed = false;
    this.callbacks.onEvent?.("playback-preroll-flush", { chunks: held.length });
    for (const chunk of held) this.enqueue(chunk);
  }
}

async function closeQuietly(context: AudioContextLike): Promise<void> {
  if (context.state === "closed") return;
  try {
    await context.close();
  } catch {
    /* already closing */
  }
}

function disconnectQuietly(source: AudioBufferSourceLike): void {
  try {
    source.disconnect();
  } catch {
    /* already detached */
  }
}
