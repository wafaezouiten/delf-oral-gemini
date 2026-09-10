/**
 * The candidate's own recording, cut into the artefacts a correction is
 * defended with: one per speaking phase, each carrying a duration that was
 * **measured** rather than read off a clock.
 *
 * Three decisions, each a departure from what the recorder did before:
 *
 *  - **One artefact per phase, not one per sitting.** The monologue suivi and
 *    the débat are separate tasks, each placed in its own duration tier and
 *    charged to its own criterion (`orale-rubric.ts`), and one 20-minute file
 *    cannot say which half the candidate ran short on. Two artefacts can, and they are also
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
import { isVoiced } from "./voice-activity";

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
  /** Samples in frames that carried speech rather than room tone. See
   *  {@link voicedSeconds} for what this is and is not. */
  voicedSamples: number;
  /** The same count, taken only while nothing else was audible in the room.
   *  See {@link soloVoicedSeconds} for why the two must not be conflated. */
  soloVoicedSamples: number;
}

export class PhaseArchive {
  /** Insertion-ordered, so `all()` returns the monologue before the débat
   *  without having to know the exam's shape. */
  private readonly segments = new Map<RecordedPhase, Segment>();
  private open: RecordedPhase | null = null;
  /** Samples that arrived while no phase was open. Reported, not filed. */
  private discardedSamples = 0;
  /**
   * Whether somebody other than the candidate is audible in the room right now.
   *
   * Set from outside because the archive cannot know: it sees the microphone's
   * frames and nothing else, and the examiner reaches the microphone the same
   * way a passing lorry does. `false` until told otherwise, which is what an
   * archive with no speaker beside it — every test, and the monologue — should
   * assume. See {@link soloVoicedSeconds}.
   */
  private playbackAudible = false;
  /**
   * Encodes already made, one per phase, keyed by how many samples they cover.
   *
   * What this buys is #86: the monologue's samples are final the moment the
   * débat begins, so the controller asks for its artefact then — thirteen
   * minutes before anyone is waiting on it — and the finish finds the work
   * already done. The sample count is what makes the reuse honest: a phase
   * re-opened and appended to (the monologue restart, #39) no longer matches
   * its cached count, and is encoded afresh from everything it now holds.
   */
  private readonly encoded = new Map<
    RecordedPhase,
    { sampleCount: number; artefact: Promise<PhaseRecording> }
  >();

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
    if (!this.segments.has(phase)) {
      this.segments.set(phase, { frames: [], samples: 0, voicedSamples: 0, soloVoicedSamples: 0 });
    }
    this.open = phase;
  }

  /** Stop filing. Audio that arrives now belongs to no task. */
  end(): void {
    this.open = null;
  }

  /**
   * Tell the archive whether the examiner is being played into the room.
   *
   * Frames still land in the artefact — the recording is of the épreuve, not of
   * the candidate's turns — and {@link voicedSeconds} still counts them. What
   * changes is {@link soloVoicedSeconds}, which stops accruing for as long as
   * this is true.
   */
  setPlaybackAudible(audible: boolean): void {
    this.playbackAudible = audible;
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
    // Measured on the way past, so nothing has to be re-read to answer "did the
    // candidate actually say anything?" — the frames are retained for the
    // artefact, but walking twenty minutes of them again to decide whether to
    // show a dialog would be work done at exactly the wrong moment.
    if (isVoiced(frame)) {
      segment.voicedSamples += frame.length;
      if (!this.playbackAudible) segment.soloVoicedSamples += frame.length;
    }
  }

  /** Samples filed under a phase that carried speech. */
  voicedSamplesIn(phase: RecordedPhase): number {
    return this.segments.get(phase)?.voicedSamples ?? 0;
  }

  /** Samples filed under a phase that carried speech while the examiner was
   *  silent. See {@link soloVoicedSeconds}. */
  soloVoicedSamplesIn(phase: RecordedPhase): number {
    return this.segments.get(phase)?.soloVoicedSamples ?? 0;
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
  /**
   * Seconds of a phase's recording that carried speech, as opposed to an open
   * microphone in a quiet room.
   *
   * Deliberately NOT the same number as {@link measuredSeconds}, and the gap
   * between them is the whole point: a candidate who sat in silence for a minute
   * measures sixty seconds captured and near zero voiced, while one whose
   * microphone died measures zero of both. Only the first of those is a
   * candidate choosing not to attempt the task, and until this existed nothing
   * could tell them apart (#39).
   *
   * It is a floor, not a transcript. It says something was carried; it cannot
   * say it was French, or the candidate, or on topic. Everything downstream
   * treats it as grounds for asking a question, never for refusing one.
   */
  voicedSeconds(phase: RecordedPhase): number {
    return this.voicedSamplesIn(phase) / this.sampleRate;
  }

  /**
   * The same measure, taken only while the examiner was NOT being played into
   * the room — the closest this file can get to "seconds the candidate spoke".
   *
   * {@link voicedSeconds} answers "was this microphone carrying anything?", and
   * across the monologue that is very nearly the same question, because nobody
   * else is supposed to be audible. Across the débat it is not, and the gap
   * broke a rule that depended on it. The examiner talks for most of a
   * thirteen-minute débat, straight into an open microphone with
   * `autoGainControl` lifting whatever the room has; the browser's echo
   * canceller reduces the return path but does not zero it. Meanwhile the bar
   * downstream (`PARTICIPATION_VOICED_FLOOR`, fifteen seconds) is CUMULATIVE:
   * 375 frames of 40 ms out of the ~16,500 a débat holds, 2.3% of the part. So
   * a candidate who sat through the débat in silence still measured well over
   * fifteen "voiced" seconds, `partsSpokenButUntranscribed` read that as an
   * exposé the app had lost, and the finish route refused the whole sitting —
   * telling a candidate who had walked out that the failure was ours, and
   * throwing away the monologue they HAD given rather than halving the mark
   * (`applyAbsentPartPenalty`, which is what should have answered).
   *
   * This number is not fooled by that, because the frames it declines to count
   * are exactly the ones the examiner's own voice could have produced.
   *
   * It is still a floor and still crude — see the header of
   * `voice-activity.ts`. A candidate who only ever speaks over the examiner
   * measures zero here; that is the direction to be wrong in, since a low
   * reading only ever moves a refusal towards grading the sitting.
   */
  soloVoicedSeconds(phase: RecordedPhase): number {
    return this.soloVoicedSamplesIn(phase) / this.sampleRate;
  }

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

    // One encode per (phase, sample count), however many callers ask — the
    // in-flight promise is shared, so an early request (#86) and the finish
    // asking moments later wait on the same work instead of doubling it.
    const cached = this.encoded.get(phase);
    if (cached && cached.sampleCount === segment.samples) return cached.artefact;

    const artefact = this.encodePhase(phase, segment);
    this.encoded.set(phase, { sampleCount: segment.samples, artefact });
    // A failed encode must not be sticky: whoever asked gets the rejection to
    // report, and the next request encodes afresh instead of replaying it. The
    // handler also keeps a fire-and-forget early encode from surfacing as an
    // unhandled rejection — the finish will meet the same failure for itself.
    artefact.catch(() => {
      if (this.encoded.get(phase)?.artefact === artefact) this.encoded.delete(phase);
    });
    return artefact;
  }

  private async encodePhase(phase: RecordedPhase, segment: Segment): Promise<PhaseRecording> {
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
   * Discard one phase's samples and any artefact cut from them (#51).
   *
   * For the phase whose content arrived as TEXT: the development panel types
   * the exposé, and whatever the open microphone captured around that typing —
   * room tone before the panel was opened, mostly — is not a recording of the
   * task, it is a recording of nobody performing it. Filing it anyway is what
   * made the same typed sitting grade differently run to run: the artefact's
   * few seconds of noise flipped the grading mode, displaced the typed
   * duration claim, and handed the corrector silence labelled as an exposé.
   *
   * The samples join {@link discarded} rather than vanishing: they were
   * captured, and the count staying visible is the difference between a
   * decision and a leak. The cached encode goes with them — an artefact
   * already cut from dropped samples is the same lie in a smaller file.
   *
   * Returns how many samples were dropped, so the caller can log the size of
   * what it decided against.
   */
  drop(phase: RecordedPhase): number {
    const segment = this.segments.get(phase);
    if (!segment) return 0;
    this.segments.delete(phase);
    this.encoded.delete(phase);
    // A dropped phase cannot stay open: frames that arrive now belong to a
    // recording that no longer exists, and filing them would resurrect it.
    if (this.open === phase) this.open = null;
    this.discardedSamples += segment.samples;
    return segment.samples;
  }

  /**
   * Every artefact with audio in it, in the order the phases were entered.
   *
   * One phase at a time rather than both at once: the encoder is a device with a
   * queue, and handing it a whole sitting in parallel buys nothing on the one
   * thread it drains on. That guarantee is per-call, not global — since #86 the
   * controller may already have an encode in flight from its early request, and
   * this walk meeting one simply awaits the shared memoized promise rather than
   * queuing a second compression.
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
    this.encoded.clear();
    this.open = null;
    this.discardedSamples = 0;
  }
}
