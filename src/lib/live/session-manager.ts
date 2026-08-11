/**
 * The Gemini Live session lifecycle — the part that makes a 13-minute débat
 * possible.
 *
 * A Gemini Live connection lives about 10 minutes. The DELF B2 débat targets 13,
 * and the full exam runs ~20 minutes of speech. So the connection WILL die
 * mid-exam. That is not an error path here, it is the expected path, and the
 * entire design goal of this module is that the candidate never notices.
 *
 * Three mechanisms, in order of preference:
 *
 *  1. **GoAway.** The server warns before it hangs up, with `timeLeft`. We treat
 *     that as the cue to reconnect on our own terms rather than waiting to be
 *     cut off mid-sentence.
 *  2. **Session resumption.** Every `sessionResumptionUpdate` carries a handle;
 *     we keep the newest one and pass it to the next `connect()`. Gemini
 *     restores the conversation, so the examiner still remembers the argument
 *     the candidate made four minutes ago.
 *  3. **Reconnect on unexpected close.** A dropped socket with no warning falls
 *     back to the same resumption path, with backoff.
 *
 * What this class deliberately does NOT own: the transcript, the timers, or the
 * exam phase. Those live above it and survive across sessions — which is exactly
 * why a reconnect cannot reset them. The class reports events; the controller
 * decides what they mean.
 */

import { GoogleGenAI, type LiveServerMessage, type Session } from "@google/genai";

import { CLIENT_CONNECT_CONFIG, INPUT_MIME_TYPE, LIVE_MODEL } from "@/lib/gemini/constants";
import type { OralTopic } from "@/lib/delf/topics";

export type LivePhase = "monologue" | "debate";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"
  | "failed";

export interface SessionManagerCallbacks {
  onStateChange: (state: ConnectionState) => void;
  /** A fragment of the candidate's speech, transcribed by Gemini. */
  onCandidateTranscript: (text: string) => void;
  /** A fragment of the examiner's speech. */
  onExaminerTranscript: (text: string) => void;
  /** Base64 PCM16 @24 kHz of the examiner's voice. */
  onExaminerAudio: (base64: string) => void;
  /** The candidate interrupted; drop queued playback. */
  onInterrupted: () => void;
  /** The examiner finished a turn. */
  onTurnComplete: () => void;
  /** Diagnostics for the reconnect log (surfaced in the dev panel). */
  onEvent: (event: string, detail?: unknown) => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
/** Reconnect this long before the server's stated deadline. */
const GOAWAY_SAFETY_MS = 1500;

export class ExamLiveSession {
  private session: Session | null = null;
  private state: ConnectionState = "idle";

  /** The newest resumption handle. The single most important field here. */
  private resumptionHandle: string | undefined;

  /** Set while we are deliberately tearing a session down, so `onclose` knows
   *  the close was ours and must not trigger a reconnect. */
  private closingIntentionally = false;

  private reconnectAttempts = 0;
  private goAwayTimer: ReturnType<typeof setTimeout> | null = null;

  /** Queued while disconnected, replayed on reconnect. Bounded: mid-reconnect
   *  audio is unrecoverable anyway, and an unbounded buffer would blow memory
   *  on a long outage. */
  private pendingAudio: string[] = [];
  private static readonly MAX_PENDING_CHUNKS = 50;

  constructor(
    private readonly phase: LivePhase,
    private readonly topic: OralTopic,
    private readonly callbacks: SessionManagerCallbacks,
    /** History to seed a fresh session with (the monologue, for the débat). */
    private readonly initialHistory: Array<{
      role: "user" | "model";
      parts: Array<{ text: string }>;
    }> = [],
  ) {}

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** Whether the exam has ever successfully connected (drives first-run UI). */
  get hasResumptionHandle(): boolean {
    return Boolean(this.resumptionHandle);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onStateChange(state);
  }

