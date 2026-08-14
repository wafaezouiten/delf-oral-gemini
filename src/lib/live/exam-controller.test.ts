import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PhaseRecording, RecordedPhase } from "@/lib/audio/archive";
import { PHASE_DURATIONS, MONOLOGUE_MIN_SECONDS } from "@/lib/delf/phases";
import type { OralTopic } from "@/lib/delf/topics";
import type { SessionManagerCallbacks } from "./session-manager";
import {
  ExamController,
  type ExamFinishedPayload,
  type LiveSessionLike,
  type PlayerLike,
  type RecorderLike,
} from "./exam-controller";

/**
 * The §17 acceptance test.
 *
 * Runs the whole DELF B2 exam — preparation, monologue, débat, a forced
 * reconnect mid-débat, and the finish — against fake Gemini/audio and a fake
 * clock. Real time would make this a 20-minute test nobody runs; here it takes
 * milliseconds, which means the reconnect path is actually exercised on every
 * commit rather than hoped about.
 *
 * What it is really asserting is the lifetime layering: a reconnect must not
 * touch the transcript, the phase, or the phase clock.
 */

const TOPIC: OralTopic = {
  slug: "teletravail",
  title: "Le télétravail a-t-il vraiment amélioré nos vies ?",
  document: "Document de test.",
  consigne: "Consigne de test.",
};

/** A recording Gemini session that never touches the network. */
class FakeSession implements LiveSessionLike {
  connects = 0;
  reconnects = 0;
  closed = false;
  directives: string[] = [];
  activityStarts = 0;
  activityEnds = 0;
  audioChunks = 0;

  constructor(
    readonly phase: "monologue" | "debate",
    readonly callbacks: SessionManagerCallbacks,
    readonly history: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>,
  ) {}

  async connect(): Promise<void> {
    this.connects += 1;
    this.callbacks.onStateChange("connected");
  }

  close(): void {
    this.closed = true;
  }

  /** Mirrors the real manager: a reconnect reports `reconnecting`, then
   *  `resuming` once it has a handle, then `connected` — and never touches
   *  anything above the session. */
  async reconnect(): Promise<void> {
    this.reconnects += 1;
    this.callbacks.onStateChange("reconnecting");
    this.callbacks.onStateChange("resuming");
    this.callbacks.onStateChange("connected");
  }

  sendAudio(): void {
    this.audioChunks += 1;
  }

  sendDirective(text: string): void {
    this.directives.push(text);
  }

  beginCandidateActivity(): void {
    this.activityStarts += 1;
  }

  endCandidateActivity(): void {
    this.activityEnds += 1;
  }

  /** Drive an arbitrary connection-state sequence, as the real manager can —
   *  including a backoff that needed several attempts. */
  emitStates(...states: Array<Parameters<SessionManagerCallbacks["onStateChange"]>[0]>): void {
    for (const state of states) this.callbacks.onStateChange(state);
  }

  /** Test helpers: pretend the examiner spoke / the candidate was transcribed. */
  candidateSays(text: string): void {
    this.callbacks.onCandidateTranscript(text);
  }

  examinerSays(text: string): void {
    this.callbacks.onExaminerTranscript(text);
  }

  finishTurn(): void {
    this.callbacks.onTurnComplete();
  }
}

/**
 * A device that can be made slow or made to fail.
 *
 * The gate is what makes the teardown races reachable: a real microphone
 * resolves whenever the candidate gets round to clicking the permission prompt,
 * and everything interesting happens to a controller inside that window.
 */
interface DeviceOptions {
  gate?: Promise<void>;
  fail?: Error;
}

/**
 * A microphone with a ledger instead of a device.
 *
 * `capture()` is the audio thread: it adds seconds to whichever phase is open,
 * which is what lets the tests drive the two things the controller now watches —
 * how much audio a phase produced, and whether that number is still moving.
 */
