/**
 * The exam controller — a framework-free state machine.
 *
 * This deliberately owns no React. It began as a hook, and the React Compiler
 * was right to reject it: an exam is an imperative machine driven by wall-clock
 * time and socket callbacks, not a render function. Pulling it out of React
 * bought three things:
 *
 *  1. **Testability.** Every dependency (the Gemini session, the microphone, the
 *     speaker, the clock) is injected, so the whole 20-minute exam — including a
 *     forced mid-débat reconnect — runs headlessly in milliseconds against
 *     fakes. That is what makes §17's acceptance test a real test rather than a
 *     manual script.
 *  2. **Correct lifetimes.** The transcript outlives every session; each phase's
 *     clock outlives every reconnect inside that phase. Those are properties of
 *     the machine, and they are now stated in one place.
 *  3. **A trivial React binding.** `useExamController` is a `useSyncExternalStore`
 *     subscription and nothing else.
 *
 * The layering it enforces:
 *
 *   exam     ───────────────────────────────────────  transcript, microphone
 *   phase    ──────────────┤├─────────────────────────  clocks, recordings
 *   session  ────┤├────┤├──┤├────┤├────┤├─────────────  Gemini connection
 *
 * Read downwards, that diagram is also the recording's specification. The
 * microphone is opened once and outlives every session; each artefact belongs to
 * exactly one phase and outlives every reconnect inside it; and the Gemini
 * connection — the shortest-lived thing on the page — cannot take a hole out of
 * either.
 */

import type { PhaseRecording, RecordedPhase } from "@/lib/audio/archive";
import {
  canAdvanceEarly,
  isPhaseTimeUp,
  monologueWasSilent,
  nextPhase,
  phaseUsesLiveSession,
  remainingSeconds,
  type OralPhase,
} from "@/lib/delf/phases";
import { closingInstruction, examinerOpeningLine } from "@/lib/delf/examiner-prompt";
import type { OralTopic } from "@/lib/delf/topics";
import {
  appendFragment,
  entriesForPhase,
  monologueAsHistory,
  type TranscriptEntry,
  type TranscriptPhase,
} from "@/lib/delf/transcript";
import type { ConnectionState, SessionManagerCallbacks } from "./session-manager";
import { examStatus, type ExamStatus } from "./state-machine";

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
  /** Seconds of audio recorded for one phase, measured from the samples. */
  measuredSeconds(phase: RecordedPhase): number;
  /** Of those, the seconds that carried speech. The two differ exactly when a
   *  microphone worked and the candidate did not speak into it. */
  voicedSeconds(phase: RecordedPhase): number;
  /** Seconds recorded across the sitting. Read by the stall watchdog, which
   *  only cares that the number is still moving. */
  readonly recordedSeconds: number;
  /** The finished artefacts, one per phase that captured anything. Compressing
   *  them is what makes a sitting small enough to upload, and it is not
   *  instant — see `audio/opus-encoder.ts`. */
  recordings(): Promise<PhaseRecording[]>;
  /** Release the recording's memory once the blobs are cut. */
  discard(): void;
}

/** What the controller needs from the speaker. */
export interface PlayerLike {
  resume(): Promise<void>;
  enqueue(base64: string): void;
  interrupt(): void;
  close(): Promise<void>;
}

/** Diagnostics from the audio layer, routed into the same session log the
 *  Gemini connection writes to — a capture rate the browser refused and a
 *  reconnect are the same kind of fact when an épreuve goes wrong. */
export type AudioEventSink = (name: string, detail?: unknown) => void;

export interface ExamEvent {
  at: number;
  phase: OralPhase;
  name: string;
  detail?: string;
}

export interface ExamState {
  phase: OralPhase;
  elapsed: number;
  remaining: number;
  connection: ConnectionState;
  /**
   * The two machines flattened into one value (`lib/live/state-machine.ts`).
   *
   * Derived on every snapshot rather than stored, so it cannot drift from the
   * phase and the connection it is derived from. `phase` and `connection` are
   * still exposed: this is the summary, not a replacement.
   */
  status: ExamStatus;
  examinerSpeaking: boolean;
  transcript: readonly TranscriptEntry[];
  events: readonly ExamEvent[];
  reconnectCount: number;
  canAdvance: boolean;
  closing: boolean;
  micError: string | null;
  /**
   * Whether the candidate's voice is being recorded right now.
   *
   * Rendered, so "nothing is recorded before consent" is something the candidate
   * can watch happen — the indicator is dark through the whole of preparation
   * and lights up at the monologue, after the browser has asked them.
   */
  recording: boolean;
  started: boolean;
  monologueSeconds: number;
  debateSeconds: number;
  /**
   * Whether the monologue has a working microphone and almost no speech on it.
   *
   * Grounds for asking the candidate a question before they move on, never for
   * refusing to let them — see `monologueWasSilent` for why the measure behind
   * it cannot be trusted with a refusal.
   */
  monologueSilent: boolean;
}