  /**
   * Mint a short-lived ephemeral token for this phase.
   *
   * Fetched fresh on EVERY connect, including reconnects, because a token is
   * single-use and a resumed session is a new session. The phase, topic and
   * resumption handle go to the server, which builds the real session config
   * (examiner prompt included) and pins it into the token — so this client never
   * holds the prompt, and the token cannot be used for anything else.
   */
  private async fetchToken(): Promise<string> {
    const response = await fetch("/api/live-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phase: this.phase,
        topicSlug: this.topic.slug,
        resumptionHandle: this.resumptionHandle,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Could not mint a Gemini token (${response.status}): ${body}`);
    }
    const { token } = (await response.json()) as { token?: string };
    if (!token) throw new Error("Token endpoint returned no token");
    return token;
  }

  /**
   * Open a session. Passing the stored resumption handle turns this into a
   * *resume* rather than a fresh start; the handle is only absent on the very
   * first connect of a phase.
   */
  async connect(): Promise<void> {
    if (this.state === "connecting" || this.state === "connected") return;

    const resuming = Boolean(this.resumptionHandle);
    this.setState(resuming ? "reconnecting" : "connecting");
    this.closingIntentionally = false;

    try {
      const token = await this.fetchToken();
      // `apiVersion: "v1alpha"` is REQUIRED when authenticating with an
      // ephemeral token: the SDK's token support only exists on v1alpha, and
      // without it the connection is rejected. The SDK warns about this at
      // runtime rather than typing it, so it is easy to miss.
      const ai = new GoogleGenAI({
        apiKey: token,
        httpOptions: { apiVersion: "v1alpha" },
      });

      this.session = await ai.live.connect({
        model: LIVE_MODEL,
        // Modalities only. The real config — instruction, VAD mode, resumption,
        // compression — is pinned in the token minted above. Verified: this
        // yields identical audio, transcripts and handles to sending the full
        // config, whereas an entirely EMPTY config silently yields no audio.
        config: CLIENT_CONNECT_CONFIG,
        callbacks: {
          onopen: () => {
            this.reconnectAttempts = 0;
            this.setState("connected");
            this.callbacks.onEvent(resuming ? "resumed" : "connected", {
              handle: this.resumptionHandle?.slice(0, 12),
            });
            this.flushPendingAudio();
          },
          onmessage: (message) => this.handleMessage(message),
          onerror: (error) => {
            this.callbacks.onEvent("error", String(error));
          },
          onclose: (event) => {
            this.session = null;
            this.clearGoAwayTimer();
            if (this.closingIntentionally) {
              this.setState("closed");
              return;
            }
            this.callbacks.onEvent("closed-unexpectedly", event?.reason ?? "");
            void this.scheduleReconnect();
          },
        },
      });

      // A brand-new débat session knows nothing about the monologue. Seed it
      // before the examiner speaks so its first objection can quote the
      // candidate. On a RESUME the handle already carries the history, so
      // re-seeding would duplicate the monologue in context.
      if (!resuming && this.initialHistory.length > 0) {
        this.session.sendClientContent({ turns: this.initialHistory, turnComplete: false });
        this.callbacks.onEvent("history-seeded", { turns: this.initialHistory.length });
      }
    } catch (error) {
      this.callbacks.onEvent("connect-failed", String(error));
      this.session = null;
      await this.scheduleReconnect();
    }
  }

  private handleMessage(message: LiveServerMessage): void {
    // Keep the newest resumption handle. Without storing this, every reconnect
    // would start a brand-new exam.
    const update = message.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) {
      this.resumptionHandle = update.newHandle;
    }

    // The server is about to hang up. Reconnect slightly early, on our terms.
    if (message.goAway) {
      const timeLeftMs = parseDurationMs(message.goAway.timeLeft) ?? 0;
      this.callbacks.onEvent("go-away", { timeLeftMs });
      this.scheduleGoAwayReconnect(timeLeftMs);
    }

    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) this.callbacks.onInterrupted();

    const candidateText = content.inputTranscription?.text;
    if (candidateText) this.callbacks.onCandidateTranscript(candidateText);

    const examinerText = content.outputTranscription?.text;
    if (examinerText) this.callbacks.onExaminerTranscript(examinerText);

    for (const part of content.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data) this.callbacks.onExaminerAudio(data);
    }

    if (content.turnComplete) this.callbacks.onTurnComplete();
  }

  /** Reconnect just before the server's deadline, so no audio is lost. */
  private scheduleGoAwayReconnect(timeLeftMs: number): void {
    this.clearGoAwayTimer();
    const delay = Math.max(0, timeLeftMs - GOAWAY_SAFETY_MS);
    this.goAwayTimer = setTimeout(() => {
      this.callbacks.onEvent("reconnecting-before-goaway");
      void this.reconnect();
    }, delay);
  }

  private clearGoAwayTimer(): void {
    if (this.goAwayTimer) {
      clearTimeout(this.goAwayTimer);
      this.goAwayTimer = null;
    }
  }

  /** Backoff reconnect after an unexpected close. */
  private async scheduleReconnect(): Promise<void> {
    if (this.closingIntentionally) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.callbacks.onEvent("reconnect-exhausted", { attempts: this.reconnectAttempts });
      this.setState("failed");
      return;
    }
    this.reconnectAttempts += 1;
    this.setState("reconnecting");
    const delay = Math.min(400 * 2 ** (this.reconnectAttempts - 1), 5000);
    this.callbacks.onEvent("reconnect-scheduled", { attempt: this.reconnectAttempts, delay });
    await new Promise((resolve) => setTimeout(resolve, delay));
    await this.connect();
  }

  /**
   * Close the current socket and immediately reopen it with the stored handle.
   *
   * This is the public seam the forced-reconnect test drives (§16 of the brief):
   * it exercises the exact code path a real GoAway takes, so the acceptance test
   * does not have to sit through ten minutes of débat to reach it.
   */
  async reconnect(): Promise<void> {
    this.clearGoAwayTimer();
    this.callbacks.onEvent("reconnect-forced", { hasHandle: this.hasResumptionHandle });
    this.closingIntentionally = true;
    this.closeSocket();
    this.closingIntentionally = false;
    this.setState("reconnecting");
    await this.connect();
  }

  /** Stream one base64 PCM16 chunk of candidate audio. */
  sendAudio(base64: string): void {
    if (!this.session || this.state !== "connected") {
      if (this.pendingAudio.length < ExamLiveSession.MAX_PENDING_CHUNKS) {
        this.pendingAudio.push(base64);
      }
      return;
    }
    try {
      this.session.sendRealtimeInput({ audio: { data: base64, mimeType: INPUT_MIME_TYPE } });
    } catch (error) {
      this.callbacks.onEvent("send-audio-failed", String(error));
    }
  }

  private flushPendingAudio(): void {
    if (this.pendingAudio.length === 0) return;
    const queued = this.pendingAudio;
    this.pendingAudio = [];
    this.callbacks.onEvent("flushing-buffered-audio", { chunks: queued.length });
    for (const chunk of queued) this.sendAudio(chunk);
  }

  /**
   * Open the candidate's turn without closing it (manual VAD, monologue only).
   * Because no `activityEnd` follows, the model has no turn boundary and cannot
   * interrupt — the guarantee the monologue rests on.
   */
  beginCandidateActivity(): void {
    if (!this.session) return;
    this.session.sendRealtimeInput({ activityStart: {} });
    this.callbacks.onEvent("activity-start");
  }

  /** Close the candidate's turn, handing the floor to the examiner. */
  endCandidateActivity(): void {
    if (!this.session) return;
    this.session.sendRealtimeInput({ activityEnd: {} });
    this.callbacks.onEvent("activity-end");
  }

  /**
   * Send a text instruction to the examiner (the opening line, the closing
   * line). Not candidate speech: these never enter the transcript, because the
   * evaluator must never grade a control prompt as something the candidate said.
   */
  sendDirective(text: string): void {
    if (!this.session) return;
    try {
      // `sendRealtimeInput({text})`, NOT `sendClientContent`. On
      // gemini-3.1-flash-live the latter only seeds history: it accepts the
      // turn and the model never speaks, which presents as a session that
      // connects fine and then sits in silence forever. Confirmed by testing
      // both against the live service.
      this.session.sendRealtimeInput({ text });
      this.callbacks.onEvent("directive-sent");
    } catch (error) {
      this.callbacks.onEvent("directive-failed", String(error));
    }
  }

  private closeSocket(): void {
    try {
      this.session?.close();
    } catch {
      /* already closed */
    }
    this.session = null;
  }

  /** End the phase for good. No reconnect follows. */
  close(): void {
    this.closingIntentionally = true;
    this.clearGoAwayTimer();
    this.pendingAudio = [];
    this.closeSocket();
    this.setState("closed");
  }
}

/**
 * Parse a protobuf duration string ("9.5s") into milliseconds.
 *
 * `goAway.timeLeft` is typed loosely and has been observed both as a string and
 * as a `{seconds, nanos}` object, so this accepts either and returns null when
 * it recognises neither — the caller then reconnects immediately, which is the
 * safe reading of "the server is about to hang up".
 */
export function parseDurationMs(value: unknown): number | null {
  if (typeof value === "number") return value * 1000;
  if (typeof value === "string") {
    const seconds = Number.parseFloat(value.replace(/s$/, ""));
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }
  if (value && typeof value === "object") {
    const record = value as { seconds?: number | string; nanos?: number };
    const seconds = Number(record.seconds ?? 0);
    const nanos = Number(record.nanos ?? 0);
    if (Number.isFinite(seconds) || Number.isFinite(nanos)) {
      return (Number.isFinite(seconds) ? seconds : 0) * 1000 + (Number.isFinite(nanos) ? nanos : 0) / 1e6;
    }
  }
  return null;
}