class FakeRecorder implements RecorderLike {
  started = false;
  stopped = false;
  discarded = false;
  /** Every `beginPhase` / `endPhase`, in order, as a readable trace. */
  calls: string[] = [];
  recordedSeconds = 0;

  private openPhase: RecordedPhase | null = null;
  private readonly seconds: Record<RecordedPhase, number> = { monologue: 0, debate: 0 };

  constructor(private readonly options: DeviceOptions = {}) {}

  async start(): Promise<void> {
    if (this.options.gate) await this.options.gate;
    if (this.options.fail) throw this.options.fail;
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.openPhase = null;
  }

  beginPhase(phase: RecordedPhase): void {
    this.calls.push(phase);
    this.openPhase = phase;
  }

  endPhase(): void {
    if (this.openPhase) this.calls.push(`end:${this.openPhase}`);
    this.openPhase = null;
  }

  measuredSeconds(phase: RecordedPhase): number {
    return this.seconds[phase];
  }

  recordings(): PhaseRecording[] {
    return (["monologue", "debate"] as const)
      .filter((phase) => this.seconds[phase] > 0)
      .map((phase) => ({
        phase,
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
        durationSeconds: this.seconds[phase],
        sampleCount: this.seconds[phase] * 16000,
        byteSize: 3,
      }));
  }

  discard(): void {
    this.discarded = true;
  }

  /** The audio thread delivering `seconds` of audio for the open phase. */
  capture(seconds: number): void {
    if (!this.openPhase) return;
    this.seconds[this.openPhase] += seconds;
    this.recordedSeconds += seconds;
  }
}

