/**
 * The controller's ports: what it needs from the three devices it drives, and
 * nothing about how any of them is built.
 *
 * A leaf on purpose. `exam-controller.ts` imports these to type its fields,
 * and `audio/recorder.ts`, `audio/player.ts` and `session-manager.ts` import
 * them to say `implements` — so a device that forgets a method is a compile
 * error rather than a stub uploaded silently. Had the interfaces stayed in the
 * controller, that `implements` would have made the devices import the
 * orchestrator that drives them, and the session and the controller would
 * have imported each other; the seam these were written to keep is that the
 * devices do not know the controller exists.
 */

import type { PhaseRecording, RecordedPhase } from "@/lib/audio/archive";

/** What the controller needs from a Gemini session. */
export interface LiveSessionLike {
  connect(): Promise<void>;
  close(): void;
  reconnect(): Promise<void>;
  sendAudio(base64: string): void;
  sendDirective(text: string): void;
  beginCandidateActivity(): void;
  endCandidateActivity(): void;
}

/** What the controller needs from the microphone. */
export interface RecorderLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Begin the artefact for a speaking phase. */
  beginPhase(phase: RecordedPhase): void;
  /** Close it, keeping what it captured. */
  endPhase(): void;
  /** Stop capturing and streaming without releasing the device, and start
   *  again. The device stays open across both, so there is no second permission
   *  prompt — which is the whole reason the development text mode can turn the
   *  microphone off and back on mid-phase. See {@link ExamController.setDevTextMode}. */
  pause(): void;
  resume(): void;
  /** Seconds of audio recorded for one phase, measured from the samples. */
  measuredSeconds(phase: RecordedPhase): number;
  /** Discard one phase's recording entirely (#51). Called at the phase
   *  boundary for a phase whose content was typed, so its captured room tone
   *  never leaves the tab dressed as the task. Required rather than optional
   *  for the same reason `recordingFor` is: an implementation that forgot it
   *  would upload the stub silently. */
  dropPhase(phase: RecordedPhase): void;
  /** Of those, the seconds that carried speech. The two differ exactly when a
   *  microphone worked and the candidate did not speak into it. */
  voicedSeconds(phase: RecordedPhase): number;
  /** And of THOSE, the seconds nobody else was audible for — the only one of
   *  the three that survives a débat spent listening to the examiner through an
   *  open microphone. See `PhaseArchive.soloVoicedSeconds`. */
  soloVoicedSeconds(phase: RecordedPhase): number;
  /** How long the candidate had to produce that: seconds recorded with the
   *  examiner silent, speech or not. The denominator the route's share test is
   *  taken against — see `PARTICIPATION_VOICED_SHARE`. */
  soloSeconds(phase: RecordedPhase): number;
  /** Tell the recorder the examiner is (or is no longer) being played into the
   *  room, so it can keep the two voiced measures apart. Called from the
   *  player's own `onSpeakingChange`, and once at install for a recorder that
   *  opened mid-sentence. */
  setPlaybackAudible(audible: boolean): void;
  /** Seconds recorded across the sitting. Read by the stall watchdog, which
   *  only cares that the number is still moving. */
  readonly recordedSeconds: number;
  /** The finished artefacts, one per phase that captured anything. Compressing
   *  them is what makes a sitting small enough to upload, and it is not
   *  instant — see `audio/opus-encoder.ts`. */
  recordings(): Promise<PhaseRecording[]>;
  /**
   * One phase's artefact on its own, or null where it captured nothing.
   *
   * One caller wants it: the controller asks for the monologue's artefact the
   * moment the débat begins (#86), so the compression runs while the candidate
   * debates instead of while they wait at « Épreuve terminée ». The archive
   * memoizes the result, which is what makes the early call worth making —
   * `recordings()` then finds the work already done. Required rather than
   * optional, because an implementation that forgot it would lose the early
   * encode silently; a compile error is the honest price.
   */
  recordingFor(phase: RecordedPhase): Promise<PhaseRecording | null>;
  /** Release the recording's memory once the blobs are cut. */
  discard(): void;
}

/** What the controller needs from the speaker. */
export interface PlayerLike {
  resume(): Promise<void>;
  enqueue(base64: string): void;
  interrupt(): void;
  close(): Promise<void>;
  /** Audio scheduled but not yet heard. Logged when an interruption is about to
   *  throw it away, so a question the candidate never heard leaves a record of
   *  how much of it there was. See {@link ExamController.handleInterruption}. */
  readonly bufferedSeconds: number;
  /** The speaker's own clock. Read only for whether it MOVED between two ticks,
   *  which is how {@link ExamController.examinerPlaybackHold} tells a dead
   *  device from a full one. */
  readonly playedSeconds: number;
}
