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
 *   exam     ───────────────────────────────────────  transcript, audio archive
 *   phase    ──────────────┤├─────────────────────────  clocks
 *   session  ────┤├────┤├──┤├────┤├────┤├─────────────  Gemini connection
 */

import {
  canAdvanceEarly,
  isPhaseTimeUp,
  nextPhase,
  phaseUsesLiveSession,
  remainingSeconds,
  type OralPhase,
} from "@/lib/delf/phases";
import { closingInstruction, examinerOpeningLine } from "@/lib/delf/examiner-prompt";
import type { OralTopic } from "@/lib/delf/topics";
import {
  appendFragment,
  monologueAsHistory,
  type TranscriptEntry,
  type TranscriptPhase,
} from "@/lib/delf/transcript";
import type { ConnectionState, SessionManagerCallbacks } from "./session-manager";

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
  toWavBlob(): Blob | null;
}

/** What the controller needs from the speaker. */
export interface PlayerLike {
  resume(): Promise<void>;
  enqueue(base64: string): void;
  interrupt(): void;
  close(): Promise<void>;
}

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
  examinerSpeaking: boolean;
  transcript: readonly TranscriptEntry[];
  events: readonly ExamEvent[];
  reconnectCount: number;
  canAdvance: boolean;
  closing: boolean;
  micError: string | null;
  started: boolean;
  monologueSeconds: number;
  debateSeconds: number;
}

export interface ExamFinishedPayload {
  transcript: TranscriptEntry[];
  audio: Blob | null;
  monologueSeconds: number;
  debateSeconds: number;
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
  createRecorder: (onChunk: (base64: string) => void) => RecorderLike;
  createPlayer: (onSpeakingChange: (speaking: boolean) => void) => PlayerLike;
  onFinished: (payload: ExamFinishedPayload) => void;
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
  private phaseSeconds = { monologue: 0, debate: 0 };

  private session: LiveSessionLike | null = null;
  private recorder: RecorderLike | null = null;
  private player: PlayerLike | null = null;

  private ticker: ReturnType<typeof setInterval> | null = null;
  private closingTimer: ReturnType<typeof setTimeout> | null = null;

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
      examinerSpeaking: this.examinerSpeaking,
      transcript: this.transcript,
      events: this.events,
      reconnectCount: this.reconnectCount,
      canAdvance: canAdvanceEarly(this.phase, this.elapsed) && !this.closing,
      closing: this.closing,
      micError: this.micError,
      started: this.started,
      monologueSeconds: this.phaseSeconds.monologue,
      debateSeconds: this.phaseSeconds.debate,
    };
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
    if (this.recorder) return true;
    try {
      const player = this.deps.createPlayer((speaking) => {
        this.examinerSpeaking = speaking;
        this.emit();
      });
      await player.resume();
      this.player = player;

      const recorder = this.deps.createRecorder((base64) => this.session?.sendAudio(base64));
      await recorder.start();
      this.recorder = recorder;

      this.micError = null;
      this.log("audio-ready");
      return true;
    } catch (error) {
      const denied =
        typeof DOMException !== "undefined" &&
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "SecurityError");
      this.micError = denied
        ? "L'accès au microphone a été refusé. Autorisez-le dans votre navigateur, puis rechargez la page."
        : "Le microphone n'est pas accessible. Vérifiez qu'aucune autre application ne l'utilise.";
      this.log("audio-failed", String(error));
      this.emit();
      return false;
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

    if (this.phase === "monologue") this.session?.endCandidateActivity();
    this.session?.sendDirective(closingInstruction(this.phase));

    this.closingTimer = setTimeout(() => {
      if (!this.closing) return;
      this.closing = false;
      this.log("closing-safety-timeout");
      void this.advance();
    }, CLOSING_SAFETY_MS);

    this.emit();
  }

  private clearClosingTimer(): void {
    if (this.closingTimer) {
      clearTimeout(this.closingTimer);
      this.closingTimer = null;
    }
  }

  /** Every phase transition runs through here, so ordering lives in one place. */
  private async advance(): Promise<void> {
    const current = this.phase;
    const target = nextPhase(current);
    if (current === target) return;

    this.clearClosingTimer();
    this.closing = false;

    // Bank this phase's speaking time before the clock resets.
    if (this.phaseStart !== null && (current === "monologue" || current === "debate")) {
      this.phaseSeconds[current] = Math.round((this.now() - this.phaseStart) / 1000);
    }

    this.log("phase-transition", `${current} -> ${target}`);

    if (current === "monologue") {
      // Release the candidate's turn, then drop the session: a system
      // instruction cannot be changed in place, so the débat needs a new one.
      this.session?.endCandidateActivity();
      this.closeSession();
    } else if (current === "debate") {
      this.closeSession();
    }

    this.phase = target;
    this.phaseStart = this.now();
    this.elapsed = 0;
    this.emit();

    if (target === "monologue" || target === "debate") {
      await this.openSession(target);
    }

    if (target === "finished") await this.finish();
  }

  private async openSession(target: TranscriptPhase): Promise<void> {
    const callbacks: SessionManagerCallbacks = {
      onStateChange: (state) => {
        if (state === "reconnecting") this.reconnectCount += 1;
        this.connection = state;
        this.emit();
      },
      onCandidateTranscript: (text) => this.addFragment("candidate", text),
      onExaminerTranscript: (text) => this.addFragment("examiner", text),
      onExaminerAudio: (base64) => this.player?.enqueue(base64),
      onInterrupted: () => this.player?.interrupt(),
      onTurnComplete: () => {
        // The examiner has delivered its closing sentence: the phase may end.
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

  private closeSession(): void {
    this.session?.close();
    this.session = null;
  }

  private async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.stopTicker();

    this.player?.interrupt();
    const audio = this.recorder?.toWavBlob() ?? null;
    await this.recorder?.stop();
    await this.player?.close();
    this.recorder = null;
    this.player = null;

    this.log("exam-finished", {
      monologue: this.phaseSeconds.monologue,
      debate: this.phaseSeconds.debate,
      reconnects: this.reconnectCount,
    });

    this.deps.onFinished({
      transcript: this.transcript,
      audio,
      monologueSeconds: this.phaseSeconds.monologue,
      debateSeconds: this.phaseSeconds.debate,
      reconnectCount: this.reconnectCount,
    });
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

    if (isPhaseTimeUp(this.phase, seconds) && !this.closing) {
      if (phaseUsesLiveSession(this.phase)) this.beginClosingHandshake();
      else void this.advance();
    }
  }

  /** Release everything. Safe to call twice. */
  destroy(): void {
    this.stopTicker();
    this.clearClosingTimer();
    this.closeSession();
    void this.recorder?.stop();
    void this.player?.close();
    this.recorder = null;
    this.player = null;
    this.listeners.clear();
  }
}