/**
 * What one speaking phase produced, with its two durations kept apart.
 *
 * They are not the same number and pretending otherwise is the mistake this
 * phase exists to stop. `elapsedSeconds` is the clock: how long the phase ran,
 * which is what the candidate watched count down. `recordedSeconds` is the
 * audio: how much of it actually reached the recording, which is smaller
 * whenever the microphone was not delivering — a device unplugged four minutes
 * in, a tab whose audio graph the browser suspended, a permission revoked.
 *
 * The duration penalty is computed from `recordedSeconds`, because a penalty is
 * a statement about a performance and the only evidence of the performance is
 * the recording. `elapsedSeconds` is kept because "the phase ran 7 minutes and
 * recorded 90 seconds" is a diagnosis, while either number alone is a mystery.
 */
export interface PhaseReport {
  phase: RecordedPhase;
  /** Wall clock: how long the phase lasted. */
  elapsedSeconds: number;
  /** Measured from the samples: how much audio exists. */
  recordedSeconds: number;
  /**
   * Epoch ms, for the audit trail. Never null: a phase is reported only because
   * it was entered, and entering it is what stamps this. The nullability lives
   * on `phaseStamps`, where "not entered" is a real state; by the time a report
   * exists that state has been filtered out, and the type should say so rather
   * than making every reader re-derive it.
   */
  startedAt: number;
  /** Null for a phase entered but never left. */
  endedAt: number | null;
}

/**
 * A speaking phase that has just ended, reported while the exam is still running.
 *
 * The clock stamps are here and no duration is: how much the candidate actually
 * spoke is measured from the audio, and the audio does not leave this tab until
 * the épreuve is submitted. What this buys is the transcript — the turns of a
 * completed phase, on the server, before the tab has a chance to lose them.
 */
export interface FinalisedPhaseReport {
  phase: RecordedPhase;
  /** This phase's turns only. The server appends them to what it already has. */
  entries: TranscriptEntry[];
  /** Epoch ms. Both non-null: the phase was entered, and it has now ended. */
  startedAt: number;
  endedAt: number;
}

export interface ExamFinishedPayload {
  transcript: TranscriptEntry[];
  /** One playable artefact per phase that captured anything. */
  recordings: PhaseRecording[];
  /** One entry per phase the candidate actually entered. */
  phases: PhaseReport[];
  reconnectCount: number;
}

export interface ExamControllerDeps {
  topic: OralTopic;
  createSession: (
    phase: TranscriptPhase,
    topic: OralTopic,
    callbacks: SessionManagerCallbacks,
    history: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>,
  ) => LiveSessionLike;
  createRecorder: (callbacks: {
    onChunk: (base64: string) => void;
    onEvent: AudioEventSink;
    onLost: (reason: string) => void;
  }) => RecorderLike;
  createPlayer: (callbacks: {
    onSpeakingChange: (speaking: boolean) => void;
    onEvent: AudioEventSink;
  }) => PlayerLike;
  onFinished: (payload: ExamFinishedPayload) => void;
  /**
   * A speaking phase has ended and the exam continues.
   *
   * Optional, and called for its side effect only — the controller does not
   * await it, does not retry it and does not care whether it succeeded. The
   * épreuve must not pause, stall or fail because a progress request did, so
   * everything about that is the binding's problem (`use-exam-controller.ts`).
   */
  onPhaseFinalised?: (report: FinalisedPhaseReport) => void;
  /** Injected so tests can drive a fake clock. */
  now?: () => number;
  /**
   * Whether to run the real 250 ms interval. Tests set this false and call
   * `tick()` by hand, which is what lets a 20-minute exam be exercised in
   * milliseconds instead of twenty minutes.
   */
  autoTick?: boolean;
}

/** How long to wait for the examiner's closing sentence before advancing anyway. */
const CLOSING_SAFETY_MS = 12_000;
const TICK_MS = 250;

/**
 * How long the recording may stop growing, mid-phase, before the candidate is
 * told.
 *
 * A working microphone delivers ~25 blocks a second, so four seconds of nothing
 * is not a slow machine, it is a capture that has stopped: an audio graph the
 * browser suspended behind a backgrounded tab, a device the OS handed to another
 * application, a track that ended without firing `ended`. The clock keeps
 * running through all of them and the page keeps looking healthy, which is
 * precisely why this has to be watched rather than waited for.
 */
