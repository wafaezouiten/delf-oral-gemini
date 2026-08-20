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

import type { AnnouncementOutcome, AnnouncerLike } from "@/lib/audio/announcer";
import type { PhaseRecording, RecordedPhase } from "@/lib/audio/archive";
import { DEV_TOOLS_ENABLED } from "@/lib/dev-tools";
import { ANNOUNCEMENTS, type AnnouncementId } from "@/lib/delf/announcements";
import {
  canAdvanceEarly,
  isPhaseTimeUp,
  monologueWasSilent,
  nextPhase,
  phaseUsesLiveSession,
  remainingSeconds,
  type OralPhase,
} from "@/lib/delf/phases";
import { readsAsClosing } from "@/lib/delf/early-closing";
import {
  closingInstruction,
  examinerOpeningLine,
  presenceCheckInstruction,
  resumeDebateInstruction,
  silenceRelanceInstruction,
  timeRemainingInstruction,
} from "@/lib/delf/examiner-prompt";
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
  /** Stop capturing and streaming without releasing the device, and start
   *  again. The device stays open across both, so there is no second permission
   *  prompt — which is the whole reason the development text mode can turn the
   *  microphone off and back on mid-phase. See {@link ExamController.setDevTextMode}. */
  pause(): void;
  resume(): void;
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
  /** Audio scheduled but not yet heard. Logged when an interruption is about to
   *  throw it away, so a question the candidate never heard leaves a record of
   *  how much of it there was. See {@link ExamController.handleInterruption}. */
  readonly bufferedSeconds: number;
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
  /**
   * When the current phase's clock started, in the transcript's own time base —
   * ms since the exam began, the same origin `TranscriptEntry.timestamp` counts
   * from. Null while the phase has not started its clock, which is a real window
   * rather than a transient: the consigne is spoken first and the clock starts
   * after it (#37).
   *
   * Exposed so the débat's feed can stamp each turn with the count the scene's
   * clock is already showing, instead of one anchored somewhere else. In the
   * transcript's base rather than the controller's so that no reader has to hold
   * two origins at once — `elapsed` answers "how long has this phase run", this
   * answers "where in the transcript did it start", and they are not
   * interchangeable.
   */
  phaseStartedAt: number | null;
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
   * This began as grounds for *asking* the candidate a question. It is now
   * grounds for refusing: a monologue with nothing on it has nothing to grade,
   * so the phase is held open until it is attempted. What keeps that from being
   * a trap is `monologueWasSilent`'s own asymmetry — a microphone that captured
   * nothing is never called silent — plus the exit, which still works and is
   * honest about costing 0/25.
   */
  monologueSilent: boolean;
  /**
   * The monologue is being held open because nothing was recorded: the clock
   * has stopped and the phase will not end until it is attempted.
   */
  monologueHeld: boolean;
  /**
   * DEVELOPMENT ONLY — the candidate is typing instead of speaking, and the
   * microphone is off for as long as that is true (#36).
   *
   * Always `false` where `DEV_TOOLS_ENABLED` is false: `setDevTextMode` refuses
   * there, so nothing can set it. Rendered so the dev panel's toggle reads its
   * own state off the controller rather than keeping a second copy that could
   * disagree with the microphone.
   */
  devTextMode: boolean;
  /**
   * The examiner's consigne for the phase now open, or null before the first one
   * (#37).
   *
   * It outlives its own playback, and since #59 nothing on screen does: the
   * consigne's control is a « Passer » button that exists for as long as the
   * voice does, and it reads the two flags below rather than this. What is left
   * here is the snapshot's record of which consigne the phase opened with — the
   * clip {@link ExamController.playAnnouncement} would play again out of a hold,
   * and the one thing that says *which* boundary a held or playing state belongs
   * to.
   */
  announcement: AnnouncementId | null;
  /**
   * The part is open, its consigne has been given, and it is waiting for the
   * candidate to press « Enregistrer ».
   *
   * Nothing is running while this is true: the timer shows the part's full
   * length, no artefact is open, and the examiner is not connected. It is the
   * state the sujet and the plan are read in. See {@link ExamController.startSpeaking}.
   */
  awaitingStart: boolean;
  /** A consigne is audible right now. */
  announcementPlaying: boolean;
  /**
   * The browser refused to play the consigne and a gesture would fix it.
   *
   * Distinct from "not playing", and the distinction decides whether the exam
   * moves: while this is true a speaking phase is **held** — its clock has not
   * started and nothing is being recorded — because the alternative is starting
   * the recording and then playing the consigne into it. See {@link announce}.
   */
  announcementBlocked: boolean;
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
  /**
   * DEVELOPMENT ONLY — the seconds typed phases claim to have lasted (#36).
   * Undefined on every real sitting. See `ExamController`'s `devSeconds`.
   */
  devSeconds?: Record<RecordedPhase, number>;
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
  /**
   * The examiner's spoken consignes (#37).
   *
   * Optional, and absent means silent: every announcement resolves as though it
   * had been skipped, and the épreuve runs exactly as it did before this existed.
   * That is what keeps the phase-machine tests free of an audio fake they have
   * nothing to say about — and it is also the honest behaviour for a browser that
   * cannot play the clips, since every word of them is on screen as well.
   */
  createAnnouncer?: (callbacks: { onEvent: AudioEventSink }) => AnnouncerLike;
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

/**
 * How long the candidate may say nothing, once the examiner has stopped
 * speaking, before the examiner speaks again (#84).
 *
 * The ask was 7 to 10 seconds and this sits in the middle of it. It is a
 * different kind of number from `silenceDurationMs` in `gemini/live-config.ts`,
 * which is 1.2 s: that one decides when a candidate who IS speaking has
 * finished, and it is long because a B2 candidate hunting for a word must not be
 * cut off. This one decides when a candidate who has not started at all should
 * be helped, and eight seconds of nothing is well past any pause for thought
 * while still being a silence the candidate is living through.
 */
const SILENCE_NUDGE_MS = 8_000;

/**
 * How many times one débat may ask whether the candidate is still there.
 *
 * The relance is the épreuve doing its job and is not rationed: every examiner
 * turn that lands in silence earns one. This is the technical check, and a
 * candidate who has genuinely frozen — or walked out — must not be asked five
 * times whether they can hear.
 */
const MAX_PRESENCE_CHECKS = 2;

/**
 * How often the débat tells the examiner how much of it is left (#85).
 *
 * Coarse on purpose. Every cue makes the model speak — `sendDirective` is
 * `sendRealtimeInput`, which takes a turn — so this is not a clock display, it
 * is an intervention. One every three minutes is three of them in a
 * thirteen-minute débat, the last two minutes belonging to the closing handshake,
 * rather than a metronome the candidate has to talk around.
 */
const TIME_CUE_INTERVAL_MS = 180_000;

/**
 * How little may be left for a cue still to be worth sending.
 *
 * Under two minutes there is nothing a cue can do that the closing handshake is
 * not about to do properly, and everything to lose: the last cue of a débat
 * would land next to the closing directive with no turn boundary between them,
 * which is the blend {@link checkCandidateSilence} is also written to avoid.
 */
const TIME_CUE_FLOOR_MS = 120_000;

/**
 * How long the room must have been quiet before a cue is slipped into it.
 *
 * A cue is the app speaking on the examiner's behalf, and the one thing worse
 * than an examiner with no clock is one that talks over the candidate every
 * three minutes. Two seconds rather than one tick: a candidate hunting for a
 * word produces a 300 ms hole in the voiced audio, and a single quiet tick would
 * read that as the floor being free.
 */
const TIME_CUE_QUIET_MS = 2_000;

/**
 * How many times one débat will contradict an examiner that has said goodbye.
 *
 * Rationed for the same reason as the presence check: a model that has decided
 * the épreuve is over may say so again, and an app that answers every time is
 * two machines arguing in front of the candidate. Every occurrence is logged;
 * only the first two are answered.
 */
