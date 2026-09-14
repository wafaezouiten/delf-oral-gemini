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

import { base64ToInt16 } from "@/lib/audio/pcm";
import { isVoiced } from "@/lib/audio/voice-activity";
import { CLIENT_CONNECT_CONFIG, INPUT_MIME_TYPE, LIVE_MODEL } from "@/lib/gemini/constants";
import type { OralTopic } from "@/lib/delf/topics";
import type { LiveSessionLike } from "./controller-ports";
import { canTransition, describeTransition, type SessionState } from "./state-machine";

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
  /**
   * The examiner the candidate chose (#99). A fallback, not the decision: the
   * server reads the choice off the sitting and only honours this when no row
   * can be read — which is what keeps a reconnect on the same examiner while
   * the database is unreachable, and what makes the choice work at all with no
   * database configured.
   */
  model?: string;
  /**
   * DEVELOPMENT ONLY — a replacement examiner system instruction (#152).
   *
   * Forwarded on every mint, including reconnects, for the same reason the
   * model is: a session that reconnects must come back as the same examiner,
   * and a prompt that survived only the first connect would quietly revert
   * mid-débat. The server drops it off a development build.
   */
  examinerPrompt?: string;
  /** Present on a resume. Its presence is what the server pins into the token. */
  resumptionHandle?: string;
}

/**
 * A minted credential, and the examiner it was minted for.
 *
 * The model comes back from the server rather than being the client's own
 * `model` echoed, because the token's constraint pins one and a connect naming
 * another is a dead session (#99). Whatever the server decided — the sitting's
 * stored choice, the request's, or the default — is what the socket must open
 * with, so the two travel together through this seam.
 */
export interface MintedLiveToken {
  token: string;
  model: string;
}

/**
 * Everything outside this module's control: the token endpoint and the socket.
 *
 * Injected so the whole lifecycle — first connect, goAway, resume, backoff,
 * exhaustion — runs headlessly against fakes. The production implementation is
 * {@link browserLiveTransport}.
 */
