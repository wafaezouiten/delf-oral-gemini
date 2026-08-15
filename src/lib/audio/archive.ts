/**
 * The candidate's own recording, cut into the artefacts a correction is
 * defended with: one per speaking phase, each carrying a duration that was
 * **measured** rather than read off a clock.
 *
 * Three decisions, each a departure from what the recorder did before:
 *
 *  - **One artefact per phase, not one per sitting.** The monologue suivi and
 *    the débat are separate tasks with separate duration floors (168 s and
 *    312 s, `minDurationSeconds(tache)`), and one 20-minute file cannot say
 *    which half the candidate ran short on. Two artefacts can, and they are also
 *    the two things a candidate re-listens to.
 *
 *  - **The duration comes from the samples.** `sampleCount / sampleRate` and
 *    nothing else. The wall clock says how long the phase lasted; it does not
 *    say how much audio exists, and the two diverge exactly when it matters — a
 *    backgrounded tab whose audio graph the browser suspended, a headset
 *    unplugged four minutes in, a permission revoked mid-sentence. All three
 *    leave a phase that "lasted" seven minutes and a recording of ninety
 *    seconds. Since this number feeds the Phase 1 duration penalty, taking it
 *    from the clock would mean penalising against audio nobody has.
 *
 *  - **Audio captured outside a phase is discarded, not filed.** The microphone
 *    opens at the monologue boundary, a moment or two before the phase itself
 *    begins; the examiner's closing sentence lands after it ends. Neither is
 *    part of either task. Dropping them is what makes "this artefact is the
 *    monologue" true rather than approximately true — and {@link discarded}
 *    keeps it from being silent.
 *
 * Everything here is deliberately free of the browser and of the transport: it
 * takes PCM16 frames and gives back blobs, which is what makes the duration
 * arithmetic testable without a microphone. Which *format* those blobs are in is
 * the transport's business and is injected — see {@link RecordingEncoder}, and
 * #24 for why a sitting can no longer leave the tab as PCM.
 */

import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import { pcm16ToWav } from "./pcm";

/**
 * The phases that produce a recording — the two the candidate speaks in.
 *
 * Structurally identical to `TranscriptPhase` and to the `oral_speaking_phase`
 * enum, and that is the point: preparation is silent and `finished` is terminal,
 * so neither can own an artefact.
 */
export type RecordedPhase = "monologue" | "debate";

/** One finished artefact: what gets uploaded, played back and graded. */
export interface PhaseRecording {
  phase: RecordedPhase;
  /** Playable and uploadable — a bare PCM archive is neither. */
  blob: Blob;
  /** What {@link blob} actually is, and what the server will be told to expect:
   *  `audio/ogg` from the Opus encoder, `audio/wav` from the default one. */
  mimeType: string;
  /**
   * Seconds of audio actually captured, measured from the sample count. Never
   * the phase's elapsed time; see the header.
   */
  durationSeconds: number;
  sampleCount: number;
  byteSize: number;
}

/**
 * How the archive turns a phase's samples into the artefact that leaves the tab.
 *
 * Injected rather than chosen here, because the choice is about the transport
 * and this file is about the arithmetic. The exam installs the Opus encoder
 * (`opus-encoder.ts`), which is what makes a 38 MB sitting a 2.4 MB upload; the
 * default below keeps the archive testable without a codec, and keeps
 * `pcm16ToWav` — the only thing that ever writes these samples uncompressed —
 * one call away.
 */
export type RecordingEncoder = (
  pcm: Int16Array,
  sampleRate: number,
) => Promise<{ blob: Blob; mimeType: string }>;

/** The artefact this application produced before Opus, and the one every test
 *  that is not about compression still uses. */
export const wavRecordingEncoder: RecordingEncoder = async (pcm, sampleRate) => ({
  blob: pcm16ToWav(pcm, sampleRate),
  mimeType: "audio/wav",
});

interface Segment {
  frames: Int16Array[];
  samples: number;
}

export class PhaseArchive {
  /** Insertion-ordered, so `all()` returns the monologue before the débat
   *  without having to know the exam's shape. */
  private readonly segments = new Map<RecordedPhase, Segment>();
  private open: RecordedPhase | null = null;
  /** Samples that arrived while no phase was open. Reported, not filed. */
  private discardedSamples = 0;

