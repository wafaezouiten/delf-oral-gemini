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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.callbacks.onclose?.({ reason: "closed by client" });
  }

  /** The server pushes a message. */
  emit(message: LiveServerMessage): void {
    this.callbacks.onmessage(message);
  }

  /** The server hangs up without warning. */
  drop(reason = "1011 internal error"): void {
    if (this.closed) return;
    this.closed = true;
    this.callbacks.onclose?.({ reason });
  }

  /** Base64 audio chunks the candidate actually got to send. */
  get audioChunks(): string[] {
    return this.realtime
      .map((input) => input.audio?.data)
      .filter((data): data is string => typeof data === "string");
  }
}

class FakeTransport implements LiveTransport {
  tokenRequests: LiveTokenClientRequest[] = [];
  opens: Array<{ token: string; model: string; config: unknown }> = [];
  sockets: FakeSocket[] = [];
  /** Number of upcoming mints that should fail, simulating a token route outage. */
  failMints = 0;
  private minted = 0;

  async mintToken(request: LiveTokenClientRequest): Promise<string> {
    this.tokenRequests.push({ ...request });
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

  schedule(fn: () => void, ms: number): CancelTimer {
    const entry = { ms, fn, cancelled: false };
    this.scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    return Promise.resolve();
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
