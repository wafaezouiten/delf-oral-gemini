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
 *     the candidate made four minutes ago. A connect carrying a handle is a
 *     `resuming`, not a `connecting` — see `state-machine.ts` for why those are
 *     two states and not one.
 *  3. **Reconnect on unexpected close.** A dropped socket with no warning falls
 *     back to the same resumption path, with backoff.
 *
 * What this class deliberately does NOT own: the transcript, the timers, or the
 * exam phase. Those live above it and survive across sessions — which is exactly
 * why a reconnect cannot reset them. The class reports events; the controller
 * decides what they mean.
 *
 * Everything that touches the outside world — minting a token, opening a socket,
 * waiting — arrives through {@link LiveTransport} and {@link SessionTimers}.
 * That is not ceremony: a resumption path exercised only in production is a
 * resumption path that does not work, and before those seams existed the only
 * testable thing in this file was a duration parser.
 */

import {
  GoogleGenAI,
  type LiveSendClientContentParameters,
  type LiveSendRealtimeInputParameters,
  type LiveConnectConfig,
  type LiveServerMessage,
} from "@google/genai";

import { CLIENT_CONNECT_CONFIG, INPUT_MIME_TYPE, LIVE_MODEL } from "@/lib/gemini/constants";
import type { OralTopic } from "@/lib/delf/topics";
import {
  canTransition,
  describeTransition,
  type SessionState,
} from "./state-machine";

export type LivePhase = "monologue" | "debate";

/**
 * The connection's state.
 *
 * Re-exported under its original name because the UI imports it from here, and
 * because "connection state" is what a badge renders. The machine itself —
 * states, legal transitions, and how this combines with the exam phase — lives
 * in `state-machine.ts`.
 */
export type ConnectionState = SessionState;

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

// ---------------------------------------------------------------- the seams

/** The subset of the SDK's `Session` this module actually uses. */
export interface LiveSocket {
  sendRealtimeInput(params: LiveSendRealtimeInputParameters): void;
  sendClientContent(params: LiveSendClientContentParameters): void;
  close(): void;
}

/** What a socket reports back. Mirrors the SDK's `LiveCallbacks`, loosely typed
 *  so a fake does not have to construct DOM events. */
export interface LiveSocketCallbacks {
  onopen?: () => void;
  onmessage: (message: LiveServerMessage) => void;
  onerror?: (error: unknown) => void;
  onclose?: (event?: { reason?: string }) => void;
}

/** What the server needs to mint a token for one connect. */
export interface LiveTokenClientRequest {
  examId: string;
  phase: LivePhase;
  topicSlug: string;
  /** Present on a resume. Its presence is what the server pins into the token. */
  resumptionHandle?: string;
}

/**
 * Everything outside this module's control: the token endpoint and the socket.
 *
 * Injected so the whole lifecycle — first connect, goAway, resume, backoff,
 * exhaustion — runs headlessly against fakes. The production implementation is
 * {@link browserLiveTransport}.
 */
export interface LiveTransport {
  mintToken(request: LiveTokenClientRequest): Promise<string>;
  open(params: {
    token: string;
    model: string;
    config: LiveConnectConfig;
    callbacks: LiveSocketCallbacks;
  }): Promise<LiveSocket>;
}

/** Cancels a scheduled callback. Idempotent. */
export type CancelTimer = () => void;

/** Injected so backoff and the goAway deadline do not cost real seconds in tests. */
export interface SessionTimers {
  schedule(fn: () => void, ms: number): CancelTimer;
  sleep(ms: number): Promise<void>;
}

export const realTimers: SessionTimers = {
  schedule(fn, ms) {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

/**
 * The real transport: our token route, then the Gemini socket.
 *
 * A token is fetched fresh on EVERY connect, including reconnects, because it is
 * single-use and a resumed session is a new session. The phase, exam, topic and
 * resumption handle go to the server, which builds the real session config
 * (examiner prompt included) and pins it into the token — so this client never
 * holds the prompt, and the token cannot be used for anything else.
 */
export const browserLiveTransport: LiveTransport = {
  async mintToken(request) {
    const response = await fetch("/api/live-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Could not mint a Gemini token (${response.status}): ${body}`);
    }
    const { token } = (await response.json()) as { token?: string };
    if (!token) throw new Error("Token endpoint returned no token");
    return token;
  },

  async open({ token, model, config, callbacks }) {
    // `apiVersion: "v1alpha"` is REQUIRED when authenticating with an ephemeral
    // token: the SDK's token support only exists on v1alpha, and without it the
    // connection is rejected. The SDK warns about this at runtime rather than
    // typing it, so it is easy to miss.
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });
    return ai.live.connect({ model, config, callbacks });
  },
};