const MAX_EARLY_CLOSING_RECOVERIES = 2;

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

  /**
   * The monologue is being held open because nothing was recorded (#39).
   *
   * While this is set the phase clock does not move and the phase cannot end —
   * not on the candidate's button and not on its own time-up. Cleared only by
   * `restartMonologue()`, which is what « Réessayer la transcription » calls.
   */
  private monologueHeld = false;

  /**
   * DEVELOPMENT ONLY — the microphone is off because the developer is typing
   * the candidate's turns instead of speaking them (#36).
   *
   * Never true in a production build; `setDevTextMode` is the only writer and
   * it returns before assigning there.
   */
  private devTextMode = false;

  /**
   * DEVELOPMENT ONLY — the seconds a typed phase claims to have lasted (#36).
   *
   * Zero on every real sitting, and on every production build, because
   * `injectCandidateSpeech` is the only writer and it returns before reaching
   * this line there.
   *
   * **How far the claim travels.** It is carried in the finished payload and the
   * finish route substitutes it for the measured duration — but only in a
   * development build, and only for a phase that uploaded no audio at all. That
   * route measures a real sitting's duration out of the bytes it received
   * precisely so a client cannot claim one, and this does not weaken that: with
   * a recording present the recording still wins, so the override cannot be used
   * to dress a short sitting up as a long one.
   */
  private devSeconds: Record<RecordedPhase, number> = { monologue: 0, debate: 0 };

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
  /**
   * The examiner's opening turn of this phase has been delivered.
   *
   * False from the moment a session opens until the examiner has finished its
   * first turn on it, or the speaker has run out of that turn. While it is
   * false an interruption is refused — see {@link handleInterruption}.
   */
  private openingTurnDelivered = false;
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

  /**
   * The silence watch: when the candidate was last known to be doing something,
   * and how many times the examiner has spoken into the silence since (#84).
   *
   * `silenceSince` doubles as the armed flag — non-null only between an
   * examiner turn completing in the débat and the watch standing down. It is
   * re-anchored rather than merely compared, in the same way the held monologue
   * re-anchors its phase clock: while the examiner is still audible, or while
   * voiced audio is still arriving, "the silence started now" is the truth and
   * there is then one number to read rather than several to reconcile.
   *
   * `silenceNudges` counts from the candidate's last answer, NOT from the
   * window. It has to: each nudge makes the examiner speak, and that turn
   * completing re-arms the window, so a counter that reset with the window would
   * relance every eight seconds forever.
   */
  private silenceSince: number | null = null;
  private silenceNudges = 0;
  private presenceChecks = 0;
  /** The voiced total the watch last saw, so growth in it reads as "the
   *  candidate is speaking right now" — the aggregate alone cannot. */
  private lastVoicedSeconds = 0;

  /**
   * The débat's time cue: which cue has gone out, and how long the room has been
   * quiet enough to send the next one into (#85).
   *
   * `lastTimeCueIndex` is an index into the three-minute grid rather than a
   * count, so a cue held back by a candidate who is still speaking coalesces
   * with the next one instead of queueing behind it. A débat interrupted for
   * four minutes owes one cue, not two.
   *
   * The quiet clock is deliberately NOT the silence watch's. That one is armed
   * only between an examiner turn and its stand-down, and it is re-anchored as a
   * side effect of reading it; this one has to be true at every moment of the
   * débat, including the ones the watch has stood down from.
   */
  private lastTimeCueIndex = 0;
  private cueVoicedSeconds = 0;
  private floorQuietSince: number | null = null;

  /**
   * The examiner said goodbye in the middle of the débat (#85).
   *
   * `earlyClosingHeard` belongs to the turn being transcribed, not to the phase:
   * fragments merge into one entry, so the same sentence is re-read on every
   * fragment after it and must be flagged once. Cleared when the turn ends,
   * which is also where the answer is sent from.
   */
  private earlyClosingHeard = false;
  private earlyClosingRecoveries = 0;

  /**
   * The consigne being spoken, and everything the candidate can do about it (#37).
   *
   * `announcementId` is the phase's consigne and is NOT cleared when the clip
   * ends — see `ExamState.announcement`. `announceToken` is the same
   * supersession guard the announcer and the player keep: a consigne that has
   * been replaced at a phase boundary must not write its own outcome over the
   * one that replaced it, and a candidate skipping the préparation while its
   * briefing is still playing reaches exactly that ordering.
   */
  private announcer: AnnouncerLike | null = null;
  private announcementId: AnnouncementId | null = null;
  private announcementPlaying = false;
  private announcementBlocked = false;
  private announceToken = 0;
  /** The same guard for candidate-initiated playback. See {@link playAnnouncement}
   *  for why it cannot share `announceToken`. */
  private playbackToken = 0;
  /** Resolves the hold a blocked consigne puts on a phase, when the candidate
   *  either plays it or gives up on it. Null when nothing is held. */
  private announcementHold: ((outcome: AnnouncementOutcome) => void) | null = null;

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
    // Built here rather than in `prepareAudio`, because the first consigne is
    // spoken during preparation and that method is deliberately not called until
    // the monologue. Nothing is opened by constructing it: the clip element is
    // created on the first `play`.
    this.announcer =
      deps.createAnnouncer?.({ onEvent: (name, detail) => this.log(name, detail) }) ?? null;
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
      phaseStartedAt: this.phaseStart === null ? null : this.phaseStart - this.examStart,
      connection: this.connection,
      status: examStatus(this.phase, this.connection),
      // A consigne is the examiner talking, so the scene animates for it exactly
      // as it does for a streamed turn. It also keeps the candidate's own
      // "recording" indicator down while it plays, which is true twice over
      // here: nothing is being captured yet either.
      examinerSpeaking: this.examinerSpeaking || this.announcementPlaying,
      transcript: this.transcript,
      events: this.events,
      reconnectCount: this.reconnectCount,
      // A phase cannot be ended before it has begun (#37). Until it does, its
      // clock has not started and no session is open, so `beginClosingHandshake`
      // would ask an examiner that is not there for a closing sentence — then
      // wait for a turn that can never complete, on a frozen clock that never
      // reaches the safety timeout.
      canAdvance:
        canAdvanceEarly(this.phase, this.elapsed) && !this.closing && !this.phaseAwaitingStart,
      closing: this.closing,
      micError: this.micError,
      // False during a stall too, not only after a lost device. The point of the
      // indicator is that the candidate can check the claim, and a pulsing
      // "Enregistrement" over a capture that has stopped delivering is the one
      // state where the claim is false and the indicator says it is true.
      // False in the development text mode too, for the same reason: the
      // recorder is paused, so the badge would be describing a capture that is
      // not happening.
      // False until the phase's clock is anchored, too. The microphone opens
      // before the consigne is spoken and the phase's artefact opens after it, so
      // between the two there is a window where a recorder exists and this phase
      // is recording nothing — and a lit indicator there would be the one claim
      // the badge exists to make checkable, made falsely (#37).
      recording:
        this.recorder !== null &&
        this.phaseStart !== null &&
        !this.captureLost &&
        !this.captureStalled &&
        !this.devTextMode &&
        (this.phase === "monologue" || this.phase === "debate"),
      started: this.started,
      monologueSeconds: this.phaseSeconds.monologue,
      debateSeconds: this.phaseSeconds.debate,
      monologueSilent: this.isMonologueSilent(),
      monologueHeld: this.monologueHeld,
      devTextMode: this.devTextMode,
      announcement: this.announcementId,
      // Armed and waiting for the click — as distinct from waiting for the
      // consigne to finish, which is the consigne control's business.
      awaitingStart:
        this.phaseAwaitingStart && !this.announcementPlaying && !this.announcementBlocked,
      announcementPlaying: this.announcementPlaying,
      announcementBlocked: this.announcementBlocked,
    };
  }

  /**
   * A speaking phase that is open but has not begun: its consigne is being
   * given, or it is armed and waiting for « Enregistrer ».
   *
   * One question, one answer, read off `phaseStart` — the field that already
   * means "this phase's clock is running" everywhere else. See `canAdvance`
   * below for what it costs to get this wrong, and why preparation is not
   * included: preparation leaves without a closing handshake, and « Passer et
   * commencer maintenant » must keep working while the briefing plays.
   */
  private get phaseAwaitingStart(): boolean {
    if (this.phase !== "monologue" && this.phase !== "debate") return false;
    return this.phaseStart === null;
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
   *
   * The development text mode takes that same exit, and it is the same rule
   * rather than an exception to it: while it is on there is no microphone in
   * this sitting, so there is no silent candidate to catch. Without it the
   * dictation box would be unusable — room tone captured before the mode was
   * switched on is measured audio carrying no speech, which is exactly what #39
   * holds the phase for, and the developer would be trapped at a monologue they
   * had just typed in full.
   */
  private isMonologueSilent(): boolean {
    if (!this.recorder || this.devTextMode) return false;
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
    // Here rather than on the session callback, so the development text mode's
    // typed turns count as answers too — a developer typing into the débat is
    // exactly as present as one speaking into it (#84).
    if (speaker === "candidate") this.noteCandidateAnswered();
    this.transcript = appendFragment(this.transcript, {
      phase: this.phase,
      speaker,
      timestamp: this.now() - this.examStart,
      text,
    });
    if (speaker === "examiner") this.watchForEarlyClosing();
    this.emit();
  }

  /**
   * Notice that the examiner has taken its leave seven minutes early (#85).
   *
   * Read off the transcript because that is the only place the intent exists:
   * Gemini reports a turn, not what the turn was for, and « Vous pouvez quitter
   * la salle » is ordinary French. See `delf/early-closing.ts` for the phrases
   * and for why a false positive is cheap here.
   *
   * **Only outside a closing handshake.** Inside one the examiner was ASKED for
   * exactly this sentence and saying it is the handshake working. `closing` is
   * therefore the whole difference between the line that ends the épreuve and
   * the identical line that must not.
   *
   * The turn accumulated so far is what is matched, not the fragment that just
   * arrived: Gemini splits a sentence wherever it likes, and half a goodbye in
   * each of two fragments is still a goodbye.
   *
   * Nothing is sent from here. The examiner is still mid-turn, and a directive
   * arriving now would blend into the sentence it is answering — the hazard
   * `tick()` is ordered around. It is answered at the turn boundary instead.
   */
  private watchForEarlyClosing(): void {
    if (this.phase !== "debate" || this.closing || this.earlyClosingHeard) return;
    const turn = this.transcript[this.transcript.length - 1];
    if (!turn || turn.speaker !== "examiner" || !readsAsClosing(turn.text)) return;
    this.earlyClosingHeard = true;
    // Logged whether or not it will be answered, and with what is left on the
    // clock: a débat where the examiner tried to leave at 6:00 is a fact about
    // the sitting, and one the transcript alone states only by implication.
    this.log("examiner-early-closing", {
      remainingSeconds: remainingSeconds("debate", this.elapsed),
      answered: this.earlyClosingRecoveries < MAX_EARLY_CLOSING_RECOVERIES,
    });
  }

  /**
   * Answer the goodbye, now that the examiner has stopped speaking (#85).
   *
   * Returns whether anything was said, because the caller must not also arm the
   * silence watch on a turn it has just answered: the recovery makes the
   * examiner speak again, and that turn ending is what opens the candidate's
   * window. Arming here would start an eight-second countdown racing a directive
   * already in flight.
   */
  private answerEarlyClosing(): boolean {
    if (!this.earlyClosingHeard) return false;
    this.earlyClosingHeard = false;
    // The clock ran out between the goodbye and this boundary, so the épreuve
    // really is ending and the model was merely early. Nothing to contradict.
    if (this.phase !== "debate" || this.closing) return false;
    if (this.earlyClosingRecoveries >= MAX_EARLY_CLOSING_RECOVERIES) return false;
    this.earlyClosingRecoveries += 1;
    const minutes = Math.max(1, Math.round(remainingSeconds("debate", this.elapsed) / 60));
    this.log("examiner-early-closing-answered", { minutes });
    this.sendControllerDirective("early-closing-recovery", resumeDebateInstruction(minutes));
    return true;
  }

  // ------------------------------------------------------------- announcements

  /**
   * Speak the consigne for a phase, and do not return until it has been heard,
   * skipped, or given up on (#37).
   *
   * The await is the whole point of the method. Every caller is at a phase
   * boundary, and what they must not do is start the candidate's clock or their
   * recording while the examiner is still talking:
   *
   *  - **The recording.** The monologue records the microphone. A consigne played
   *    through the speakers while capture was running would be captured, land in
   *    the transcript, and pollute the very performance being graded. The briefing
   *    already asks for a headset for this reason and that cannot be relied on, so
   *    the ordering is enforced here instead of hoped for.
   *  - **The clock.** Twenty-five seconds of consigne is four per cent of a
   *    monologue, and the DELF's duration floor is graded. The phase's clock is
   *    anchored by the caller *after* this resolves.
   *
   * A `blocked` outcome is the one that does not resolve straight through.
   * Browsers refuse to autoplay without a recent gesture, and while the two
   * click-driven boundaries are safe, preparation's clock simply running out is
   * not: nothing has been clicked for thirty minutes. Returning there would start
   * a recording and leave a consigne that plays into it the moment the candidate
   * finds the button, so instead the phase is held and the screen offers the
   * choice. Both ways out are one click, nothing is being spent while it waits,
   * and `destroy()` releases it.
   */
  private async announce(id: AnnouncementId): Promise<AnnouncementOutcome> {
    const announcer = this.announcer;
    if (!announcer) return "skipped";

    // A hold left over from an earlier consigne. Reachable because the
    // préparation's briefing is spoken without being awaited: if the browser
    // refused it and the candidate then pressed « Passer et commencer
    // maintenant », that hold has no reader and this consigne is about to
    // overwrite its resolver. Released rather than dropped, so no promise is left
    // pending forever with a listener attached to it.
    this.releaseAnnouncementHold("skipped");

    const token = (this.announceToken += 1);
    this.announcementId = id;
    this.announcementPlaying = true;
    this.announcementBlocked = false;
    this.emit();

    let outcome = await announcer.play(ANNOUNCEMENTS[id].src);

    // Superseded — a later boundary is already speaking. Its state is the state.
    if (token !== this.announceToken) return outcome;

    if (outcome === "blocked") {
      this.announcementPlaying = false;
      this.announcementBlocked = true;
      this.log("announcement-held", id);
      this.emit();
      outcome = await new Promise<AnnouncementOutcome>((resolve) => {
        this.announcementHold = resolve;
      });
      if (token !== this.announceToken) return outcome;
    }

    this.announcementPlaying = false;
    this.announcementBlocked = false;
    this.log("announcement", { id, outcome });
    this.emit();
    return outcome;
  }

  /**
   * Play the phase's consigne now, on the candidate's own click.
   *
   * One button since #59: « Écouter la consigne », which answers a browser that
   * refused to autoplay. The « Réécouter » that shared this method went with the
   * card, and with it every case where a phase was *not* waiting on the answer —
   * which {@link releaseAnnouncementHold} handles either way.
   *
   * Being a click is what makes it work: the autoplay policy this exists to
   * survive is satisfied by the gesture that called it.
   */
  playAnnouncement(): void {
    const id = this.announcementId;
    const announcer = this.announcer;
    if (!id || !announcer) return;

    // Its own counter, not `announceToken`: this playback must not supersede the
    // `announce()` parked on the hold it is answering, only another of its own.
    // Without it a double-clicked « Écouter la consigne » has the first click's
    // playback report itself finished while the second one is still audible, and
    // the control disappears over the sound of the examiner talking.
    const token = (this.playbackToken += 1);

    this.announcementPlaying = true;
    this.announcementBlocked = false;
    this.emit();

    void announcer.play(ANNOUNCEMENTS[id].src).then((outcome) => {
      if (token !== this.playbackToken) return;
      this.announcementPlaying = false;
      this.emit();
      this.releaseAnnouncementHold(outcome);
    });
  }

  /**
   * Silence the consigne that is playing, and let the phase get on with it.
   *
   * Labelled « Passer » (#59). It could not be, while the préparation carried a
   * ghost « Passer et commencer maintenant » that ended a thirty-minute phase —
   * two controls both reading "Passer", one silencing a clip and one ending the
   * préparation, would have been genuinely ambiguous. That ghost is gone and the
   * only other way on is « Commencer » in the topbar, so the short label is the
   * unambiguous one.
   *
   * This clip only. The sticky « Couper les annonces » was deleted with the card
   * that carried it: nothing now silences a consigne the candidate has not
   * reached yet.
   */
  skipAnnouncement(): void {
    this.announcer?.stop();
    // Cleared here rather than left to `announce()` on the far side of its await.
    // The clip stops synchronously, so a snapshot taken in the same tick that
    // still said "playing" would be describing a silence.
    this.announcementPlaying = false;
    this.releaseAnnouncementHold("skipped");
  }

  /** Let a held phase continue. Releases nothing when nothing is held — a skip
   *  landing after the clip finished on its own — but still emits, because the
   *  caller has just changed what the control should be drawing. */
  private releaseAnnouncementHold(outcome: AnnouncementOutcome): void {
    const hold = this.announcementHold;
    this.announcementHold = null;
    hold?.(outcome);
    this.emit();
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Begin the exam. Preparation's clock starts now.
   *
   * The briefing is spoken but **not** awaited, which is the one place a consigne
   * runs alongside a clock rather than in front of it. Preparation is thirty
   * minutes of reading and note-taking that the candidate can start on
   * immediately; holding the phase shut for half a minute would buy nothing, and
   * re-anchoring its clock afterwards would show a timer jumping backwards from
   * 29:26 to 30:00. Half a minute out of thirty minutes is also not a duration
   * anything grades — unlike the monologue's, which is why that one waits.
   *
   * **Called when the épreuve opens, not from a button (#55).** A briefing screen
   * used to stand between the sujet and the préparation and call this from its
   * CTA, so a candidate who had already pressed « Commencer » was asked to press
   * it again — and the consigne fired below, being the first thing that happens
   * after this, could not be heard until they did. `ExamClient` calls it on mount
   * now. The clip still plays on the ordinary path because entering the épreuve
   * is a client-side navigation: the document keeps the sticky activation the
   * candidate's click gave it. A hard load of the same URL has no activation, and
   * `announce()` already answers for that — the phase is not held, the card
   * carries the text, and « Écouter la consigne » is one click.
   *
   * Refused after `destroy()`, which is not hypothetical: this is now called from
   * an effect rather than a click, and a controller torn down between the two
   * would otherwise start a ticker counting a phase nobody is in and speak into
   * a closed announcer.
   */
  start(): void {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.examStart = this.now();
    this.phaseStart = this.now();
    this.startTicker();
    this.log("exam-started", this.deps.topic.slug);
    void this.announce("preparation");
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
    // The speaker first, and on its own terms (#74).
    //
    // The two devices fail for different reasons and only one of them is the
    // candidate's to fix, but they used to be installed together: the player
    // was built, resumed, and then closed in the microphone's catch. A refused
    // permission therefore also cost the examiner its voice on a sitting whose
    // socket and transcript were both working — so the débat printed questions
    // that were never spoken, the faces never moved, and the only notice on
    // screen talked about the microphone. Nothing about the examiner speaking
    // depends on the candidate being recorded, so nothing here makes it.
    if (!(await this.openPlayer())) return false;

    try {
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
      // microphone is installed on the controller only at the line below, so a
      // teardown that ran meanwhile found the field null and closed nothing;
      // without this check the device is then adopted by a controller that is
      // already gone, and nothing will ever stop it again. The speaker answers
      // its half of the same race in `openPlayer`, and each device guards its
      // own version internally; this is that race one layer up, where only the
      // controller can see it.
      if (this.destroyed) {
        await recorder.stop().catch(() => {});
        this.log("audio-discarded", "the sitting ended while the microphone was opening");
        return false;
      }

      this.recorder = recorder;
      // The development text mode can be switched on during preparation, before
      // there is any microphone to turn off. The device has to arrive already
      // paused, or the toggle silently means nothing for the phase it was
      // pressed for.
      if (this.devTextMode) recorder.pause();
      this.micError = null;
      this.log("audio-ready");
      return true;
    } catch (error) {
      // The speaker opened above is deliberately left running. It is the half
      // that still works, and it is not the candidate's recording: keeping it is
      // the difference between an épreuve that goes unrecorded and one that is
      // also silent, on which the examiner asks questions only the feed reports.
      // `destroy()` closes it, as it does on every other path.
      this.reportAudioFailure(error);
      return false;
    }
  }

  /**
   * Open the speaker, and install it whether or not the microphone follows.
   *
   * Idempotent by reuse rather than by rebuilding: `prepareAudio()` retries
   * while there is no microphone — from `advanceEarly()`, and again at every
   * speaking boundary — and the speaker now survives those failures, so a retry
   * arrives with a working one already installed. Building a second
   * `AudioContext` there would abandon the first with nothing holding it, which
   * is the leak the two devices were bundled together to avoid.
   */
  private async openPlayer(): Promise<boolean> {
    if (this.player) return true;

    let player: PlayerLike | null = null;
    try {
      player = this.deps.createPlayer({
        onSpeakingChange: (speaking) => {
          // The speaker running out of the examiner's turn is one of the two
          // things that prove the opening question was delivered. See
          // {@link handleInterruption}.
          if (!speaking && this.examinerSpeaking) this.openingTurnDelivered = true;
          this.examinerSpeaking = speaking;
          this.emit();
        },
        onEvent: (name, detail) => this.log(name, detail),
      });
      await player.resume();

      // The same teardown race the microphone answers below, one device earlier.
      if (this.destroyed) {
        await player.close().catch(() => {});
        this.log("audio-discarded", "the sitting ended while the speaker was opening");
        return false;
      }

      this.player = player;
      return true;
    } catch (error) {
      await player?.close().catch(() => {
        /* nothing left to report; the exam failure below is the story */
      });
      // The microphone is not attempted after this, and the notice below is the
      // one it would have raised anyway: a browser that cannot open an
      // `AudioContext` for playback will not open a capture graph either.
      this.reportAudioFailure(error);
      return false;
    }
  }

  /** One notice for either device. Both are refused by the same prompt and by
   *  the same browser, and neither failure is worth a sentence that asks the
   *  candidate for something different. */
  private reportAudioFailure(error: unknown): void {
    const denied =
      typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "SecurityError");
    this.micError = denied ? MIC_MESSAGES.denied : MIC_MESSAGES.unavailable;
    this.log("audio-failed", String(error));
    this.emit();
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
    // A microphone we turned off ourselves is not a microphone that failed.
    // Without this the development text mode would raise the stalled-capture
    // notice four seconds in, every time, and teach developers to ignore the
    // one notice that means something.
    if (this.devTextMode) return;

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

  /**
   * The candidate has the floor and the clock on their silence starts now (#84).
   *
   * Armed at the end of an examiner turn, and only in the débat. The monologue
   * is excluded twice over: its prompt says the silences belong to the candidate
   * — « Les silences font partie de l'épreuve » — and its transport could not do
   * this anyway, since manual voice-activity detection means no `activityEnd`
   * for the whole phase and therefore no turn to end.
   */
  private armSilenceWatch(): void {
    if (this.phase !== "debate" || this.silenceStepsSpent) return;
    this.silenceSince = this.now();
    this.lastVoicedSeconds = this.recorder?.voicedSeconds("debate") ?? 0;
  }

  /**
   * The escalation has nothing left to say into this silence: a relance has gone
   * out, and so has the check (or the check's ration for the whole débat is
   * spent).
   *
   * It is what keeps the examiner's OWN turns from restarting the watch. Every
   * nudge makes the model speak, that turn completing re-arms the window, and
   * without this the pair would trade a directive and a stand-down every eight
   * seconds for the rest of the débat — silently, since nothing more is sent,
   * but writing a line into the sitting's log each time. Only an answer restarts
   * it. See {@link noteCandidateAnswered}.
   */
  private get silenceStepsSpent(): boolean {
    if (this.silenceNudges === 0) return false;
    return this.silenceNudges >= 2 || this.presenceChecks >= MAX_PRESENCE_CHECKS;
  }

  /**
   * The candidate answered: the escalation goes back to the beginning.
   *
   * Called for a transcription fragment and for an interruption the controller
   * honoured, which are the two things that prove a person rather than a room.
   * Voiced audio is deliberately not one of them — it holds the window open (see
   * {@link checkCandidateSilence}) but a cough is not an answer, and letting it
   * clear the counter would let a noisy room earn an unlimited number of « Vous
   * m'entendez ? ».
   */
  private noteCandidateAnswered(): void {
    this.silenceNudges = 0;
    if (this.silenceSince !== null) this.silenceSince = this.now();
  }

  /**
   * Break a silence the examiner cannot notice on its own (#84).
   *
   * The examiner asks a question, the candidate says nothing, and nothing
   * happens: the débat runs on automatic voice-activity detection, which takes a
   * turn when it hears speech END. A candidate who never starts speaking
   * produces no speech-end, so there is no turn boundary and the model is never
   * given the floor. It is not choosing to wait, it has not been asked anything
   * — which is why this is the controller's problem and not the prompt's.
   *
   * **What counts as "still nothing".** Recent voiced audio, plus any
   * transcription fragment. The transcript alone would be the wrong signal:
   * Gemini emits `onCandidateTranscript` on its own schedule, so a candidate two
   * seconds into an answer may have produced no text yet and a relance fired
   * then talks over them. The voiced measure is the recorder's own
   * (`audio/voice-activity.ts`) and is read here as growth per tick rather than
   * as the per-phase aggregate it was built for, which is what turns "did they
   * speak at all" into "are they speaking now".
   *
   * **Two steps, then silence.** A relance on the substance first, because that
   * is the épreuve doing its job; a fixed « Vous m'entendez ? » only if that also
   * lands in nothing, because by then the likely fault is technical. After that
   * the watch stands down until the candidate answers: the alternative is
   * badgering someone who has frozen or left.
   *
   * **What it declines to notice.** A microphone that has stalled or gone away
   * produces no voiced audio either, and the candidate can see why on screen
   * already; asking them out loud whether they can hear, over a device that
   * cannot carry their reply, is noise on top of a failure. The development text
   * mode is out for the same reason as the stall watchdog: a microphone we
   * turned off ourselves has not failed.
   */
  private checkCandidateSilence(): void {
    if (this.silenceSince === null) return;
    if (this.phase !== "debate" || this.closing || this.devTextMode) return;

    const recorder = this.recorder;
    if (!recorder || this.captureLost || this.captureStalled) return;

    const now = this.now();

    // The examiner's own question is still coming out of the speaker. The
    // candidate has not been silent for eight seconds; they have been listening
    // for eight seconds. `onTurnComplete` fires when generation ends, and Gemini
    // generates a turn faster than it is heard, so this window is several
    // seconds wide on every single turn.
    if (this.examinerSpeaking || this.announcementPlaying) {
      this.silenceSince = now;
      return;
    }

    // A step spent into a socket that is not up is spent unheard. Worse than it
    // looks from `sendControllerDirective`'s catch: `SessionManager.sendDirective`
    // opens with `if (!this.socket) return`, so a directive during a reconnect
    // is dropped WITHOUT throwing, and nothing downstream could tell the
    // difference. Since the check is rationed, a candidate who froze just as the
    // connection dropped could have both of theirs burnt in silence and never be
    // asked anything at all. Re-anchored rather than merely skipped: when the
    // socket comes back the eight seconds start again, because a relance should
    // follow a question the candidate actually heard.
    if (this.connection !== "connected") {
      this.silenceSince = now;
      return;
    }

    const voiced = recorder.voicedSeconds("debate");
    if (voiced > this.lastVoicedSeconds) {
      this.lastVoicedSeconds = voiced;
      this.silenceSince = now;
      return;
    }

    if (now - this.silenceSince < SILENCE_NUDGE_MS) return;

    if (this.silenceNudges === 0) {
      this.silenceNudges = 1;
      // Re-anchored rather than closed: a directive is not a promise that the
      // model will speak, and if it says nothing either, the next step is due
      // eight seconds from the attempt rather than on the very next tick.
      //
      // This is the second site that anchors the window, and the two are not
      // redundant: {@link armSilenceWatch} covers the model ANSWERING the
      // relance, this covers it saying nothing back. Whichever happens first
      // anchors, and they agree only because both mean "now" — so a future
      // change to either has to keep meaning that.
      this.silenceSince = now;
      this.log("silence-relance");
      this.sendControllerDirective("silence-relance", silenceRelanceInstruction());
      return;
    }

    // Exactly one step is left to reach here, because `silenceStepsSpent` stops
    // the window being re-armed after this one.
    if (this.presenceChecks < MAX_PRESENCE_CHECKS) {
      this.silenceNudges = 2;
      this.presenceChecks += 1;
      // Closed, not re-anchored. This is the last thing that will be said into
      // this silence, and re-anchoring would only schedule a stand-down.
      this.silenceSince = null;
      this.log("silence-presence-check", { of: MAX_PRESENCE_CHECKS });
      this.sendControllerDirective("silence-presence-check", presenceCheckInstruction());
      return;
    }

    // A relance into a débat whose two checks are already spent. Nothing left to
    // say, so the watch stands down and says so once: a sitting where the
    // examiner had to prompt and got nothing back is a fact about that sitting,
    // and the correction's diagnostics read this log.
    this.silenceSince = null;
    this.log("silence-unanswered", { nudges: this.silenceNudges });
  }

  /**
   * Lend the examiner the clock it does not have (#85).
   *
   * A Live session carries no notion of elapsed time. The model is told « environ
   * 13 minutes » once, in its system instruction, and after that nothing ever
   * tells it how much of the débat has gone or how much is left. A model that has
   * run out of counter-arguments, or that reads a lull as the end of an exchange,
   * has nothing to weigh against the feeling that this is over — and one of them
   * thanked the candidate and showed them the door at 6:00 of 13:00. Two things
   * make that likelier the longer a débat runs: the sliding context window drops
   * the oldest turns, and the temperature is high on purpose.
   *
   * So the app says it, every three minutes, through the same directive path as
   * the closing line.
   *
   * **A cue is an intervention, not a display.** `sendDirective` is
   * `sendRealtimeInput`, which takes a turn: the examiner WILL speak in response
   * to this. That is why the text tells it to spend the turn on a new objection
   * rather than on an acknowledgement, and why nothing is sent unless the floor
   * is free — {@link floorIsQuiet}. A candidate who never pauses simply gets the
   * cue late, which costs nothing; a candidate talked over mid-argument loses a
   * graded answer.
   *
   * **Nothing is sent near the end.** Under two minutes the closing handshake is
   * about to do this properly, and a cue there would land beside the closing
   * directive with no turn boundary between them.
   *
   * A stalled or lost microphone does NOT stand this down, unlike the silence
   * relance: that one asks the candidate a question over a device that cannot
   * carry the answer, and this one only keeps the examiner from concluding a part
   * that has not finished. The speaker still works, and a candidate reading a
   * microphone error is better off in an épreuve that is still running.
   *
   * Returns whether it spoke, so `tick()` can keep the silence relance from
   * speaking on the same tick.
   */
  private checkDebateTimeCue(): boolean {
    if (this.phase !== "debate") return false;
    const now = this.now();
    // Before every guard below, because a quiet clock only means anything if it
    // has been kept during the noise as well.
    const quiet = this.floorIsQuiet(now);
    if (this.closing || this.devTextMode) return false;
    if (this.connection !== "connected") return false;

    const remaining = remainingSeconds("debate", this.elapsed);
    if (remaining * 1000 < TIME_CUE_FLOOR_MS) return false;

    // An index into the three-minute grid, not a count: a cue held back while
    // the candidate was speaking coalesces with the next one rather than
    // arriving two at a time behind it.
    const index = Math.floor((this.elapsed * 1000) / TIME_CUE_INTERVAL_MS);
    if (index === 0 || index <= this.lastTimeCueIndex) return false;
    if (!quiet) return false;

    this.lastTimeCueIndex = index;
    const minutes = Math.max(1, Math.round(remaining / 60));
    // The cue makes the examiner speak, so the silence window is re-anchored on
    // the attempt for the same reason the relance is: the answer to a question
    // that has not been asked yet is not a silence.
    if (this.silenceSince !== null) this.silenceSince = now;
    this.log("debate-time-cue", { minutes });
    this.sendControllerDirective("debate-time-cue", timeRemainingInstruction(minutes));
    return true;
  }

  /**
   * Has the room been quiet long enough to speak into it?
   *
   * Its own measurement rather than the silence watch's, and the two are not
   * duplicates: `silenceSince` exists only between an examiner turn and the
   * watch standing down, and reading it re-anchors it. This has to hold at every
   * moment of the débat, including the stretches the watch has stood down from.
   *
   * Two seconds rather than one tick, because a B2 candidate hunting for a word
   * leaves a 300 ms hole in the voiced audio and a single quiet tick would read
   * that as the floor being free.
   */
  private floorIsQuiet(now: number): boolean {
    const voiced = this.recorder?.voicedSeconds("debate") ?? 0;
    const busy = this.examinerSpeaking || this.announcementPlaying || voiced > this.cueVoicedSeconds;
    this.cueVoicedSeconds = voiced;
    if (busy) {
      this.floorQuietSince = null;
      return false;
    }
    if (this.floorQuietSince === null) {
      this.floorQuietSince = now;
      return false;
    }
    return now - this.floorQuietSince >= TIME_CUE_QUIET_MS;
  }

  /** Make the examiner speak on the app's initiative rather than the model's —
   *  a relance into a silence, a time cue, a débat put back on its feet — and
   *  survive a socket that has gone away. Its own catch rather than `tolerate`,
   *  whose event says "teardown": nothing is ending here, and a directive that
   *  failed to go out should not read as a phase that failed to close. */
  private sendControllerDirective(step: string, instruction: string): void {
    try {
      this.session?.sendDirective(instruction);
    } catch (error) {
      this.log("directive-failed", { step, error: String(error) });
    }
  }

  /** The candidate ends the current phase early. */
  async advanceEarly(): Promise<void> {
    if (!canAdvanceEarly(this.phase, this.elapsed)) return;
    // Refused rather than confirmed: a monologue with no speech on it has
    // nothing to grade, so the only way on is to attempt it. See
    // `holdMonologue` for the two things that stop this being a trap.
    if (this.phase === "monologue" && this.isMonologueSilent()) {
      this.holdMonologue("the candidate ended a monologue with no speech on it");
      return;
    }
    if (this.phase === "preparation") {
      const ready = await this.prepareAudio();
      if (!ready) return;
      // The guard at the top was checked before the await, and « Commencer » is
      // a button: a double-click puts two of these in flight on the same
      // `prepareAudio()` promise, both having seen the préparation, and the
      // second would advance the monologue the first had just opened — straight
      // to the débat, past the silence hold and the five-minute floor, which
      // were both consulted about a phase that no longer is (#104). The clock
      // running out during the permission prompt is the same window: whoever
      // ended the préparation first wins, and a click that arrives to find it
      // already over means nothing more than that.
      if (this.phase !== "preparation") return;
      await this.advance();
      return;
    }
    this.beginClosingHandshake();
  }

  /**
   * Start the part the candidate is looking at: « Enregistrer ».
   *
   * This is the moment the épreuve begins for that part. The clock is anchored,
   * the phase's artefact opens, and the examiner's session connects — in that
   * order, and all three from one click.
   *
   * **Why a click rather than automatically.** The passation screen now carries
   * the sujet and the plan, and a candidate arrives at it having heard a consigne
   * telling them to present a document they are about to re-read. Starting the
   * clock underneath that reading would charge them for it, and the DELF grades
   * how long they spoke. So the part waits. Nothing is spent while it does: the
   * timer shows the part's full length and the microphone, though open, belongs
   * to no phase, so `PhaseArchive` discards whatever it hears.
   *
   * Refused while the consigne is still being given, which is not a special case
   * so much as the same rule the button's own disabled state applies — the
   * examiner is talking, and the candidate's turn has not been handed over.
   *
   * Idempotent, because it is a button: a second click on a part that has already
   * begun must not re-anchor its clock or open a second session.
   */
  startSpeaking(): void {
    if (this.phase !== "monologue" && this.phase !== "debate") return;
    if (this.phaseStart !== null) return;
    if (this.announcementPlaying || this.announcementBlocked) return;
    if (this.destroyed) return;

    const phase = this.phase;
    this.phaseStart = this.now();
    this.log("phase-started", phase);
    this.emit();
    this.beginRecording(phase);
    // Not awaited: this is a click handler, and the connection reports itself
    // through `onStateChange` exactly as it does on every other path.
    void this.openSession(phase);
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

    this.monologueHeld = false;
    this.phaseStart = this.now();
    this.elapsed = 0;
    this.phaseSeconds.monologue = 0;
    this.log("monologue-restarted", "no speech was recorded");
    this.emit();
  }

  /**
   * Stop the monologue's clock and refuse to leave the phase.
   *
   * Two things stop this being a trap, and neither is incidental:
   *
   *  - **A dead microphone is never held.** `monologueWasSilent` answers false
   *    when nothing was captured at all, so a candidate whose capture failed
   *    while they spoke passes straight through and is graded on the "corrigé
   *    sans l'audio" path. Only a working microphone with no voice on it is
   *    held.
   *  - **Abandoning still works.** The exit is untouched, and it is honest
   *    about its price — the épreuve is recorded as a walk-out scored 0/25.
   *
   * What is gone is the clock as an escape: a candidate with a working
   * microphone who never speaks is now required to speak, which is the rule
   * this product was asked for.
   */
  private holdMonologue(why: string): void {
    if (this.monologueHeld) return;
    this.monologueHeld = true;
    this.log("monologue-held", why);
    this.emit();
  }

  /**
   * DEVELOPMENT ONLY — turn the microphone off and type the candidate's turns
   * instead (#36).
   *
   * The dictation box used to sit open beside a live microphone, so a typed
   * sitting recorded whatever the room happened to contain. That is a worse lie
   * than no recording at all: the artefact is real audio of nobody speaking, it
   * is uploaded, it is graded, and the « Enregistrement » badge says it is
   * happening. This makes the mode mean what it says — while it is on, nothing
   * is captured and nothing is streamed.
   *
   * `pause()` rather than `stop()`, because the device stays open: the mode is
   * a toggle, and releasing the microphone would put a browser permission
   * prompt in the middle of a phase every time it went back on.
   *
   * What it does NOT do:
   *
   *  - **It does not discard what was already captured.** Audio recorded before
   *    the mode went on belongs to the phase and stays in the artefact. The
   *    duration penalty is then computed from a genuinely shorter recording,
   *    which is the truth about a phase that was half spoken and half typed.
   *  - **It does not run in production.** Same guard, and the same reason, as
   *    {@link injectCandidateSpeech}: two independent checks of the same flag,
   *    because
   *    the other one is a UI condition somebody could refactor away.
   */
  setDevTextMode(on: boolean): void {
    if (!DEV_TOOLS_ENABLED) return;
    if (this.devTextMode === on) return;

    this.devTextMode = on;
    if (on) {
      this.recorder?.pause();
    } else {
      this.recorder?.resume();
      // The watchdog stood down while the mode was on, so its bookkeeping is
      // four minutes stale and would fire a stall the instant it resumes.
      // Rewound to now, exactly as a phase change rewinds it.
      this.lastCaptureAt = this.now();
      this.lastRecordedSeconds = this.recorder?.recordedSeconds ?? 0;
      if (this.captureStalled) {
        this.captureStalled = false;
        this.micError = null;
      }
    }
    this.log("dev-text-mode", on ? "on — the microphone is off" : "off");
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
   *  - **It records no audio.** Under {@link setDevTextMode}, which is how this
   *    is meant to be used, the microphone is off and the phase measures zero
   *    seconds. `seconds` is what the phase should *claim* to have lasted
   *    instead — see {@link devSeconds} for how far that claim travels, and how
   *    far it deliberately does not.
   *  - **It does not advance the phase.** The clock and the state machine are
   *    untouched. {@link submitTypedExpose} is the one that does, and it is what
   *    the panel's « Envoyer l'exposé » calls.
   *  - **It does not run where marks are real.** The guard is `DEV_TOOLS_ENABLED`
   *    and it is the first line, so a production build cannot carry a way to
   *    write an exam transcript without speaking. See `lib/dev-tools.ts` for
   *    which environments that leaves.
   *
   * @param seconds How long this turn would have taken to say. Accumulated per
   *   phase, so several submissions add up the way several minutes of speaking
   *   would.
   */
  injectCandidateSpeech(text: string, seconds = 0): void {
    if (!DEV_TOOLS_ENABLED) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.phase !== "monologue" && this.phase !== "debate") return;

    if (Number.isFinite(seconds) && seconds > 0) {
      this.devSeconds[this.phase] += Math.round(seconds);
    }

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
   * DEVELOPMENT ONLY — deliver a typed exposé and end the monologue with it.
   *
   * What « Envoyer l'exposé » means. The text is not a fragment of the
   * monologue, it *is* the monologue: sending it is the same act as finishing
   * speaking, so the phase ends and the débat begins, through the same closing
   * handshake the microphone button uses. Leaving the developer on a monologue
   * they had just delivered in full — waiting out a clock for a task that was
   * done — was the thing that made the panel feel like it had not worked.
   *
   * **It starts the part when the part has not begun (#53).** Since #37 a
   * speaking phase opens armed and waits for « Enregistrer », and this used to
   * refuse while it did — silently, on the very flow the panel exists for:
   * arrive at the monologue, open the panel, paste, send. One press now means
   * the whole of what the button says, in the order the épreuve needs it —
   * anchor the clock, write the exposé down, leave for the débat. That is not a
   * hole in the arm gate: `DEV_TOOLS_ENABLED` is the first line here, so no
   * build where marks are real has this path at all, and `startSpeaking` is
   * untouched for the builds that do.
   *
   * The one refusal left is the consigne: while the examiner is speaking, the
   * candidate's turn has not been handed over, and starting underneath it would
   * record the instruction and charge the candidate for hearing it.
   *
   * **The five-minute floor does not apply, and that is the point.** `canAdvanceEarly`
   * exists to stop a candidate skipping the task; here the task has been handed
   * over complete, and the whole reason to type it was not to spend five minutes
   * saying it. The floor still governs every real candidate, because this method
   * cannot be reached in a build where the tooling is off.
   *
   * **No closing handshake, and no session for the monologue at all.** A spoken
   * monologue ends by asking the examiner for a closing sentence and waiting up
   * to `CLOSING_SAFETY_MS` for it, because that wait is what lets Gemini's
   * transcription of the candidate's last words arrive. A typed exposé has
   * nothing in flight — the text was handed over whole — so the wait is several
   * seconds of an épreuve that has already finished this part, with nothing on
   * screen to explain them. The examiner is told all the same: the débat's
   * session is seeded from the transcript by `monologueAsHistory`, which is
   * where the typed text now is. For the same reason an armed monologue does not
   * connect anybody — a socket opened here would be closed in the same act,
   * having heard nothing and said nothing.
   *
   * @returns Whether the exposé counted as the monologue. `false` means nothing
   *   happened at all — no turn, no clock, no phase change — and the caller
   *   still holds the only copy of the text, so it must not throw it away.
   */
  async submitTypedExpose(text: string, seconds = 0): Promise<boolean> {
    if (!DEV_TOOLS_ENABLED) return false;
    if (this.phase !== "monologue") return false;
    // Nothing typed is not a delivered exposé, so it must not end the phase —
    // otherwise the button becomes a way to skip the monologue entirely.
    if (!text.trim()) return false;
    // A handshake somebody else started — the mic button, or the clock running
    // out — already owns the end of this phase.
    if (this.closing) return false;

    if (this.phaseAwaitingStart && !this.anchorTypedMonologue()) return false;

    this.injectCandidateSpeech(text, seconds);
    this.log("dev-expose-submitted", "ending the monologue");
    // Not awaited, and nothing is waited for: `advance()` sets the phase and
    // emits before it does anything asynchronous, so the débat is on screen by
    // the time this returns. What follows — the microphone handed back, the
    // débat's own consigne — is the ordinary path, unchanged.
    //
    // That synchronous stretch is what makes the `true` below true, and it used
    // to be reachable only if nothing in it threw: a socket that failed on the
    // way out took the phase change with it and left this method still claiming
    // the exposé had counted (#65). The steps in question are guarded now, and
    // `advanceDetached` reports anything else that fails rather than dropping it.
    this.advanceDetached();
    return true;
  }

  /**
   * DEVELOPMENT ONLY — anchor an armed monologue that is about to end anyway.
   *
   * Everything « Enregistrer » does except open a session, because
   * {@link submitTypedExpose} ends the phase in the same act and a socket opened
   * here would be closed before it had finished connecting. What is kept is what
   * the rest of the sitting reads: the clock is anchored and the phase's artefact
   * is opened and stamped, so the monologue reports itself as a phase that
   * happened rather than one nothing can date.
   *
   * `false` while the consigne is being given — the same refusal `startSpeaking`
   * makes, for the same reason.
   */
  private anchorTypedMonologue(): boolean {
    if (this.phase !== "monologue" || this.phaseStart !== null) return false;
    if (this.announcementPlaying || this.announcementBlocked) return false;
    if (this.destroyed) return false;

    this.phaseStart = this.now();
    this.log("phase-started", "monologue");
    // `emit()` then `beginRecording()`, in that order, because `startSpeaking`
    // does it in that order and this claims to be that method minus the session.
    // Nothing observes the difference today; a claim of parity that is only
    // nearly true is how the next reader ends up comparing the two line by line.
    this.emit();
    this.beginRecording("monologue");
    return true;
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
      this.advanceDetached();
      return;
    }
    if (this.closing) return;

    this.closing = true;
    this.log("closing-handshake");

    if (this.phase === "monologue") this.endMonologueActivity();
    // Tolerated for the same reason as the teardown steps, and this one is the
    // candidate's own « Terminer » rather than a development tool: a socket that
    // threw here never reached the stamp below, so `closingHasTimedOut()` could
    // never become true and the safety timeout — the whole reason a silent
    // examiner cannot strand anybody — was itself stranded (#65).
    const instruction = closingInstruction(this.phase);
    this.tolerate("closing-directive", () => this.session?.sendDirective(instruction));

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

  /**
   * Advance without waiting for it, and without dropping the reason if it fails.
   *
   * Five callers hand the phase change off rather than awaiting it, and every
   * one of them is right to: a turn completing, a clock running out and a typed
   * exposé all have somewhere else to be, and `advance()` ends with a consigne
   * that takes twenty-five seconds to speak.
   *
   * What they were not right to do was write it `void this.advance()`. That
   * dropped the rejection: `submitTypedExpose` had already told the panel the
   * exposé was accepted, so the box emptied, the screen stayed on the exposé,
   * and the only trace anywhere was an unhandled rejection in a console nobody
   * had open (#65). The teardown steps that produced it are guarded now — but a
   * phase change that fails for some other reason must still say so, and this is
   * where it says it.
   */
  private advanceDetached(): void {
    // Read here, not in the catch. `advance()` flips the phase before the awaits
    // that can still fail — `finish()`'s teardown among them — so by the time a
    // rejection lands, `this.phase` is the part being entered and a log naming
    // it `from` would point at the wrong transition entirely.
    const from = this.phase;
    void this.advance().catch((error: unknown) => {
      this.log("advance-failed", { from, error: String(error) });
    });
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
      this.tolerate("end-phase", () => this.recorder?.endPhase());
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

    // DEVELOPMENT ONLY — the transcription panel lives on the exposé and nowhere
    // else (#36), so leaving the monologue is what gives the microphone back.
    // Without this the mode would outlive the only screen that can use it: the
    // débat would be neither typeable nor recordable, and it would arrive at the
    // correction with an empty transcript and zero seconds.
    if (this.devTextMode && current === "monologue") {
      this.tolerate("dev-text-mode-off", () => this.setDevTextMode(false));
    }

    this.phase = target;
    // Null, not `now()`: the phase is open but its clock has not started. The
    // examiner's consigne is spoken first, and the seconds it takes belong to
    // neither the phase that ended nor the one about to begin (#37). Anchored
    // below, once the consigne has been heard, skipped or refused. A null
    // `phaseStart` already means "no clock" everywhere that reads it — `tick()`
    // returns early, the recording indicator stays dark, and `remaining` shows
    // the phase's full length rather than a countdown that has begun.
    this.phaseStart = null;
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

      // The consigne, then the candidate's own go-ahead, then the clock, the
      // microphone and the examiner. None of that order commutes: the consigne
      // must not be recorded, so it goes before capture opens; it must not be
      // charged to the candidate, so it goes before the clock; and the session
      // opens last so the examiner is not left holding a turn while an
      // instruction it did not give is being read out.
      await this.announce(target);
      // A sitting that ended while the consigne was playing — the tab closed,
      // the candidate walked out. There is no phase left to start.
      if (this.destroyed) return;

      // ARMED, not started. `phaseStart` stays null and `startSpeaking()` is
      // what anchors it, from the candidate's own click on « Enregistrer ». The
      // part is now the sujet, the plan and a button, with no clock running: a
      // candidate reading the document they are about to speak about is not
      // spending the seven minutes they have to speak in.
      this.log("phase-armed", target);
      this.emit();
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
    // Same lifetime, same reason: the opening turn this guards is this
    // session's, not the one the previous phase finished. See
    // {@link handleInterruption}.
    this.openingTurnDelivered = false;

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
      onInterrupted: () => this.handleInterruption(),
      onTurnComplete: () => {
        // Whatever else this turn ending means below, it means the examiner has
        // finished the first thing it said on this session.
        this.openingTurnDelivered = true;
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
          this.advanceDetached();
          return;
        }
        // The turn that just ended was a goodbye the app never asked for, and
        // this is the first boundary at which it can be contradicted without
        // blending into it (#85). The recovery is itself an examiner turn, so
        // the window opens when THAT one ends and not before.
        if (this.answerEarlyClosing()) return;
        // Otherwise the examiner has finished asking something and the floor is
        // the candidate's. That is the moment the silence window opens (#84).
        this.armSilenceWatch();
      },
      onEvent: (name, detail) => this.log(name, detail),
    };

    // Only the débat is seeded: it is a fresh session that would otherwise know
    // nothing about the monologue it is supposed to challenge.
    const history = target === "debate" ? monologueAsHistory(this.transcript) : [];

    const session = this.deps.createSession(target, this.deps.topic, callbacks, history);
    this.session = session;
    await session.connect();

    // Null for the monologue since #37: the greeting it used to speak is now the
    // spoken consigne, which has already played by the time this runs. The débat
    // still has one, because its opening cannot be a fixed clip — it has to quote
    // an argument the candidate actually made.
    const opening = examinerOpeningLine(target);
    if (opening) session.sendDirective(opening);

    if (target === "monologue") {
      // Manual VAD: open the candidate's activity and never close it, so the
      // model has no turn boundary at which it could interrupt.
      session.beginCandidateActivity();
    }
  }

  /**
   * Gemini reports that the candidate took the floor: drop the queued playback.
   *
   * Refused until the examiner's opening turn has been delivered (#74), because
   * before that there is nothing to take the floor FROM. The débat opens with
   * the examiner's question, and the candidate cannot be interrupting a question
   * they have not been asked yet — so an interruption arriving in that window is
   * automatic VAD reacting to the room, and honouring it threw away the whole
   * question while the transcript went on printing it. The candidate then read
   * an objection nobody had spoken.
   *
   * Two things release it, whichever comes first: the turn completing, and the
   * speaker running out of it. The second matters because an interrupted
   * generation is not guaranteed to be followed by a `turnComplete`, and a guard
   * that could only be released by one of them could stay shut for a whole
   * débat — leaving an examiner the candidate genuinely cannot talk over.
   *
   * After that, an interruption is exactly what it says: the candidate is
   * speaking, and the examiner stops.
   *
   * **What refusing it can and cannot do.** `interrupted` reports a decision the
   * server has already taken: generation stopped, and no client can ask for the
   * rest of a turn that was never produced. What this keeps is everything
   * already delivered — which is usually the whole question, because Gemini
   * streams a turn faster than real time and the candidate is hearing its first
   * second while the remaining four sit queued in the player. That queue is
   * exactly what the flush threw away, and it is the failure that was reported:
   * a question printed in full and never heard. A turn genuinely cut short
   * server-side arrives short in the transcript too, and nothing here can make
   * it longer.
   */
  private handleInterruption(): void {
    // Redundant to name the phase: `log` stamps every event with it.
    const buffered = this.player?.bufferedSeconds ?? 0;
    if (!this.openingTurnDelivered) {
      this.log("interruption-refused", { buffered });
      return;
    }
    this.log("interruption", { buffered });
    this.player?.interrupt();
    // Talking over the examiner is the loudest possible answer to « Vous
    // m'entendez ? », and it arrives before any transcription of it does (#84).
    this.noteCandidateAnswered();
  }

  /** Release the monologue floor exactly once. See `activityEnded`. */
  private endMonologueActivity(): void {
    if (this.activityEnded) return;
    this.activityEnded = true;
    this.tolerate("end-candidate-activity", () => this.session?.endCandidateActivity());
  }

  private closeSession(): void {
    this.tolerate("close-session", () => this.session?.close());
    // Dropped whether or not the close succeeded. A socket this controller can
    // no longer talk to is not one it should keep a reference to — and holding
    // it would hand the next phase a session belonging to the last one.
    this.session = null;
  }

  /**
   * Run a step that ends something, and let the épreuve survive it failing.
   *
   * Every caller is a variation on telling a thing that is going away that it is
   * going away: the socket's activity marker, the socket itself, the recorder's
   * open artefact, the development text mode. None of them is a reason to keep
   * the candidate on a part that has ended — and all of them sit in `advance()`
   * BEFORE the phase changes, so before this existed, one throw left the épreuve
   * on a finished part with no way forward (#65).
   *
   * The throw is real rather than theoretical: `endCandidateActivity` reaches
   * `sendRealtimeInput` on a WebSocket the SDK still believes is open, which is
   * exactly the state a dropped connection leaves behind.
   *
   * Not every site is one that throws *today* — `SessionManager.sendDirective`
   * and `close` catch their own errors, so those two are the interface's contract
   * being honoured rather than a live failure being caught. That is deliberate
   * and is not dead code: this class holds `LiveSessionLike`, not that class, and
   * the one time it assumed an implementation detail of the socket instead of the
   * interface was this bug.
   *
   * Logged, not swallowed. The step failed and the event log says which one, so
   * a recording that is short by one phase has something to be explained by.
   */
  private tolerate(step: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.log("teardown-failed", { step, error: String(error) });
    }
  }

  private async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.stopTicker();

    this.player?.interrupt();

    /**
     * The closing consigne, started here and awaited at the bottom (#37).
     *
     * Started early because the seconds after this are already spent
     * compressing a twenty-minute sitting into an upload, and a candidate who
     * has just stopped speaking should be told the épreuve is over while that
     * happens rather than a beat afterwards. The recording was closed by
     * `advance()` before this ran, so there is nothing left for the clip to
     * pollute.
     *
     * Awaited before `onFinished` because that is what navigates to the results
     * page. Letting it run past the navigation would leave the examiner's voice
     * talking over a screen that has moved on, from an element belonging to a
     * page that has been replaced. The finished screen says "Préparation de
     * votre enregistrement…" throughout, which is exactly what is happening.
     */
    const closing = this.announce("finished");

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

    // See the top of the method: the voice must not outlive the screen.
    await closing;

    this.deps.onFinished({
      transcript: this.transcript,
      recordings,
      phases,
      reconnectCount: this.reconnectCount,
      // Only when something was actually typed, so a real sitting sends no such
      // field at all rather than a pair of zeroes the route has to interpret.
      devSeconds:
        this.devSeconds.monologue > 0 || this.devSeconds.debate > 0
          ? { ...this.devSeconds }
          : undefined,
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

    // Held: re-anchor the phase's start to now so the elapsed count stands
    // still. Re-anchoring rather than tracking a paused duration means every
    // other reader of `phaseStart` — the time-up check, the phase report —
    // keeps working off one number with no second notion of time to reconcile.
    if (this.monologueHeld) {
      this.phaseStart = this.now() - this.elapsed * 1000;
      this.checkCaptureAlive();
      return;
    }

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
      this.advanceDetached();
      return;
    }

    if (isPhaseTimeUp(this.phase, seconds) && !this.closing) {
      // A monologue that ran its whole length in silence does not become a
      // débat. The clock stops, the screen says so, and the task stays to be
      // done — the same refusal the candidate's own button meets, applied to
      // the one path that would otherwise carry them past it.
      if (this.phase === "monologue" && this.isMonologueSilent()) {
        this.holdMonologue("the monologue's time ran out in silence");
        return;
      }
      if (phaseUsesLiveSession(this.phase)) this.beginClosingHandshake();
      else this.advanceDetached();
    }

    // The other watchdog on this heartbeat, and the same argument for it: a
    // question that has gone unanswered for eight seconds is a fact the exam's
    // one clock should notice (#84).
    //
    // LAST, and the order is the guard. A relance is the only thing `tick()`
    // says out loud, and the branch above is where the phase's clock running out
    // asks for the closing sentence. Run earlier, the one tick that crosses both
    // deadlines would send a relance and the closing directive back to back with
    // no turn boundary between them — two `sendRealtimeInput` texts, a blended
    // sentence, and the blend landing on the one turn the controller waits for to
    // let the candidate's last transcription arrive. A candidate who freezes in
    // the closing seconds is exactly who reaches it. From here `this.closing` is
    // already true and {@link checkCandidateSilence} stands down on it.
    //
    // The time cue answers to the same rule and sits inside the same window: it
    // speaks, so it runs after the closing branch, and it runs before the relance
    // so that a tick where both are due sends one directive rather than two (#85).
    // Which of the two wins does not much matter — a cue and a relance both end
    // in the examiner asking something — but sending both does.
    if (this.checkDebateTimeCue()) return;
    this.checkCandidateSilence();
  }

  /** Release everything. Safe to call twice. */
  destroy(): void {
    // Set before anything else: a `prepareAudio()` still waiting on the
    // permission prompt reads this when it resolves, and closes what it opened
    // rather than handing it to a controller that no longer exists.
    this.destroyed = true;
    this.stopTicker();
    this.clearClosingTimer();
    // Before anything is awaited. A phase held open by a consigne the browser
    // refused to play is waiting on a promise only a click resolves, and the
    // click cannot arrive on a page that is going away — `advance()` would keep
    // this controller, its microphone and its socket alive forever waiting for
    // one. Released as skipped, and `advance()` checks `destroyed` on the far
    // side rather than starting a phase nobody is in.
    this.announcer?.close();
    this.releaseAnnouncementHold("skipped");
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
