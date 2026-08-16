import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  LiveSendClientContentParameters,
  LiveSendRealtimeInputParameters,
  LiveServerMessage,
} from "@google/genai";

import { CLIENT_CONNECT_CONFIG, LIVE_MODEL } from "@/lib/gemini/constants";
import type { OralTopic } from "@/lib/delf/topics";
import {
  ExamLiveSession,
  parseDurationMs,
  type CancelTimer,
  type ConnectionState,
  type LiveSocket,
  type LiveSocketCallbacks,
  type LiveTokenClientRequest,
  type LiveTransport,
  type SessionManagerCallbacks,
  type SessionTimers,
} from "./session-manager";

/**
 * The session lifecycle, driven end to end against a fake transport.
 *
 * Everything here used to be untestable: the class built a `GoogleGenAI` client
 * and called `fetch` inline, so a suite could only reach the duration parser at
 * the bottom of the file. Since a Gemini connection dying mid-exam is the
 * NORMAL path for a 13-minute débat, that left the most load-bearing code in
 * the project covered by hope.
 *
 * The fakes below stand in for the token route and the socket, and the timers
 * are manual — so a goAway warning, its deadline, five rounds of backoff and an
 * exhaustion all happen in microseconds.
 */

const TOPIC: OralTopic = {
  slug: "teletravail",
  title: "Le télétravail a-t-il vraiment amélioré nos vies ?",
  document: "Document de test.",
  consigne: "Consigne de test.",
};

class FakeSocket implements LiveSocket {
  realtime: LiveSendRealtimeInputParameters[] = [];
  contents: LiveSendClientContentParameters[] = [];
  closed = false;

  constructor(readonly callbacks: LiveSocketCallbacks) {}

  sendRealtimeInput(params: LiveSendRealtimeInputParameters): void {
    if (this.closed) throw new Error("socket is closed");
    this.realtime.push(params);
  }

  sendClientContent(params: LiveSendClientContentParameters): void {
    if (this.closed) throw new Error("socket is closed");
    this.contents.push(params);
  }

  /**
   * Close, delivering `onclose` on a LATER tick, exactly as a real WebSocket
   * does — `NodeWebSocket.close()` is a bare `ws.close()` and the event is
   * dispatched asynchronously.
   *
   * This fake used to fire it synchronously, inside the caller's stack, and that
   * accident is what let a whole class of bug through: any guard held only for
   * the duration of a synchronous teardown looked airtight here and covered
   * nothing in production, because the real event lands while the replacement
   * connect is still awaiting its token.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.callbacks.onclose?.({ reason: "closed by client" }));
  }

  /** The server pushes a message. */
  emit(message: LiveServerMessage): void {
    this.callbacks.onmessage(message);
  }

  /** The server hangs up without warning. Also asynchronous. */
  drop(reason = "1011 internal error"): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.callbacks.onclose?.({ reason }));
  }

  /** Base64 audio chunks the candidate actually got to send. */
  get audioChunks(): string[] {
    return this.realtime
      .map((input) => input.audio?.data)
      .filter((data): data is string => typeof data === "string");
  }
}

interface MintGate {
  promise: Promise<void>;
  /** Let the gated mint proceed. */
  release: () => void;
  /** Make the gated mint reject, as a flaky network would. */
  fail: () => void;
}

class FakeTransport implements LiveTransport {
  tokenRequests: LiveTokenClientRequest[] = [];
  opens: Array<{ token: string; model: string; config: unknown }> = [];
  sockets: FakeSocket[] = [];
  /** Number of upcoming mints that should fail, simulating a token route outage. */
  failMints = 0;
  private minted = 0;
  private mintGate: MintGate | null = null;
  private openGate: Promise<void> | null = null;