// ---------------------------------------------------------------- the session

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
/** Reconnect this long before the server's stated deadline. */
const GOAWAY_SAFETY_MS = 1500;
const BACKOFF_BASE_MS = 400;
const BACKOFF_CAP_MS = 5000;

export interface ExamLiveSessionOptions {
  /** The sitting this session belongs to. Sent to the token route, which binds
   *  the token to it after checking the caller owns it. */
  examId: string;
  phase: LivePhase;
  topic: OralTopic;
  callbacks: SessionManagerCallbacks;
  /** History to seed a fresh session with (the monologue, for the débat). */
  initialHistory?: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
  transport?: LiveTransport;
  timers?: SessionTimers;
  maxReconnectAttempts?: number;
}

export class ExamLiveSession {
  private socket: LiveSocket | null = null;
  private state: SessionState = "idle";

  /** The newest resumption handle. The single most important field here. */
  private resumptionHandle: string | undefined;

  /**
   * Which socket this session is currently listening to.
   *
   * A socket's callbacks capture the generation they were opened under, and go
   * quiet the moment it moves on. This exists because **`close()` on a real
   * WebSocket does not deliver `onclose` synchronously** — `NodeWebSocket.close()`
   * is a bare `ws.close()`, and the event lands on a later tick, typically while
   * the replacement connect is still awaiting its token. A flag flipped around
   * the synchronous teardown (which is what this used to be) only covers that
   * call stack, so the late event arrived looking exactly like an unannounced
   * drop. Three things went wrong when it did: a second reconnect stacked on the
   * one already in flight, `reconnectCount` inflated in the finished payload,
   * and — worst — the handler's unconditional `this.socket = null` cleared the
   * reference to the NEW, healthy socket, so audio was silently buffered while
   * the badge still read "examinateur en ligne".
   *
   * A stale socket must also not be able to speak: its `sessionResumptionUpdate`
   * would overwrite a newer handle with an older one, and its transcript
   * fragments would land in the exam having been said to nobody.
   */
  private generation = 0;
  /** Set once by {@link close}, never cleared: `closed` is terminal. */
  private finished = false;
  private reconnectAttempts = 0;
  private cancelGoAway: CancelTimer | null = null;

  /** Queued while disconnected, replayed on reconnect. Bounded: mid-reconnect
   *  audio is unrecoverable anyway, and an unbounded buffer would blow memory
   *  on a long outage. */
  private pendingAudio: string[] = [];
  private static readonly MAX_PENDING_CHUNKS = 50;
  /** Reported once per outage rather than once per dropped chunk. */
  private bufferOverflowed = false;
  /**
   * Whether this session has ever been connected.
   *
   * It separates the two silences the microphone can be sending into. A
   * reconnect is one: the candidate is mid-sentence, and every chunk held is a
   * chunk of the épreuve. The seconds before the FIRST connect are the other:
   * nothing has been said into this phase yet, and what the room offers in the
   * meantime is not worth replaying. See {@link sendAudio}.
   */
  private everConnected = false;
  /** Reported once per session rather than once per dropped chunk. */
  private preconnectAudioDropped = false;

  private readonly examId: string;
  private readonly phase: LivePhase;
  private readonly topic: OralTopic;
  private readonly callbacks: SessionManagerCallbacks;
  private readonly initialHistory: Array<{
    role: "user" | "model";
    parts: Array<{ text: string }>;
  }>;
  private readonly transport: LiveTransport;
  private readonly timers: SessionTimers;
  private readonly maxReconnectAttempts: number;

  constructor(options: ExamLiveSessionOptions) {
    this.examId = options.examId;
    this.phase = options.phase;
    this.topic = options.topic;
    this.callbacks = options.callbacks;
    this.initialHistory = options.initialHistory ?? [];
    this.transport = options.transport ?? browserLiveTransport;
    this.timers = options.timers ?? realTimers;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
  }

