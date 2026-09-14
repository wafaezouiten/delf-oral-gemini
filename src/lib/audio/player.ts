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
import type { PlayerLike } from "./ports";
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
 * Chunks held while the context is still opening — or suspended. ~40 s of
 * speech, sized for the longest thing it has to survive whole: the débat's
 * opening question arriving while the context waits on the browser (#94). It
 * used to be 40 chunks (~1.6 s), sized for a connection race measured in
 * milliseconds, and a suspension measured in seconds silently dropped
 * everything past the first breath of the question.
 *
 * Still bounded, for the same reason the session manager bounds its send
 * buffer: this only fills while something is wrong, and an unbounded buffer
 * turns a stall into a memory leak. At ~2.5 KB of base64 per 40 ms chunk the
 * cap is a couple of megabytes, held only for as long as the outage lasts.
 */
const MAX_PREROLL_CHUNKS = 1000;

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

export class ExaminerAudioPlayer implements PlayerLike {
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
  /** A resume kicked off by {@link enqueue} finding the context suspended.
   *  One at a time: under autoplay policy the promise can sit unresolved until
   *  the next user gesture, and every chunk of a held question arrives while it
   *  does. */
  private waking = false;
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
    const context = this.context;
    if (context) {
      if (context.state === "suspended") {
        await context.resume();
        // The sitting can end, or the context be replaced, while the browser
        // is deciding — a resume that resolves then belongs to nobody.
        if (this.closed || this.context !== context) return;
        // Play what the suspension held back. The cursor may still point into
        // the frozen past; `enqueue` clamps to `currentTime + lead` on its own.
        this.flushPreroll();
      }
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

    // A suspended context is the unheard first question (#94). It accepts
    // `start()` calls and plays nothing: its clock is frozen, so every source
    // lands at a time that has already passed, and whenever the context does
    // resume the whole backlog fires at once as garble. Treat it like a context
    // that has not opened yet — hold the chunk, ask the browser to wake it —
    // and abandon whatever was already scheduled into the frozen graph, because
    // that cannot be replayed in order and a question restarting cleanly beats
    // its backlog arriving as one burst.
    if (context.state === "suspended") {
      this.dropFrozenQueue(context);
      this.holdForPlayback(base64);
      this.wake();
      return;
    }

    // Anything held for a suspension plays before the chunk in hand, or the
    // question comes out with its middle moved to the front. Reached when the
    // context resumed between two chunks, before `resume()`'s own flush ran.
    this.flushPreroll();

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
   * The speaker's own clock — the one thing a dead speaker cannot move.
   *
   * `AudioContext.currentTime` advances while and only while the context is
   * running, whatever is or is not queued on top of it. That makes it the
   * honest answer to "is this device actually playing?", which the queue's
   * length is not: a queue that is not shrinking is either a suspended context
   * or Gemini streaming a turn in faster than it is spoken, and those two are
   * the same picture (see `ExamController.examinerPlaybackHold`, which used to
   * read them off `bufferedSeconds` and could not tell them apart).
   *
   * Zero with no context. The reader compares consecutive samples for CHANGE
   * rather than growth, so a context that is replaced — and starts counting
   * from zero again — reads as moving rather than as frozen.
   */
  get playedSeconds(): number {
    return this.context?.currentTime ?? 0;
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

  /**
   * Stop and detach everything scheduled into a clock that is not moving.
   *
   * The sources' base64 is gone — a buffer handed to the graph cannot be read
   * back into the queue — so what was scheduled-but-unplayed at the moment of
   * suspension is lost. Bounded loss: at most the player's own lead over real
   * time, and the alternative is the whole backlog playing at once on resume.
   * The speaking flag comes down with it, which is the honest report — nothing
   * is audible — and what lets the exam's silence escalation run over a
   * speaker that is genuinely broken.
   */
  private dropFrozenQueue(context: AudioContextLike): void {
    if (this.queued.size === 0) return;
    this.callbacks.onEvent?.("playback-frozen-dropped", { sources: this.queued.size });
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
    this.cursor = context.currentTime;
    this.setSpeaking(false);
  }

  /** Ask the browser to resume the suspended context, once per outage. The
   *  attempt can be refused (autoplay policy wants a user gesture); the exam's
   *  own gesture-borne `resume()` — the « Enregistrer » click — is the recovery
   *  that cannot be, and either one flushes what was held. */
  private wake(): void {
    if (this.waking) return;
    this.waking = true;
    void this.resume()
      .catch(() => this.callbacks.onEvent?.("playback-wake-failed"))
      .finally(() => {
        this.waking = false;
      });
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