  /**
   * Stall the NEXT mint until released, so a test can land something else in
   * the middle of an in-flight connect — a `close()`, or a whole second attempt
   * that overtakes this one. Consumed by the call it gates, so a later attempt
   * runs at full speed and can win the race.
   *
   * `fail()` rejects it instead, which is how a superseded attempt is made to
   * throw after a newer one has already connected.
   */
  holdMint(): MintGate {
    let release!: () => void;
    let fail!: () => void;
    const promise = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = () => reject(new Error("token route unavailable"));
    });
    // Not unhandled: `mintToken` awaits it, and this keeps node quiet if a test
    // fails before that happens.
    promise.catch(() => {});
    this.mintGate = { promise, release, fail };
    return this.mintGate;
  }

  holdOpen(): () => void {
    let release!: () => void;
    this.openGate = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.openGate = null;
      release();
    };
  }

  async mintToken(request: LiveTokenClientRequest): Promise<string> {
    this.tokenRequests.push({ ...request });
    const gate = this.mintGate;
    if (gate) {
      this.mintGate = null;
      await gate.promise;
    }
    if (this.failMints > 0) {
      this.failMints -= 1;
      throw new Error("token route unavailable");
    }
    this.minted += 1;
    return `token-${this.minted}`;
  }

  async open(params: {
    token: string;
    model: string;
    config: unknown;
    callbacks: LiveSocketCallbacks;
  }): Promise<LiveSocket> {
    if (this.openGate) await this.openGate;
    const socket = new FakeSocket(params.callbacks);
    this.sockets.push(socket);
    this.opens.push({ token: params.token, model: params.model, config: params.config });
    // Mirrors the SDK: the open event fires before `connect()` resolves, so the
    // session's own socket field is still unset inside `onopen`.
    params.callbacks.onopen?.();
    return socket;
  }

  get socket(): FakeSocket {
    return this.sockets[this.sockets.length - 1];
  }
}

/** Timers that never wait. Backoff delays are recorded rather than slept. */
class TestTimers implements SessionTimers {
  scheduled: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  slept: number[] = [];
  private sleepGate: Promise<void> | null = null;

  schedule(fn: () => void, ms: number): CancelTimer {
    const entry = { ms, fn, cancelled: false };
    this.scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  /** Park the next backoff until released, so a test can land something else
   *  in the middle of it. */
  holdSleep(): () => void {
    let release!: () => void;
    this.sleepGate = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.sleepGate = null;
      release();
    };
  }

  sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    return this.sleepGate ?? Promise.resolve();
  }

  /** Fire every live scheduled callback. */
  runScheduled(): void {
    const due = this.scheduled.filter((entry) => !entry.cancelled);
    this.scheduled = [];
    for (const entry of due) entry.fn();
  }

  get liveTimerDelays(): number[] {
    return this.scheduled.filter((entry) => !entry.cancelled).map((entry) => entry.ms);
  }
}

interface Recorded {
  states: ConnectionState[];
  events: Array<{ name: string; detail?: unknown }>;
  candidate: string[];
  examiner: string[];
  audio: string[];
  interruptions: number;
  turnCompletions: number;
}

function recorder(): { callbacks: SessionManagerCallbacks; log: Recorded } {
  const log: Recorded = {
    states: [],
    events: [],
    candidate: [],
    examiner: [],
    audio: [],
    interruptions: 0,
    turnCompletions: 0,
  };
  return {
    log,
    callbacks: {
      onStateChange: (state) => log.states.push(state),
      onCandidateTranscript: (text) => log.candidate.push(text),
      onExaminerTranscript: (text) => log.examiner.push(text),
      onExaminerAudio: (base64) => log.audio.push(base64),
      onInterrupted: () => {
        log.interruptions += 1;
      },
      onTurnComplete: () => {
        log.turnCompletions += 1;
      },
      onEvent: (name, detail) => log.events.push({ name, detail }),
    },
  };
}

interface Harness {
  session: ExamLiveSession;
  transport: FakeTransport;
  timers: TestTimers;
  log: Recorded;
  eventNames: () => string[];
}