export interface LiveTransport {
  mintToken(request: LiveTokenClientRequest): Promise<MintedLiveToken>;
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
    const { token, model } = (await response.json()) as { token?: string; model?: string };
    if (!token) throw new Error("Token endpoint returned no token");
    // A server from before the model rode along answers with the token alone;
    // it also pinned the build default, so that is what the socket must name.
    return { token, model: model ?? LIVE_MODEL };
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

/** One turn of seedable history, in the shape `sendClientContent` takes. */
export type LiveHistoryTurn = { role: "user" | "model"; parts: Array<{ text: string }> };

export interface ExamLiveSessionOptions {
  /** The sitting this session belongs to. Sent to the token route, which binds
   *  the token to it after checking the caller owns it. */
  examId: string;
  phase: LivePhase;
  topic: OralTopic;
  /** The candidate's chosen examiner, forwarded on every mint (#99). Absent
   *  means "never chosen" — the server decides, exactly as before. */
  model?: string;
  /** DEVELOPMENT ONLY — the examiner prompt this session runs under (#152).
   *  Absent means the instruction this repository builds. */
  examinerPrompt?: string;
  callbacks: SessionManagerCallbacks;
  /**
   * History to seed a fresh session with (the monologue, for the débat).
   *
   * A provider is read again on EVERY fresh connect, and a reconnect whose
   * socket died before the first resumption handle arrived is a fresh connect
   * (#133): nothing restores the exchange, so what the provider returns is all
   * the examiner will know. A caller whose history grows while the session
   * runs — the débat, whose exchange is itself the history — passes the
   * function; a plain array behaves as it always has, the same turns on every
   * fresh connect.
   */
  initialHistory?: LiveHistoryTurn[] | (() => LiveHistoryTurn[]);
  transport?: LiveTransport;
  timers?: SessionTimers;
  maxReconnectAttempts?: number;
}

export class ExamLiveSession implements LiveSessionLike {
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
   * An examiner turn is in flight on the current socket: its first chunk has
   * arrived and its `turnComplete` has not (#220).
   *
   * Under `activityHandling: NO_INTERRUPTION` the service does not queue the
   * candidate's speech during a turn it is generating — it drops it. Measured
   * against the real service with `debateConfig` as shipped
   * (`scripts/probe-overlap.ts`): a sentence spoken entirely inside the
   * examiner's turn produced no transcription and no reply, and a sentence that
   * started inside the turn and ran past it was transcribed from the turn's
   * edge onward, its opening clause gone. The comment on `debateConfig` used to
   * promise the opposite.
   *
   * So while a turn is in flight the microphone is HELD here rather than
   * streamed, and released as one burst at `turnComplete` — the same audio,
   * delivered the moment the service will listen to it. Probed with the same
   * script: both sentences came back complete, from the first word, and the
   * examiner answered the short one. The window is bounded above by generation,
   * which runs ~3× faster than speech (§8 of `docs/GEMINI_LIVE_FINDINGS.md`),
   * so the burst is at most a third of the turn's length and lands well before
   * the candidate has finished hearing it.
   *
   * What this cannot recover: the ~0.5 s between the server deciding the
   * candidate's turn was over and its first chunk reaching this client. Nothing
   * on this side can see that decision, so speech in that gap is still lost.
   *
   * **This is only correct because the débat forbids barge-in.** Under the
   * default `activityHandling` a held chunk is an interruption the server never
   * gets to hear, so the hold is keyed to the phase whose config pins
   * `NO_INTERRUPTION` — and `live-config.test.ts` pins that pairing.
   */
  private examinerTurnInFlight = false;
  /** Candidate audio held during an in-flight examiner turn, oldest first. */
  private heldAudio: string[] = [];
  /**
   * Thirty seconds of chunks. Generation of even the longest examiner turn is
   * a fraction of that; the cap exists for a turn that never completes — a
   * session gone deaf (#218) — so the hold cannot grow for the rest of the
   * épreuve. Past it the newest chunks are dropped and it is reported once.
   */
  private static readonly MAX_HELD_CHUNKS = 750;
  private heldOverflowed = false;
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
  private readonly model: string | undefined;
  private readonly examinerPrompt: string | undefined;
  private readonly callbacks: SessionManagerCallbacks;
  private readonly initialHistory: () => LiveHistoryTurn[];
  private readonly transport: LiveTransport;
  private readonly timers: SessionTimers;
  private readonly maxReconnectAttempts: number;

  constructor(options: ExamLiveSessionOptions) {
    this.examId = options.examId;
    this.phase = options.phase;
    this.topic = options.topic;
    this.model = options.model;
    this.examinerPrompt = options.examinerPrompt;
    this.callbacks = options.callbacks;
    const history = options.initialHistory ?? [];
    this.initialHistory = typeof history === "function" ? history : () => history;
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
      model: this.model,
      examinerPrompt: this.examinerPrompt,
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
    // Read before anything can open a socket: `onopen` sets `everConnected`,
    // so by the time the connect below has succeeded the field can no longer
    // say whether this attempt was the session's first. A fresh connect that
    // is NOT the first is the amnesia path (#133) — see the event at the
    // bottom of the try block.
    const everConnectedBefore = this.everConnected;
    this.setState(resuming ? "resuming" : "connecting");

    // Everything below belongs to this attempt. If a close or another reconnect
    // supersedes it mid-flight, the generation moves on and every line that
    // checks it becomes a no-op.
    const generation = this.generation;
    const isCurrent = () => generation === this.generation;

    try {
      const minted = await this.transport.mintToken(this.tokenRequest());
      // A close (or a second reconnect) can land while the token is minting.
      // Bail before spending a socket on it.
      if (!isCurrent()) return;

      const socket = await this.transport.open({
        token: minted.token,
        // The model the SERVER pinned into the token, not this session's own
        // `model` field: the constraint decides, and naming anything else on
        // the connect is a dead session (#99).
        model: minted.model,
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
      // candidate. Read from the provider on every fresh connect, not captured
      // at construction: a reconnect that lost its handle is a fresh connect
      // (#133), and it must be seeded with the exchange as it stands NOW. On a
      // RESUME the handle already carries the history, so re-seeding would
      // duplicate it in context.
      if (!resuming) {
        const history = this.initialHistory();
        if (history.length > 0) {
          this.socket.sendClientContent({ turns: history, turnComplete: false });
          this.callbacks.onEvent("history-seeded", { turns: history.length });
        }
      }

      // BEFORE the flush below, and that order is the point: the buffered
      // chunks are the candidate mid-sentence when the socket died, and they
      // have to land inside the reopened activity rather than in front of it.
      if (this.candidateActivityOpen) this.sendActivityStart("activity-reopened");

      // A turn in flight died with the socket that was generating it; whatever
      // the candidate said into it goes out first, then what they said during
      // the outage — the order they were said in.
      this.releaseHeldAudio();
      // Flushed HERE and not only in `onopen`, because `open()` resolves after
      // the socket is open: `onopen` therefore runs while `this.socket` is still
      // null, `sendAudio` refuses, and every buffered chunk is quietly pushed
      // straight back onto the queue. That is the audio captured during a
      // reconnect — precisely the audio the buffer exists to save. Calling it in
      // both places is safe: it is a no-op on an empty queue, and it refuses
      // unless the state says connected.
      this.flushPendingAudio();

      // The reconnect that could not resume (#133): this connect REPLACED a
      // live session and presented no handle, so the model's own memory of the
      // exchange is gone and the seed above is all it knows. Announced as its
      // own event rather than left to `connected`, because the controller
      // answers it with a directive and `connected` fires from `onopen`, while
      // `this.socket` is still null and `sendDirective` would silently drop
      // it. Last on purpose: the answer then lands on an installed, seeded
      // socket, after the candidate's own buffered mid-sentence words.
      if (!resuming && everConnectedBefore) {
        this.callbacks.onEvent("reconnected-fresh");
      }
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

    // This socket is done, so nothing further from it counts either — the
    // turn it was generating included.
    this.generation += 1;
    this.socket = null;
    this.examinerTurnInFlight = false;
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

    const audio: string[] = [];
    for (const part of content.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data) audio.push(data);
    }

    // The turn opens on its first sign — text or audio, whichever lands first
    // — and from here until `turnComplete` the microphone is held. See
    // {@link examinerTurnInFlight}.
    if ((examinerText || audio.length > 0) && this.holdsDuringExaminerTurn()) {
      this.examinerTurnInFlight = true;
    }
    for (const data of audio) this.callbacks.onExaminerAudio(data);

    if (content.turnComplete) {
      // Released BEFORE the controller hears the turn is complete, so what the
      // candidate said during it reaches the socket ahead of anything the
      // controller sends in answer to the boundary — a directive, a cue.
      this.examinerTurnInFlight = false;
      this.releaseHeldAudio();
      this.callbacks.onTurnComplete();
    }
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

  /**
   * Whether the candidate holds the manual-VAD floor — a fact about the PHASE,
   * which is why it is re-asserted on every socket.
   *
   * During the monologue, `activityStart` is what makes the audio that follows
   * part of a turn, and `activityEnd` is what makes Gemini emit the
   * transcription of it (verified, and the reason it is emitted only then:
   * `docs/GEMINI_LIVE_FINDINGS.md` §6 — nothing is transcribed DURING a
   * manual-VAD activity; the entire exposé arrives in one fragment at the
   * boundary).
   *
   * A marker binds to the socket it was sent on. This class replaces sockets
   * without telling anyone — that invisibility is its whole purpose — and
   * `ExamController` sends the marker exactly once, after the first `connect()`
   * resolves. So every reconnect during a monologue used to leave the new
   * socket with no open activity, and everything said after it was never part
   * of a turn and never transcribed. The visible consequence was not a warning:
   * `candidateWordCount(transcript, "monologue")` came back under
   * `PARTICIPATION_WORD_FLOOR`, the rubric called the monologue ABSENT, and the
   * correction told a candidate who had spoken for seven minutes that they had
   * not presented it and halved their mark for it.
   *
   * What this does NOT recover is the audio already spoken on the socket that
   * died: no `activityEnd` reached it, so its transcription was never emitted
   * and no client can ask for it now. That is why the finish payload carries
   * measured voiced seconds per part — so a transcript lost this way is read as
   * the app's failure and not the candidate's silence.
   *
   * Re-sent on a resume as well as on a cold reconnect. Whether resumption
   * restores an in-flight activity is not documented and was not observable
   * from here; a duplicate `activityStart` is at worst redundant, a missing one
   * costs the exposé.
   */
  private candidateActivityOpen = false;

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
    if (this.examinerTurnInFlight) {
      this.holdAudio(base64);
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
    // A true no-op with nothing to send to, not a logged one: the `onopen`
    // call lands while `this.socket` is still null, and without this it
    // reported a flush, sent nothing, and re-queued every chunk — a phantom
    // `flushing-buffered-audio` in the session log ahead of the real one.
    if (!this.socket || this.state !== "connected") return;
    const queued = this.pendingAudio;
    this.pendingAudio = [];
    this.bufferOverflowed = false;
    this.callbacks.onEvent("flushing-buffered-audio", { chunks: queued.length });
    for (const chunk of queued) this.sendAudio(chunk);
  }

  /**
   * Whether this session holds the microphone during an examiner turn.
   *
   * The débat only. The monologue is manual VAD with the candidate's activity
   * held open, so the examiner has no turn boundary to generate against while
   * the candidate speaks, and its exposé is transcribed from the recording in
   * any case (#206). The hold would cost nothing there and gain nothing.
   */
  private holdsDuringExaminerTurn(): boolean {
    return this.phase === "debate";
  }

  /** Hold one chunk for the end of the examiner's turn, up to the cap. */
  private holdAudio(base64: string): void {
    if (this.heldAudio.length < ExamLiveSession.MAX_HELD_CHUNKS) {
      this.heldAudio.push(base64);
      return;
    }
    if (!this.heldOverflowed) {
      this.heldOverflowed = true;
      this.callbacks.onEvent("held-audio-overflow", { cap: ExamLiveSession.MAX_HELD_CHUNKS });
    }
  }

  /**
   * Send what was held during the turn, or drop it if nobody spoke.
   *
   * The common case is the quiet one: the candidate listens to the question
   * and the hold is room tone plus whatever the browser's echo cancellation
   * left of the examiner's own voice. Sending that back as a burst at every
   * `turnComplete` would be pointless at best — and, if the residue crosses the
   * detector's threshold, an echo served to the examiner in delayed form. So the
   * hold is released only if at least one chunk in it crossed
   * {@link isVoiced}'s bar, the same crude measure the recorder uses to say
   * whether the microphone carried anything at all. A chunk that cannot be
   * decoded is counted as voiced: what is in doubt is the candidate's words,
   * and the cost of keeping room tone is a burst the server's VAD ignores.
   *
   * Released whole, silences included: they are the rhythm of the speech, and
   * the server's silence window is what turns them into a turn boundary.
   */
  private releaseHeldAudio(): void {
    if (this.heldAudio.length === 0) return;
    const held = this.heldAudio;
    this.heldAudio = [];
    this.heldOverflowed = false;
    if (!held.some(chunkIsVoiced)) {
      this.callbacks.onEvent("held-audio-discarded", { chunks: held.length });
      return;
    }
    this.callbacks.onEvent("held-audio-released", { chunks: held.length });
    for (const chunk of held) this.sendAudio(chunk);
  }

  /**
   * Open the candidate's turn without closing it (manual VAD, monologue only).
   * Because no `activityEnd` follows, the model has no turn boundary and cannot
   * interrupt — the guarantee the monologue rests on.
   *
   * The floor stays open until {@link endCandidateActivity}, and OPEN IS A
   * FACT ABOUT THE PHASE, NOT ABOUT THE SOCKET: see {@link candidateActivityOpen}
   * for why that distinction is the whole of the monologue's transcript.
   */
  beginCandidateActivity(): void {
    this.candidateActivityOpen = true;
    this.sendActivityStart("activity-start");
  }

  /** Close the candidate's turn, handing the floor to the examiner. */
  endCandidateActivity(): void {
    this.candidateActivityOpen = false;
    if (!this.socket) return;
    this.socket.sendRealtimeInput({ activityEnd: {} });
    this.callbacks.onEvent("activity-end");
  }

  /**
   * Mark the candidate as holding the floor on the CURRENT socket.
   *
   * Split out from `beginCandidateActivity` so the reconnect path can re-send
   * the marker without re-deciding whether the floor is open, and so the two
   * sites log under different names — an `activity-reopened` in the session log
   * is the fingerprint of the failure below actually having been survived.
   *
   * Silent with no socket, deliberately: the flag is already set, so the next
   * connect sends it. That covers the sitting where the monologue's very first
   * connect exhausted its retries and the candidate recovered it by hand —
   * `beginCandidateActivity` ran against a null socket there, and before the
   * flag existed the marker was simply never sent at all.
   */
  private sendActivityStart(event: string): void {
    if (!this.socket) return;
    this.socket.sendRealtimeInput({ activityStart: {} });
    this.callbacks.onEvent(event);
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
    this.examinerTurnInFlight = false;
  }

  /** End the phase for good. No reconnect follows. Safe to call twice. */
  close(): void {
    this.finished = true;
    this.clearGoAwayTimer();
    this.pendingAudio = [];
    this.heldAudio = [];
    this.retireSocket();
    this.setState("closed");
  }
}

/**
 * Whether a base64 PCM16 chunk crossed the recorder's speech threshold.
 *
 * Kept, not dropped, when it cannot be decoded: see `releaseHeldAudio`.
 */
function chunkIsVoiced(base64: string): boolean {
  try {
    return isVoiced(base64ToInt16(base64));
  } catch {
    return true;
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
      return (
        (Number.isFinite(seconds) ? seconds : 0) * 1000 + (Number.isFinite(nanos) ? nanos : 0) / 1e6
      );
    }
  }
  return null;
}