  get connectionState(): SessionState {
    return this.state;
  }

  /** Whether a resume is possible — i.e. whether the examiner's memory survives
   *  the next reconnect. */
  get hasResumptionHandle(): boolean {
    return Boolean(this.resumptionHandle);
  }

  /**
   * Move the machine, refusing nothing but reporting anything illegal.
   *
   * Applied rather than thrown on purpose: an unexpected transition is a bug in
   * this file, and freezing a live exam over it would turn a cosmetic fault into
   * a lost épreuve. It lands in the session log, and `session-manager.test.ts`
   * asserts the real lifecycle never produces one — so the check has teeth in CI
   * without having teeth on a candidate.
   */
  private setState(next: SessionState): void {
    if (this.state === next) return;
    if (!canTransition(this.state, next)) {
      this.callbacks.onEvent("invalid-transition", describeTransition(this.state, next));
    }
    this.state = next;
    this.callbacks.onStateChange(next);
  }

  private tokenRequest(): LiveTokenClientRequest {
    return {
      examId: this.examId,
      phase: this.phase,
      topicSlug: this.topic.slug,
      resumptionHandle: this.resumptionHandle,
    };
  }

  /**
   * Open a session.
   *
   * Passing the stored resumption handle turns this into a *resume* rather than
   * a fresh start; the handle is only absent on the very first connect of a
   * phase. The two are separate states because only one of them keeps the
   * examiner's memory of the exam so far.
   */
  async connect(): Promise<void> {
    // `closed` is terminal in the state machine, so it has to be terminal here
    // too. Without this a stray `reconnect()` after the phase ended would reopen
    // a session for an exam that is over.
    if (this.isFinished()) {
      this.callbacks.onEvent("connect-refused", "the phase is over");
      return;
    }
    if (this.state === "connecting" || this.state === "resuming" || this.state === "connected") {
      return;
    }

    const resuming = Boolean(this.resumptionHandle);
    this.setState(resuming ? "resuming" : "connecting");

    // Everything below belongs to this attempt. If a close or another reconnect
    // supersedes it mid-flight, the generation moves on and every line that
    // checks it becomes a no-op.
    const generation = this.generation;
    const isCurrent = () => generation === this.generation;

    try {
      const token = await this.transport.mintToken(this.tokenRequest());
      // A close (or a second reconnect) can land while the token is minting.
      // Bail before spending a socket on it.
      if (!isCurrent()) return;

      const socket = await this.transport.open({
        token,
        model: LIVE_MODEL,
        // Modalities only. The real config — instruction, VAD mode, resumption,
        // compression — is pinned in the token minted above. Verified: this
        // yields identical audio, transcripts and handles to sending the full
        // config, whereas an entirely EMPTY config silently yields no audio.
        config: CLIENT_CONNECT_CONFIG,
        callbacks: {
          onopen: () => {
            // The socket can open after we stopped caring — see the guard below,
            // which is what actually closes it.
            if (!isCurrent()) return;
            this.reconnectAttempts = 0;
            this.everConnected = true;
            this.setState("connected");
            this.callbacks.onEvent(resuming ? "resumed" : "connected", {
              handle: this.resumptionHandle?.slice(0, 12),
            });
            // Not the flush that matters — `this.socket` is still null here, so
            // this one always no-ops. It is kept for a transport that resolves
            // `open()` before firing this event; the load-bearing call is the
            // one after the await below.
            this.flushPendingAudio();
          },
          onmessage: (message) => {
            if (!isCurrent()) return;
            this.handleMessage(message);
          },
          onerror: (error) => {
            if (!isCurrent()) return;
            this.callbacks.onEvent("error", String(error));
          },
          onclose: (event) => this.handleClose(generation, event),
        },
      });

      // The socket only becomes ours once it exists. Anything that ran while
      // `open()` was in flight found `this.socket` null and closed nothing — the
      // socket would then open, stay open, and be referenced by nobody, leaking
      // until Gemini's own idle limit reaped it. A candidate navigating away
      // mid-connect is enough to hit this.
      if (!isCurrent()) {
        this.discard(socket);
        this.callbacks.onEvent("closed-late-open");
        return;
      }
      this.socket = socket;

      // A brand-new débat session knows nothing about the monologue. Seed it
      // before the examiner speaks so its first objection can quote the
      // candidate. On a RESUME the handle already carries the history, so
      // re-seeding would duplicate the monologue in context.
      if (!resuming && this.initialHistory.length > 0) {
        this.socket.sendClientContent({ turns: this.initialHistory, turnComplete: false });
        this.callbacks.onEvent("history-seeded", { turns: this.initialHistory.length });
      }

      // Flushed HERE and not only in `onopen`, because `open()` resolves after
      // the socket is open: `onopen` therefore runs while `this.socket` is still
      // null, `sendAudio` refuses, and every buffered chunk is quietly pushed
      // straight back onto the queue. That is the audio captured during a
      // reconnect — precisely the audio the buffer exists to save. Calling it in
      // both places is safe: it is a no-op on an empty queue, and it refuses
      // unless the state says connected.
      this.flushPendingAudio();
    } catch (error) {
      // A superseded attempt failing is not this session's problem. Without
      // this check the rejection of an abandoned `mintToken`/`open` — an
      // entirely normal thing on the flaky network this class exists for —
      // would null the reference to the LIVE socket a newer attempt had already
      // installed, force `reconnecting` over its `connected`, and then open a
      // second socket alongside the first: two `onmessage` streams, doubled
      // audio, and one of them leaked. Every other callback here checks this;
      // the catch was the one path that did not.
      if (!isCurrent()) {
        this.callbacks.onEvent("stale-connect-failed", String(error));
        return;
      }
      this.callbacks.onEvent("connect-failed", String(error));
      // `retireSocket()` rather than `this.socket = null`: the throw can come
      // from seeding the history, which happens AFTER the socket is installed,
      // and nulling the field there would abandon an open socket instead of
      // closing it.
      this.retireSocket();
      // Awaited, not fired and forgotten, and that is deliberate: this resolves
      // only once the whole retry chain has — a socket, or every attempt spent
      // (~11 s with the current backoff). `openSession()` in the controller
      // awaits `connect()`, so a phase transition blocks for that window on a
      // bad first connect, and the directive and activity markers that follow
      // no-op against a null socket.
      //
      // Making this fire-and-forget would look like an improvement and is not:
      // a second `openSession()` could then start while this chain is still
      // retrying, and two overlapping chains would race for the same phase.
      await this.scheduleReconnect();
    }
  }