const CAPTURE_STALL_MS = 4_000;

/** The two phases that produce a recording, in exam order. */
const SPEAKING_PHASES: readonly RecordedPhase[] = ["monologue", "debate"];

const MIC_MESSAGES = {
  denied:
    "L'accès au microphone a été refusé. Autorisez-le dans votre navigateur, puis rechargez la page.",
  unavailable:
    "Le microphone n'est pas accessible. Vérifiez qu'aucune autre application ne l'utilise.",
  lost: "Le microphone s'est déconnecté. Ce qui a déjà été enregistré est conservé, mais la suite de l'épreuve ne le sera pas.",
  stalled:
    "Votre microphone n'envoie plus de son. Vérifiez qu'il est branché et gardez cet onglet au premier plan.",
} as const;

export class ExamController {
  private listeners = new Set<() => void>();
  private snapshot: ExamState;

  private phase: OralPhase = "preparation";
  private phaseStart: number | null = null;
  private examStart = 0;
  private elapsed = 0;

  private transcript: TranscriptEntry[] = [];
  private events: ExamEvent[] = [];
  private connection: ConnectionState = "idle";
  private examinerSpeaking = false;
  private reconnectCount = 0;
  private micError: string | null = null;
  private started = false;
  private closing = false;
  private finished = false;
  /**
   * Whether the monologue's `activityEnd` has already gone out.
   *
   * It is what both releases the floor AND causes Gemini to emit the
   * candidate's transcription (verified: during a manual-VAD activity NOTHING
   * is transcribed; the whole monologue arrives in one fragment at
   * `activityEnd`). Sending it twice would be a second, empty turn boundary, so
   * the closing handshake and the phase transition coordinate through this.
   */
  private activityEnded = false;
  private phaseSeconds = { monologue: 0, debate: 0 };
  /** Wall-clock stamps per speaking phase, for `oral_exam_phases`' audit trail.
   *  Null means the phase was never entered, which is the truth about an
   *  abandoned sitting rather than a gap to fill in. */
  private phaseStamps: Record<RecordedPhase, { startedAt: number | null; endedAt: number | null }> =
    {
      monologue: { startedAt: null, endedAt: null },
      debate: { startedAt: null, endedAt: null },
    };

  /** The stall watchdog's state: the recording's length last time we looked,
   *  and when it was last seen to grow. See {@link CAPTURE_STALL_MS}. */
  private lastRecordedSeconds = 0;
  private lastCaptureAt: number | null = null;
  private captureStalled = false;
  /** Terminal, unlike a stall: a device that ended does not come back, so the
   *  watchdog stands down rather than reporting the same silence twice. */
  private captureLost = false;

  private session: LiveSessionLike | null = null;
  private recorder: RecorderLike | null = null;
  private player: PlayerLike | null = null;
  /** In flight, so a second `prepareAudio()` joins it rather than opening a
   *  second pair of devices. */
  private preparingAudio: Promise<boolean> | null = null;
  /** Set once by {@link destroy}. Terminal, like the session's `closed`: the
   *  controller is gone and nothing it opens afterwards has an owner. */
  private destroyed = false;

  private ticker: ReturnType<typeof setInterval> | null = null;
  /** When the closing handshake started, for its safety deadline. See `tick()`. */
  private closingStartedAt: number | null = null;

  private readonly now: () => number;

  constructor(private readonly deps: ExamControllerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.snapshot = this.buildSnapshot();
  }

  // ---------------------------------------------------------------- store API

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Identity-stable between changes, as `useSyncExternalStore` requires. */
  getSnapshot = (): ExamState => this.snapshot;

  private buildSnapshot(): ExamState {
    return {
      phase: this.phase,
      elapsed: this.elapsed,
      remaining: remainingSeconds(this.phase, this.elapsed),
      connection: this.connection,
      status: examStatus(this.phase, this.connection),
      examinerSpeaking: this.examinerSpeaking,
      transcript: this.transcript,
      events: this.events,
      reconnectCount: this.reconnectCount,
      canAdvance: canAdvanceEarly(this.phase, this.elapsed) && !this.closing,
      closing: this.closing,
      micError: this.micError,
      // False during a stall too, not only after a lost device. The point of the
      // indicator is that the candidate can check the claim, and a pulsing
      // "Enregistrement" over a capture that has stopped delivering is the one
      // state where the claim is false and the indicator says it is true.
      recording:
        this.recorder !== null &&
        !this.captureLost &&
        !this.captureStalled &&
        (this.phase === "monologue" || this.phase === "debate"),
      started: this.started,
      monologueSeconds: this.phaseSeconds.monologue,
      debateSeconds: this.phaseSeconds.debate,
      monologueSilent: this.monologueSilent(),
    };
  }