  constructor(
    readonly sampleRate: number = INPUT_SAMPLE_RATE,
    private readonly encode: RecordingEncoder = wavRecordingEncoder,
  ) {
    if (!(sampleRate > 0)) {
      throw new RangeError(`A recording cannot be measured at ${sampleRate} Hz`);
    }
  }

  /**
   * Start (or resume) filing audio under a phase.
   *
   * Re-opening the phase that is already open is a no-op rather than a reset:
   * a phase is entered once, but the controller ensures the microphone is ready
   * on more than one path into it, and a reset would silently truncate the
   * artefact to whatever came after the second call.
   */
  begin(phase: RecordedPhase): void {
    if (this.open === phase) return;
    if (!this.segments.has(phase)) this.segments.set(phase, { frames: [], samples: 0 });
    this.open = phase;
  }

  /** Stop filing. Audio that arrives now belongs to no task. */
  end(): void {
    this.open = null;
  }

  /** Which phase is being recorded, or null between phases. */
  get openPhase(): RecordedPhase | null {
    return this.open;
  }

  /** Samples captured while no phase was open — the count, so it can be said
   *  out loud rather than inferred from a gap. */
  get discarded(): number {
    return this.discardedSamples;
  }

  /** File one PCM16 frame under the open phase. Retains the frame; callers must
   *  hand over a buffer they will not reuse (the framer already copies). */
  append(frame: Int16Array): void {
    if (frame.length === 0) return;
    const segment = this.open === null ? null : this.segments.get(this.open);
    if (!segment) {
      this.discardedSamples += frame.length;
      return;
    }
    segment.frames.push(frame);
    segment.samples += frame.length;
  }

  /** Samples filed under a phase. */
  samplesIn(phase: RecordedPhase): number {
    return this.segments.get(phase)?.samples ?? 0;
  }

  /**
   * The measured length of a phase's recording, in seconds. Zero for a phase
   * that captured nothing, which is a real answer — a candidate whose
   * microphone died has no audio, and the penalty rules should hear that.
   */
  measuredSeconds(phase: RecordedPhase): number {
    return this.samplesIn(phase) / this.sampleRate;
  }

  /** Measured seconds across every phase. */
  get totalSeconds(): number {
    let samples = 0;
    for (const segment of this.segments.values()) samples += segment.samples;
    return samples / this.sampleRate;
  }

  /**
   * One phase's artefact, or null when that phase captured nothing.
   *
   * Null rather than an empty file so a caller can tell "the microphone never
   * worked" from "here is a zero-length recording", which is the difference
   * between a bug to report and a grade to withhold.
   *
   * Asynchronous because compressing a phase is: the encoder runs off the main
   * thread and a 13-minute débat is not free. Note what is NOT waited on —
   * `durationSeconds` and `sampleCount` are the archive's own count of what it
   * filed, so the number the duration penalty rests on does not depend on the
   * codec having behaved.
   */
  async recordingFor(phase: RecordedPhase): Promise<PhaseRecording | null> {
    const segment = this.segments.get(phase);
    if (!segment || segment.samples === 0) return null;

    const pcm = new Int16Array(segment.samples);
    let offset = 0;
    for (const frame of segment.frames) {
      pcm.set(frame, offset);
      offset += frame.length;
    }

    // Always at the archive's rate, whatever the device ran at: the framer has
    // already converted, so what the file declares is a fact rather than a claim.
    const { blob, mimeType } = await this.encode(pcm, this.sampleRate);
    return {
      phase,
      blob,
      mimeType,
      durationSeconds: segment.samples / this.sampleRate,
      sampleCount: segment.samples,
      byteSize: blob.size,
    };
  }

  /**
   * Every artefact with audio in it, in the order the phases were entered.
   *
   * One phase at a time rather than both at once: the encoder is a device with a
   * queue, and handing it a whole sitting in parallel buys nothing on the one
   * thread it drains on.
   */
  async all(): Promise<PhaseRecording[]> {
    const recordings: PhaseRecording[] = [];
    for (const phase of this.segments.keys()) {
      const recording = await this.recordingFor(phase);
      if (recording) recordings.push(recording);
    }
    return recordings;
  }

  /**
   * Drop everything held.
   *
   * A twenty-minute sitting is roughly 38 MB of PCM sitting in a tab that is
   * about to navigate to the results page. Releasing it once the blobs are cut
   * is not tidiness, it is the difference between one sitting and three in the
   * same tab.
   */
  clear(): void {
    this.segments.clear();
    this.open = null;
    this.discardedSamples = 0;
  }
}
