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
  formatClock,
  isPhaseTimeUp,
  monologueWasSilent,
  nextPhase,
  phaseDurationSeconds,
  phaseUsesLiveSession,
  remainingSeconds,
  type OralPhase,
} from "@/lib/delf/phases";
import { readsAsClosing } from "@/lib/delf/early-closing";
import { rewindStartBy } from "@/lib/ui/po-player-view";
import {
  closingInstruction,
  examinerOpeningLine,
  lastQuestionInstruction,
  presenceCheckInstruction,
  resumeAfterReconnectInstruction,
  resumeDebateInstruction,
  silenceRelanceInstruction,
  timeRemainingInstruction,
} from "@/lib/delf/examiner-prompt";
import type { OralTopic } from "@/lib/delf/topics";
import {
  appendFragment,
  debateSessionHistory,
  entriesForPhase,
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
  /** Discard one phase's recording entirely (#51). Called at the phase
   *  boundary for a phase whose content was typed, so its captured room tone
   *  never leaves the tab dressed as the task. Required rather than optional
   *  for the same reason `recordingFor` is: an implementation that forgot it
   *  would upload the stub silently. */
  dropPhase(phase: RecordedPhase): void;
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
  /**
   * The débat has begun and the examiner's opening question has not been
   * delivered yet — the connect-and-generate window before a word of it is
   * audible, plus however long it takes to speak.
   *
   * Exposed because the floor is the examiner's for that whole window, and
   * `examinerSpeaking` cannot say so: it reports the speaker, which is silent
   * until the first chunk actually plays. Without this the scene opened the
   * débat with the candidate's ring pulsing and « Vous avez la parole » under
   * it, over an examiner who was about to talk. The transcript in this same
   * snapshot is also held back while this is true and nothing has played yet,
   * for the same reason — see the controller's `visibleTranscript`.
   */
  openingQuestionPending: boolean;
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
   * DEVELOPMENT ONLY — the examiner is running under an edited system
   * instruction (#152).
   *
   * Always `false` where `DEV_TOOLS_ENABLED` is false, because
   * `setExaminerPrompt` refuses there. Rendered so the panel's badge reads the
   * fact off the controller instead of keeping a second copy — the same rule
   * `devTextMode` follows, and for the same reason: a panel that believed it
   * had applied a prompt the controller had discarded would send a developer
   * hunting for a behaviour change that was never installed.
   */
  examinerPromptModified: boolean;
  /**
   * DEVELOPMENT ONLY — a live examiner session exists right now (#152).
   *
   * Read off `this.session` rather than inferred from the connection state,
   * because the two disagree exactly where it matters: a session that is
   * connecting is one an applied prompt WILL restart, and a `connection` of
   * "idle" would have the panel promise the opposite. The prompt panel uses it
   * to say whether applying restarts the examiner or merely waits for the next
   * one, which is the only claim it makes that it could get wrong.
   */
  examinerSessionOpen: boolean;
  /**
   * The examiner's consigne for the phase now open, or null before the first one
   * (#37).
   *
   * It outlives its own playback, and since #59 nothing on screen does: the
   * consigne's control is a « Passer » button that exists for as long as the
   * voice does, and it reads `announcementPlaying` rather than this. What is
   * left here is the snapshot's record of which consigne the phase opened with.
   */
  announcement: AnnouncementId | null;
  /**
   * The part is open and waiting for the candidate to press « Enregistrer ».
   *
   * Nothing is running while this is true: the timer shows the part's full
   * length, no artefact is open, and the examiner is not connected. It is the
   * state the sujet and the plan are read in. See {@link ExamController.startSpeaking}.
   *
   * True from the moment the part opens, so it covers the consigne as well as
   * the silence after it (#176) — one flag, one meaning: *this part has not
   * begun*. It is deliberately not "the press would be taken now": that is
   * `announcementPlaying`'s to answer, and the two are read together by a
   * control that must say « Enregistrer » throughout and only accept the click
   * at the end. `startSpeaking` refuses during a consigne on its own account.
   */
  awaitingStart: boolean;
  /** A consigne is audible right now. */
  announcementPlaying: boolean;
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
   * How many goodbyes the examiner said mid-débat, outside a closing handshake
   * (#92) — the count behind every `examiner-early-closing` event, carried out
   * of the tab the way `reconnectCount` is, because the event log itself dies
   * with the page. Zero on the ordinary sitting.
   */
  earlyClosingCount: number;
  /**
   * Seconds of VOICED audio the microphone measured, per part.
   *
   * Not a duration and not a grade: the only question it answers is whether
   * the candidate was audibly in a part at all. The route pairs it with the
   * transcript, because those two disagreeing is a failure with exactly one
   * plausible owner — minutes of measured speech under an empty transcript is
   * the app having lost the words, never the candidate having declined to say
   * them. See `partsSpokenButUntranscribed` on the finish route.
   *
   * Zero for both when there was no recorder at all, and that is the truthful
   * reading: a sitting with no microphone has no evidence either way, and this
   * field only ever speaks up to excuse, never to accuse.
   */
  voicedSeconds: Record<RecordedPhase, number>;
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
    /** What a fresh connect is seeded with. A provider rather than an array
     *  because the manager reads it again on every fresh connect, and a
     *  reconnect that lost its resumption handle is one (#133): mid-débat it
     *  must return the exchange as it stands, not as it stood at the phase
     *  boundary. */
    history: () => Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>,
    /** The chosen examiner (#99), or undefined for the server's default. An
     *  argument rather than a closure so the factory cannot capture a choice
     *  that had not been made when the controller was built. */
    examinerModel: string | undefined,
    /** DEVELOPMENT ONLY — the examiner prompt this session should run under
     *  (#152), or undefined for the instruction the repository builds. An
     *  argument for the same reason as the model above: it is edited during
     *  the épreuve, so a factory that captured it would pin the wrong one. */
    examinerPrompt: string | undefined,
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
 * #84 asked for 7 to 10 seconds and this took the middle of it; #101 asks for
 * the top, because the relance now comes round again and a window that fires
 * early would make a candidate who is merely thinking hear the examiner twice
 * before they have begun. It is a different kind of number from
 * `silenceDurationMs` in `gemini/live-config.ts`, which is 1 s: that one
 * decides when a candidate who IS speaking has finished, and it is long because
 * a B2 candidate hunting for a word must not be cut off. This one decides when a
 * candidate who has not started at all should be helped, and ten seconds of
 * nothing is well past any pause for thought while still being a silence the
 * candidate is living through.
 *
 * Ten seconds buys the FIRST step of a silence — « Vous m'entendez ? ». Every
 * step after it waits {@link SILENCE_STEP_MS}, which is longer, because by then
 * the candidate has been spoken to and is owed room to answer.
 */
const SILENCE_NUDGE_MS = 10_000;

/**
 * How long each step after the first waits.
 *
 * Longer than the ten seconds before « Vous m'entendez ? », and deliberately:
 * the first step asks a four-word question that is answered in one, while the
 * second repeats the examiner's question and the ones after it ask a new one —
 * things a candidate needs a moment to think about. Fifteen seconds of silence
 * after being spoken to is unambiguous, and it keeps a walked-out sitting to one
 * intervention every twenty-odd seconds rather than one every twelve.
 *
 * Measured in SILENCE, like the first: the window does not run while the
 * examiner is audible, so this is fifteen seconds after the nudge was heard, not
 * fifteen seconds after it was sent.
 */
const SILENCE_STEP_MS = 15_000;

/**
 * How much of an interval has to carry speech before the candidate counts as
 * speaking through it.
 *
 * The reason a real sitting could go thirty seconds in silence and hear nothing
 * back. This used to be any growth at all in the recorder's voiced total, which
 * is 40 ms — ONE frame — against a window of ten thousand. A cough, a chair, a
 * keyboard, a fan crossing −34 dBFS once every few seconds: each of them reset
 * the whole countdown, and in a room that is never perfectly quiet the countdown
 * never finished. The measure was built to answer "did the candidate speak at
 * all in this phase?" (`audio/voice-activity.ts`), where a single loud frame
 * costs nothing; read as "are they speaking right now?" it had no floor.
 *
 * So a tick counts as speech when at least this much of it was voiced. At the
 * 250 ms tick that is 100 ms — two and a half frames — which a click cannot
 * reach and a syllable comfortably does.
 */
const VOICED_SPEECH_RATIO = 0.4;

/**
 * How long an armed watch may say nothing at all before it explains itself.
 *
 * A silence that is being held open by one of the guards above produces no
 * nudge and no log line, which is exactly the report this got: "thirty seconds
 * and the examiner said nothing". The guards are individually right and
 * invisible together, so once the watch has been armed for three steps without
 * having spoken, it says once what has been holding it. Diagnostics only —
 * nothing branches on it.
 */
/**
 * How long the speaker must stay dry before that counts as the examiner having
 * finished its opening turn (#94).
 *
 * A turn arrives as many chunks and the player's queue empties whenever one
 * finishes before the next lands. That gap is network jitter, not the end of a
 * sentence, and treating it as the end of a sentence is what let the rest of an
 * opening question be flushed by the first noise in the room.
 *
 * A second is longer than any gap a working stream produces and short enough to
 * be invisible at the end of a real turn: what it costs is that a candidate who
 * barges in during that second is refused the interruption — the examiner keeps
 * talking for up to a second longer — and nothing about what is recorded or
 * transcribed changes.
 */
const OPENING_DRAIN_GRACE_MS = 1_000;

/**
 * How long the examiner's queued audio may sit without draining before the
 * watch stops believing it is being heard.
 *
 * The two playback holds below trust the player: a speaking flag, and the
 * seconds of audio scheduled and not yet played. Both lie the same way when the
 * speaker itself has died — an AudioContext the browser suspended schedules
 * every chunk and plays none of them, so the flag sticks on and the buffer
 * freezes above zero, forever. The candidate's sitting then does this: the
 * question prints in the feed, nothing comes out of the speakers, and the watch
 * re-anchors on "the examiner is still audible" for the rest of the part — no
 * relance, no « Vous m'entendez ? », no line in the log. Waiting for that audio
 * is waiting for a bus that has been cancelled.
 *
 * So progress is what earns the hold: the buffer DROPPING between ticks, which
 * is what actual playback does continuously. Six seconds without a single drop,
 * with audio queued, is a stall — longer than the burst in which Gemini streams
 * a whole turn into the queue (buffered grows for two or three seconds while
 * generation outruns playback, and that must not read as a stall), and shorter
 * than the first silence window, so a dead speaker costs seconds rather than
 * the épreuve.
 */
const PLAYBACK_STALL_MS = 6_000;

const SILENCE_HELD_REPORT_MS = 3 * SILENCE_STEP_MS;

/**
 * How often the débat tells the examiner how much of it is left (#85).
 *
 * Coarse on purpose. Every cue makes the model speak — `sendDirective` is
 * `sendRealtimeInput`, which takes a turn — so this is not a clock display, it
 * is an intervention. One every three minutes is three of them in a
 * thirteen-minute débat, the last two minutes belonging to the last question
 * and the closing handshake, rather than a metronome the candidate has to talk
 * around.
 */
const TIME_CUE_INTERVAL_MS = 180_000;

/**
 * How little may be left for an ordinary cue still to be worth sending.
 *
 * Under two minutes the grid stands down and the end of the débat belongs to
 * two spoken interventions instead: the last question (#108), announced as such
 * at this very crossing, and the closing handshake. A silent cue there would
 * land next to one of them with no turn boundary between, which is the blend
 * {@link checkCandidateSilence} is also written to avoid.
 */
const TIME_CUE_FLOOR_MS = 120_000;

/**
 * How little may be left for the last question still to be worth asking (#108).
 *
 * The announcement waits for a quiet floor like every cue, and a candidate deep
 * in an answer can hold it back well past the two-minute crossing. At some
 * point the question stops fitting: forty-five seconds is one short question
 * and one short answer before the closing directive wants the floor, and under
 * that the candidate is better served by an uninterrupted final answer than by
 * a « dernière question » whose reply the clock cuts in half. A débat that
 * never went quiet in the window simply misses the announcement, and the log
 * says so.
 */
const LAST_QUESTION_CUTOFF_MS = 45_000;

/**
 * How early the débat's closing directive goes out (#108).
 *
 * Sent at 0:00 the examiner only STARTS its sentence there — a couple of
 * seconds of generation, a few more of speech — so « le temps de l'épreuve est
 * écoulé » was always heard well after time was up, and the part ran long by
 * exactly that much. Led by ten seconds, the sentence lands while the clock
 * still shows seconds and the part ends where the clock says it does. The
 * teardown does not move: it still waits on the closing turn completing, which
 * is what lets the candidate's last transcription arrive (see
 * `beginClosingHandshake`).
 *
 * The monologue keeps 0:00, deliberately: every second before its boundary is
 * the candidate's graded monologue, and an examiner cutting in early there
 * takes speaking time the grille counts. The débat's last seconds are an
 * exchange the examiner is licensed to end.
 */
const CLOSING_LEAD_MS = 10_000;

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
 * How long an unanswered candidate answer holds the floor beyond that (#130).
 *
 * Two seconds of quiet is enough to prove a pause, but not enough to prove the
 * floor is FREE: between the candidate finishing an answer and the examiner's
 * rebound reaching the speaker there is a gap in which nobody is audible —
 * voice-activity detection has ended the candidate's turn and Gemini is already
 * generating its reply, none of which the controller can see. A cue slipped
 * into that gap lands beside the reply: two examiner turns back to back, each
 * asking its own question, which in the closing minutes is « une dernière
 * question » followed by another one.
 *
 * So while the candidate has spoken and no examiner turn has completed since,
 * a reply is presumed owed and the cue waits this long from the candidate's
 * last voiced moment. Eight seconds clears the generation gap by a wide margin
 * while staying under {@link SILENCE_NUDGE_MS}, and a reply that has still not
 * arrived by then is not coming — at which point the cue's demand for a new
 * question is the right voice to break in with, and it still beats the relance
 * to the tick (see `tick()`'s ordering). The cost when the examiner was never
 * going to reply is a cue up to six seconds later than before, which the grid
 * already tolerates from a candidate who simply kept talking.
 */
const EXAMINER_REPLY_WAIT_MS = 8_000;

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
   * DEVELOPMENT ONLY — the system instruction the next session opens under
   * (#152), or undefined for the one this repository builds.
   *
   * Undefined on every real sitting and in every production build:
   * `setExaminerPrompt` is the only writer and it returns before assigning
   * there. Read at `openSession` time rather than captured, so a prompt applied
   * mid-débat governs the session the restart opens.
   */
  private examinerPrompt: string | undefined;

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

  /**
   * DEVELOPMENT ONLY — the phases whose content was typed rather than spoken
   * (#51). Empty on every real sitting and every production build, because
   * `injectCandidateSpeech` is the only writer and it returns before reaching
   * this there.
   *
   * What membership costs: the phase's recording is dropped at its boundary
   * (see `advance()`), so a typed phase NEVER leaves the tab with an audio
   * file attached. The few seconds an open microphone captured around the
   * typing — room tone before the panel opened, mostly — were what made the
   * same typed sitting grade differently run to run: the stub flipped the
   * grading mode to audio, displaced the typed duration claim, and handed
   * the corrector silence labelled as the exposé.
   */
  private readonly typedPhases = new Set<RecordedPhase>();

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
   * first turn on it, or the speaker has run out of that turn AND STAYED THAT
   * WAY. While it is false an interruption is refused — see
   * {@link handleInterruption}.
   *
   * The second half of that sentence is #94. A turn arrives as many chunks, and
   * the player's queue empties whenever one chunk finishes before the next one
   * lands — ordinary network jitter, several times in a long question. Read as
   * "the turn is over", a single such gap opened the guard mid-question, and the
   * next thing automatic voice-activity detection heard in the room flushed
   * everything still queued: the question printed in full and never heard, which
   * is the failure #74 was filed about, reached through the door opened to keep
   * the guard from jamming shut. A drain that PERSISTS is a different claim from
   * a drain observed once, and `speakerDrainedAt` is what tells them apart.
   */
  private openingTurnDelivered = false;
  /** When the speaker last ran dry with the opening turn still unproven. Null
   *  whenever it is audible again, or once the turn is proven. */
  private speakerDrainedAt: number | null = null;
  /**
   * Playback of this session's opening turn has begun: the speaker reported
   * itself audible at least once since the session opened.
   *
   * Latched rather than read live off `examinerSpeaking`, because that flag
   * flickers false in the gap between two chunks of one question (#94), and
   * this one answers a question that must not flicker: has the candidate heard
   * ANY of the opening question yet? While the answer is no, the snapshot
   * withholds the débat's examiner turns from the feed — Gemini transcribes at
   * generation speed, several times faster than the voice, so without this the
   * whole question is printed while the audio is still connecting and the
   * candidate reads an objection nobody has spoken yet. `turnComplete` releases
   * the hold too (through {@link openingQuestionPending}), so a sitting whose
   * speaker failed still gets the question in the feed — the text is the only
   * voice it has left.
   */
  private openingTurnAudible = false;
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
   * `silenceSince` doubles as the armed flag — null until the first examiner
   * turn of the débat completes, and from then on non-null for the rest of the
   * part, since #101 removed the stand-down that used to clear it. It is
   * re-anchored rather than merely compared, in the same way the held monologue
   * re-anchors its phase clock: while the examiner is still audible, or while
   * voiced audio is still arriving, "the silence started now" is the truth and
   * there is then one number to read rather than several to reconcile.
   *
   * `silenceNudges` counts from the candidate's last answer, NOT from the
   * window. It has to: each nudge makes the examiner speak, and that turn
   * completing re-arms the window, so the count is what tells the third nudge of
   * one silence from the first nudge of the next one, and what decides which of
   * the three things gets said. What it no longer does is end the escalation —
   * #101 — so a silence that goes on being a silence goes on being answered.
   *
   * `silenceArmedAt` is the same moment as `silenceSince` on the tick the watch
   * is armed and is NOT re-anchored afterwards, which is what lets the watch
   * notice that it has been armed for a long time and said nothing.
   */
  private silenceSince: number | null = null;
  private silenceArmedAt: number | null = null;
  private silenceNudges = 0;
  /** How many silences of this débat have opened with « Vous m'entendez ? ».
   *  A tally for the log rather than a ration: the check is the first step of a
   *  silence and there is only ever one of it per silence, so what bounds it is
   *  how often the candidate stops answering. */
  private presenceChecks = 0;
  /** Why the window kept being re-anchored, counted per armed watch, and
   *  whether that has been reported. See {@link SILENCE_HELD_REPORT_MS}. */
  private silenceHolds: Record<string, number> = {};
  private silenceHeldReported = false;
  /**
   * The playback-progress ledger behind {@link PLAYBACK_STALL_MS}.
   *
   * `lastBufferedSeconds` is compared, not displayed: a drop between two ticks
   * is proof the audio is really reaching the speaker. `playbackStalled` is
   * sticky across enqueues on purpose — new audio landing in a dead player
   * grows the buffer without draining it, and growth must not read as recovery
   * or every relance sent into the stall would re-arm the very hold that
   * swallowed the last one. Only a drop clears it. Deliberately NOT reset at a
   * phase boundary: the player is the sitting's, and a context that died in the
   * monologue is still dead when the débat opens.
   */
  private lastBufferedSeconds = 0;
  private playbackStuckSince: number | null = null;
  private playbackStalled = false;

  /** The voiced total the watch last saw and when it saw it, so growth in it can
   *  be read as a RATE — the aggregate alone cannot say who is speaking now, and
   *  a single voiced frame is not somebody answering. */
  private lastVoicedSeconds = 0;
  private lastVoicedAt: number | null = null;

  /**
   * The next thing the examiner says is a new turn, not more of the last one
   * (#101).
   *
   * `appendFragment` coalesces consecutive fragments from the same speaker,
   * which is right for the fragments of one sentence and wrong for two separate
   * interventions. Every controller directive produces the second kind: the
   * examiner asked a question, the candidate said nothing, and ten seconds later
   * the app made the examiner speak again. Merged, the relance reads as the tail
   * of the question it was sent to replace, under that question's timestamp, in
   * the live feed and in the correction alike.
   *
   * Set where a controller directive is sent rather than where the relance is
   * chosen, so it covers the time cue (#85) and the answer to an early goodbye
   * as well: those are the same kind of intervention and were welded the same
   * way. `beginClosingHandshake` sets it by hand for the same reason, since its
   * directive is tolerated rather than caught and does not pass through
   * {@link sendControllerDirective}.
   */
  private examinerTurnBreakPending = false;

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
   * When the candidate's voice last grew the voiced total while the examiner
   * was not audible, and when an examiner turn last completed — the two sides
   * of "is a reply owed?" (#130). The candidate speaking after the examiner's
   * last completed turn means Gemini is presumed to be composing a rebound,
   * and {@link floorIsQuiet} holds the cues out of that gap for up to
   * {@link EXAMINER_REPLY_WAIT_MS}. Both are per-phase facts and reset with
   * the session in `openSession`: the monologue's closing turn must not read
   * as a reply to the débat's first answer.
   */
  private cueCandidateVoiceAt: number | null = null;
  private examinerTurnEndedAt: number | null = null;

  /**
   * Where the débat's last-question announcement stands (#108).
   *
   * Three states rather than a boolean because "it never went out" splits in
   * two, and the difference travels: `sent` is a promise the rest of the débat
   * has to keep (the early-goodbye recovery switches wording on it), while
   * `missed` — a floor that never went quiet before the cutoff — changes
   * nothing downstream but is logged, because a sitting where the candidate
   * was never told the end was coming should say so rather than read as
   * covered.
   */
  private lastQuestionCue: "pending" | "sent" | "missed" = "pending";

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
   * Every goodbye heard, answered or not — where `earlyClosingRecoveries` stops
   * counting at the recovery cap, this keeps going, because the third goodbye
   * the app gave up contradicting is still a fact about the sitting (#92).
   * Never reset: sitting-level, like `reconnectCount`, and it leaves the tab
   * the same way — on the finish payload, into `oral_exams.early_closing_count`.
   */
  private earlyClosingCount = 0;
  /**
   * How far into which transcript entry the counted goodbye reaches (#92).
   *
   * `earlyClosingHeard` guards re-matching only until the turn boundary clears
   * it — and a goodbye's entry can GROW past its boundary: beyond the recovery
   * cap nothing is sent, so no turn break is pending, and an examiner that
   * simply keeps talking with no candidate in between coalesces into the same
   * entry. Re-scanning the merged text would then re-count the goodbye already
   * on the record off text that contains no new one. So the watch matches only
   * the text that arrived since this mark, and the turn boundary advances the
   * mark over the whole spoken turn — one turn, one count, however its
   * fragments landed — while a REPEATED goodbye in the continuation is new
   * text, still matches, and still counts, which is what #91's every-one-on-
   * the-record test has always asserted.
   */
  private countedGoodbye: { index: number; textLength: number } | null = null;

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
  private announceToken = 0;

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
  /**
   * The closing turn has completed and the handshake is now waiting for its
   * AUDIO (#135).
   *
   * `turnComplete` is a fact about generation, and generation runs several
   * times faster than the voice: when it arrives, seconds of the closing
   * sentence are still queued in the player. Advancing on it directly is what
   * put the next part's consigne on top of the sentence still being spoken —
   * two voices at once, at every handover. So the turn completing only sets
   * this, and {@link finishClosingIfQuiet} advances once the speaker has run
   * dry. The safety deadline is unchanged and still bounds the whole
   * handshake, which is what keeps a dead speaker — a queue that will never
   * drain — from stranding the candidate here.
   */
  private closingTurnComplete = false;

  /**
   * The examiner chosen for this sitting (#99), handed to every session this
   * controller opens. Held here rather than closed over by `createSession`
   * because it can change during the préparation — after the controller is
   * built, before any session exists — and a factory that captured it at
   * construction would open the monologue on a stale choice.
   */
  private examinerModel: string | undefined;

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

  /**
   * Name the examiner for every session opened from here on (#99).
   *
   * Deliberately NOT applied to a session already open: the choice is only
   * changeable during the préparation, which opens none — and if a stray call
   * ever landed mid-débat, restarting the socket over it would trade a voice
   * for a dropped exam. The next session picks it up, which for the legal call
   * pattern is the first one.
   */
  setExaminerModel(model: string | null): void {
    this.examinerModel = model ?? undefined;
  }

  /**
   * DEVELOPMENT ONLY — run the examiner under a different system instruction
   * (#152).
   *
   * **Why this cannot touch the session that is open.** A Gemini Live session's
   * system instruction is fixed for its lifetime: it is pinned into the
   * ephemeral token before the socket exists (`/api/live-token`), and there is
   * no message that replaces it afterwards. So a new prompt can only ever
   * govern a NEW session, and this method stores it for the next one rather
   * than pretending the current examiner has changed its mind.
   *
   * {@link restartExaminerSession} is the other half — it makes "the next one"
   * be now — and the panel calls both, because a developer who has just edited
   * a prompt wants to hear it on the next question rather than after the next
   * phase boundary.
   *
   * `null` restores the built instruction. Refused outright where the tooling
   * is off: a second independent check of the same flag the panel's render and
   * the server's own gate make, because either could be refactored away and
   * this is the one that decides what a session runs under.
   */
  setExaminerPrompt(prompt: string | null): void {
    if (!DEV_TOOLS_ENABLED) return;
    const next = prompt?.trim() ? prompt : undefined;
    if (this.examinerPrompt === next) return;
    this.examinerPrompt = next;
    this.log("dev-examiner-prompt", next ? `${next.length} chars` : "back to the default");
    this.emit();
  }

  /**
   * DEVELOPMENT ONLY — close the examiner's session and open a fresh one
   * (#152).
   *
   * What makes an edited prompt audible without waiting for the next phase.
   * Deliberately NOT `forceReconnect()`, which is a *resume*: it carries the
   * resumption handle, so the server restores the session that already exists
   * — the one minted under the old instruction. Closing and opening builds a
   * new `SessionManager` with no handle at all, which is the only path that
   * mints a token under the prompt just applied.
   *
   * What it costs is the examiner's memory of the exchange so far, and that is
   * not hidden: the panel says so above the button. For a tool whose whole
   * purpose is watching one instruction behave differently from another, an
   * examiner that starts the argument again is the honest trade, and the
   * transcript on screen is untouched either way.
   *
   * A no-op unless a speaking phase has actually begun — there is no session
   * during the préparation, and an armed part has not opened one yet, so its
   * first connect will pick the new prompt up on its own.
   */
  restartExaminerSession(): void {
    if (!DEV_TOOLS_ENABLED) return;
    if (this.phase !== "monologue" && this.phase !== "debate") return;
    if (!this.session) return;
    this.log("dev-examiner-session-restart", this.phase);
    this.closeSession();
    // Detached, exactly as every other session open in this class is: this is
    // called from a click handler and the connection reports itself through
    // `onStateChange`. A failure here is a failed connect like any other.
    void this.openSession(this.phase).catch((error) =>
      this.log("dev-examiner-session-restart-failed", String(error)),
    );
  }

  /**
   * DEVELOPMENT ONLY — fast-forward the part's clock (#149).
   *
   * PORT NOTE: the reference's admin time-skip, whole. It rewinds the phase's
   * start stamp so the derived elapsed jumps forward, then ticks once so the
   * jump is applied now rather than on the next heartbeat. Because everything
   * that ends a part reads that same clock — the time-cue grid, the last
   * question's window, the closing lead, the safety timeout, the silent-
   * monologue hold — a skip exercises the real end-game exactly as waiting
   * would, and nothing here bypasses the closing handshake. That property is
   * the reference's design and the reason to port it rather than invent one.
   *
   * What it deliberately does NOT touch: `examStart`. Transcript timestamps
   * are `now - examStart`, so a skip moves no words; only this part's clock
   * jumps. The cost, same as the reference's: `phaseSeconds` at the boundary
   * claims the skipped time, so a skipped sitting reports minutes nobody
   * spoke. The server measures a real sitting's duration from the audio bytes,
   * so the claim travels no further than the payload — and no production build
   * carries this method at all.
   *
   * Refused while the phase is armed (no clock to move), while a closing
   * handshake owns the end of the part, and while the monologue is held —
   * `tick()` re-anchors a held clock to keep it still, so a skip there would
   * be silently undone, which is worse than a refusal.
   */
  devSkipTime(seconds: number): void {
    if (!DEV_TOOLS_ENABLED) return;
    if (this.phase !== "monologue" && this.phase !== "debate") return;
    if (this.phaseStart === null || this.closing || this.monologueHeld) return;

    this.phaseStart = rewindStartBy(this.phaseStart, seconds);
    this.log("dev-time-skip", { seconds, phase: this.phase });
    this.tick();
  }

  /**
   * DEVELOPMENT ONLY — jump straight to the part's time-up (#149).
   *
   * « Fin du temps » : lands the clock exactly on the phase's duration
   * regardless of how far it has run, so the very next tick is the ordinary
   * time-up — the monologue thanks and hands over, the débat sends its led
   * closing directive. Same guards, same mechanism, same port as
   * {@link devSkipTime}.
   */
  devSkipToEnd(): void {
    if (!DEV_TOOLS_ENABLED) return;
    if (this.phase !== "monologue" && this.phase !== "debate") return;
    if (this.phaseStart === null || this.closing || this.monologueHeld) return;

    this.phaseStart = this.now() - phaseDurationSeconds(this.phase) * 1000;
    this.log("dev-time-skip", { toEnd: true, phase: this.phase });
    this.tick();
  }

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
      openingQuestionPending: this.openingQuestionPending,
      transcript: this.visibleTranscript(),
      events: this.events,
      reconnectCount: this.reconnectCount,
      // A phase cannot be ended before it has begun (#37). Until it does, its
      // clock has not started and no session is open, so `beginClosingHandshake`
      // would ask an examiner that is not there for a closing sentence — then
      // wait for a turn that can never complete, on a frozen clock that never
      // reaches the safety timeout.
      canAdvance: canAdvanceEarly(this.phase) && !this.closing && !this.phaseAwaitingStart,
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
      examinerPromptModified: this.examinerPrompt !== undefined,
      examinerSessionOpen: this.session !== null,
      announcement: this.announcementId,
      // The part has not begun — including while its consigne is still being
      // spoken (#176). It used to exclude that window, and the control read the
      // difference as « Vous parlez. Cliquez pour terminer le débat. » over the
      // examiner's own voice: the mic's state ladder is total, so a phase that
      // is neither armed, closing nor connecting falls through to "recording".
      // Whether the click is *accepted* yet is `announcementPlaying`'s answer,
      // and the control disables itself on it.
      awaitingStart: this.phaseAwaitingStart,
      announcementPlaying: this.announcementPlaying,
    };
  }

  /**
   * The débat has begun and its opening question has not been delivered yet.
   *
   * The window between the candidate's « Enregistrer » and the end of the
   * examiner's first turn — connecting, generating, speaking. The floor is the
   * examiner's for all of it: the débat opens with their question, and a scene
   * reading `examinerSpeaking` alone put the parole on the candidate for the
   * several seconds before the first audio chunk actually played, inviting them
   * to answer a question that had not been asked. Ends the way the
   * interruption guard's own hold does — `turnComplete`, or the speaker
   * staying dry (#94) — because it is the same fact about the same turn.
   */
  private get openingQuestionPending(): boolean {
    return this.phase === "debate" && this.phaseStart !== null && !this.openingTurnDelivered;
  }

  /**
   * The transcript as the screen may show it now.
   *
   * The whole transcript, except while the débat's opening question is still
   * unheard: its text arrives at generation speed and its voice at speaking
   * speed, so until playback has begun (`openingTurnAudible`) the examiner's
   * débat turns are withheld from the snapshot — a candidate must not read a
   * question nobody has spoken yet. Display-only: everything recorded,
   * persisted or sent reads `this.transcript` directly, so nothing about the
   * sitting's record changes. Once released, the turns appear with their
   * original timestamps — transcript timestamps are generation times, not
   * playback times, and the correction depends on them staying that way.
   */
  private visibleTranscript(): readonly TranscriptEntry[] {
    if (!this.openingQuestionPending || this.openingTurnAudible) return this.transcript;
    return this.transcript.filter(
      (entry) => !(entry.phase === "debate" && entry.speaker === "examiner"),
    );
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
    const at = this.examStart ? this.now() - this.examStart : 0;
    const printable =
      detail === undefined
        ? undefined
        : typeof detail === "object"
          ? JSON.stringify(detail)
          : String(detail);
    this.events = [...this.events.slice(-199), { at, phase: this.phase, name, detail: printable }];
    // Nothing reads `events` outside this class — not the screen, not the finish
    // payload — so a sitting that behaved oddly used to leave the person who sat
    // it with nothing to look at, and a report like "thirty seconds and the
    // examiner said nothing" could not be checked against anything. Where the
    // development tooling is on (local, staging, previews — never production,
    // see `dev-tools.ts`) the same lines go to the console, which is somewhere a
    // person can actually read them while the épreuve is running.
    // `window`, because this is for the browser's console and `node --test` also
    // counts as a development environment: without it the unit suite prints
    // every event of every simulated sitting.
    if (DEV_TOOLS_ENABLED && typeof window !== "undefined") {
      console.info(`[exam ${formatClock(Math.round(at / 1000))}] ${name}`, printable ?? "");
    }
    this.emit();
  }

  // ------------------------------------------------------------- transcript

  private addFragment(speaker: "candidate" | "examiner", text: string): void {
    if (this.phase !== "monologue" && this.phase !== "debate") return;
    // Here rather than on the session callback, so the development text mode's
    // typed turns count as answers too — a developer typing into the débat is
    // exactly as present as one speaking into it (#84).
    if (speaker === "candidate") this.noteCandidateAnswered();
    const startsTurn = speaker === "examiner" && this.examinerTurnBreakPending;
    this.transcript = appendFragment(this.transcript, {
      phase: this.phase,
      speaker,
      timestamp: this.now() - this.examStart,
      text,
      startsTurn,
    });
    // Cleared on the fragment that consumed it, and only if that fragment
    // survived: `appendFragment` drops blank text, and Gemini emits blank
    // fragments at turn boundaries — spending the break on one would weld the
    // relance onto the question after all. The rest of the same turn's fragments
    // then merge into the entry this one opened, which is the ordinary behaviour
    // and the one that must not change.
    if (startsTurn && text.trim()) this.examinerTurnBreakPending = false;
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
   * each of two fragments is still a goodbye. Since #92 that accumulation runs
   * from the last COUNTED goodbye rather than from the top of the entry — a
   * turn's entry can keep growing past its boundary when nothing was sent to
   * break it, and re-reading the whole merged text would count the same
   * goodbye twice off its own stale words (see `countedGoodbye`).
   *
   * Nothing is sent from here. The examiner is still mid-turn, and a directive
   * arriving now would blend into the sentence it is answering — the hazard
   * `tick()` is ordered around. It is answered at the turn boundary instead.
   */
  private watchForEarlyClosing(): void {
    if (this.phase !== "debate" || this.closing || this.earlyClosingHeard) return;
    const index = this.transcript.length - 1;
    const turn = this.transcript[index];
    if (!turn || turn.speaker !== "examiner") return;
    // Only the text that arrived since this entry's counted goodbye, when it
    // has one — the entry can outlive its turn boundary (see `countedGoodbye`),
    // and the goodbye before the mark is on the record already. Entries are
    // append-only and coalescing replaces in place, so the index names the
    // same logical turn across every re-read.
    const unscanned =
      this.countedGoodbye?.index === index
        ? turn.text.slice(this.countedGoodbye.textLength)
        : turn.text;
    if (!readsAsClosing(unscanned)) return;
    this.earlyClosingHeard = true;
    this.countedGoodbye = { index, textLength: turn.text.length };
    // Counted at detection, not at the answer: the branch in
    // `answerEarlyClosing` where the clock ran out first still heard a goodbye
    // said with time on the clock, and the count is the record of the fault
    // rather than of the recovery (#92).
    this.earlyClosingCount += 1;
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
    // The turn is now wholly spoken, so the mark advances over all of it:
    // fragments that landed after the counted phrase were part of the same
    // goodbye, and only text arriving after THIS point can be a new one. The
    // index check matters — mid-turn candidate speech can have pushed the
    // goodbye's entry off the end, and a mark advanced over the wrong entry
    // would swallow real text.
    const index = this.transcript.length - 1;
    if (this.countedGoodbye?.index === index) {
      this.countedGoodbye = { index, textLength: this.transcript[index].text.length };
    }
    // The clock ran out between the goodbye and this boundary, so the épreuve
    // really is ending and the model was merely early. Nothing to contradict.
    if (this.phase !== "debate" || this.closing) return false;
    if (this.earlyClosingRecoveries >= MAX_EARLY_CLOSING_RECOVERIES) return false;
    this.earlyClosingRecoveries += 1;
    const minutes = Math.max(1, Math.round(remainingSeconds("debate", this.elapsed) / 60));
    this.log("examiner-early-closing-answered", { minutes });
    // A goodbye after the announced last question is answered differently: the
    // recovery must not demand the fresh objection that would break « une
    // dernière question » in the examiner's own mouth (#108).
    this.sendControllerDirective(
      "early-closing-recovery",
      resumeDebateInstruction(minutes, this.lastQuestionCue === "sent"),
    );
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
   * A `blocked` outcome — the browser refusing to autoplay without a recent
   * gesture — is treated as a skip, on the user's call. The épreuve used to be
   * HELD on it: the phase waited on a click, behind a panel explaining the
   * frozen clock and offering « Écouter la consigne » / « Commencer sans
   * écouter ». That panel is gone; a consigne the browser will not play is
   * forfeited, and the phase gets on with it. The ordering guarantees above
   * survive intact — the phase still arms only after this resolves, nothing is
   * recorded before the candidate's own « Enregistrer » — what changed is that
   * nobody is asked to click their way out of a silence. The refusal is still
   * logged, because "the candidate never heard the consigne" is a fact worth
   * keeping about a sitting.
   */
  private async announce(id: AnnouncementId): Promise<AnnouncementOutcome> {
    const announcer = this.announcer;
    if (!announcer) return "skipped";

    const token = (this.announceToken += 1);
    this.announcementId = id;
    this.announcementPlaying = true;
    this.emit();

    const outcome = await announcer.play(ANNOUNCEMENTS[id].src);

    // Superseded — a later boundary is already speaking. Its state is the state.
    if (token !== this.announceToken) return outcome;

    this.announcementPlaying = false;
    this.log("announcement", { id, outcome });
    this.emit();
    return outcome;
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
   * `announce()` already answers for that — the refusal is logged and the
   * consigne is forfeited, so the préparation carries on in silence.
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
    if (this.player) {
      // Reused across parts, so entering one must also wake it: the browser
      // can suspend a context that sat quiet through a seven-minute monologue,
      // and a suspended speaker at the débat's opening is the unheard first
      // question (#94). Not awaited — under autoplay policy this promise can
      // sit unresolved until the candidate's next click, and `advance()` must
      // not hang on it; the gesture-borne resume in `startSpeaking` is the one
      // that cannot be refused.
      void this.player.resume().catch(() => {});
      return true;
    }

    let player: PlayerLike | null = null;
    try {
      player = this.deps.createPlayer({
        onSpeakingChange: (speaking) => {
          // The speaker running out of the examiner's turn is one of the two
          // things that prove the opening question was delivered — but only if
          // it stays run out (#94). Timed rather than believed: `tick()` is what
          // decides, once the drain has lasted longer than a gap between chunks.
          if (!speaking && this.examinerSpeaking && !this.openingTurnDelivered) {
            this.speakerDrainedAt = this.now();
          }
          if (speaking) {
            this.speakerDrainedAt = null;
            // The first audible moment of the session's opening turn, and the
            // release the feed's hold is waiting on. See `openingTurnAudible`.
            this.openingTurnAudible = true;
          }
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
   * The examiner's opening turn is over because the speaker has been quiet, not
   * because it was quiet for an instant (#94).
   *
   * The stamp is taken on the callback and spent here, on the exam's own
   * heartbeat, so the claim being made is "dry for a whole second" rather than
   * "dry at the moment somebody looked". While it is unspent the interruption
   * guard stays shut and the rest of the question survives the room.
   */
  private checkOpeningTurnDrained(): void {
    if (this.openingTurnDelivered || this.speakerDrainedAt === null) return;
    if (this.examinerSpeaking) return;
    if (this.now() - this.speakerDrainedAt < OPENING_DRAIN_GRACE_MS) return;
    this.speakerDrainedAt = null;
    this.openingTurnDelivered = true;
    // Worth a line of its own: this release is the one that has been wrong
    // twice, and a sitting where it fired says which of the two proved the turn.
    this.log("opening-turn-drained");
  }

  /**
   * The candidate has the floor and the clock on their silence starts now (#84).
   *
   * Armed at the end of an examiner turn, and only in the débat. The monologue
   * is excluded twice over: its prompt says the silences belong to the candidate
   * — « Les silences font partie de l'épreuve » — and its transport could not do
   * this anyway, since manual voice-activity detection means no `activityEnd`
   * for the whole phase and therefore no turn to end.
   *
   * **It no longer refuses to re-arm** (#101). It used to stand down once the
   * escalation was spent, which is what made a candidate who was late twice hear
   * the examiner once: the examiner's own nudge re-armed nothing, and only an
   * answer brought the watch back. Now every examiner turn that ends in the
   * débat opens a window, including the nudges' own turns, and the escalation in
   * {@link checkCandidateSilence} decides what to say into it.
   */
  private armSilenceWatch(): void {
    if (this.phase !== "debate") return;
    const now = this.now();
    this.silenceSince = now;
    this.silenceArmedAt = now;
    this.silenceHolds = {};
    this.silenceHeldReported = false;
    this.resetVoicedBaseline(now);
  }

  /** Start measuring voiced audio again from here. Called wherever the watch
   *  declines to read a stretch of it — the examiner's own voice comes back
   *  through the microphone, and a reconnect's backlog arrives all at once. */
  private resetVoicedBaseline(now: number): void {
    this.lastVoicedSeconds = this.recorder?.voicedSeconds("debate") ?? 0;
    this.lastVoicedAt = now;
  }

  /**
   * Whether the microphone has been carrying speech since the last look.
   *
   * A rate, not a change. The recorder's voiced total was built to answer "did
   * the candidate speak at all in this phase?" and one 40 ms frame moves it; the
   * question here is whether somebody is speaking *now*, and treating any
   * movement as an answer is what let a room with a fan in it hold the window
   * open indefinitely. See {@link VOICED_SPEECH_RATIO}.
   *
   * Reads and re-baselines in one call, so the interval is always "since the
   * last time anybody asked" and two callers cannot disagree about it.
   */
  private candidateIsSpeaking(now: number): boolean {
    const voiced = this.recorder?.voicedSeconds("debate") ?? 0;
    const grew = voiced - this.lastVoicedSeconds;
    const since = this.lastVoicedAt;
    this.lastVoicedSeconds = voiced;
    this.lastVoicedAt = now;
    if (since === null) return false;
    const elapsed = (now - since) / 1000;
    if (elapsed <= 0) return false;
    return grew >= elapsed * VOICED_SPEECH_RATIO;
  }

  /**
   * Whether the examiner is audibly speaking, as far as the watch is concerned
   * — and null the moment that claim stops being checkable.
   *
   * Playing audio DRAINS: `bufferedSeconds` falls between any two ticks that
   * playback crossed. A queue that holds its level while audio is scheduled is
   * one of two things — Gemini streaming a turn in faster than real time
   * (buffered grows for a few seconds, then drains for the rest of the turn),
   * or a speaker that has died and will never play what it holds. The first
   * clears itself well inside {@link PLAYBACK_STALL_MS}; the second is declared
   * a stall: logged once, answered with a `resume()` in case the context merely
   * suspended, and the hold is dropped so the silence escalation runs — the
   * question is on screen even when the room is silent, and « Vous
   * m'entendez ? » is the precise thing to ask over a speaker that may be dead.
   *
   * A drop is also what ends a stall, because it is the one thing a dead
   * speaker cannot do. Growth is not recovery: every relance sent into the
   * stall enqueues more audio, and letting that re-arm the hold would hand the
   * watch back to the fault it just escaped.
   */
  private examinerPlaybackHold(now: number): string | null {
    const buffered = this.player?.bufferedSeconds ?? 0;
    const dropped = buffered < this.lastBufferedSeconds;
    this.lastBufferedSeconds = buffered;

    if (dropped) {
      this.playbackStuckSince = null;
      if (this.playbackStalled) {
        this.playbackStalled = false;
        this.log("examiner-playback-recovered", { buffered: Number(buffered.toFixed(2)) });
      }
    }

    if (!this.examinerSpeaking && buffered <= 0) {
      this.playbackStuckSince = null;
      return null;
    }
    if (this.playbackStalled) return null;

    // A speaking flag with an empty queue cannot stall — it is the real
    // player's last instant of a turn, and the fakes' whole fiction — so the
    // clock only runs while there is audio that ought to be draining.
    if (buffered <= 0) {
      this.playbackStuckSince = null;
    } else if (!dropped) {
      this.playbackStuckSince ??= now;
      if (now - this.playbackStuckSince >= PLAYBACK_STALL_MS) {
        this.playbackStalled = true;
        this.playbackStuckSince = null;
        this.log("examiner-playback-stalled", {
          buffered: Number(buffered.toFixed(2)),
          speaking: this.examinerSpeaking,
        });
        // The one recovery the client owns: a context the browser suspended
        // resumes on request. A context that is beyond that ignores this, and
        // the escalation proceeds either way.
        void this.player?.resume().catch(() => {});
        return null;
      }
    }

    return this.examinerSpeaking ? "examiner-speaking" : "examiner-audio-queued";
  }

  /**
   * What this nudge waited through, for the log line that announces it.
   *
   * `waited` is the whole armed stretch — from the end of the examiner's turn to
   * this moment — and the step it was due after is the constant. The two differ
   * by whatever held the window open, and the holds say what that was. It is the
   * number to look at first when a sitting reports "thirty seconds and nothing":
   * a wait of eleven seconds means the watch did its job and the delay was
   * elsewhere (the question is long, the model is slow to answer), while a wait
   * of forty with `candidate-speaking` beside it means the room was talking.
   */
  private waitReport(now: number): Record<string, number> {
    const waited =
      this.silenceArmedAt === null ? 0 : Math.round((now - this.silenceArmedAt) / 1000);
    return { waitedSeconds: waited, ...this.silenceHolds };
  }

  /**
   * Note that the window was held open, and say so if it has been held for long
   * enough that the candidate is entitled to wonder why nothing is happening.
   *
   * Once per armed watch, with every reason and its count, because the reasons
   * compound: an examiner still audible and a socket that keeps dropping look
   * identical from the candidate's chair, and neither leaves a trace of its own.
   */
  private holdSilenceWatch(reason: string, now: number): void {
    this.silenceHolds[reason] = (this.silenceHolds[reason] ?? 0) + 1;
    this.silenceSince = now;
    if (this.silenceHeldReported || this.silenceArmedAt === null) return;
    if (now - this.silenceArmedAt < SILENCE_HELD_REPORT_MS) return;
    this.silenceHeldReported = true;
    this.log("silence-watch-held", {
      armedForSeconds: Math.round((now - this.silenceArmedAt) / 1000),
      ...this.silenceHolds,
    });
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
   * **What counts as "still nothing".** A transcription fragment is an answer,
   * and so is a stretch of voiced audio — but a stretch, not a frame. The
   * transcript alone would be the wrong signal, since Gemini emits
   * `onCandidateTranscript` on its own schedule and a candidate two seconds into
   * an answer may have produced no text yet. The voiced measure is the
   * recorder's own (`audio/voice-activity.ts`), read here as a RATE:
   * {@link candidateIsSpeaking}, and {@link VOICED_SPEECH_RATIO} for the sitting
   * that went thirty seconds in silence and heard nothing back because a room is
   * never perfectly quiet.
   *
   * **Three steps, and the last one repeats (#101).** Ten seconds of nothing
   * earns « Vous m'entendez ? », because at that point the likeliest reasons are
   * a candidate who heard nothing and a candidate who is lost, and four plain
   * words serve both. Fifteen seconds after that, the examiner's question again.
   * Fifteen seconds after that, a new and simpler one, and so on for as long as
   * the silence lasts. It used to stop after two steps, on the argument that
   * anything else is badgering someone who has frozen or left; a candidate who
   * is late twice in a débat was then being helped once, and an examiner in the
   * room asks again.
   *
   * What bounds it is the window rather than a counter. A nudge only goes out
   * after a whole step in which the examiner was not speaking, the consigne was
   * not playing, the socket was up and nobody was speaking into the microphone —
   * so the spacing is fifteen seconds of real silence plus however long the
   * examiner's own nudge took to say. What it costs, in the sitting where the
   * candidate has walked out, is a model turn every twenty-odd seconds into an
   * empty room; the `attempt` on each logged relance is what makes that visible
   * afterwards.
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

    if (!this.recorder || this.captureLost || this.captureStalled) return;

    const now = this.now();

    // A consigne is its own device and does not stall the way the player can,
    // so it keeps the simple hold: while it plays, the candidate is listening.
    if (this.announcementPlaying) {
      this.resetVoicedBaseline(now);
      this.holdSilenceWatch("announcement-playing", now);
      return;
    }

    // The examiner's own question is still coming out of the speaker — reported
    // by the player's flag AND measured off its queue, because `onTurnComplete`
    // fires when generation ends and Gemini generates a turn several times
    // faster than it is spoken: a window counted from the end of GENERATION put
    // « Vous m'entendez ? » at 0:13, inside the question it was asking about.
    // But heard only while the queue is actually draining — see
    // {@link examinerPlaybackHold} for the sitting where it never was.
    const playbackHold = this.examinerPlaybackHold(now);
    if (playbackHold) {
      // The microphone is hearing the examiner through the speakers while this
      // holds, so the voiced baseline restarts with the window.
      this.resetVoicedBaseline(now);
      this.holdSilenceWatch(playbackHold, now);
      return;
    }

    // A step spent into a socket that is not up is spent unheard. Worse than it
    // looks from `sendControllerDirective`'s catch: `SessionManager.sendDirective`
    // opens with `if (!this.socket) return`, so a directive during a reconnect
    // is dropped WITHOUT throwing, and nothing downstream could tell the
    // difference. Since the check is rationed, a candidate who froze just as the
    // connection dropped could have both of theirs burnt in silence and never be
    // asked anything at all. Re-anchored rather than merely skipped: when the
    // socket comes back the ten seconds start again, because a relance should
    // follow a question the candidate actually heard.
    if (this.connection !== "connected") {
      this.resetVoicedBaseline(now);
      this.holdSilenceWatch("not-connected", now);
      return;
    }

    if (this.candidateIsSpeaking(now)) {
      this.holdSilenceWatch("candidate-speaking", now);
      return;
    }

    // Ten seconds before the first step, fifteen before every one after it.
    const due = this.silenceNudges === 0 ? SILENCE_NUDGE_MS : SILENCE_STEP_MS;
    if (now - this.silenceSince < due) return;

    const nudge = (this.silenceNudges += 1);
    // Re-anchored rather than closed, and now on every step rather than only on
    // the first: a directive is not a promise that the model will speak, and if
    // it says nothing either, the next step is due ten seconds from the attempt
    // rather than on the very next tick.
    //
    // This is the second site that anchors the window, and the two are not
    // redundant: {@link armSilenceWatch} covers the model ANSWERING the nudge,
    // this covers it saying nothing back. Whichever happens first anchors, and
    // they agree only because both mean "now" — so a future change to either has
    // to keep meaning that.
    this.silenceSince = now;

    // FIRST, at ten seconds: « Vous m'entendez ? ». Ten seconds of nothing after
    // a question is as likely to be a candidate who heard nothing as one who has
    // nothing to say, and four words that plainly ask about the connection are
    // answerable by someone who is lost as well as by someone who is cut off.
    // Once per silence and once only: the steps after it are the épreuve's, and
    // an app that asked about the equipment twice would be talking about itself.
    if (nudge === 1) {
      this.presenceChecks += 1;
      this.log("silence-presence-check", {
        inDebate: this.presenceChecks,
        ...this.waitReport(now),
      });
      this.sendControllerDirective("silence-presence-check", presenceCheckInstruction());
      return;
    }

    // THEN the question again, and after that a new one, every fifteen seconds
    // for as long as the silence lasts. The attempt travels into the instruction
    // — the second nudge repeats the question, the ones after it stop asking for
    // a rephrasing and ask something simpler (`silenceRelanceInstruction`) — and
    // into the log, so a sitting where the examiner had to prompt seven times
    // says so. That used to be one `silence-unanswered` line written as the
    // escalation gave up, and there is no giving up to write now.
    const attempt = nudge - 1;
    this.log("silence-relance", { attempt, ...this.waitReport(now) });
    // « Une dernière question » is a promise (#108), and the escalation's later
    // steps were the one path still breaking it: a candidate who went quiet
    // after the announced last question earned a demand for a NEW one (#130).
    // After the announcement, every step re-asks the promised question instead.
    this.sendControllerDirective(
      "silence-relance",
      silenceRelanceInstruction(attempt, this.lastQuestionCue === "sent"),
    );
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
    if (remaining * 1000 < TIME_CUE_FLOOR_MS)
      return this.checkLastQuestionCue(now, quiet, remaining);

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
   * Announce the last question, once, in the closing two minutes (#108).
   *
   * The one cue the candidate is meant to HEAR. Everything else near the end is
   * addressed past them — the grid cues are for the model alone, the clock
   * badge is chrome — and a candidate mid-argument watches none of it: the
   * débat simply stopped with answers still in hand. So when the grid stands
   * down at two minutes, this takes the same slot once: the examiner says out
   * loud that the end is near and poses one question named as the last.
   *
   * Same guards as the grid, and inherited the same way — the caller has
   * already established the phase, a floor being measured, a live socket and no
   * closing in flight. What is new is the cutoff: a floor that never goes
   * quiet holds the announcement back like any cue, but unlike a grid cue it
   * does not keep sooner-or-later value. Under {@link LAST_QUESTION_CUTOFF_MS}
   * a last question no longer fits in front of the closing directive, so it is
   * dropped and the drop is logged — a sitting where the candidate was never
   * warned should say so.
   *
   * `sent` is a promise (#108): from here nothing asks for a fresh question.
   * The grid is already floored above this moment, the silence relances read
   * this state to re-ask the promised question instead of escalating to a new
   * one (#130), and the early-goodbye recovery reads it to switch from "new
   * objection" to "follow up on that answer".
   */
  private checkLastQuestionCue(now: number, quiet: boolean, remaining: number): boolean {
    if (this.lastQuestionCue !== "pending") return false;
    if (remaining * 1000 < LAST_QUESTION_CUTOFF_MS) {
      this.lastQuestionCue = "missed";
      this.log("debate-last-question-missed", { remainingSeconds: remaining });
      return false;
    }
    if (!quiet) return false;

    this.lastQuestionCue = "sent";
    // The cue makes the examiner speak, so the silence window re-anchors on the
    // attempt, exactly as the grid cues and relances do: the answer to a
    // question not yet asked is not a silence.
    if (this.silenceSince !== null) this.silenceSince = now;
    this.log("debate-last-question", { remainingSeconds: remaining });
    this.sendControllerDirective("debate-last-question", lastQuestionInstruction());
    return true;
  }

  /**
   * Has the room been quiet long enough to speak into it?
   *
   * Its own measurement rather than the silence watch's, and the two are not
   * duplicates: `silenceSince` starts at the first examiner turn of the débat
   * and is re-anchored by the act of reading it, so it answers "how long since
   * the candidate was last doing something", not "is the floor free now". This
   * has to hold at every moment of the débat, including before that first turn.
   *
   * Two seconds rather than one tick, because a B2 candidate hunting for a word
   * leaves a 300 ms hole in the voiced audio and a single quiet tick would read
   * that as the floor being free.
   *
   * Quiet is still not free (#130): after a candidate answer that no examiner
   * turn has yet followed, the likeliest reading of the quiet is that Gemini is
   * composing its rebound, and a cue sent there produces two examiner questions
   * back to back. That stretch holds the floor for up to
   * {@link EXAMINER_REPLY_WAIT_MS} from the candidate's last voiced moment.
   */
  private floorIsQuiet(now: number): boolean {
    const voiced = this.recorder?.voicedSeconds("debate") ?? 0;
    const candidateSpoke = voiced > this.cueVoicedSeconds;
    const busy = this.examinerSpeaking || this.announcementPlaying || candidateSpoke;
    // Growth while the examiner is audible is its own voice through the open
    // microphone, not an answer owed a reply — the same attribution the
    // silence watch makes when it re-baselines under a playback hold.
    if (candidateSpoke && !this.examinerSpeaking && !this.announcementPlaying) {
      this.cueCandidateVoiceAt = now;
    }
    this.cueVoicedSeconds = voiced;
    if (busy) {
      this.floorQuietSince = null;
      return false;
    }
    if (this.floorQuietSince === null) {
      this.floorQuietSince = now;
      return false;
    }
    if (now - this.floorQuietSince < TIME_CUE_QUIET_MS) return false;

    const lastVoice = this.cueCandidateVoiceAt;
    const replyOwed =
      lastVoice !== null &&
      (this.examinerTurnEndedAt === null || this.examinerTurnEndedAt < lastVoice);
    return !replyOwed || now - lastVoice >= EXAMINER_REPLY_WAIT_MS;
  }

  /** Make the examiner speak on the app's initiative rather than the model's —
   *  a relance into a silence, a time cue, a débat put back on its feet — and
   *  survive a socket that has gone away. Its own catch rather than `tolerate`,
   *  whose event says "teardown": nothing is ending here, and a directive that
   *  failed to go out should not read as a phase that failed to close. */
  private sendControllerDirective(step: string, instruction: string): void {
    // Before the send, and unconditionally. What the examiner says next is a
    // separate intervention from what it said last, and must not be transcribed
    // as more of it (#101, {@link examinerTurnBreakPending}). Set even when the
    // send throws: a directive that failed produces no examiner speech, nothing
    // consumes the flag, and the next real turn — which by then follows an
    // answer or another directive — is a new turn either way.
    this.examinerTurnBreakPending = true;
    try {
      this.session?.sendDirective(instruction);
    } catch (error) {
      this.log("directive-failed", { step, error: String(error) });
    }
  }

  /** The candidate ends the current phase early. */
  async advanceEarly(): Promise<void> {
    if (!canAdvanceEarly(this.phase)) return;
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
    if (this.announcementPlaying) return;
    if (this.destroyed) return;

    const phase = this.phase;
    // This click is the one user gesture this part is guaranteed, and a
    // suspended AudioContext may accept a resume from nowhere else: the stall
    // detector's own attempt (`examinerPlaybackHold`) has no gesture behind it
    // and autoplay policy can refuse it. `resume()` reaches the context's own
    // `resume()` synchronously, inside the gesture, which is what makes the
    // browser honour it — and a speaker that was quietly suspended since the
    // last part is the unheard first question (#94).
    void this.player?.resume().catch(() => {});
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
   * attempted cannot be spent: the clock goes back to zero and the task is still
   * there to do.
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
   *
   * **A restart does not un-type the phase** (dev only, #51). Only the clock is
   * rewound: a typed turn stays in the transcript, its claimed seconds stay
   * counted, and the `typedPhases` mark stays with them — so a phase typed
   * into, restarted, and then spoken in full still drops its recording at the
   * boundary. The mark follows the content, and the content survived — not as
   * a policy that could have gone the other way, but because nothing can
   * un-write a typed turn: `addFragment` only appends, so "typed a fragment,
   * deleted it, spoke the rest" is not a state this controller can reach, and
   * a mark that outlives its content cannot happen either.
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
   *  - **It does not discard what was already captured — but typing does.**
   *    Toggling the mode on and off again leaves the phase's audio exactly as
   *    it was: the toggle is about the microphone, not the artefact. What
   *    costs a phase its recording is CONTENT arriving as text — the moment
   *    `injectCandidateSpeech` writes a typed turn, the phase is marked and
   *    its artefact is dropped whole at the boundary (see `typedPhases` and
   *    `advance()`). That reverses this comment's earlier promise, and #51 is
   *    why: the promise protected a phase half spoken and half typed, and what
   *    it delivered in the ordinary flow was a stub of room tone uploaded in
   *    front of every typed exposé, grading the same sitting differently run
   *    to run. A typed phase now measures zero seconds every time, and the
   *    panel's claimed duration is what the penalty is computed from.
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
    // The phase's content is now (at least partly) typed, which costs it its
    // recording at the boundary — see `typedPhases` for the decision.
    this.typedPhases.add(this.phase);

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
    if (this.announcementPlaying) return false;
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
    this.closingTurnComplete = false;
    this.log("closing-handshake");

    // Tolerated for the same reason as the teardown steps, and this one is the
    // candidate's own « Terminer » rather than a development tool: a socket that
    // threw here never reached the stamp below, so `closingHasTimedOut()` could
    // never become true and the safety timeout — the whole reason a silent
    // examiner cannot strand anybody — was itself stranded (#65).
    const instruction = closingInstruction(this.phase);
    // A new turn, like every other directive (#101). This one does not go
    // through `sendControllerDirective` — it is tolerated rather than caught,
    // for the reason above — so it sets the break itself. Being the LAST thing
    // said in the part does not stop it merging into the entry before it: a
    // débat that ends in an unanswered relance has an examiner turn as its last
    // entry, and « le temps de l'épreuve est écoulé » would be read back as the
    // tail of a question, under that question's timestamp.
    this.examinerTurnBreakPending = true;
    this.tolerate("closing-directive", () => this.session?.sendDirective(instruction));

    // AFTER the directive, deliberately (#135). With manual VAD the
    // `activityEnd` IS the turn boundary: the model takes the floor the moment
    // it arrives, with whatever is in context. Sent first, it handed the model
    // a monologue it had been told to memorise « pour le débat qui suit » and
    // nothing else — so the "closing" turn opened a débat of its own, an
    // objection quoting the exposé, while the directive raced its generation
    // and lost. Sent second, the one turn the boundary releases already
    // carries its execution order, and the sentence it produces is the thanks
    // that was asked for. Both ride `sendRealtimeInput` on the same socket, so
    // the ordering here is the ordering on the wire.
    if (this.phase === "monologue") this.endMonologueActivity();

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

  /**
   * Advance out of a completed closing handshake once nothing is audible (#135).
   *
   * Called from the turn completing and from every tick after it. The two
   * player reads are the same pair the drain grace and the stall watch trust:
   * `examinerSpeaking` for audio mid-chunk, `bufferedSeconds` for audio
   * scheduled behind it. Both zero is a speaker with nothing left of the
   * closing sentence, and that — not the turn's generation ending — is when
   * the next part's consigne may have the room. A speaker that never drains is
   * the safety timeout's case, unchanged.
   */
  private finishClosingIfQuiet(): boolean {
    if (!this.closing || !this.closingTurnComplete) return false;
    if (this.examinerSpeaking || (this.player?.bufferedSeconds ?? 0) > 0) return false;
    this.closing = false;
    this.closingTurnComplete = false;
    this.clearClosingTimer();
    this.advanceDetached();
    return true;
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
    this.closingTurnComplete = false;

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

      // DEVELOPMENT ONLY — a typed phase leaves no artefact (#51). Decided at
      // the boundary rather than when the text arrived, because until the
      // phase ends the developer can still speak into it; and BEFORE the
      // pre-encode below, which would otherwise spend the débat compressing a
      // recording this sitting has just decided against. Reverses the earlier
      // "audio captured before the mode went on stays in the artefact" rule —
      // see `setDevTextMode` for what that rule protected and why the typed
      // phase's determinism won: the duration penalty is then computed from
      // the panel's claim, the same way every run, instead of from however
      // many seconds of room tone the panel took to open.
      if (this.typedPhases.has(current)) {
        this.tolerate("drop-typed-recording", () => this.recorder?.dropPhase(current));
      }
    }

    /**
     * Compress the monologue now, not at the finish (#86).
     *
     * Its samples are final — `endPhase()` above flushed the framer's tail, and
     * nothing re-opens the monologue once the débat exists — and the candidate
     * is about to spend thirteen minutes debating, which is exactly when a slow
     * compression cannot be perceived. Fire-and-forget on purpose: the artefact
     * is memoized by the archive, so the finish reuses it if it succeeded and
     * simply encodes afresh if it did not. Nothing here may hold the débat's
     * consigne behind a codec.
     */
    const recorder = this.recorder;
    if (current === "monologue" && target === "debate" && recorder) {
      const encodeStart = this.now();
      recorder.recordingFor("monologue").then(
        (recording) => {
          if (!recording) return;
          this.log("monologue-preencoded", {
            ms: this.now() - encodeStart,
            bytes: recording.byteSize,
          });
        },
        (error) => this.log("monologue-preencode-failed", String(error)),
      );
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

    // Whatever the examiner still had queued dies with its part (#135). The
    // closing handshake has already waited out a well-behaved sentence, so
    // anything left here is overrun — a safety timeout, a turn that kept
    // going — and letting it play on would put two voices under the consigne
    // about to be spoken. Logged, like every interruption, because "the
    // candidate never heard the end of that" is a fact about the sitting.
    if (current === "monologue" || current === "debate") {
      const leftover = this.player?.bufferedSeconds ?? 0;
      if (leftover > 0) {
        this.log("boundary-audio-dropped", { seconds: leftover });
        this.player?.interrupt();
      }
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
    this.speakerDrainedAt = null;
    this.openingTurnAudible = false;
    // The reply-gap facts are this phase's too (#130): the monologue's closing
    // turn is not a reply to anything the débat's candidate will say.
    this.cueCandidateVoiceAt = null;
    this.examinerTurnEndedAt = null;

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
        // finished the first thing it said on this session. This one is the
        // server's own word and needs no grace — unlike the drained speaker,
        // which #94 makes wait.
        const openingJustDelivered = !this.openingTurnDelivered;
        this.openingTurnDelivered = true;
        this.speakerDrainedAt = null;
        // Whatever answer the candidate had given has now been replied to: the
        // floor's reply-gap hold stands down (#130). Unconditional, like the
        // delivery flag above — a turn completing means this even on the paths
        // below that return early.
        this.examinerTurnEndedAt = this.now();
        // The snapshot reads the flag twice — the floor, and the feed's hold on
        // an unheard question — and none of the paths below is guaranteed to
        // emit, so the delivery has to announce itself.
        if (openingJustDelivered) this.emit();
        // The ONLY thing Gemini is allowed to influence about the exam's flow,
        // and only inside a window the app opened: once the clock has run out
        // and the closing directive has gone out, the examiner's turn ending is
        // what releases the phase. Outside a closing handshake this is ignored —
        // the examiner finishing a sentence mid-débat must not end the débat.
        // The timer decides when a phase ends; the model only decides when it
        // has stopped talking about it.
        if (this.closing) {
          // Not an advance yet (#135): the sentence this turn generated is
          // still coming out of the speaker, and the phase turns over when it
          // has been HEARD, not when it has been written. `tick()` carries the
          // wait from here; the quiet case advances on this very call.
          this.closingTurnComplete = true;
          this.finishClosingIfQuiet();
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
      onEvent: (name, detail) => {
        this.log(name, detail);
        // The reconnect that could not resume (#133): the manager has already
        // re-seeded the transcript into the fresh session, and the examiner
        // still needs telling where it stands. See {@link recoverFreshSession}.
        if (name === "reconnected-fresh") this.recoverFreshSession();
      },
    };

    // Only the débat is seeded: it is a fresh session that would otherwise know
    // nothing about the monologue it is supposed to challenge. A provider
    // rather than the turns themselves, because the manager reads it again on
    // every fresh connect — and a mid-débat reconnect that lost its handle
    // must be seeded with the exchange so far, not the monologue alone (#133).
    const history = target === "debate" ? () => debateSessionHistory(this.transcript) : () => [];

    // The prompt override is the débat's, and only the débat's (#166).
    //
    // The editor was fixed to that part in #153 — the monologue's examiner is
    // silent by design, so an experiment there has nothing observable to test —
    // but this layer never knew it, and merely could not be caught out: the
    // panel is the only thing that ever called `setExaminerPrompt`, and it does
    // not exist before the débat. A SAVED prompt breaks that accident. It is
    // applied at mount, during the préparation, and would otherwise hand the
    // monologue's session a débat instruction: an examiner arguing through the
    // exposé it is supposed to listen silently to.
    //
    // So the scope is stated here rather than defended by where the caller
    // happens to be, which also means a restart during the monologue reopens
    // on the shipped instruction. That is the honest reading of an override
    // that only describes one part of the épreuve.
    const examinerPrompt = target === "debate" ? this.examinerPrompt : undefined;

    const session = this.deps.createSession(
      target,
      this.deps.topic,
      callbacks,
      history,
      this.examinerModel,
      examinerPrompt,
    );
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
   *
   * **Mostly disarmed from the outside now, and left standing on purpose.** The
   * débat runs with `activityHandling: NO_INTERRUPTION`, so the server no
   * longer stops a turn because it heard the room — which is the fix for the
   * reported failure this guard could only ever soften, since it acts after the
   * decision has been taken. This stays because `interrupted` is the server's
   * message and not the client's to predict, and because the guard costs
   * nothing when it never fires. What DOES go quiet with it is the
   * `noteCandidateAnswered` below: talking over the examiner used to be how a
   * candidate's answer to « Vous m'entendez ? » registered before a word of it
   * was transcribed. The silence watch's own voiced-audio hold covers that
   * case, and covers it from a measure this tab owns.
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

  /**
   * Put a session that reconnected WITHOUT its memory back into the épreuve
   * (#133).
   *
   * A socket that dies before its first `sessionResumptionUpdate` has no
   * handle to resume with, so the manager reconnects fresh: same phase, same
   * system instruction, and no memory of the exchange beyond the transcript it
   * re-seeded at connect. For the monologue that seed is enough — the examiner
   * there is silent by instruction, and the floor marker is re-sent by the
   * manager itself. The débat's examiner is under a standing order to OPEN the
   * débat, and with nothing telling it how far the exchange has come, its
   * correct reading of that order is to open it again: a second « first
   * question », minutes in, with an announced « une dernière question »
   * forgotten along with everything else.
   *
   * Which directive it gets depends on how far the débat got:
   *
   *  - **Opening question never delivered.** The opening directive died with
   *    the old socket and nothing was heard, so it is simply sent again —
   *    without the re-send, nobody ever asks the débat's first question on the
   *    new session, and the part opens into a silence the watch is not yet
   *    armed to break.
   *  - **Mid-exchange.** A recovery in the goodbye-recovery's family: the
   *    débat is in progress, do not re-open it, continue from the last answer
   *    — honouring an announced last question the same way that one does
   *    (#108).
   *
   * Nothing during a closing handshake, deliberately: a fresh examiner told to
   * continue the débat seconds before the clock falls would say exactly the
   * wrong thing, and the handshake's own safety deadline already bounds a
   * closing turn that never arrives.
   */
  private recoverFreshSession(): void {
    if (this.phase !== "debate" || this.closing) return;
    if (!this.openingTurnDelivered) {
      const opening = examinerOpeningLine("debate");
      if (opening) {
        this.log("debate-reopened-after-reconnect");
        this.sendControllerDirective("debate-reopening", opening);
      }
      return;
    }
    this.log("fresh-session-recovery", { afterLastQuestion: this.lastQuestionCue === "sent" });
    this.sendControllerDirective(
      "fresh-session-recovery",
      resumeAfterReconnectInstruction(this.lastQuestionCue === "sent"),
    );
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
    // this is where a 38 MB sitting becomes a 2.4 MB upload (#24). Timed,
    // because it is the first segment of the wait #86 is about — and since the
    // monologue was compressed during the débat, what is measured here should
    // be the débat's encode alone.
    const encodeStart = this.now();
    const recordings = (await recorder?.recordings()) ?? [];
    const encodeMs = this.now() - encodeStart;
    const phases = this.phaseReports(recorder);
    // Read while the recorder still exists, for the same reason `phaseReports`
    // is: `discard()` is one line below and takes the samples these were
    // measured from with it.
    const voicedSeconds: Record<RecordedPhase, number> = {
      monologue: Math.round(recorder?.voicedSeconds("monologue") ?? 0),
      debate: Math.round(recorder?.voicedSeconds("debate") ?? 0),
    };
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
      earlyClosings: this.earlyClosingCount,
      // What the candidate spent at « Épreuve terminée » waiting on the codec
      // (#86). Near zero when the monologue was pre-encoded during the débat.
      encodeMs,
    });

    // See the top of the method: the voice must not outlive the screen.
    await closing;

    this.deps.onFinished({
      transcript: this.transcript,
      recordings,
      phases,
      reconnectCount: this.reconnectCount,
      earlyClosingCount: this.earlyClosingCount,
      voicedSeconds,
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

    // Same heartbeat, same reason: whether the speaker has been dry long enough
    // for the opening turn to count as delivered (#94).
    this.checkOpeningTurnDrained();

    // The examiner was asked for one closing sentence and never delivered it.
    // Advancing anyway is what stops a silent model stranding the candidate on
    // a frozen clock — the failure the reference implementation hit in
    // production.
    // The turn is over and its audio has now run out: the ordinary end of a
    // closing handshake (#135). Before the deadline check, because a drained
    // speaker is the good exit and the timeout is the bad one.
    if (this.finishClosingIfQuiet()) return;

    if (this.closingHasTimedOut()) {
      this.closing = false;
      this.closingTurnComplete = false;
      this.clearClosingTimer();
      this.log("closing-safety-timeout");
      this.advanceDetached();
      return;
    }

    // The débat's deadline is read with a lead (#108): the closing directive
    // sent at 0:00 is heard after it, so the sentence goes out early enough to
    // land while the clock still runs. The monologue keeps 0:00 — its last
    // seconds are graded candidate speech, not an exchange to be called.
    const closingLead = this.phase === "debate" ? CLOSING_LEAD_MS / 1000 : 0;
    if (isPhaseTimeUp(this.phase, seconds + closingLead) && !this.closing) {
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
    // Before anything is awaited: `close()` resolves any in-flight `play()` as
    // skipped, so an `announce()` a phase boundary is awaiting cannot strand
    // that boundary on a page that is going away — and `advance()` checks
    // `destroyed` on the far side rather than starting a phase nobody is in.
    this.announcer?.close();
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