class FakePlayer implements PlayerLike {
  resumed = false;
  closed = false;
  interrupts = 0;
  constructor(private readonly options: DeviceOptions = {}) {}
  async resume(): Promise<void> {
    if (this.options.gate) await this.options.gate;
    if (this.options.fail) throw this.options.fail;
    this.resumed = true;
  }
  enqueue(): void {}
  interrupt(): void {
    this.interrupts += 1;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Harness {
  controller: ExamController;
  sessions: FakeSession[];
  /** The first microphone opened — the only one a healthy exam opens. */
  recorder: FakeRecorder;
  recorders: FakeRecorder[];
  players: FakePlayer[];
  finished: ExamFinishedPayload[];
  /** Time passes AND the microphone delivers, which is what a healthy exam
   *  looks like. */
  advanceClock: (seconds: number) => void;
  /** Time passes and no audio arrives: a suspended audio graph, a device the OS
   *  took away. The page looks identical, which is the problem. */
  advanceClockSilently: (seconds: number) => void;
  /** The device ends its track under us. */
  loseMicrophone: (reason?: string) => void;
  session: () => FakeSession;
  /** The phase report for one phase of the finished payload. */
  report: (phase: RecordedPhase) => ExamFinishedPayload["phases"][number] | undefined;
}

function harness(devices: { recorder?: DeviceOptions; player?: DeviceOptions } = {}): Harness {
  let now = 0;
  const sessions: FakeSession[] = [];
  // Built per call rather than shared, so "how many devices did this open?" is
  // a question the harness can answer.
  const recorders: FakeRecorder[] = [];
  const players: FakePlayer[] = [];
  const finished: ExamFinishedPayload[] = [];
  let notifyLost: ((reason: string) => void) | null = null;

  const controller = new ExamController({
    topic: TOPIC,
    createSession: (phase, _topic, callbacks, history) => {
      const session = new FakeSession(phase, callbacks, history);
      sessions.push(session);
      return session;
    },
    createRecorder: (callbacks) => {
      notifyLost = callbacks.onLost;
      const recorder = new FakeRecorder(devices.recorder);
      recorders.push(recorder);
      return recorder;
    },
    createPlayer: () => {
      const player = new FakePlayer(devices.player);
      players.push(player);
      return player;
    },
    onFinished: (payload) => finished.push(payload),
    now: () => now,
    autoTick: false,
  });

  return {
    controller,
    sessions,
    get recorder() {
      return recorders[0];
    },
    recorders,
    players,
    finished,
    advanceClock: (seconds: number) => {
      now += seconds * 1000;
      for (const recorder of recorders) recorder.capture(seconds);
      controller.tick();
    },
    advanceClockSilently: (seconds: number) => {
      now += seconds * 1000;
      controller.tick();
    },
    loseMicrophone: (reason = "the audio track ended") => notifyLost?.(reason),
    session: () => sessions[sessions.length - 1],
    report: (phase: RecordedPhase) =>
      finished[0]?.phases.find((entry) => entry.phase === phase),
  };
}

/** Drive the closing handshake the way the real examiner does: it speaks, then
 *  its turn completes, which is what releases the phase. */
async function completeClosing(h: Harness): Promise<void> {
  h.session().finishTurn();
  // Let the controller's async advance settle.
  await new Promise((resolve) => setImmediate(resolve));
}

describe("full DELF B2 exam, with a forced reconnect mid-debate", () => {
  it("runs preparation to finished, surviving a reconnect without losing anything", async (t) => {
    const h = harness();

    // 1. The candidate enters preparation.
    h.controller.start();
    assert.equal(h.controller.getSnapshot().phase, "preparation");
    assert.equal(h.sessions.length, 0, "no Gemini session during preparation");

    // 2. Preparation ends (early, as a candidate who has finished their notes may).
    h.advanceClock(120);
    await h.controller.advanceEarly();
    await new Promise((resolve) => setImmediate(resolve));

    // 3. The monologue begins, with its own session.
    assert.equal(h.controller.getSnapshot().phase, "monologue");
    assert.equal(h.sessions.length, 1);
    assert.equal(h.session().phase, "monologue");
    assert.equal(h.recorder.started, true, "microphone opened at the monologue boundary");

    // 4. The examiner hands over the floor and opens the candidate's activity.
    assert.equal(h.session().directives.length, 1);
    assert.equal(h.session().activityStarts, 1);

    // 5. The candidate speaks for six minutes. The examiner must NOT be able to
    //    interrupt: with manual VAD, that means no activityEnd is sent while the
    //    monologue is running.
    h.session().candidateSays("Le télétravail a transformé le rapport au bureau.");
    h.advanceClock(200);
    h.session().candidateSays("Premièrement, il supprime des trajets subis.");
    h.advanceClock(160);
    h.session().candidateSays("Mais il isole les plus jeunes salariés.");

    assert.equal(
      h.session().activityEnds,
      0,
      "the examiner had no turn boundary during the monologue, so it cannot interrupt",
    );

    const elapsedInMonologue = h.controller.getSnapshot().elapsed;
    assert.ok(elapsedInMonologue >= MONOLOGUE_MIN_SECONDS, "past the five-minute DELF floor");
    assert.equal(h.controller.getSnapshot().canAdvance, true);

    // 6. The monologue ends via the closing handshake.
    const monologueSession = h.session();
    await h.controller.advanceEarly();
    assert.equal(h.controller.getSnapshot().closing, true, "waiting for the closing line");
    assert.equal(monologueSession.activityEnds, 1, "the floor is released only at the end");
    await completeClosing(h);

    // Exactly once, across the closing handshake AND the phase transition.
    // `activityEnd` is what makes Gemini emit the monologue's transcription
    // (verified live: nothing is transcribed until the floor is released), so a
    // second one is a spurious empty turn boundary rather than a no-op.
    assert.equal(
      monologueSession.activityEnds,
      1,
      "activityEnd is sent once, not again by the phase transition",
    );

    // 7-8. The débat starts on a NEW session, seeded with the monologue so the
    //      examiner can quote the candidate back at them.
    assert.equal(h.controller.getSnapshot().phase, "debate");
    assert.equal(h.sessions.length, 2);
    assert.equal(h.session().phase, "debate");
    assert.equal(monologueSession.closed, true, "the monologue session was torn down");

    const seeded = h.session().history;
    assert.equal(seeded.length, 2, "the débat session was seeded with the monologue");
    assert.ok(
      seeded[0].parts[0].text.includes("Le télétravail a transformé le rapport au bureau."),
      "the seeded history carries what the candidate actually said",
    );

    // 9. Candidate and examiner interact.
    h.session().examinerSays("Vous dites que le télétravail supprime des trajets subis.");
    h.session().candidateSays("Oui, et cela libère du temps personnel.");
    h.advanceClock(180);

    const beforeReconnect = {
      transcriptLength: h.controller.getSnapshot().transcript.length,
      elapsed: h.controller.getSnapshot().elapsed,
      phase: h.controller.getSnapshot().phase,
    };

    // 10-11. A reconnect is forced mid-débat, exactly as a GoAway would.
    await h.controller.forceReconnect();
    const after = h.controller.getSnapshot();

    assert.equal(after.reconnectCount, 1, "the reconnect was recorded");
    assert.equal(after.connection, "connected", "the exam is live again");

    // 12. The examiner still remembers: the same session object was resumed
    //     rather than replaced, so its seeded history and handle are intact.
    assert.equal(h.sessions.length, 2, "resumed in place, not restarted as a new exam");
    assert.equal(h.session().reconnects, 1);

    // 13. The transcript is continuous — nothing was dropped or duplicated.
    assert.equal(after.transcript.length, beforeReconnect.transcriptLength);

    // 14. The débat clock did not reset.
    assert.equal(after.elapsed, beforeReconnect.elapsed);
    assert.equal(after.phase, beforeReconnect.phase);

    // Speech after the reconnect appends to the SAME transcript.
    h.session().candidateSays("Je maintiens ma position, avec un exemple nouveau.");
    assert.ok(
      h.controller.getSnapshot().transcript.length >= beforeReconnect.transcriptLength,
      "post-reconnect speech lands in the same transcript",
    );

    // 15. The débat runs to its target duration and closes itself.
    h.advanceClock(PHASE_DURATIONS.debate);
    assert.equal(h.controller.getSnapshot().closing, true, "time-up opened the closing handshake");
    await completeClosing(h);

    // 16. The exam finishes correctly.
    assert.equal(h.controller.getSnapshot().phase, "finished");
    assert.equal(h.finished.length, 1, "finished exactly once");
    assert.equal(h.recorder.stopped, true, "the microphone was released");

    const payload = h.finished[0];
    assert.equal(payload.reconnectCount, 1);

    // One artefact per task, both with audio in them. The reconnect at step 10
    // happened inside the débat and left no hole: the recording is independent
    // of the socket, and this is where that is asserted end to end.
    assert.deepEqual(
      payload.recordings.map((recording) => recording.phase),
      ["monologue", "debate"],
    );
    assert.deepEqual(
      h.recorder.calls,
      ["monologue", "end:monologue", "debate", "end:debate"],
      "each phase opened and closed its own recording, in order",
    );

    const monologue = h.report("monologue");
    const debate = h.report("debate");
    assert.ok(monologue && debate);
    assert.ok(monologue.recordedSeconds >= MONOLOGUE_MIN_SECONDS);
    assert.ok(debate.recordedSeconds > 0);
    assert.equal(monologue.startedAt !== null && monologue.endedAt !== null, true);
    assert.ok(
      debate.startedAt !== null && monologue.endedAt !== null && debate.startedAt >= monologue.endedAt,
      "the débat starts where the monologue stopped",
    );

    // The final transcript keeps both tasks, distinctly.
    const phases = new Set(payload.transcript.map((entry) => entry.phase));
    assert.deepEqual([...phases].sort(), ["debate", "monologue"]);

    t.diagnostic(
      `monologue ${monologue.recordedSeconds}s · débat ${debate.recordedSeconds}s · ` +
        `${payload.transcript.length} tours · ${payload.reconnectCount} reconnexion`,
    );
  });

  it("does not open a Gemini session during preparation", () => {
    const h = harness();
    h.controller.start();
    h.advanceClock(PHASE_DURATIONS.preparation - 10);
    assert.equal(h.sessions.length, 0);
  });

  it("keeps the monologue closed to early exit before the five-minute floor", async () => {
    const h = harness();
    h.controller.start();
    await h.controller.advanceEarly();
    await new Promise((resolve) => setImmediate(resolve));

    h.advanceClock(MONOLOGUE_MIN_SECONDS - 30);
    assert.equal(h.controller.getSnapshot().canAdvance, false);

    await h.controller.advanceEarly();
    assert.equal(h.controller.getSnapshot().phase, "monologue", "still in the monologue");
  });

  it("keeps the timer as the sole authority on when a phase ends", async () => {
    // The requirement in one test: Gemini must not decide the exam's structure.
    // The examiner finishes turns constantly during a débat — every objection is
    // one — and none of them may end the phase. Only the clock (or the
    // candidate) opens a closing handshake, and only inside that window does the
    // model's turn ending mean anything.
    const h = harness();
    h.controller.start();
    await h.controller.advanceEarly();
    await new Promise((resolve) => setImmediate(resolve));

    h.advanceClock(60);
    for (let i = 0; i < 5; i += 1) {
      h.session().finishTurn();
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(h.controller.getSnapshot().phase, "monologue", "five turns did not end anything");
    assert.equal(h.controller.getSnapshot().closing, false);
    assert.equal(h.sessions.length, 1, "and no débat session was opened behind the clock's back");
  });

  it("reports one flattened status, and calls a reconnect a continuation", async () => {
    const h = harness();
    h.controller.start();
    assert.equal(h.controller.getSnapshot().status, "preparation");

    await h.controller.advanceEarly();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.controller.getSnapshot().status, "monologue");

    // Mid-reconnect the phase is still the monologue underneath, and the clock
    // never stopped — but what the candidate is told is that the exam continues.
    const seen: string[] = [];
    const unsubscribe = h.controller.subscribe(() => {
      seen.push(h.controller.getSnapshot().status);
    });
    await h.controller.forceReconnect();
    unsubscribe();

    assert.ok(seen.includes("reconnecting"));
    assert.ok(seen.includes("resuming"), "the resume is distinguishable from a bare reconnect");
    assert.equal(h.controller.getSnapshot().status, "monologue", "and it lands back in the phase");
    assert.equal(h.controller.getSnapshot().reconnectCount, 1, "counted once, not twice");
  });

  it("ignores a second recovery request while one is already running", async () => {
    // The candidate's "reprendre la connexion" is a real button and gets
    // double-clicked. The session's generation guard means that cannot open two
    // sockets, but every press still mints and discards an ephemeral token.
    const h = harness();
    h.controller.start();
    await h.controller.advanceEarly();
    await new Promise((resolve) => setImmediate(resolve));

    h.session().emitStates("reconnecting");
    await h.controller.forceReconnect();

    assert.equal(h.session().reconnects, 0, "the recovery in flight was left to finish");
    assert.ok(
      h.controller.getSnapshot().events.some((event) => event.detail === "already recovering"),
    );
  });

  it("counts one reconnection per outage, not one per attempt inside it", async () => {
    // The number is persisted on the sitting as a reliability signal. A backoff
    // sequence re-enters `reconnecting` once per failed attempt, so counting
    // every entry reported three reconnections for one flaky ten-second
    // episode — and a signal that cannot tell one bad minute from three
    // separate ones is not a signal.
    const h = harness();
    h.controller.start();
    await h.controller.advanceEarly();
    await new Promise((resolve) => setImmediate(resolve));

    // One outage that took three attempts to come back from.
    h.session().emitStates(
      "reconnecting",
      "resuming",
      "reconnecting",
      "resuming",
      "reconnecting",
      "resuming",
      "connected",
    );
    assert.equal(h.controller.getSnapshot().reconnectCount, 1);

    // A second, genuinely separate outage.
    h.session().emitStates("reconnecting", "resuming", "connected");
    assert.equal(h.controller.getSnapshot().reconnectCount, 2);
  });

  it("advances anyway when the examiner never delivers its closing line", async () => {
    const h = harness();
    h.controller.start();
    await h.controller.advanceEarly();
    await new Promise((resolve) => setImmediate(resolve));
    h.advanceClock(MONOLOGUE_MIN_SECONDS);

    await h.controller.advanceEarly();
    assert.equal(h.controller.getSnapshot().closing, true);

    // The safety timeout is the guard against a silent examiner freezing the
    // exam. Driven off the injected clock like every other deadline here, so
    // reaching it costs a tick rather than a real twelve seconds.
    h.advanceClock(11);
    assert.equal(h.controller.getSnapshot().phase, "monologue", "not yet");

    h.advanceClock(2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.controller.getSnapshot().phase, "debate");
  });
});

/**
 * Opening the two devices, and the ways that goes wrong.
 *
 * `prepareAudio()` runs at the monologue boundary precisely so the permission
 * prompt appears when the candidate is about to speak — which means the exam's
 * most ordinary interactions (pressing the button again, closing the tab,
 * denying the microphone) all land INSIDE the window where the devices are
 * half-open. `MicRecorder` and `ExaminerAudioPlayer` each guard their own half
 * of that; these are the same races one layer up, where only the controller can
 * see them.
 */
describe("opening the microphone and the speaker", () => {
  it("opens one pair of devices however many times the button is pressed", async () => {
    const gate = deferred();
    const h = harness({ recorder: { gate: gate.promise } });
    h.controller.start();

    const attempts = [
      h.controller.prepareAudio(),
      h.controller.prepareAudio(),
      h.controller.prepareAudio(),
    ];
    gate.resolve();
    const results = await Promise.all(attempts);

    assert.deepEqual(results, [true, true, true]);
    assert.equal(h.recorders.length, 1, "a second microphone would never be released");
    assert.equal(h.players.length, 1, "nor a second AudioContext");
  });

  it("closes the speaker when the microphone is refused", async () => {
    // The common failure, and the asymmetric one: the microphone is the half
    // that needs permission, and it fails AFTER the speaker is already open.
    const h = harness({
      recorder: { fail: new DOMException("Permission denied", "NotAllowedError") },
    });
    h.controller.start();

    assert.equal(await h.controller.prepareAudio(), false);
    assert.equal(h.players[0].closed, true, "the speaker's context does not outlive the failure");
    assert.match(h.controller.getSnapshot().micError ?? "", /microphone a été refusé/);
  });

  it("does not open a second speaker when the candidate retries", async () => {
    const h = harness({ recorder: { fail: new Error("device busy") } });
    h.controller.start();

    await h.controller.prepareAudio();
    await h.controller.prepareAudio();

    assert.equal(h.players.length, 2, "a retry legitimately builds a new pair");
    assert.deepEqual(
      h.players.map((player) => player.closed),
      [true, true],
      "and every abandoned one is closed",
    );
  });

  it("releases devices that finish opening after the sitting ended", async () => {
    // The candidate closes the tab while the permission prompt is up. `destroy()`
    // runs, finds both fields still null — they are assigned only once BOTH
    // devices are open — and closes nothing. Without the check in `openAudio()`
    // the microphone and the AudioContext are then handed to a controller that
    // no longer exists, and nothing will ever stop them again.
    const gate = deferred();
    const h = harness({ recorder: { gate: gate.promise } });
    h.controller.start();

    const preparing = h.controller.prepareAudio();
    h.controller.destroy();
    gate.resolve();

    assert.equal(await preparing, false, "the audio never became this exam's");
    assert.equal(h.recorders[0].stopped, true, "the late microphone was released");
    assert.equal(h.players[0].closed, true, "and so was the late AudioContext");
    assert.ok(
      h.controller.getSnapshot().events.some((event) => event.name === "audio-discarded"),
      "and it is in the session log rather than silent",
    );
  });

  it("refuses to open anything once the exam has been torn down", async () => {
    const h = harness();
    h.controller.start();
    h.controller.destroy();

    assert.equal(await h.controller.prepareAudio(), false);
    assert.equal(h.recorders.length, 0);
    assert.equal(h.players.length, 0);
  });
});

/**
 * Recording the candidate.
 *
 * The controller's half of Phase 6: which phase is being recorded and when, what
 * the finished payload says about it, and the three ways a working microphone
 * stops being one mid-épreuve.
 */
describe("recording the candidate", () => {
  /** Preparation to the monologue, with the devices open. */
  async function intoMonologue(h: Harness): Promise<void> {
    h.controller.start();
    await h.controller.advanceEarly();
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("records nothing until the candidate has been asked", async () => {
    // Consent, as the candidate can check it: the indicator is dark for the whole
    // of preparation, and the microphone has not been touched.
    const h = harness();
    h.controller.start();
    h.advanceClock(600);

    assert.equal(h.controller.getSnapshot().recording, false);
    assert.equal(h.recorders.length, 0, "no permission prompt during preparation");

    await intoMonologue(h);
    assert.equal(h.controller.getSnapshot().recording, true);
    assert.deepEqual(h.recorder.calls, ["monologue"]);
  });

  it("opens the microphone even when preparation simply runs out", async () => {
    // The path that had no microphone at all. `advanceEarly()` opens the devices
    // itself, so pressing the button worked; a candidate who used their full
    // thirty minutes reached the monologue with nothing recording and nothing
    // saying why.
    const h = harness();
    h.controller.start();
    h.advanceClock(PHASE_DURATIONS.preparation);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(h.controller.getSnapshot().phase, "monologue");
    assert.equal(h.recorders.length, 1, "the microphone was asked for");
    assert.equal(h.recorder.started, true);
    assert.deepEqual(h.recorder.calls, ["monologue"]);
  });

  it("reports the measured duration and the clock as separate numbers", async () => {
    // The distinction the phase exists for. Here the monologue ran seven minutes
    // and recorded four of them, because the microphone stopped delivering
    // halfway through — and both facts reach the payload intact.
    const h = harness();
    await intoMonologue(h);
    h.advanceClock(240); // four minutes of audio
    h.advanceClockSilently(180); // three minutes of nothing

    assert.match(h.controller.getSnapshot().micError ?? "", /n'envoie plus de son/);

    await h.controller.advanceEarly();
    h.session().finishTurn();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(h.controller.getSnapshot().phase, "debate");
    assert.equal(
      h.controller.getSnapshot().micError,
      null,
      "and the monologue's stall warning did not follow the candidate into the débat",
    );

    h.advanceClock(PHASE_DURATIONS.debate);
    h.session().finishTurn();
    await new Promise((resolve) => setImmediate(resolve));

    const monologue = h.report("monologue");
    assert.ok(monologue);
    assert.equal(monologue.recordedSeconds, 240, "measured from the audio");
    assert.equal(monologue.elapsedSeconds, 420, "and the clock says otherwise, on the record");
  });

  it("hands over the artefacts and then releases their memory", async () => {
    const h = harness();
    await intoMonologue(h);
    h.advanceClock(PHASE_DURATIONS.monologue);
    h.session().finishTurn();
    await new Promise((resolve) => setImmediate(resolve));
    h.advanceClock(PHASE_DURATIONS.debate);
    h.session().finishTurn();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(h.finished.length, 1);
    assert.equal(h.finished[0].recordings.length, 2, "taken before the memory was released");
    assert.equal(h.recorder.discarded, true, "and released, since the blobs own their bytes now");
  });

  it("reports only the phases the candidate actually reached", async () => {
    // An abandoned sitting has a monologue and no débat, which is the truth about
    // it — better than a débat row claiming zero seconds of a task that never
    // happened.
    const h = harness();
    await intoMonologue(h);
    h.advanceClock(60);
    h.controller.destroy();

    assert.equal(h.finished.length, 0, "an abandoned sitting is not a finished one");
    assert.equal(h.recorder.stopped, true, "but the device is released either way");
  });

  it("tells the candidate when the microphone dies, and keeps what it recorded", async () => {
    const h = harness();
    await intoMonologue(h);
    h.advanceClock(120);

    h.loseMicrophone("the audio track ended");

    const state = h.controller.getSnapshot();
    assert.match(state.micError ?? "", /microphone s'est déconnecté/);
    assert.equal(state.recording, false, "and the indicator says so");
    assert.ok(state.events.some((event) => event.name === "microphone-lost"));

    // The exam is NOT ended: the examiner is still listening over the socket, and
    // two minutes of real audio have already been recorded.
    assert.equal(state.phase, "monologue");
    assert.equal(h.recorder.measuredSeconds("monologue"), 120);
  });

  it("reports a dead microphone once, not once per event", async () => {
    const h = harness();
    await intoMonologue(h);
    h.loseMicrophone();
    h.loseMicrophone();
    h.loseMicrophone();

    const losses = h.controller
      .getSnapshot()
      .events.filter((event) => event.name === "microphone-lost");
    assert.equal(losses.length, 1);
  });

  it("notices a recording that has quietly stopped growing", async () => {
    // The failure with no event to listen for: a backgrounded tab whose audio
    // graph the browser suspended. Blocks stop, `ended` never fires, the clock
    // runs on and the page looks exactly like a working one.
    const h = harness();
    await intoMonologue(h);
    h.advanceClock(60);
    assert.equal(h.controller.getSnapshot().micError, null);

    h.advanceClockSilently(3);
    assert.equal(h.controller.getSnapshot().micError, null, "not yet — three seconds is a pause");

    h.advanceClockSilently(3);
    assert.match(h.controller.getSnapshot().micError ?? "", /n'envoie plus de son/);
    assert.equal(
      h.controller.getSnapshot().recording,
      false,
      "and the indicator goes dark, because at this moment it is telling the truth",
    );
    assert.ok(
      h.controller.getSnapshot().events.some((event) => event.name === "capture-stalled"),
    );

    // And it clears itself when the tab comes back, rather than leaving a stale
    // warning over a working microphone for the rest of the épreuve.
    h.advanceClock(1);
    assert.equal(h.controller.getSnapshot().micError, null);
    assert.equal(h.controller.getSnapshot().recording, true);
    assert.ok(h.controller.getSnapshot().events.some((event) => event.name === "capture-resumed"));
  });

  it("does not call a phase transition a stalled microphone", async () => {
    // There is a real gap in the audio at every boundary: the monologue's
    // recording closes, a session is torn down and another is built. The
    // watchdog is re-armed per phase so that gap is not reported as a fault.
    const h = harness();
    await intoMonologue(h);
    h.advanceClock(PHASE_DURATIONS.monologue);
    h.session().finishTurn();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(h.controller.getSnapshot().phase, "debate");
    h.advanceClock(1);
    assert.equal(h.controller.getSnapshot().micError, null);
  });

  it("keeps recording through a reconnect", async () => {
    // The property the layering diagram promises: the socket is the shortest-
    // lived thing on the page and cannot take a hole out of the recording.
    const h = harness();
    await intoMonologue(h);
    h.advanceClock(60);
    await h.controller.forceReconnect();
    h.advanceClock(60);

    assert.deepEqual(h.recorder.calls, ["monologue"], "the recording was never closed");
    assert.equal(h.recorder.measuredSeconds("monologue"), 120);
    assert.equal(h.controller.getSnapshot().recording, true);
  });
});