  /**
   * Whether the monologue so far reads as never attempted (#39).
   *
   * Read off the recorder every snapshot rather than tracked as state: both
   * numbers are counters the archive already keeps, so this is two reads and no
   * bookkeeping that could drift from the audio it describes.
   *
   * `false` with no recorder at all, which is the same asymmetry
   * `monologueWasSilent` is built on — no microphone is not a silent candidate.
   */
  private monologueSilent(): boolean {
    if (!this.recorder) return false;
    return monologueWasSilent(
      this.recorder.measuredSeconds("monologue"),
      this.recorder.voicedSeconds("monologue"),
    );
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private log(name: string, detail?: unknown): void {
    this.events = [
      ...this.events.slice(-199),
      {
        at: this.examStart ? this.now() - this.examStart : 0,
        phase: this.phase,
        name,
        detail:
          detail === undefined
            ? undefined
            : typeof detail === "object"
              ? JSON.stringify(detail)
              : String(detail),
      },
    ];
    this.emit();
  }

  // ------------------------------------------------------------- transcript

  private addFragment(speaker: "candidate" | "examiner", text: string): void {
    if (this.phase !== "monologue" && this.phase !== "debate") return;
    this.transcript = appendFragment(this.transcript, {
      phase: this.phase,
      speaker,
      timestamp: this.now() - this.examStart,
      text,
    });
    this.emit();
  }

  // ---------------------------------------------------------------- lifecycle

  /** Begin the exam. Preparation's clock starts now. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.examStart = this.now();
    this.phaseStart = this.now();
    this.startTicker();
    this.log("exam-started", this.deps.topic.slug);
  }

  /**
   * Open the microphone and speaker. Called at the monologue boundary rather
   * than at exam start, so the browser's permission prompt appears when the
   * candidate is about to speak, not thirty minutes earlier.
   */
  async prepareAudio(): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.recorder) return true;
    // A second attempt after a failed one used to build a second player and
    // abandon the first, still holding an open AudioContext. `advanceEarly()`
    // is a button, and a candidate who has just been told their microphone is
    // blocked presses it again.
    if (this.preparingAudio) return this.preparingAudio;
    this.preparingAudio = this.openAudio();
    try {
      return await this.preparingAudio;
    } finally {
      this.preparingAudio = null;
    }
  }

  private async openAudio(): Promise<boolean> {
    // Held locally until BOTH devices are open. Assigning as we went meant a
    // microphone failure — the common one; it is the half that needs
    // permission — left the speaker's context open with nothing to close it
    // until the exam ended.
    let player: PlayerLike | null = null;
    try {
      player = this.deps.createPlayer({
        onSpeakingChange: (speaking) => {
          this.examinerSpeaking = speaking;
          this.emit();
        },
        onEvent: (name, detail) => this.log(name, detail),
      });
      await player.resume();

      const recorder = this.deps.createRecorder({
        // The recording does not go through here and must not: `sendAudio` on a
        // torn-down session is a no-op, and a sitting has several of those.
        onChunk: (base64) => this.session?.sendAudio(base64),
        onEvent: (name, detail) => this.log(name, detail),
        onLost: (reason) => this.handleCaptureLost(reason),
      });
      await recorder.start();

      // `destroy()` can land while the permission prompt is up — which is the
      // very window this method was moved late in the exam to create. The
      // devices are installed on the controller only at the lines below, so a
      // teardown that ran meanwhile found both fields null and closed nothing;
      // without this check they are then adopted by a controller that is
      // already gone, and nothing will ever stop them again. The microphone
      // and the speaker each guard their own version of this internally; this
      // is the same race one layer up, where only the controller can see it.
      if (this.destroyed) {
        await recorder.stop().catch(() => {});
        await player.close().catch(() => {});
        this.log("audio-discarded", "the sitting ended while the devices were opening");
        return false;
      }

      this.player = player;
      this.recorder = recorder;
      this.micError = null;
      this.log("audio-ready");
      return true;
    } catch (error) {
      await player?.close().catch(() => {
        /* nothing left to report; the exam failure below is the story */
      });
      const denied =
        typeof DOMException !== "undefined" &&
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "SecurityError");
      this.micError = denied ? MIC_MESSAGES.denied : MIC_MESSAGES.unavailable;
      this.log("audio-failed", String(error));
      this.emit();
      return false;
    }
  }

  /**
   * The microphone went away mid-sitting.
   *
   * The exam is deliberately NOT ended. What was recorded up to this point is a
   * real artefact of a real performance and is kept; the candidate is told, in a
   * sentence that says both halves of that, and the phase runs on so they can
   * finish speaking to an examiner that is still listening over the socket. The
   * measured duration then reports the shortfall on its own, without anyone
   * having to reconstruct when the device died.
   */
  private handleCaptureLost(reason: string): void {
    if (this.captureLost) return;
    this.captureLost = true;
    this.captureStalled = false;
    this.micError = MIC_MESSAGES.lost;
    this.log("microphone-lost", reason);
    this.emit();
  }

  /**
   * Whether the recording is still growing, checked from the phase clock.
   *
   * Cheaper and more honest than trusting the device to report its own death:
   * `ended` does not fire for a suspended AudioContext, and a candidate who has
   * been silently unrecorded for four minutes cannot be given those minutes
   * back. The clock is the injected one, like every other deadline here.
   */
  private checkCaptureAlive(): void {
    const recorder = this.recorder;
    if (!recorder || this.captureLost) return;
    if (this.phase !== "monologue" && this.phase !== "debate") return;

    const seconds = recorder.recordedSeconds;
    const now = this.now();

    if (seconds > this.lastRecordedSeconds) {
      this.lastRecordedSeconds = seconds;
      this.lastCaptureAt = now;
      if (this.captureStalled) {
        this.captureStalled = false;
        this.micError = null;
        this.log("capture-resumed");
        this.emit();
      }
      return;
    }

    this.lastCaptureAt ??= now;
    if (!this.captureStalled && now - this.lastCaptureAt >= CAPTURE_STALL_MS) {
      this.captureStalled = true;
      this.micError = MIC_MESSAGES.stalled;
      this.log("capture-stalled", { recordedSeconds: Number(seconds.toFixed(2)) });
      this.emit();
    }
  }

  /** The candidate ends the current phase early. */
  async advanceEarly(): Promise<void> {
    if (!canAdvanceEarly(this.phase, this.elapsed)) return;
    if (this.phase === "preparation") {
      const ready = await this.prepareAudio();
      if (!ready) return;
      await this.advance();
      return;
    }
    this.beginClosingHandshake();
  }

  /**
   * Put the monologue's clock back to zero so the candidate can attempt it
   * again.
   *
   * Reached from « Réessayer la transcription », after they tried to move on
   * having recorded no speech (#39). The point is that a monologue nobody
   * attempted cannot be spent: the clock restarts, the minimum before they may
   * move on applies again, and the task is still there to do.
   *
   * Only during the monologue, and only before the closing handshake has begun —
   * once the examiner has been asked to wrap up, the turn is over and rewinding
   * the clock underneath it would leave the two disagreeing about which phase is
   * running.
   *
   * **The phase's own time-up is untouched, and that is deliberate.** It is the
   * one thing standing between "you must attempt the task" and a candidate
   * trapped forever — someone whose microphone is delivering sound that is not
   * their voice can still let the clock run out and be carried into the débat by
   * `isPhaseTimeUp`. What restarting removes is the *shortcut*, not the exit.
   */
  restartMonologue(): void {
    if (this.phase !== "monologue" || this.closing) return;

    this.phaseStart = this.now();
    this.elapsed = 0;
    this.phaseSeconds.monologue = 0;
    this.log("monologue-restarted", "no speech was recorded");
    this.emit();
  }

  /**
   * DEVELOPMENT ONLY — type what the candidate would have said.
   *
   * Testing this product otherwise means speaking French into a microphone for
   * twenty minutes, twice, every time anything downstream of the transcript
   * changes: the rubric, the persistence, the results page, the duration
   * penalty. That is slow enough that those paths get tested rarely, which is
   * the opposite of what they need.
   *
   * So this appends a candidate turn to the transcript exactly as a
   * transcription fragment would, and the examiner is told the same text
   * through `sendDirective` so the conversation stays coherent — a débat where
   * the examiner never heard the exposé is not a useful thing to test against.
   *
   * Three things it deliberately does NOT do, because each would make what it
   * produces a lie about a real sitting:
   *
   *  - **It records no audio.** The measured duration stays whatever the
   *    microphone actually captured, so a typed sitting is graded from its
   *    transcript and takes the duration penalty. That is the correct answer:
   *    nothing was spoken.
   *  - **It does not advance the phase.** The clock and the state machine are
   *    untouched.
   *  - **It does not run in production.** The guard is on `NODE_ENV` and is the
   *    first line, so a build cannot ship a way to write an exam transcript
   *    without speaking.
   */
  injectCandidateSpeech(text: string): void {
    if (process.env.NODE_ENV === "production") return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.phase !== "monologue" && this.phase !== "debate") return;

    this.addFragment("candidate", trimmed);
    // The examiner has to hear it too, or the débat argues with silence.
    try {
      this.session?.sendDirective(trimmed);
    } catch (error) {
      this.log("dev-inject-directive-failed", String(error));
    }
    this.log("dev-inject-speech", `${trimmed.length} chars`);
  }

  /**
   * Force a reconnect on the live session.
   *
   * Exposed because a real GoAway takes about ten minutes to arrive, and a
   * resumption path that is only exercised in production is a resumption path
   * that does not work. This drives exactly the code a GoAway drives.
   */
  async forceReconnect(): Promise<void> {
    if (!this.session) {
      this.log("force-reconnect-skipped", "no active session");
      return;
    }
    // A recovery already under way does not need helping along. The candidate's
    // button is a real button and gets double-clicked; the session's generation
    // guard means that cannot open two sockets, but each press still mints and
    // discards an ephemeral token, and the second press does nothing the first
    // is not already doing.
    if (this.connection === "reconnecting" || this.connection === "resuming") {
      this.log("force-reconnect-skipped", "already recovering");
      return;
    }
    await this.session.reconnect();
  }

  // ------------------------------------------------------------ phase changes

  /**
   * Ask the examiner for one closing sentence, then advance when it has
   * finished speaking.
   *
   * Cutting the audio dead at 0:00 both sounds abrupt and truncates the
   * candidate's last words before Gemini has transcribed them. The safety
   * timeout means a silent examiner cannot strand the candidate on a frozen
   * clock — the failure mode this guards against is the one the reference
   * implementation had to fix in production.
   */
  private beginClosingHandshake(): void {
    if (this.phase !== "monologue" && this.phase !== "debate") {
      void this.advance();
      return;
    }
    if (this.closing) return;

    this.closing = true;
    this.log("closing-handshake");

    if (this.phase === "monologue") this.endMonologueActivity();
    this.session?.sendDirective(closingInstruction(this.phase));

    // Stamped, not scheduled. The deadline is checked from `tick()` against the
    // injected clock, like every other timing decision here — this used to be a
    // real `setTimeout`, the one path in the file that ignored `deps.now()`, and
    // it cost the unit suite a genuine twelve-second sleep to reach.
    this.closingStartedAt = this.now();

    this.emit();
  }

  /** Whether the examiner has had its promised sentence and then some. */
  private closingHasTimedOut(): boolean {
    if (!this.closing || this.closingStartedAt === null) return false;
    return this.now() - this.closingStartedAt >= CLOSING_SAFETY_MS;
  }

  private clearClosingTimer(): void {
    this.closingStartedAt = null;
  }

  /** Every phase transition runs through here, so ordering lives in one place. */
  private async advance(): Promise<void> {
    const current = this.phase;
    const target = nextPhase(current);
    if (current === target) return;

    this.clearClosingTimer();
    this.closing = false;

    // Bank this phase's speaking time before the clock resets, and close its
    // artefact. `endPhase()` runs before the session teardown below because it
    // flushes the framer's partial frame, and those are the candidate's last
    // words of THIS task — they belong in this recording, not in the next one.
    if (current === "monologue" || current === "debate") {
      if (this.phaseStart !== null) {
        this.phaseSeconds[current] = Math.round((this.now() - this.phaseStart) / 1000);
      }
      this.phaseStamps[current].endedAt = this.now();
      this.recorder?.endPhase();
    }

    this.log("phase-transition", `${current} -> ${target}`);

    if (current === "monologue") {
      // Normally already sent by the closing handshake, which then WAITED for
      // the examiner's turn — and that wait is what gives the candidate's
      // transcription time to arrive before the socket goes away. This call
      // only covers the path where the phase ends without a handshake.
      this.endMonologueActivity();
      this.closeSession();
    } else if (current === "debate") {
      this.closeSession();
    }

    this.phase = target;
    this.phaseStart = this.now();
    this.elapsed = 0;
    this.emit();

    if (target === "monologue" || target === "debate") {
      // Every entry into a speaking phase goes through here, which is the point.
      // `advanceEarly()` opens the devices itself and refuses to advance without
      // them, but preparation can also end by simply running out — and on that
      // path nothing had ever asked for a microphone, so a candidate who sat
      // through the full thirty minutes reached the monologue with no recording
      // and no message saying why. A failure here is not fatal: the micError is
      // already on screen and the épreuve is still worth sitting.
      await this.prepareAudio();
      this.beginRecording(target);
      await this.openSession(target);
    }

    // Deliberately last, and deliberately not on the way into `finished`.
    //
    // Last, because the transcript is what is being reported and Gemini's
    // transcription of the monologue arrives asynchronously: the awaits above
    // are free time for the fragments still in flight, and any that land after
    // this carry the NEXT phase's tag, so they cannot contaminate what is sent.
    // Not on the way into `finished`, because `finish()` is about to post the
    // whole sitting — transcript, recordings and all — and a progress request
    // racing it would be a second write of the same turns for no insurance.
    if (target !== "finished" && (current === "monologue" || current === "debate")) {
      this.reportFinalisedPhase(current);
    }

    if (target === "finished") await this.finish();
  }

  /** Hand a completed phase to whoever is persisting it. Never throws upward. */
  private reportFinalisedPhase(phase: RecordedPhase): void {
    const { startedAt, endedAt } = this.phaseStamps[phase];
    // A phase that was never entered, or somehow never stamped its end, has
    // nothing honest to report. The finish payload still carries its turns.
    if (startedAt === null || endedAt === null) return;

    try {
      this.deps.onPhaseFinalised?.({
        phase,
        entries: entriesForPhase(this.transcript, phase),
        startedAt,
        endedAt,
      });
    } catch (error) {
      // A throwing listener must not take a phase transition down with it.
      this.log("error", `progress report failed: ${String(error)}`);
    }
  }

  /** Open this phase's artefact and arm the stall watchdog for it. */
  private beginRecording(phase: RecordedPhase): void {
    this.phaseStamps[phase].startedAt = this.now();
    // Re-armed per phase: the gap between the monologue's last frame and the
    // débat's first one is a phase transition, not a stalled microphone.
    this.lastCaptureAt = this.now();
    this.lastRecordedSeconds = this.recorder?.recordedSeconds ?? 0;
    // A stall warning from the previous phase does not survive into this one.
    // Without this it would sit on screen until audio next arrives, which for a
    // candidate whose microphone recovered at the boundary is never.
    if (this.captureStalled) {
      this.captureStalled = false;
      this.micError = null;
    }
    this.recorder?.beginPhase(phase);
  }

  private async openSession(target: TranscriptPhase): Promise<void> {
    // Each phase gets its own session, and therefore its own connection
    // machine. Without this the previous phase's terminal `closed` would show
    // as the new session's starting state until its first callback arrived.
    this.connection = "idle";

    const callbacks: SessionManagerCallbacks = {
      onStateChange: (state) => {
        // Counts OUTAGES, not attempts, and the `from connected` is what makes
        // the difference. A backoff sequence re-enters `reconnecting` once per
        // failed attempt — `resuming` → throw → `reconnecting` → `resuming` —
        // so counting every entry reported three reconnections for one flaky
        // ten-second episode. That number is persisted on the sitting as a
        // reliability signal, and a signal that cannot tell one bad minute from
        // three separate ones is not one.
        //
        // Only a transition out of a HEALTHY connection starts a new episode.
        // A first connect that fails goes `connecting` → `reconnecting` and is
        // deliberately not counted either: nothing was ever connected, so
        // nothing reconnected.
        if (state === "reconnecting" && this.connection === "connected") {
          this.reconnectCount += 1;
        }
        this.connection = state;
        this.emit();
      },
      onCandidateTranscript: (text) => this.addFragment("candidate", text),
      onExaminerTranscript: (text) => this.addFragment("examiner", text),
      onExaminerAudio: (base64) => this.player?.enqueue(base64),
      onInterrupted: () => this.player?.interrupt(),
      onTurnComplete: () => {
        // The ONLY thing Gemini is allowed to influence about the exam's flow,
        // and only inside a window the app opened: once the clock has run out
        // and the closing directive has gone out, the examiner's turn ending is
        // what releases the phase. Outside a closing handshake this is ignored —
        // the examiner finishing a sentence mid-débat must not end the débat.
        // The timer decides when a phase ends; the model only decides when it
        // has stopped talking about it.
        if (this.closing) {
          this.closing = false;
          this.clearClosingTimer();
          void this.advance();
        }
      },
      onEvent: (name, detail) => this.log(name, detail),
    };

    // Only the débat is seeded: it is a fresh session that would otherwise know
    // nothing about the monologue it is supposed to challenge.
    const history = target === "debate" ? monologueAsHistory(this.transcript) : [];

    const session = this.deps.createSession(target, this.deps.topic, callbacks, history);
    this.session = session;
    await session.connect();

    session.sendDirective(examinerOpeningLine(target));

    if (target === "monologue") {
      // Manual VAD: open the candidate's activity and never close it, so the
      // model has no turn boundary at which it could interrupt.
      session.beginCandidateActivity();
    }
  }

  /** Release the monologue floor exactly once. See `activityEnded`. */
  private endMonologueActivity(): void {
    if (this.activityEnded) return;
    this.activityEnded = true;
    this.session?.endCandidateActivity();
  }

  private closeSession(): void {
    this.session?.close();
    this.session = null;
  }

  private async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.stopTicker();

    this.player?.interrupt();

    // Stopped BEFORE the artefacts are taken, not after. `stop()` is what
    // flushes the partial frame still in the framer, so cutting the blobs first
    // dropped the candidate's last few tens of milliseconds from the recording
    // the phonologie score is measured on. Cheap to get right, invisible when
    // wrong.
    const recorder = this.recorder;
    this.recorder = null;
    await recorder?.stop();
    // Awaited: the artefacts are compressed on the way out of the archive, so
    // this is where a 38 MB sitting becomes a 2.4 MB upload (#24).
    const recordings = (await recorder?.recordings()) ?? [];
    const phases = this.phaseReports(recorder);
    // The blobs are cut and own their bytes; the PCM behind them is a second
    // copy of a sitting, and this tab is about to load a results page.
    recorder?.discard();

    const player = this.player;
    this.player = null;
    await player?.close();

    this.log("exam-finished", {
      phases: phases.map((report) => ({
        phase: report.phase,
        elapsed: report.elapsedSeconds,
        recorded: Number(report.recordedSeconds.toFixed(2)),
      })),
      reconnects: this.reconnectCount,
    });

    this.deps.onFinished({
      transcript: this.transcript,
      recordings,
      phases,
      reconnectCount: this.reconnectCount,
    });
  }

  /**
   * One report per phase the candidate actually entered.
   *
   * A sitting abandoned during the monologue reports the monologue and nothing
   * else — which is the truth about it, and better than a débat row claiming
   * zero seconds of a task that never happened.
   */
  private phaseReports(recorder: RecorderLike | null): PhaseReport[] {
    const reports: PhaseReport[] = [];
    for (const phase of SPEAKING_PHASES) {
      const { startedAt, endedAt } = this.phaseStamps[phase];
      // Not entered. Written as a narrowing `continue` rather than a filter so
      // `startedAt` is a number below without an assertion talking the compiler
      // out of something it was right about.
      if (startedAt === null) continue;
      reports.push({
        phase,
        elapsedSeconds: this.phaseSeconds[phase],
        recordedSeconds: recorder?.measuredSeconds(phase) ?? 0,
        startedAt,
        endedAt,
      });
    }
    return reports;
  }

  // -------------------------------------------------------------------- clock

  /**
   * The phase clock, derived from a wall-clock start stamp rather than counted
   * ticks. `setInterval` is throttled in background tabs, so a counted clock
   * would silently under-run a 13-minute phase.
   */
  private startTicker(): void {
    if (this.ticker || this.deps.autoTick === false) return;
    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /** Advance the clock. Public so a test can drive it without real time. */
  tick(): void {
    if (!this.started || this.phase === "finished" || this.phaseStart === null) return;

    const seconds = Math.floor((this.now() - this.phaseStart) / 1000);
    if (seconds !== this.elapsed) {
      this.elapsed = seconds;
      this.emit();
    }

    // Checked on the phase clock rather than on a timer of its own: the exam
    // already has one heartbeat driven by the injected clock, and a recording
    // that has stopped growing is exactly the kind of fact it should notice.
    this.checkCaptureAlive();

    // The examiner was asked for one closing sentence and never delivered it.
    // Advancing anyway is what stops a silent model stranding the candidate on
    // a frozen clock — the failure the reference implementation hit in
    // production.
    if (this.closingHasTimedOut()) {
      this.closing = false;
      this.clearClosingTimer();
      this.log("closing-safety-timeout");
      void this.advance();
      return;
    }

    if (isPhaseTimeUp(this.phase, seconds) && !this.closing) {
      if (phaseUsesLiveSession(this.phase)) this.beginClosingHandshake();
      else void this.advance();
    }
  }

  /** Release everything. Safe to call twice. */
  destroy(): void {
    // Set before anything else: a `prepareAudio()` still waiting on the
    // permission prompt reads this when it resolves, and closes what it opened
    // rather than handing it to a controller that no longer exists.
    this.destroyed = true;
    this.stopTicker();
    this.clearClosingTimer();
    this.closeSession();
    const recorder = this.recorder;
    this.recorder = null;
    // Released rather than kept: `destroy()` runs when the tab is going away or
    // the exam is over, and by then either the artefacts have already been taken
    // (`finish()` nulls the field first) or the page they belonged to is gone.
    void recorder?.stop().then(() => recorder.discard());
    void this.player?.close();
    this.player = null;
    this.listeners.clear();
  }
}
