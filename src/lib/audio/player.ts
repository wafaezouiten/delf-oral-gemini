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
 */

import { OUTPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import { base64ToInt16 } from "./recorder";

export class ExaminerAudioPlayer {
  private context: AudioContext | null = null;
  /** When the next chunk should start, in AudioContext time. */
  private cursor = 0;
  private queued = new Set<AudioBufferSourceNode>();
  private onSpeakingChange?: (speaking: boolean) => void;

  constructor(onSpeakingChange?: (speaking: boolean) => void) {
    this.onSpeakingChange = onSpeakingChange;
  }

  /**
   * Must be called from a user gesture (the "Commencer" click). Browsers start
   * an AudioContext suspended otherwise, and the examiner would be silent with
   * no error to show for it.
   */
  async resume(): Promise<void> {
    this.context ??= new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    if (this.context.state === "suspended") await this.context.resume();
  }

  /** Queue one base64 PCM16 chunk from Gemini. */
  enqueue(base64: string): void {
    if (!this.context) return;
    const samples = base64ToInt16(base64);
    if (samples.length === 0) return;

    const buffer = this.context.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      // int16 -> float32. 0x8000 (not 0x7fff) so full-scale negative doesn't clip.
      channel[i] = samples[i] / 0x8000;
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);

    // Never schedule in the past: if the stream stalled, the cursor is behind
    // currentTime and the chunk would be dropped silently.
    const startAt = Math.max(this.context.currentTime, this.cursor);
    source.start(startAt);
    this.cursor = startAt + buffer.duration;

    if (this.queued.size === 0) this.onSpeakingChange?.(true);
    this.queued.add(source);
    source.onended = () => {
      this.queued.delete(source);
      if (this.queued.size === 0) this.onSpeakingChange?.(false);
    };
  }

  /** Whether the examiner is currently audible. */
  get isSpeaking(): boolean {
    return this.queued.size > 0;
  }

  /**
   * Drop everything queued — the candidate interrupted, or the phase ended.
   * Stopping a node fires `onended`, which clears it from the set.
   */
  interrupt(): void {
    for (const source of this.queued) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.queued.clear();
    this.cursor = this.context?.currentTime ?? 0;
    this.onSpeakingChange?.(false);
  }

  async close(): Promise<void> {
    this.interrupt();
    if (this.context && this.context.state !== "closed") {
      await this.context.close().catch(() => {
        /* already closing */
      });
    }
    this.context = null;
  }
}