function harness(
  overrides: {
    phase?: "monologue" | "debate";
    initialHistory?: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
    maxReconnectAttempts?: number;
  } = {},
): Harness {
  const transport = new FakeTransport();
  const timers = new TestTimers();
  const { callbacks, log } = recorder();

  const session = new ExamLiveSession({
    examId: "42",
    phase: overrides.phase ?? "debate",
    topic: TOPIC,
    callbacks,
    initialHistory: overrides.initialHistory,
    transport,
    timers,
    maxReconnectAttempts: overrides.maxReconnectAttempts,
  });

  return { session, transport, timers, log, eventNames: () => log.events.map((e) => e.name) };
}

/** A server message carrying a fresh resumption handle. */
function resumptionUpdate(handle: string): LiveServerMessage {
  return { sessionResumptionUpdate: { resumable: true, newHandle: handle } } as LiveServerMessage;
}

/** Let any pending microtask-driven reconnect settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ------------------------------------------------------------------- creation

describe("session creation", () => {
  it("mints a token bound to the sitting, then opens a socket", async () => {
    const h = harness({ phase: "monologue" });
    await h.session.connect();

    assert.equal(h.transport.tokenRequests.length, 1);
    assert.deepEqual(h.transport.tokenRequests[0], {
      examId: "42",
      phase: "monologue",
      topicSlug: TOPIC.slug,
      // Absent on a first connect: there is nothing to resume yet, and its
      // absence is what makes this a `connecting` rather than a `resuming`.
      resumptionHandle: undefined,
    });
    assert.equal(h.transport.opens.length, 1);
    assert.equal(h.transport.opens[0].token, "token-1", "the minted token opens the socket");
    assert.equal(h.transport.opens[0].model, LIVE_MODEL);
    assert.equal(h.session.connectionState, "connected");
  });

  it("reports idle, connecting, connected, in that order", async () => {
    const h = harness();
    assert.equal(h.session.connectionState, "idle");
    await h.session.connect();
    assert.deepEqual(h.log.states, ["connecting", "connected"]);
  });

  it("does not open a second socket while one is already opening or open", async () => {
    const h = harness();
    await h.session.connect();
    await h.session.connect();
    assert.equal(h.transport.opens.length, 1);
  });

  it("routes a token-route outage into the reconnect path, not an exception", async () => {
    const h = harness({ maxReconnectAttempts: 1 });
    h.transport.failMints = 99;

    await h.session.connect();
    await flush();

    assert.ok(h.eventNames().includes("connect-failed"));
    assert.equal(h.session.connectionState, "failed", "gives up only after exhausting attempts");
  });
});

// -------------------------------------------------------------- configuration

describe("session configuration", () => {
  it("connects with modalities only, never with the examiner's instruction", async () => {
    // The whole point of pinning the config into the token: the system prompt
    // exists only on the server. If it ever appears in this config it is also in
    // the client bundle.
    const h = harness();
    await h.session.connect();

    const config = h.transport.opens[0].config as Record<string, unknown>;
    assert.deepEqual(config, CLIENT_CONNECT_CONFIG);
    assert.equal(config.systemInstruction, undefined);
    assert.ok(Array.isArray(config.responseModalities), "audio is still requested explicitly");
  });

  it("seeds a fresh débat session with the monologue", async () => {
    const history = [{ role: "user" as const, parts: [{ text: "Mon exposé." }] }];
    const h = harness({ phase: "debate", initialHistory: history });
    await h.session.connect();

    assert.equal(h.transport.socket.contents.length, 1);
    assert.deepEqual(h.transport.socket.contents[0], { turns: history, turnComplete: false });
    // `turnComplete: false` matters: seeding must not prompt a turn. The
    // examiner's opening line is sent separately, as a directive.
    assert.ok(h.eventNames().includes("history-seeded"));
  });

  it("sends the monologue's activity markers as realtime input", async () => {
    const h = harness({ phase: "monologue" });
    await h.session.connect();

    h.session.beginCandidateActivity();
    assert.deepEqual(h.transport.socket.realtime.at(-1), { activityStart: {} });

    h.session.endCandidateActivity();
    assert.deepEqual(h.transport.socket.realtime.at(-1), { activityEnd: {} });
  });

  it("sends a directive as realtime text, which is what makes this model speak", async () => {
    // `sendClientContent` only seeds history on gemini-3.1-flash-live: the
    // session connects and then sits in silence forever.
    const h = harness();
    await h.session.connect();
    h.session.sendDirective("Ouvre le débat.");

    assert.deepEqual(h.transport.socket.realtime.at(-1), { text: "Ouvre le débat." });
    assert.equal(h.transport.socket.contents.length, 0);
  });
});

// ------------------------------------------------------------------ resumption

describe("session resumption", () => {
  it("keeps the newest handle the server issues", async () => {
    const h = harness();
    await h.session.connect();
    assert.equal(h.session.hasResumptionHandle, false);

    h.transport.socket.emit(resumptionUpdate("handle-one"));
    h.transport.socket.emit(resumptionUpdate("handle-two"));
    assert.equal(h.session.hasResumptionHandle, true);

    await h.session.reconnect();
    assert.equal(
      h.transport.tokenRequests.at(-1)?.resumptionHandle,
      "handle-two",
      "the newest handle is the one presented",
    );
  });

  it("ignores an update the server marks unresumable", async () => {
    const h = harness();
    await h.session.connect();
    h.transport.socket.emit({
      sessionResumptionUpdate: { resumable: false, newHandle: "no-good" },
    } as LiveServerMessage);

    assert.equal(h.session.hasResumptionHandle, false);
  });

  it("enters `resuming` rather than `connecting` when it holds a handle", async () => {
    // The distinction is the whole reason both states exist: only one of them
    // keeps the examiner's memory of the exam so far.
    const h = harness();
    await h.session.connect();
    h.transport.socket.emit(resumptionUpdate("handle-one"));
    h.log.states.length = 0;

    await h.session.reconnect();
    assert.deepEqual(h.log.states, ["reconnecting", "resuming", "connected"]);
    assert.ok(h.eventNames().includes("resumed"));
  });

  it("does not re-seed the monologue on a resume", async () => {
    // The handle already carries the history; seeding again would give the
    // examiner the candidate's exposé twice.
    const history = [{ role: "user" as const, parts: [{ text: "Mon exposé." }] }];
    const h = harness({ phase: "debate", initialHistory: history });
    await h.session.connect();
    h.transport.socket.emit(resumptionUpdate("handle-one"));

    await h.session.reconnect();
    assert.equal(h.transport.sockets.length, 2);
    assert.equal(h.transport.socket.contents.length, 0, "the resumed socket was not re-seeded");
  });

  it("mints a fresh token for every connect, because a token is single-use", async () => {
    const h = harness();
    await h.session.connect();
    h.transport.socket.emit(resumptionUpdate("handle-one"));
    await h.session.reconnect();

    assert.equal(h.transport.tokenRequests.length, 2);
    assert.deepEqual(
      h.transport.opens.map((open) => open.token),
      ["token-1", "token-2"],
    );
  });
});

// ------------------------------------------------------------------- reconnect

describe("reconnection", () => {
  it("reconnects after an unannounced drop, with backoff", async () => {
    const h = harness();
    await h.session.connect();
    h.transport.socket.emit(resumptionUpdate("handle-one"));

    h.transport.socket.drop();
    await flush();

    assert.ok(h.eventNames().includes("closed-unexpectedly"));
    assert.deepEqual(h.timers.slept, [400], "first backoff is the base delay");
    assert.equal(h.session.connectionState, "connected", "and it came back");
    assert.equal(h.transport.sockets.length, 2);
  });

  it("gives up after the attempt limit, and says so", async () => {
    const h = harness({ maxReconnectAttempts: 3 });
    await h.session.connect();
    h.transport.socket.emit(resumptionUpdate("handle-one"));
    // Every subsequent mint fails, so each attempt burns one try.
    h.transport.failMints = 99;

    h.transport.socket.drop();
    await flush();

    assert.deepEqual(h.timers.slept, [400, 800, 1600], "delays double, capped");
    assert.equal(h.session.connectionState, "failed");
    assert.ok(h.eventNames().includes("reconnect-exhausted"));

    // Each failed attempt re-enters `reconnecting` from `resuming`. That is
    // correct at this level — every one of them IS an attempt — and it is why
    // the controller counts outages by looking for a transition out of
    // `connected`, not by counting these.
    assert.equal(h.log.states.filter((state) => state === "reconnecting").length, 3);
  });

  it("gives a deliberate retry a fresh budget, so recovery from `failed` works", async () => {
    // `failed` is recoverable by design, and the candidate has a button for it.
    // Without resetting the counter that button gets exactly one attempt before
    // falling straight back to `failed` — which reads as an unrecoverable exam
    // when it is not.
    const h = harness({ maxReconnectAttempts: 2 });
    await h.session.connect();
    h.transport.failMints = 99;
    h.transport.socket.drop();
    await flush();
    assert.equal(h.session.connectionState, "failed");

    h.transport.failMints = 0;
    await h.session.reconnect();

    assert.equal(h.session.connectionState, "connected", "the candidate got back in");
    assert.equal(h.transport.sockets.length, 2);
  });

  it("resets the attempt counter once a socket opens again", async () => {
    const h = harness({ maxReconnectAttempts: 3 });
    await h.session.connect();
    h.transport.socket.drop();
    await flush();
    h.transport.socket.drop();
    await flush();

    assert.deepEqual(h.timers.slept, [400, 400], "the second drop starts from the base delay again");
    assert.equal(h.session.connectionState, "connected");
  });

  it("never routes a forced reconnect through the terminal `closed` state", async () => {
    // `closed` means the phase is over. A reconnect that passed through it would
    // end the session machine for good, mid-débat.
    const h = harness();
    await h.session.connect();
    h.log.states.length = 0;

    await h.session.reconnect();
    assert.ok(!h.log.states.includes("closed"));
    assert.equal(h.session.connectionState, "connected");
  });

  it("flushes audio buffered while the socket was down", async () => {
    const h = harness();
    await h.session.connect();
    h.transport.socket.emit(resumptionUpdate("handle-one"));

    h.transport.socket.drop();
    h.session.sendAudio("chunk-a");
    h.session.sendAudio("chunk-b");
    await flush();

    assert.deepEqual(
      h.transport.socket.audioChunks,
      ["chunk-a", "chunk-b"],
      "the candidate's words during a reconnect are not lost",
    );
    assert.ok(h.eventNames().includes("flushing-buffered-audio"));
  });

  it("bounds the buffer rather than growing it through a long outage", async () => {
    const h = harness();
    await h.session.connect();
    h.transport.socket.drop();
    for (let i = 0; i < 200; i += 1) h.session.sendAudio(`chunk-${i}`);
    await flush();

    assert.equal(h.transport.socket.audioChunks.length, 50);
    // Bounded, but not silently: a dropped-audio incident has to be visible in
    // the session log, and once per outage rather than once per chunk.
    assert.equal(
      h.log.events.filter((event) => event.name === "audio-buffer-overflow").length,
      1,
    );
  });

  it("ignores the retired socket's close, which lands mid-reconnect", async () => {
    // The race: `close()` on a real WebSocket delivers `onclose` on a later
    // tick, so a forced reconnect's own teardown event arrives while the
    // replacement connect is still awaiting its token. Read as a fresh drop it
    // stacks a second reconnect on the one in flight, inflates reconnectCount
    // in the finished payload, and — worst — nulls the reference to the NEW,
    // healthy socket, so audio is silently buffered while the badge still says
    // the examiner is online.
    const h = harness();
    await h.session.connect();
    h.transport.socket.emit(resumptionUpdate("handle-one"));

    const retired = h.transport.socket;
    const gate = h.transport.holdMint();
    const reconnecting = h.session.reconnect();
    // The old socket's close lands here, with the connect still mid-mint.
    await flush();
    assert.ok(h.eventNames().includes("stale-close-ignored"));
    gate.release();
    await reconnecting;

    assert.equal(h.transport.sockets.length, 2, "one replacement, not two");
    assert.notEqual(h.transport.socket, retired);
    assert.equal(h.session.connectionState, "connected");
    assert.deepEqual(h.timers.slept, [], "no backoff cycle was started behind it");
    assert.deepEqual(
      h.log.events.filter((event) => event.name === "closed-unexpectedly"),
      [],
      "our own teardown was never mistaken for a drop",
    );

    // And the live socket is still held: audio goes out rather than to the buffer.
    h.session.sendAudio("chunk-after");
    assert.deepEqual(h.transport.socket.audioChunks, ["chunk-after"]);
  });

  it("opens one socket when a forced reconnect lands during a backoff", async () => {
    // Two independent callers can each reach connect(): the parked
    // scheduleReconnect() and the candidate pressing the button. What stops a
    // duplicate socket is connect()'s state guard, which is checked before any
    // await — so the backoff finds the session already connected and gives up
    // rather than opening a second one on top of it.
    const h = harness();
    await h.session.connect();
    h.transport.socket.emit(resumptionUpdate("handle-one"));

    const releaseSleep = h.timers.holdSleep();
    h.transport.socket.drop();
    await flush();
    assert.equal(h.session.connectionState, "reconnecting", "backoff is parked");

    const forced = h.session.reconnect();
    await flush();
    assert.equal(h.session.connectionState, "connected", "the forced attempt won the race");

    releaseSleep();
    await forced;
    await flush();

    assert.equal(h.transport.sockets.length, 2, "one replacement socket, not two");
    assert.equal(h.session.connectionState, "connected");
  });

  it("ignores a retired socket's messages, so it cannot rewind the handle", async () => {
    // A stale socket that could still speak would overwrite the newer
    // resumption handle with an older one, and drop transcript fragments into
    // an exam they were not said in.
    const h = harness();
    await h.session.connect();
    h.transport.socket.emit(resumptionUpdate("handle-one"));

    const retired = h.transport.socket;
    await h.session.reconnect();
    h.transport.socket.emit(resumptionUpdate("handle-two"));

    retired.emit(resumptionUpdate("handle-stale"));
    retired.emit({
      serverContent: { inputTranscription: { text: "d'un examen précédent" } },
    } as LiveServerMessage);

    assert.deepEqual(h.log.candidate, [], "the retired socket said nothing");
    await h.session.reconnect();
    assert.equal(h.transport.tokenRequests.at(-1)?.resumptionHandle, "handle-two");
  });

  it("closes a socket that finishes opening after the phase ended", async () => {
    // The leak this guards: `close()` works by closing `this.socket`, which is
    // only assigned once `open()` resolves. A candidate navigating away
    // mid-connect therefore found null, closed nothing, and left a live Gemini
    // socket that nothing held a reference to.
    const h = harness();
    const release = h.transport.holdOpen();

    const connecting = h.session.connect();
    // Let the mint settle, so the close lands while `open()` is in flight —
    // past the point where bailing early is still possible.
    await flush();
    h.session.close();
    release();
    await connecting;

    assert.equal(h.transport.sockets.length, 1, "the socket did open");
    assert.equal(h.transport.socket.closed, true, "and it was closed anyway");
    assert.equal(h.session.connectionState, "closed");
    assert.ok(h.eventNames().includes("closed-late-open"));
  });

  it("does not spend a socket at all when the phase ends while the token is minting", async () => {
    const h = harness();
    const gate = h.transport.holdMint();

    const connecting = h.session.connect();
    h.session.close();
    gate.release();
    await connecting;

    assert.equal(h.transport.sockets.length, 0);
    assert.equal(h.session.connectionState, "closed");
  });

  it("lets a superseded attempt fail without disturbing the one that replaced it", async () => {
    // The last unguarded path. A connect parked on its token can be overtaken
    // by a forced reconnect; when the abandoned attempt then rejects — an
    // ordinary thing on the flaky network this class exists for — its catch
    // used to null the reference to the LIVE socket the newer attempt had
    // installed, force `reconnecting` over its `connected`, and open a second
    // socket beside the first. Two message streams, doubled audio, one leaked.
    const h = harness();
    const gate = h.transport.holdMint();
    const superseded = h.session.connect();
    await flush();

    // A forced reconnect overtakes it and connects for real.
    await h.session.reconnect();
    assert.equal(h.session.connectionState, "connected");
    const live = h.transport.socket;

    // Only now does the abandoned attempt's token request fail.
    gate.fail();
    await superseded;
    await flush();

    assert.ok(h.eventNames().includes("stale-connect-failed"));
    assert.equal(h.transport.sockets.length, 1, "no second socket was opened");
    assert.equal(h.session.connectionState, "connected", "the live attempt was left alone");
    assert.deepEqual(h.timers.slept, [], "and no backoff was started behind it");

    // The live socket is still held, so audio still goes out.
    h.session.sendAudio("chunk-after");
    assert.deepEqual(live.audioChunks, ["chunk-after"]);
  });

  it("refuses to reopen after the phase is over, however it is asked", async () => {
    // `closed` is terminal in the state machine, so it has to be terminal here.
    // A stray reconnect would otherwise open a session for an exam that ended.
    const h = harness();
    await h.session.connect();
    h.session.close();

    await h.session.connect();
    await h.session.reconnect();

    assert.equal(h.transport.sockets.length, 1);
    assert.equal(h.session.connectionState, "closed");
    assert.ok(h.eventNames().includes("connect-refused"));
  });

  it("stops for good on close, with no reconnect behind it", async () => {
    const h = harness();
    await h.session.connect();
    h.session.close();

    assert.equal(h.session.connectionState, "closed");
    assert.equal(h.transport.sockets.length, 1);
    assert.deepEqual(h.timers.slept, [], "no backoff was scheduled");
    assert.equal(h.timers.liveTimerDelays.length, 0);
  });
});

// ---------------------------------------------------------------------- goAway

describe("goAway handling", () => {
  it("schedules a reconnect ahead of the server's deadline", async () => {
    const h = harness();
    await h.session.connect();
    h.transport.socket.emit(resumptionUpdate("handle-one"));

    h.transport.socket.emit({ goAway: { timeLeft: "9.5s" } } as LiveServerMessage);

    // 9500 ms of warning, reconnect 1500 ms early: the new socket opens while
    // the old one is still healthy, so no audio falls on the floor.
    assert.deepEqual(h.timers.liveTimerDelays, [8000]);
    assert.equal(h.session.connectionState, "connected", "still live until the deadline");
  });

  it("resumes the same exam when that deadline arrives", async () => {
    const h = harness();
    await h.session.connect();
    h.transport.socket.emit(resumptionUpdate("handle-one"));
    h.transport.socket.emit({ goAway: { timeLeft: "9.5s" } } as LiveServerMessage);

    h.timers.runScheduled();
    await flush();

    assert.ok(h.eventNames().includes("reconnecting-before-goaway"));
    assert.equal(h.transport.sockets.length, 2, "a new socket");
    assert.equal(
      h.transport.tokenRequests.at(-1)?.resumptionHandle,
      "handle-one",
      "carrying the handle, so it is the same exam and not a new one",
    );
    assert.equal(h.session.connectionState, "connected");
  });

  it("reconnects immediately when the deadline cannot be read", async () => {
    // Being early costs nothing; being late costs the candidate's words.
    const h = harness();
    await h.session.connect();
    h.transport.socket.emit({ goAway: { timeLeft: "bientôt" } } as LiveServerMessage);

    assert.deepEqual(h.timers.liveTimerDelays, [0]);
    const goAway = h.log.events.find((event) => event.name === "go-away");
    assert.deepEqual(goAway?.detail, { timeLeftMs: 0, parsed: false });
  });

  it("reconnects immediately when the deadline has already passed", async () => {
    const h = harness();
    await h.session.connect();
    h.transport.socket.emit({ goAway: { timeLeft: "0.2s" } } as LiveServerMessage);

    assert.deepEqual(h.timers.liveTimerDelays, [0], "never a negative delay");
  });

  it("replaces an earlier goAway timer instead of stacking a second one", async () => {
    const h = harness();
    await h.session.connect();
    h.transport.socket.emit({ goAway: { timeLeft: "9s" } } as LiveServerMessage);
    h.transport.socket.emit({ goAway: { timeLeft: "4s" } } as LiveServerMessage);

    assert.deepEqual(h.timers.liveTimerDelays, [2500], "only the newest deadline is live");
  });

  it("cancels the goAway timer when the phase ends first", async () => {
    // The clock running out mid-warning must not resurrect a closed session.
    const h = harness();
    await h.session.connect();
    h.transport.socket.emit({ goAway: { timeLeft: "9s" } } as LiveServerMessage);
    h.session.close();

    h.timers.runScheduled();
    await flush();

    assert.equal(h.transport.sockets.length, 1);
    assert.equal(h.session.connectionState, "closed");
  });
});

// --------------------------------------------------------------- server events

describe("server messages", () => {
  it("splits the two transcripts and the examiner's audio", async () => {
    const h = harness();
    await h.session.connect();

    h.transport.socket.emit({
      serverContent: {
        inputTranscription: { text: "Je maintiens ma position." },
        outputTranscription: { text: "Vraiment ?" },
        modelTurn: { parts: [{ inlineData: { data: "pcm-base64" } }] },
        turnComplete: true,
      },
    } as LiveServerMessage);

    assert.deepEqual(h.log.candidate, ["Je maintiens ma position."]);
    assert.deepEqual(h.log.examiner, ["Vraiment ?"]);
    assert.deepEqual(h.log.audio, ["pcm-base64"]);
    assert.equal(h.log.turnCompletions, 1);
  });

  it("reports an interruption so queued playback can be dropped", async () => {
    const h = harness();
    await h.session.connect();
    h.transport.socket.emit({ serverContent: { interrupted: true } } as LiveServerMessage);
    assert.equal(h.log.interruptions, 1);
  });
});

// --------------------------------------------------------------- the machine

describe("the session state machine, as actually driven", () => {
  it("never makes an illegal transition across a full connect-goAway-resume-close cycle", async () => {
    const h = harness({ phase: "debate", initialHistory: [] });

    await h.session.connect();
    h.transport.socket.emit(resumptionUpdate("handle-one"));
    h.transport.socket.emit({ goAway: { timeLeft: "9.5s" } } as LiveServerMessage);
    h.timers.runScheduled();
    await flush();
    h.transport.socket.drop();
    await flush();
    h.session.close();

    assert.deepEqual(
      h.log.events.filter((event) => event.name === "invalid-transition"),
      [],
      "the declared table and the code that walks it agree",
    );
    assert.deepEqual(h.log.states, [
      "connecting",
      "connected",
      // goAway: our own teardown, then the resume.
      "reconnecting",
      "resuming",
      "connected",
      // the unannounced drop, and its backoff resume.
      "reconnecting",
      "resuming",
      "connected",
      "closed",
    ]);
  });
});

/**
 * `goAway.timeLeft` is the trigger for a graceful reconnect, and it arrives in
 * more than one shape. Misreading it means either reconnecting instantly (losing
 * audio we did not have to lose) or too late (being cut off mid-sentence), so
 * the parser is worth pinning down.
 */
describe("goAway timeLeft parsing", () => {
  it("reads the protobuf duration string", () => {
    assert.equal(parseDurationMs("9.5s"), 9500);
    assert.equal(parseDurationMs("30s"), 30000);
  });

  it("reads a plain number as seconds", () => {
    assert.equal(parseDurationMs(4), 4000);
  });

  it("reads the structured {seconds, nanos} form", () => {
    assert.equal(parseDurationMs({ seconds: 2, nanos: 500_000_000 }), 2500);
    assert.equal(parseDurationMs({ seconds: "7" }), 7000);
  });

  it("returns null for anything unrecognised, so the caller reconnects at once", () => {
    assert.equal(parseDurationMs(undefined), null);
    assert.equal(parseDurationMs(null), null);
    assert.equal(parseDurationMs("bientôt"), null);
  });
});