  private handleClose(generation: number, event?: { reason?: string }): void {
    // A close event from a socket we already retired. It arrives late by
    // definition — see {@link generation} — and acting on it would stack a
    // second reconnect on the one already running and null out the live socket.
    if (generation !== this.generation) {
      this.callbacks.onEvent("stale-close-ignored");
      return;
    }

    // This socket is done, so nothing further from it counts either.
    this.generation += 1;
    this.socket = null;
    this.clearGoAwayTimer();

    if (this.isFinished()) {
      this.setState("closed");
      return;
    }
    this.callbacks.onEvent("closed-unexpectedly", event?.reason ?? "");
    void this.scheduleReconnect();
  }

  private handleMessage(message: LiveServerMessage): void {
    // Keep the newest resumption handle. Without storing this, every reconnect
    // would start a brand-new exam.
    const update = message.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) {
      this.resumptionHandle = update.newHandle;
      this.callbacks.onEvent("resumption-handle", { handle: update.newHandle.slice(0, 12) });
    }

    // The server is about to hang up. Reconnect slightly early, on our terms.
    if (message.goAway) {
      this.handleGoAway(message.goAway.timeLeft);
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

  /**
   * `goAway`: the server's warning that it is about to hang up.
   *
   * Handled explicitly rather than left to the `onclose` path, because the two
   * are not equivalent. Waiting for the close means the socket dies mid-sentence
   * and the audio in flight is lost; acting on the warning means the new socket
   * opens while the old one is still healthy. This is the difference between a
   * seamless 13-minute débat and one with a hole in it.
   *
   * An unparseable `timeLeft` reconnects immediately, which is the safe reading
   * of "the server is about to hang up" — being early costs nothing, being late
   * costs the candidate's words.
   */
  private handleGoAway(timeLeft: unknown): void {
    const parsed = parseDurationMs(timeLeft);
    const timeLeftMs = parsed ?? 0;
    this.callbacks.onEvent("go-away", { timeLeftMs, parsed: parsed !== null });

    this.clearGoAwayTimer();
    const delay = Math.max(0, timeLeftMs - GOAWAY_SAFETY_MS);
    this.cancelGoAway = this.timers.schedule(() => {
      this.cancelGoAway = null;
      this.callbacks.onEvent("reconnecting-before-goaway");
      void this.reconnect();
    }, delay);
  }

  private clearGoAwayTimer(): void {
    this.cancelGoAway?.();
    this.cancelGoAway = null;
  }

  /**
   * Whether the phase has been ended for good.
   *
   * A method rather than a bare field read, because the check is made on both
   * sides of several `await`s and the compiler narrows the field at the first
   * one — then reports the rest as unreachable. They are not: `close()` can land
   * while a token is being minted, while a socket is opening, or while the
   * backoff sleeps, and every one of those is a way to end up with a live socket
   * nobody holds a reference to.
   */
  private isFinished(): boolean {
    return this.finished;
  }

  /** Backoff reconnect after an unexpected close or a failed connect. */
  private async scheduleReconnect(): Promise<void> {
    if (this.isFinished()) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.callbacks.onEvent("reconnect-exhausted", { attempts: this.reconnectAttempts });
      this.setState("failed");
      return;
    }
    this.reconnectAttempts += 1;
    this.setState("reconnecting");
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.reconnectAttempts - 1), BACKOFF_CAP_MS);
    this.callbacks.onEvent("reconnect-scheduled", { attempt: this.reconnectAttempts, delay });
    await this.timers.sleep(delay);
    if (this.isFinished()) return;
    await this.connect();
  }

  /**
   * Close the current socket and immediately reopen it with the stored handle.
   *
   * This is the public seam the forced-reconnect test drives: it exercises the
   * exact code path a real GoAway takes, so the acceptance test does not have to
   * sit through ten minutes of débat to reach it.
   */
  async reconnect(): Promise<void> {
    // Checked here as well as in `connect()`: without it the machine would still
    // announce `reconnecting` for a session that is never going to reopen, and
    // the badge would sit on "reconnexion, l'épreuve continue" forever.
    if (this.isFinished()) {
      this.callbacks.onEvent("reconnect-refused", "the phase is over");
      return;
    }
    this.clearGoAwayTimer();
    this.callbacks.onEvent("reconnect-forced", { hasHandle: this.hasResumptionHandle });
    // A deliberate retry earns a fresh budget. Without this the counter is
    // still at the limit after an exhaustion, so the candidate's "reprendre la
    // connexion" would get exactly one attempt and then fall straight back to
    // `failed` — a recovery control that works once is worse than none, because
    // it looks like the exam is unrecoverable when it is not.
    this.reconnectAttempts = 0;
    // Retiring bumps the generation, so the old socket's `onclose` — which
    // arrives on a later tick, well after this method has returned — is already
    // stale by the time it lands and cannot be mistaken for a fresh drop. This
    // is also why a forced reconnect never passes through `closed`.
    this.retireSocket();
    this.setState("reconnecting");
    await this.connect();
  }

  /** Stream one base64 PCM16 chunk of candidate audio. */
  sendAudio(base64: string): void {
    if (!this.socket || this.state !== "connected") {
      // Dropped, not held, before the first connect (#74).
      //
      // Opening a session is a token mint and a handshake, a second or two in
      // which the microphone is already running: the recording starts on the
      // candidate's click and the socket is opened after it. Nothing said in
      // that window is the épreuve, because the phase's first words are the
      // examiner's. What the microphone has is the room, and flushing it at
      // connect delivered that burst at the exact moment the examiner began
      // the opening question. Automatic VAD read it as the candidate taking
      // the floor, reported an interruption, and the question was thrown away
      // unheard while the transcript printed it.
      //
      // A reconnect is the case this buffer exists for and is untouched: there
      // the candidate IS mid-sentence, and those are the chunks worth saving.
      if (!this.everConnected) {
        if (!this.preconnectAudioDropped) {
          this.preconnectAudioDropped = true;
          this.callbacks.onEvent("preconnect-audio-dropped");
        }
        return;
      }
      this.bufferAudio(base64);
      return;
    }
    try {
      this.socket.sendRealtimeInput({ audio: { data: base64, mimeType: INPUT_MIME_TYPE } });
    } catch (error) {
      // A dead socket reports its close on a LATER tick, so `state` still says
      // connected for a moment after sending stops working — and the microphone
      // does not pause for it. This used to log and drop the chunk. Buffering it
      // instead means the candidate's words in that window survive to the
      // reconnect like every other chunk; the send threw, so nothing was sent
      // and there is nothing to duplicate.
      this.callbacks.onEvent("send-audio-failed", String(error));
      this.bufferAudio(base64);
    }
  }

  /**
   * Hold a chunk for the next connect, up to the cap.
   *
   * Past the cap the newest chunks are dropped and the oldest kept, which is
   * the arguable half of this trade-off — the audio nearest the reconnect is
   * what joins up with the resumed stream. It is left as it is because the cap
   * is ~2 seconds and the alternative is speculation nothing here can measure;
   * what it must not be is SILENT, so an overflow is reported once per outage
   * and shows up in the session log next to the flush that follows it.
   */
  private bufferAudio(base64: string): void {
    if (this.pendingAudio.length < ExamLiveSession.MAX_PENDING_CHUNKS) {
      this.pendingAudio.push(base64);
      return;
    }
    if (!this.bufferOverflowed) {
      this.bufferOverflowed = true;
      this.callbacks.onEvent("audio-buffer-overflow", {
        cap: ExamLiveSession.MAX_PENDING_CHUNKS,
      });
    }
  }

  private flushPendingAudio(): void {
    if (this.pendingAudio.length === 0) return;
    const queued = this.pendingAudio;
    this.pendingAudio = [];
    this.bufferOverflowed = false;
    this.callbacks.onEvent("flushing-buffered-audio", { chunks: queued.length });
    for (const chunk of queued) this.sendAudio(chunk);
  }

  /**
   * Open the candidate's turn without closing it (manual VAD, monologue only).
   * Because no `activityEnd` follows, the model has no turn boundary and cannot
   * interrupt — the guarantee the monologue rests on.
   */
  beginCandidateActivity(): void {
    if (!this.socket) return;
    this.socket.sendRealtimeInput({ activityStart: {} });
    this.callbacks.onEvent("activity-start");
  }

  /** Close the candidate's turn, handing the floor to the examiner. */
  endCandidateActivity(): void {
    if (!this.socket) return;
    this.socket.sendRealtimeInput({ activityEnd: {} });
    this.callbacks.onEvent("activity-end");
  }

  /**
   * Send a text instruction to the examiner (the opening line, the closing
   * line). Not candidate speech: these never enter the transcript, because the
   * evaluator must never grade a control prompt as something the candidate said.
   */
  sendDirective(text: string): void {
    if (!this.socket) return;
    try {
      // `sendRealtimeInput({text})`, NOT `sendClientContent`. On
      // gemini-3.1-flash-live the latter only seeds history: it accepts the
      // turn and the model never speaks, which presents as a session that
      // connects fine and then sits in silence forever. Confirmed by testing
      // both against the live service.
      this.socket.sendRealtimeInput({ text });
      this.callbacks.onEvent("directive-sent");
    } catch (error) {
      this.callbacks.onEvent("directive-failed", String(error));
    }
  }

  /** Close a socket this session has no further interest in. */
  private discard(socket: LiveSocket): void {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }

  /**
   * Stop listening to the current socket and close it.
   *
   * The generation bump is the load-bearing half, not the `close()`: it is what
   * makes every callback still holding a reference to that socket a no-op from
   * this line onward, including the `onclose` its own teardown is about to
   * raise several ticks from now.
   */
  private retireSocket(): void {
    this.generation += 1;
    if (this.socket) this.discard(this.socket);
    this.socket = null;
  }

  /** End the phase for good. No reconnect follows. Safe to call twice. */
  close(): void {
    this.finished = true;
    this.clearGoAwayTimer();
    this.pendingAudio = [];
    this.retireSocket();
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
