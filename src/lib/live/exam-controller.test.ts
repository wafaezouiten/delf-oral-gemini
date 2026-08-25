import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AnnouncementOutcome, AnnouncerLike } from "@/lib/audio/announcer";
import type { PhaseRecording, RecordedPhase } from "@/lib/audio/archive";
import { ANNOUNCEMENTS } from "@/lib/delf/announcements";
import { countClosingTurns } from "@/lib/delf/early-closing";
import { PHASE_DURATIONS, MONOLOGUE_MIN_SECONDS } from "@/lib/delf/phases";
import type { OralTopic } from "@/lib/delf/topics";
import type { SessionManagerCallbacks } from "./session-manager";
import {
  ExamController,
  type ExamFinishedPayload,
  type FinalisedPhaseReport,
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
  open = false;
  directives: string[] = [];
  activityStarts = 0;
  activityEnds = 0;
  audioChunks = 0;
  /** Every control send in wire order (#135). The counters above cannot say
   *  whether the closing directive went out before or after the activityEnd
   *  that frees the model's floor, and that ordering is the fix. */
  wire: string[] = [];

  constructor(
    readonly phase: "monologue" | "debate",
    readonly callbacks: SessionManagerCallbacks,
    readonly history: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>,
  ) {}

  async connect(): Promise<void> {
    this.connects += 1;
    // Open on a later turn, never in the caller's — a real socket cannot do
    // otherwise, and everything said into that window is dropped by
    // `sendDirective` below rather than silently counted here.
    await Promise.resolve();
    this.open = true;
    this.callbacks.onStateChange("connected");
  }

  close(): void {
    this.closed = true;
    this.open = false;
  }

  /** Mirrors the real manager: a reconnect reports `reconnecting`, then
   *  `resuming` once it has a handle, then `connected` — and never touches
   *  anything above the session. */
  async reconnect(): Promise<void> {
    this.reconnects += 1;
    this.callbacks.onStateChange("reconnecting");
    this.callbacks.onStateChange("resuming");
    this.open = true;
    this.callbacks.onStateChange("connected");
  }

  sendAudio(): void {
    this.audioChunks += 1;
  }

  /** Mirrors the real manager: with no socket yet the text goes nowhere and
   *  nobody is told, so a directive only counts once `connect()` has resolved. */
  sendDirective(text: string): void {
    if (!this.open) return;
    this.directives.push(text);
    this.wire.push("directive");
  }

  beginCandidateActivity(): void {
    this.activityStarts += 1;
    this.wire.push("activity-start");
  }

  endCandidateActivity(): void {
    this.activityEnds += 1;
    this.wire.push("activity-end");
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

  /** The examiner's voice, which arrives on its own callback and reaches the
   *  speaker rather than the transcript. */
  examinerVoice(base64: string): void {
    this.callbacks.onExaminerAudio(base64);
  }

  /** Gemini reporting that somebody took the floor from the examiner. */
  interrupts(): void {
    this.callbacks.onInterrupted();
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

  /** Reachable, because "was the microphone actually off?" is the claim the
   *  development text mode makes and the thing worth asserting. */
  paused = false;

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

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  measuredSeconds(phase: RecordedPhase): number {
    return this.seconds[phase];
  }

  /** Voiced audio, defaulted to "all of it was speech" so every existing test
   *  keeps describing a candidate who spoke. Tests about silence set it. */
  voiced: Record<RecordedPhase, number | null> = { monologue: null, debate: null };

  voicedSeconds(phase: RecordedPhase): number {
    return this.voiced[phase] ?? this.seconds[phase];
  }

  /** Phases whose artefact was asked for on its own — the early encode the
   *  controller starts as the débat opens (#86). */
  prepared: RecordedPhase[] = [];

  async recordingFor(phase: RecordedPhase): Promise<PhaseRecording | null> {
    this.prepared.push(phase);
    return (await this.recordings()).find((recording) => recording.phase === phase) ?? null;
  }

  /** Asynchronous like the real one, which compresses on the way out. */
  async recordings(): Promise<PhaseRecording[]> {
    return (["monologue", "debate"] as const)
      .filter((phase) => this.seconds[phase] > 0)
      .map((phase) => ({
        phase,
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/ogg" }),
        mimeType: "audio/ogg",
        durationSeconds: this.seconds[phase],
        sampleCount: this.seconds[phase] * 16000,
        byteSize: 3,
      }));
  }

  /** Phases whose recording the controller decided against (#51), in order,
   *  and in `calls` so the ordering against `end` and the early encode is a
   *  readable trace. */
  droppedPhases: RecordedPhase[] = [];

  dropPhase(phase: RecordedPhase): void {
    this.calls.push(`drop:${phase}`);
    this.droppedPhases.push(phase);
    // As the real archive: the samples are gone, so the phase measures zero
    // and produces no artefact from here on.
    this.seconds[phase] = 0;
    this.voiced[phase] = 0;
  }

  discard(): void {
    this.discarded = true;
  }

  /** The audio thread delivering `seconds` of audio for the open phase. Drops
   *  it while paused, exactly as the real recorder's `consume` does — otherwise
   *  the harness would keep feeding a microphone the controller has turned off,
   *  and the tests about that would pass for the wrong reason. */
  capture(seconds: number): void {
    if (this.paused || !this.openPhase) return;
    this.seconds[this.openPhase] += seconds;
    this.recordedSeconds += seconds;
  }
}

/**
 * The examiner's consigne player, with a hold in it (#37).
 *
 * `hold` is what makes the ordering assertable. Everything #37 is about happens
 * *while* a consigne is playing — the clock that must not have started, the
 * artefact that must not be open, the session that must not be connected — and a
 * clip that resolves instantly leaves no window to look inside.
 */
class FakeAnnouncer implements AnnouncerLike {
  played: string[] = [];
  closed = false;
  stops = 0;
  /** What the next clip does. `hold` keeps playing until the test ends it. */
  behaviour: AnnouncementOutcome | "hold" = "played";
  private pending: ((outcome: AnnouncementOutcome) => void) | null = null;

  async play(src: string): Promise<AnnouncementOutcome> {
    this.played.push(src);
    if (this.behaviour !== "hold") return this.behaviour;
    return new Promise<AnnouncementOutcome>((resolve) => {
      this.pending = resolve;
    });
  }

  stop(): void {
    this.stops += 1;
    this.settle("skipped");
  }

  close(): void {
    this.closed = true;
    this.settle("skipped");
  }

  /** The clip reaches its end. */
  reachEnd(): void {
    this.settle("played");
  }

  /** Whether a clip is still playing, from the test's point of view. */
  get playing(): boolean {
    return this.pending !== null;
  }

  private settle(outcome: AnnouncementOutcome): void {
    const pending = this.pending;
    this.pending = null;
    pending?.(outcome);
  }
}

class FakePlayer implements PlayerLike {
  resumed = false;
  closed = false;
  interrupts = 0;
  /** The examiner's voice, as far as it has reached the speaker: what an
   *  interruption drops, and therefore what the candidate does not hear. */
  chunks: string[] = [];
  /** One chunk stands for one second. Derived rather than hardcoded so the
   *  figure the controller logs is a figure a test can hold it to. */
  get bufferedSeconds(): number {
    return this.chunks.length;
  }
  constructor(
    private readonly options: DeviceOptions = {},
    private readonly callbacks: { onSpeakingChange?: (speaking: boolean) => void } = {},
  ) {}
  resumes = 0;
  async resume(): Promise<void> {
    if (this.options.gate) await this.options.gate;
    if (this.options.fail) throw this.options.fail;
    this.resumed = true;
    this.resumes += 1;
  }
  enqueue(base64: string): void {
    this.chunks.push(base64);
  }
  /** Playback progressing: the real player's queue drains continuously while
   *  audio is actually reaching the speaker, and a test that leaves the queue
   *  frozen is describing a stalled one — see `examinerPlaybackHold`. */
  drain(n = 1): void {
    this.chunks.splice(0, n);
  }
  interrupt(): void {
    this.interrupts += 1;
    this.chunks = [];
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  /** The real player reports this from its own queue: audible while there is
   *  something scheduled, silent when it runs out. */
  speak(speaking: boolean): void {
    this.callbacks.onSpeakingChange?.(speaking);
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
  /** The examiner each session was created for (#99), in creation order. */
  sessionModels: Array<string | undefined>;
  /** The first microphone opened — the only one a healthy exam opens. */
  recorder: FakeRecorder;
  recorders: FakeRecorder[];
  players: FakePlayer[];
  finished: ExamFinishedPayload[];
  /** Phases reported mid-exam, in the order they finalised (Phase 8). */
  progress: FinalisedPhaseReport[];
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
  /** The consigne player, when the harness was asked for one. Null otherwise,
   *  which is what every test written before #37 runs against. */
  announcer: FakeAnnouncer | null;
}

function harness(
  devices: {
    recorder?: DeviceOptions;
    player?: DeviceOptions;
    /** Overrides the sink below, for the one test about a listener that fails. */
    onPhaseFinalised?: (report: FinalisedPhaseReport) => void;
    /**
     * Give the exam a voice (#37). Off by default, so the phase-machine tests run
     * against a controller with nothing to say — the same silence a browser that
     * cannot play the clips gets.
     */
    announcer?: FakeAnnouncer;
  } = {},
): Harness {
  let now = 0;
  const sessions: FakeSession[] = [];
  const sessionModels: Array<string | undefined> = [];
  // Built per call rather than shared, so "how many devices did this open?" is
  // a question the harness can answer.
  const recorders: FakeRecorder[] = [];
  const players: FakePlayer[] = [];
  const finished: ExamFinishedPayload[] = [];
  const progress: FinalisedPhaseReport[] = [];
  let notifyLost: ((reason: string) => void) | null = null;

  const controller = new ExamController({
    topic: TOPIC,
    createSession: (phase, _topic, callbacks, history, examinerModel) => {
      const session = new FakeSession(phase, callbacks, history);
      sessions.push(session);
      sessionModels.push(examinerModel);
      return session;
    },
    createRecorder: (callbacks) => {
      notifyLost = callbacks.onLost;
      const recorder = new FakeRecorder(devices.recorder);
      recorders.push(recorder);
      return recorder;
    },
    createPlayer: (callbacks) => {
      const player = new FakePlayer(devices.player, callbacks);
      players.push(player);
      return player;
    },
    createAnnouncer: devices.announcer ? () => devices.announcer! : undefined,
    onFinished: (payload) => finished.push(payload),
    onPhaseFinalised: devices.onPhaseFinalised ?? ((report) => progress.push(report)),
    now: () => now,
    autoTick: false,
  });

  return {
    controller,
    announcer: devices.announcer ?? null,
    sessions,
    sessionModels,
    get recorder() {
      return recorders[0];
    },
    recorders,
    players,
    finished,
    progress,
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
    report: (phase: RecordedPhase) => finished[0]?.phases.find((entry) => entry.phase === phase),
  };
}

/** Drive the closing handshake the way the real examiner does: it speaks, then
 *  its turn completes, which is what releases the phase. */
/**
 * The candidate presses « Enregistrer » on the part that has just opened.
 *
 * A part opens ARMED — the sujet and the plan on screen, the timer at its full
 * length, nothing captured — and starts on this click. `startSpeaking` guards its
 * own phase, so this is a no-op anywhere else and is safe to call after any
 * advance.
 */
async function pressRecord(h: Harness): Promise<void> {
  h.controller.startSpeaking();
  await new Promise((resolve) => setImmediate(resolve));
}

async function completeClosing(h: Harness): Promise<void> {
  h.session().finishTurn();
  // Let the controller's async advance settle.
  await new Promise((resolve) => setImmediate(resolve));
  // Whatever part that landed in opens armed, so this is the candidate pressing
  // « Enregistrer » on it. A no-op on the way into `finished`, which is not a
  // part anybody starts — `startSpeaking` guards its own phase.
  h.controller.startSpeaking();
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
    await pressRecord(h);

    // 3. The monologue begins, with its own session.
    assert.equal(h.controller.getSnapshot().phase, "monologue");
    assert.equal(h.sessions.length, 1);
    assert.equal(h.session().phase, "monologue");
    assert.equal(h.recorder.started, true, "microphone opened at the monologue boundary");

    // 4. The candidate's activity is opened, and the examiner says nothing.
    //    The handover it used to speak here is now a recorded consigne played
    //    before this session exists (#37); this harness has no voice, so the
    //    monologue opens in silence.
    assert.deepEqual(h.session().directives, []);
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
    assert.notEqual(monologue.endedAt, null, "a phase that was left has an end stamp");
    assert.ok(
      monologue.endedAt !== null && debate.startedAt >= monologue.endedAt,
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

  it("lands a double-click on « Commencer » in the monologue, not the débat", async () => {
    // Both presses pass `advanceEarly()`'s guard while the phase is still the
    // préparation, and both sit on the same `prepareAudio()` promise — so the
    // second used to advance the monologue the first had just opened, and the
    // candidate arrived at the débat without ever being offered the exposé
    // (#104).
    const h = harness();
    h.controller.start();

    const first = h.controller.advanceEarly();
    const second = h.controller.advanceEarly();
    await Promise.all([first, second]);

    assert.equal(h.controller.getSnapshot().phase, "monologue");
    assert.equal(h.controller.getSnapshot().awaitingStart, true, "armed, waiting for the press");
    assert.ok(
      !h.controller.getSnapshot().events.some((event) => event.detail === "monologue -> debate"),
      "the second press did not end the part the first had opened",
    );
  });

  it("keeps the monologue closed to early exit before the five-minute floor", async () => {
    const h = harness();
    h.controller.start();
    await h.controller.advanceEarly();
    await pressRecord(h);

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
    await pressRecord(h);

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
    await pressRecord(h);
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
    await pressRecord(h);

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
    await pressRecord(h);

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
    await pressRecord(h);
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

  it("keeps the speaker when the microphone is refused", async () => {
    // The common failure, and the asymmetric one: the microphone is the half
    // that needs permission, and it fails AFTER the speaker is already open.
    // Closing the speaker with it was how a sitting reached the débat with a
    // working socket, a streaming transcript and no examiner's voice (#74).
    const h = harness({
      recorder: { fail: new DOMException("Permission denied", "NotAllowedError") },
    });
    h.controller.start();

    assert.equal(await h.controller.prepareAudio(), false, "the épreuve is not recorded");
    assert.equal(h.players[0].closed, false, "but the examiner still has a voice");
    assert.match(h.controller.getSnapshot().micError ?? "", /microphone a été refusé/);
  });

  it("does not open a second speaker when the candidate retries", async () => {
    const h = harness({ recorder: { fail: new Error("device busy") } });
    h.controller.start();

    await h.controller.prepareAudio();
    await h.controller.prepareAudio();

    assert.equal(h.players.length, 1, "the open speaker is reused, never rebuilt beside itself");
    assert.equal(h.players[0].closed, false);
    assert.equal(h.recorders.length, 2, "and the microphone is the half that is retried");
  });

  it("releases a microphone that finishes opening after the sitting ended", async () => {
    // The candidate closes the tab while the permission prompt is up. `destroy()`
    // runs, finds the field still null — the device is installed only once it
    // has started — and closes nothing. Without the check in `openAudio()` the
    // microphone is then handed to a controller that no longer exists, and
    // nothing will ever stop it again.
    //
    // The tick before `destroy()` is what puts the sitting in that window: the
    // speaker opens first and on its own now (#74), so without it the teardown
    // lands while the SPEAKER is opening and no microphone is ever asked for,
    // which is the case below.
    const gate = deferred();
    const h = harness({ recorder: { gate: gate.promise } });
    h.controller.start();

    const preparing = h.controller.prepareAudio();
    await new Promise((resolve) => setImmediate(resolve));
    h.controller.destroy();
    gate.resolve();

    assert.equal(await preparing, false, "the audio never became this exam's");
    assert.equal(h.recorders[0].stopped, true, "the late microphone was released");
    assert.equal(h.players[0].closed, true, "and the speaker went with the sitting");
    assert.ok(
      h.controller.getSnapshot().events.some((event) => event.name === "audio-discarded"),
      "and it is in the session log rather than silent",
    );
  });

  it("asks for no microphone when the sitting ends while the speaker is opening", async () => {
    const gate = deferred();
    const h = harness({ player: { gate: gate.promise } });
    h.controller.start();

    const preparing = h.controller.prepareAudio();
    h.controller.destroy();
    gate.resolve();

    assert.equal(await preparing, false);
    assert.equal(h.players[0].closed, true, "the late AudioContext was released");
    assert.equal(h.recorders.length, 0, "and a sitting that has ended asks for no permission");
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
    await pressRecord(h);
    // The part opens ARMED: the sujet and the plan are on screen and no clock is
    // running until the candidate presses « Enregistrer ». This is that press.
    h.controller.startSpeaking();
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
    // Asked for on the way in, so the permission prompt is answered before the
    // candidate presses « Enregistrer » rather than in the second they start
    // speaking. The artefact still waits for the press.
    assert.equal(h.controller.getSnapshot().awaitingStart, true);
    assert.deepEqual(h.recorder.calls, []);

    await pressRecord(h);
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
    await pressRecord(h);

    assert.equal(h.controller.getSnapshot().phase, "debate");
    assert.equal(
      h.controller.getSnapshot().micError,
      null,
      "and the monologue's stall warning did not follow the candidate into the débat",
    );

    h.advanceClock(PHASE_DURATIONS.debate);
    h.session().finishTurn();
    await pressRecord(h);

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
    await pressRecord(h);
    h.advanceClock(PHASE_DURATIONS.debate);
    h.session().finishTurn();
    await pressRecord(h);

    assert.equal(h.finished.length, 1);
    assert.equal(h.finished[0].recordings.length, 2, "taken before the memory was released");
    assert.equal(h.recorder.discarded, true, "and released, since the blobs own their bytes now");
  });

  it("asks for the monologue's artefact as the débat opens, not at the finish (#86)", async () => {
    // The samples are final once the phase closes, and the candidate is about to
    // spend thirteen minutes debating — which is when a compression cannot be
    // perceived. The archive memoizes what this produces, so the finish reuses
    // it instead of holding « Épreuve terminée » behind the codec.
    const h = harness();
    await intoMonologue(h);
    h.advanceClock(240);
    await h.controller.advanceEarly();
    h.session().finishTurn();
    await pressRecord(h);

    assert.equal(h.controller.getSnapshot().phase, "debate");
    assert.deepEqual(h.recorder.prepared, ["monologue"], "asked for as the débat opened");
    assert.equal(h.finished.length, 0, "long before the sitting is handed over");
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
    assert.ok(h.controller.getSnapshot().events.some((event) => event.name === "capture-stalled"));

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
    await pressRecord(h);

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

  describe("a silent monologue", () => {
    it("is flagged when the microphone recorded and carried no speech", async () => {
      const h = harness();
      await intoMonologue(h);
      // Set before the clock: `advanceClock` is what feeds the recorder and
      // rebuilds the snapshot, and `getSnapshot` returns the cached one.
      h.recorder.voiced.monologue = 0;
      h.advanceClock(120);

      assert.equal(h.recorder.measuredSeconds("monologue"), 120, "the mic worked");
      assert.equal(h.controller.getSnapshot().monologueSilent, true);
    });

    it("is not flagged once enough speech was carried", async () => {
      const h = harness();
      await intoMonologue(h);
      h.recorder.voiced.monologue = 45;
      h.advanceClock(120);

      assert.equal(h.controller.getSnapshot().monologueSilent, false);
    });

    it("is not flagged when the microphone captured nothing at all", async () => {
      // A dead microphone is not a silent candidate. Someone whose capture
      // failed while they spoke for six minutes must never be told they said
      // nothing — that is the "corrigé sans l'audio" path.
      const h = harness();
      await intoMonologue(h);
      h.advanceClockSilently(120);

      assert.equal(h.recorder.measuredSeconds("monologue"), 0, "nothing was captured");
      assert.equal(h.controller.getSnapshot().monologueSilent, false);
    });

    it("refuses the advance and stops the clock", async () => {
      const h = harness();
      await intoMonologue(h);
      h.recorder.voiced.monologue = 0;
      h.advanceClock(120);

      await h.controller.advanceEarly();

      const state = h.controller.getSnapshot();
      assert.equal(state.monologueHeld, true);
      assert.equal(state.phase, "monologue", "the phase did not move");
      assert.equal(state.closing, false, "and the examiner was not asked to wrap up");
      assert.equal(state.elapsed, 120);

      // The clock is stopped, not merely paused for a tick.
      h.advanceClock(45);
      assert.equal(h.controller.getSnapshot().elapsed, 120, "the clock stood still");
    });

    it("does not let the monologue's own time-up carry a silent candidate on", async () => {
      // The path the screen cannot see: nobody pressed anything, the clock
      // simply ran out. It used to hand the candidate to the débat regardless.
      const h = harness();
      await intoMonologue(h);
      h.recorder.voiced.monologue = 0;
      h.advanceClock(PHASE_DURATIONS.monologue + 5);

      const state = h.controller.getSnapshot();
      assert.equal(state.monologueHeld, true);
      assert.equal(state.phase, "monologue");
      assert.equal(state.closing, false);
    });

    it("lets the time-up through as usual once the candidate has spoken", async () => {
      const h = harness();
      await intoMonologue(h);
      h.advanceClock(PHASE_DURATIONS.monologue + 5);

      const state = h.controller.getSnapshot();
      assert.equal(state.monologueHeld, false);
      assert.equal(state.closing, true, "the examiner was asked to wrap up");
    });

    it("never holds a dead microphone — that is not a silent candidate", async () => {
      // Someone whose capture failed while they spoke for six minutes must not
      // be held. They pass through and are graded on the audio-less path.
      const h = harness();
      await intoMonologue(h);
      h.advanceClockSilently(PHASE_DURATIONS.monologue + 5);

      const state = h.controller.getSnapshot();
      assert.equal(h.recorder.measuredSeconds("monologue"), 0, "nothing was captured");
      assert.equal(state.monologueHeld, false);
      assert.equal(state.closing, true, "and the épreuve moved on");
    });

    it("restarts the clock and releases the hold", async () => {
      const h = harness();
      await intoMonologue(h);
      h.recorder.voiced.monologue = 0;
      h.advanceClock(120);
      await h.controller.advanceEarly();
      assert.equal(h.controller.getSnapshot().monologueHeld, true);

      h.controller.restartMonologue();

      const state = h.controller.getSnapshot();
      assert.equal(state.monologueHeld, false, "the hold is released");
      assert.equal(state.elapsed, 0, "the clock is back to zero");
      assert.equal(state.canAdvance, false, "so the minimum applies again");

      // And it runs again, rather than staying frozen.
      h.advanceClock(30);
      assert.equal(h.controller.getSnapshot().elapsed, 30);
    });

    it("refuses to rewind once the closing handshake has begun", async () => {
      // The examiner has been asked to wrap up; rewinding the clock underneath
      // that would leave the two disagreeing about which phase is running.
      const h = harness();
      await intoMonologue(h);
      h.advanceClock(120);
      await h.controller.advanceEarly();
      assert.equal(h.controller.getSnapshot().closing, true);

      h.controller.restartMonologue();
      assert.equal(h.controller.getSnapshot().elapsed, 120, "the clock stood still");
    });
  });

  describe("the development text mode (#36)", () => {
    it("turns the microphone off, and says so rather than claiming a recording", async () => {
      const h = harness();
      await intoMonologue(h);
      h.advanceClock(30);
      assert.equal(h.recorder.measuredSeconds("monologue"), 30);

      h.controller.setDevTextMode(true);

      assert.equal(h.recorder.paused, true, "the microphone stopped");
      assert.equal(
        h.controller.getSnapshot().recording,
        false,
        "and the badge stopped saying it was recording",
      );
      assert.equal(h.controller.getSnapshot().devTextMode, true);

      // Nothing more reaches the artefact, so the phase is graded on the
      // seconds that were genuinely spoken.
      h.advanceClock(120);
      assert.equal(h.recorder.measuredSeconds("monologue"), 30, "no room tone was added");
    });

    it("keeps what was captured before it went on", async () => {
      // Pausing is not discarding. Thirty seconds spoken aloud belong to the
      // phase whatever happens next.
      const h = harness();
      await intoMonologue(h);
      h.advanceClock(30);
      h.controller.setDevTextMode(true);
      h.advanceClock(200);
      h.controller.setDevTextMode(false);

      assert.equal(h.recorder.paused, false, "the microphone came back");
      assert.equal(h.recorder.measuredSeconds("monologue"), 30);
      assert.equal(h.controller.getSnapshot().recording, true);
    });

    it("does not raise the stalled-capture notice while the mode is on", async () => {
      // The microphone is off because we turned it off. Reporting that as a
      // failing device teaches developers to ignore the notice that matters.
      const h = harness();
      await intoMonologue(h);
      h.advanceClock(30);
      h.controller.setDevTextMode(true);
      h.advanceClock(120);

      assert.equal(h.controller.getSnapshot().micError, null);
    });

    it("does not fire a stall the moment the microphone comes back", async () => {
      // The watchdog's bookkeeping is two minutes stale by then, and without
      // rewinding it the first tick after resuming looks like a dead device.
      const h = harness();
      await intoMonologue(h);
      h.advanceClock(30);
      h.controller.setDevTextMode(true);
      h.advanceClock(120);
      h.controller.setDevTextMode(false);
      h.advanceClock(1);

      assert.equal(h.controller.getSnapshot().micError, null);
    });

    it("does not hold the monologue for silence, and lets a typed one through", async () => {
      // The reason the mode has to cut the microphone at all. Room tone
      // captured before it went on is measured audio carrying no speech —
      // exactly what #39 holds the phase for — so without this exit the
      // developer is trapped at a monologue they have just typed in full.
      const h = harness();
      await intoMonologue(h);
      h.recorder.voiced.monologue = 0;
      h.advanceClock(30);
      assert.equal(h.controller.getSnapshot().monologueSilent, true, "as #39 sees it");

      h.controller.setDevTextMode(true);
      h.controller.injectCandidateSpeech("Le télétravail a transformé le rapport au bureau.");
      h.advanceClock(MONOLOGUE_MIN_SECONDS);

      assert.equal(h.controller.getSnapshot().monologueSilent, false);
      await h.controller.advanceEarly();

      const state = h.controller.getSnapshot();
      assert.equal(state.monologueHeld, false, "the phase was not held");
      assert.equal(state.closing, true, "the examiner was asked to wrap up");
    });

    it("holds a silent monologue again once the microphone is back", async () => {
      // The exit belongs to the mode, not to the sitting. Turning it off puts
      // #39 back exactly as it was.
      const h = harness();
      await intoMonologue(h);
      h.recorder.voiced.monologue = 0;
      h.controller.setDevTextMode(true);
      h.advanceClock(120);
      h.controller.setDevTextMode(false);
      h.advanceClock(30);

      assert.equal(h.controller.getSnapshot().monologueSilent, true);
      await h.controller.advanceEarly();
      assert.equal(h.controller.getSnapshot().monologueHeld, true);
    });

    it("is inert before the microphone exists, and applies once it does", async () => {
      // Nothing to pause during preparation. The flag still has to survive to
      // the monologue, or the toggle silently means nothing.
      const h = harness();
      h.controller.start();
      h.controller.setDevTextMode(true);
      assert.equal(h.controller.getSnapshot().devTextMode, true);

      await intoMonologue(h);
      h.advanceClock(120);

      assert.equal(h.controller.getSnapshot().recording, false);
      assert.equal(h.recorder.measuredSeconds("monologue"), 0, "nothing was captured");
    });

    /** Monologue → débat → finished, the way a whole sitting gets there. */
    async function runToFinish(h: Harness, inDebate: () => void): Promise<void> {
      h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
      await h.controller.advanceEarly();
      await completeClosing(h);
      inDebate();
      h.advanceClock(PHASE_DURATIONS.debate);
      await completeClosing(h);
    }

    it("claims the seconds a typed exposé says it took, and adds them up", async () => {
      const h = harness();
      await intoMonologue(h);
      h.controller.setDevTextMode(true);
      h.controller.injectCandidateSpeech("Premier paragraphe.", 200);
      h.controller.injectCandidateSpeech("Second paragraphe.", 130);
      await runToFinish(h, () => {});

      assert.equal(h.controller.getSnapshot().phase, "finished");
      assert.deepEqual(h.finished[0]?.devSeconds, { monologue: 330, debate: 0 });
    });

    it("sends no artefact for a typed phase, even when the room was recorded first (#51)", async () => {
      // The ordinary panel flow: « Enregistrer » pressed, some seconds of room
      // tone captured while the panel is found and opened, then the exposé
      // typed. That stub used to ride in front of every typed exposé — a real
      // file of nobody speaking, uploaded, graded as the monologue's audio,
      // and displacing the typed duration claim.
      const h = harness();
      await intoMonologue(h);
      h.advanceClock(8);
      assert.equal(h.recorder.measuredSeconds("monologue"), 8, "the stub was captured");

      h.controller.setDevTextMode(true);
      h.controller.injectCandidateSpeech("Un exposé tapé.", 330);
      await runToFinish(h, () => {});

      const payload = h.finished[0];
      assert.deepEqual(h.recorder.droppedPhases, ["monologue"]);
      assert.deepEqual(
        payload?.recordings.map((recording) => recording.phase),
        ["debate"],
        "the typed monologue left no file; the spoken débat kept its own",
      );
      // With the stub gone, the claim is what the route will compute the
      // duration penalty from — nothing displaces it any more.
      assert.deepEqual(payload?.devSeconds, { monologue: 330, debate: 0 });
    });

    it("drops the artefact at the boundary, after the phase closes and before the early encode", async () => {
      // The order is the design: the drop must come after `endPhase()` (until
      // the boundary the developer can still speak into the phase) and before
      // the #86 pre-encode, which would otherwise spend the débat compressing
      // a recording the sitting has just decided against.
      const h = harness();
      await intoMonologue(h);
      h.advanceClock(8);
      h.controller.setDevTextMode(true);
      h.controller.injectCandidateSpeech("Un exposé tapé.", 330);
      await runToFinish(h, () => {});

      const end = h.recorder.calls.indexOf("end:monologue");
      const drop = h.recorder.calls.indexOf("drop:monologue");
      assert.ok(end !== -1 && drop === end + 1, "closed, then dropped, in the same breath");
    });

    it("produces the same artefacts however long the panel took to open", async () => {
      // The issue's definition of done, item one: the same typed flow, run
      // twice, must produce the same set of phases-with-audio. The stub's size
      // was the run-to-run variable — however many seconds the panel took —
      // so two runs that differ only in that must finish identically.
      const phases = async (secondsBeforePanel: number) => {
        const h = harness();
        await intoMonologue(h);
        h.advanceClock(secondsBeforePanel);
        h.controller.setDevTextMode(true);
        h.controller.injectCandidateSpeech("Le même exposé, tapé.", 330);
        await runToFinish(h, () => {});
        return h.finished[0]?.recordings.map((recording) => recording.phase);
      };

      assert.deepEqual(await phases(2), await phases(45));
    });

    it("costs the débat its recording too, when the débat is what was typed", async () => {
      // Per phase, not per sitting: a spoken monologue keeps its artefact
      // beside a typed débat that loses its own.
      const h = harness();
      await intoMonologue(h);
      h.advanceClock(30);
      await runToFinish(h, () => {
        h.controller.injectCandidateSpeech("Une réponse tapée.", 60);
      });

      assert.deepEqual(h.recorder.droppedPhases, ["debate"]);
      assert.deepEqual(
        h.finished[0]?.recordings.map((recording) => recording.phase),
        ["monologue"],
      );
    });

    it("stays typed through a restart — the typed turn does too", async () => {
      // Deliberate, not an oversight: `restartMonologue` rewinds the clock, but
      // it removes neither the typed turn from the transcript nor the claimed
      // seconds — so a phase that was typed into and then restarted and spoken
      // is still a phase whose content is partly typed, and its recording goes
      // the way every typed phase's does. Clearing the mark on restart while
      // the typed words stayed in the transcript would re-open exactly the
      // mixed-input coin flip #51 closed, one restart deep.
      const h = harness();
      await intoMonologue(h);
      h.controller.setDevTextMode(true);
      h.controller.injectCandidateSpeech("Un fragment tapé.", 60);
      h.controller.setDevTextMode(false);

      h.controller.restartMonologue();
      h.advanceClock(120);
      assert.equal(h.recorder.measuredSeconds("monologue"), 120, "the restart was spoken");

      await runToFinish(h, () => {});

      assert.deepEqual(h.recorder.droppedPhases, ["monologue"]);
      assert.deepEqual(
        h.finished[0]?.recordings.map((recording) => recording.phase),
        ["debate"],
      );
    });

    it("never drops anything on a sitting where nothing was typed", async () => {
      // The guard the whole feature stands behind: a real spoken sitting's
      // artefacts are untouched, both of them.
      const h = harness();
      await intoMonologue(h);
      h.advanceClock(30);
      await runToFinish(h, () => {});

      assert.deepEqual(h.recorder.droppedPhases, []);
      assert.deepEqual(
        h.finished[0]?.recordings.map((recording) => recording.phase),
        ["monologue", "debate"],
      );
    });

    it("gives the microphone back when the monologue ends, so the débat records", async () => {
      // The panel is on the exposé and nowhere else. A mode that outlived it
      // would leave the débat neither typeable nor recordable — an empty
      // transcript and zero seconds arriving at the correction.
      const h = harness();
      await intoMonologue(h);
      h.controller.setDevTextMode(true);
      h.controller.injectCandidateSpeech("Un exposé tapé.", 330);
      h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
      await h.controller.advanceEarly();
      await completeClosing(h);

      assert.equal(h.controller.getSnapshot().phase, "debate");
      assert.equal(h.controller.getSnapshot().devTextMode, false, "the mode stood down");
      assert.equal(h.recorder.paused, false, "the microphone is back");

      h.advanceClock(60);
      assert.equal(h.recorder.measuredSeconds("debate"), 60, "and the débat is recording");
      assert.equal(h.controller.getSnapshot().recording, true);
    });

    it("sends no claim at all when nothing was typed", async () => {
      // A real sitting must not carry the field, or the route has a pair of
      // zeroes to interpret on every single request.
      const h = harness();
      await intoMonologue(h);
      await runToFinish(h, () => {});

      assert.equal(h.finished[0]?.devSeconds, undefined);
    });

    it("claims nothing for a turn that gives no duration", async () => {
      const h = harness();
      await intoMonologue(h);
      h.controller.setDevTextMode(true);
      h.controller.injectCandidateSpeech("Sans durée.");
      await runToFinish(h, () => {});

      assert.equal(h.finished[0]?.devSeconds, undefined);
    });

    describe("« Envoyer l'exposé »", () => {
      /**
       * Preparation → an ARMED monologue: the consigne is over, « Enregistrer »
       * has not been pressed, and nothing has started (#37).
       *
       * The state the natural flow lands in — arrive, open the panel, paste,
       * send — and therefore the one #53 is about.
       */
      async function intoArmedMonologue(h: Harness): Promise<void> {
        h.controller.start();
        await h.controller.advanceEarly();
      }

      it("ends the monologue and lands in the débat, with nothing to wait out", async () => {
        // The typed text is not a fragment of the monologue, it is the whole
        // thing — so sending it is the same act as finishing speaking, and the
        // épreuve is in the débat when the press returns. A spoken monologue
        // waits up to twelve seconds here for the examiner's closing sentence;
        // a typed one has nothing in flight to wait for.
        const h = harness();
        await intoMonologue(h);
        h.controller.setDevTextMode(true);
        h.advanceClock(20);

        const accepted = await h.controller.submitTypedExpose("Un exposé complet, tapé.", 330);

        assert.equal(accepted, true, "and it says so, which is what empties the panel");
        const state = h.controller.getSnapshot();
        assert.equal(state.phase, "debate", "immediately: no handshake, no safety timeout");
        assert.equal(state.closing, false, "nothing is being waited for");
        assert.equal(h.recorder.paused, false, "and the microphone came back for the débat");
      });

      it("starts an armed part itself, so one press is the whole act (#53)", async () => {
        const h = harness();
        await intoArmedMonologue(h);

        const armed = h.controller.getSnapshot();
        assert.equal(armed.awaitingStart, true, "nobody has pressed « Enregistrer »");
        assert.equal(armed.canAdvance, false, "and the ordinary way out is shut");

        h.controller.setDevTextMode(true);
        const accepted = await h.controller.submitTypedExpose("Un exposé complet, tapé.", 330);

        assert.equal(accepted, true);
        assert.equal(h.controller.getSnapshot().phase, "debate", "no other click required");
        assert.deepEqual(
          h.recorder.calls,
          ["monologue", "end:monologue", "drop:monologue"],
          "the phase's artefact was opened, closed and — being typed — dropped (#51), " +
            "all in the one press",
        );
      });

      it("connects nobody to a monologue it is ending in the same act", async () => {
        // A session opened here would be closed before it finished connecting,
        // having heard nothing and said nothing — and it costs an ephemeral
        // token to mint. The examiner learns the exposé from the débat's own
        // seeded history, asserted below.
        const h = harness();
        await intoArmedMonologue(h);
        h.controller.setDevTextMode(true);

        await h.controller.submitTypedExpose(
          "Le télétravail a transformé le rapport au bureau.",
          330,
        );

        assert.equal(h.sessions.length, 0, "the monologue connected nobody");

        await pressRecord(h);
        assert.equal(h.sessions.length, 1, "the débat is the first session of the sitting");
        assert.equal(h.session().phase, "debate");
        assert.ok(
          h.session().history[0]?.parts[0]?.text.includes("le rapport au bureau"),
          "and it was seeded with the typed exposé, so the examiner has been told it",
        );
      });

      it("does not wait out the five-minute floor", async () => {
        // The floor stops a candidate skipping the task. Here the task has been
        // handed over complete, and not spending five minutes saying it is the
        // entire reason to type it.
        const h = harness();
        await intoMonologue(h);
        h.controller.setDevTextMode(true);
        h.advanceClock(5);
        assert.equal(h.controller.getSnapshot().canAdvance, false, "the floor is still on");

        await h.controller.submitTypedExpose("Bien avant les cinq minutes.", 330);
        assert.equal(h.controller.getSnapshot().phase, "debate");
      });

      it("carries the transcript and the claimed duration with it", async () => {
        const h = harness();
        await intoMonologue(h);
        h.controller.setDevTextMode(true);
        await h.controller.submitTypedExpose(
          "Le télétravail a transformé le rapport au bureau.",
          330,
        );

        const said = h.controller
          .getSnapshot()
          .transcript.filter(
            (entry) => entry.phase === "monologue" && entry.speaker === "candidate",
          )
          .map((entry) => entry.text)
          .join(" ");
        assert.match(said, /Le télétravail a transformé le rapport au bureau\./);

        await pressRecord(h);
        h.advanceClock(PHASE_DURATIONS.debate);
        await completeClosing(h);
        assert.deepEqual(h.finished[0]?.devSeconds, { monologue: 330, debate: 0 });
      });

      it("reports the monologue as a phase that happened, not one nothing can date", async () => {
        // `reportFinalisedPhase` needs both stamps, and an armed phase has
        // neither. Without anchoring one here the exposé would reach the
        // correction but the phase would never be persisted mid-sitting.
        const h = harness();
        await intoArmedMonologue(h);
        h.controller.setDevTextMode(true);
        await h.controller.submitTypedExpose("Un exposé complet, tapé.", 330);
        // The phase flips before this settles — the transition's tail (the
        // microphone, the débat's consigne, this report) is what runs after.
        await new Promise((resolve) => setImmediate(resolve));

        const report = h.progress.find((entry) => entry.phase === "monologue");
        assert.ok(report, "the monologue was reported as it finalised");
        assert.ok(
          report.entries.some((entry) => /Un exposé complet, tapé\./.test(entry.text)),
          "with the typed exposé on it",
        );
      });

      it("refuses an empty exposé, which would be a way to skip the monologue", async () => {
        const h = harness();
        await intoMonologue(h);
        h.controller.setDevTextMode(true);
        h.advanceClock(20);

        const accepted = await h.controller.submitTypedExpose("   ", 330);

        const state = h.controller.getSnapshot();
        assert.equal(accepted, false, "and the panel is told, so it keeps what it has");
        assert.equal(state.phase, "monologue", "the phase was not ended");
      });

      it("refuses while the consigne is being given, and hands the text back", async () => {
        // The one refusal left, and it is the same rule « Enregistrer » obeys:
        // the examiner is talking and the candidate's turn has not been handed
        // over. What must not happen is the old failure — a refusal that took
        // the exposé with it.
        const announcer = new FakeAnnouncer();
        announcer.behaviour = "hold";
        const h = harness({ announcer });
        const idle = () => new Promise((resolve) => setImmediate(resolve));

        h.controller.start();
        await idle();
        h.advanceClock(120);
        const advancing = h.controller.advanceEarly();
        await idle();

        h.controller.setDevTextMode(true);
        const accepted = await h.controller.submitTypedExpose("Envoyé trop tôt.", 330);

        assert.equal(accepted, false, "so the panel keeps the exposé");
        assert.equal(h.controller.getSnapshot().phase, "monologue", "nothing was started");
        assert.deepEqual(h.recorder.calls, [], "and nothing was recorded of the consigne");
        assert.equal(
          h.controller.getSnapshot().transcript.length,
          0,
          "the turn was not written either",
        );

        // And it works the moment the examiner stops talking, with no
        // « Enregistrer » in between.
        announcer.reachEnd();
        await advancing;
        assert.equal(await h.controller.submitTypedExpose("Envoyé à temps.", 330), true);
        assert.equal(h.controller.getSnapshot().phase, "debate");
      });

      it("does nothing once a handshake somebody else started is under way", async () => {
        // The mic button ends the monologue the spoken way, and that closing
        // belongs to the examiner: an exposé typed into it would be a turn
        // arriving after the phase had been handed over.
        const h = harness();
        await intoMonologue(h);
        h.controller.setDevTextMode(true);
        h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
        await h.controller.advanceEarly();
        assert.equal(h.controller.getSnapshot().closing, true);

        const accepted = await h.controller.submitTypedExpose("Trop tard.", 90);

        assert.equal(accepted, false, "refused, and the exposé is handed back");
        assert.equal(
          h.controller.getSnapshot().transcript.some((e) => /Trop tard/.test(e.text)),
          false,
          "the turn is over; an exposé does not join it",
        );
      });

      it("does nothing on a second press, the monologue being over", async () => {
        const h = harness();
        await intoMonologue(h);
        h.controller.setDevTextMode(true);
        await h.controller.submitTypedExpose("Premier envoi.", 330);
        assert.equal(h.controller.getSnapshot().phase, "debate");

        const accepted = await h.controller.submitTypedExpose("Second envoi, trop tard.", 90);

        assert.equal(accepted, false, "refused, and the second exposé is handed back");
        assert.equal(
          h.controller.getSnapshot().transcript.some((e) => /trop tard/.test(e.text)),
          false,
          "the turn is over; a second exposé does not join it",
        );
      });
    });

    it("ignores a toggle that changes nothing", async () => {
      const h = harness();
      await intoMonologue(h);
      h.controller.setDevTextMode(true);
      h.advanceClock(30);
      h.controller.setDevTextMode(true);

      assert.equal(h.recorder.paused, true);
      const modeEvents = h.controller
        .getSnapshot()
        .events.filter((event) => event.name === "dev-text-mode");
      assert.equal(modeEvents.length, 1, "one entry, not one per press");
    });
  });
});

describe("reporting a phase as it finalises", () => {
  /** Preparation → monologue, the way a candidate who has finished their notes
   *  gets there. */
  async function intoMonologue(h: Harness): Promise<void> {
    h.controller.start();
    await h.controller.advanceEarly();
    await pressRecord(h);
    // The part opens ARMED: the sujet and the plan are on screen and no clock is
    // running until the candidate presses « Enregistrer ». This is that press.
    h.controller.startSpeaking();
    await new Promise((resolve) => setImmediate(resolve));
  }

  /** And on into the débat, through the closing handshake. */
  async function intoDebate(h: Harness): Promise<void> {
    await intoMonologue(h);
    h.session().candidateSays("Le télétravail a transformé le rapport au bureau.");
    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    await h.controller.advanceEarly();
    await completeClosing(h);
  }

  it("says nothing until a speaking phase has actually ended", async () => {
    const h = harness();
    await intoMonologue(h);
    h.advanceClock(120);
    assert.deepEqual(h.progress, [], "preparation produced nothing, and the monologue is running");
  });

  it("reports the monologue once, with its turns and its clock", async () => {
    const h = harness();
    await intoDebate(h);

    assert.equal(h.progress.length, 1);
    const [report] = h.progress;
    assert.equal(report.phase, "monologue");
    assert.deepEqual(
      report.entries.map((entry) => entry.text),
      ["Le télétravail a transformé le rapport au bureau."],
    );
    assert.ok(report.endedAt > report.startedAt, "a finalised phase has both stamps");
  });

  it("carries only that phase's turns, never the exam's", async () => {
    // The turns are appended server-side, so a report that swept up the débat
    // would file them under the monologue — and the corrector grades the two
    // tasks separately.
    const h = harness();
    await intoDebate(h);
    h.session().candidateSays("Oui, et cela libère du temps personnel.");
    h.advanceClock(60);

    assert.equal(h.progress.length, 1, "the débat is still running and has not reported");
    assert.ok(
      h.progress[0].entries.every((entry) => entry.phase === "monologue"),
      "the monologue's report is the monologue's turns",
    );
  });

  it("does not report the débat, because finishing carries it", async () => {
    // A progress request racing the finish request would be a second write of
    // the same turns, buying nothing: `onFinished` sends the whole sitting.
    const h = harness();
    await intoDebate(h);
    h.advanceClock(PHASE_DURATIONS.debate);
    await completeClosing(h);

    assert.equal(h.controller.getSnapshot().phase, "finished");
    assert.equal(h.finished.length, 1);
    assert.deepEqual(
      h.progress.map((report) => report.phase),
      ["monologue"],
    );
  });

  it("survives a listener that throws, because the épreuve must not stop", async () => {
    // The report is fire-and-forget by contract, and the controller has to hold
    // up its end: a phase transition that can be taken down by a failing
    // listener would mean a progress request could end an épreuve.
    const h = harness({
      onPhaseFinalised: () => {
        throw new Error("the network is on fire");
      },
    });
    await intoDebate(h);

    assert.equal(h.controller.getSnapshot().phase, "debate", "the transition completed anyway");
    assert.equal(h.sessions.length, 2, "and the débat session was opened");
  });
});

/**
 * The examiner's spoken consignes (#37).
 *
 * Everything here is about **ordering**, because that is what the feature is: a
 * consigne played at the wrong moment is captured into the recording it is
 * introducing, or charged to a clock that grades how long the candidate spoke.
 * Each test below sits inside the window a real clip would occupy and asserts
 * what has NOT happened yet.
 */
describe("spoken consignes", () => {
  /** Let the microtask queue drain, so an in-flight transition reaches its await. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /** A harness whose consignes keep playing until the test ends them. */
  function speaking(behaviour: AnnouncementOutcome | "hold" = "hold") {
    const announcer = new FakeAnnouncer();
    announcer.behaviour = behaviour;
    const h = harness({ announcer });
    return { h, announcer };
  }

  it("speaks the briefing at the start of the préparation, without holding it up", async () => {
    const { h, announcer } = speaking();
    h.controller.start();
    await settle();

    assert.deepEqual(announcer.played, [ANNOUNCEMENTS.preparation.src]);
    assert.equal(h.controller.getSnapshot().announcement, "preparation");
    assert.equal(h.controller.getSnapshot().announcementPlaying, true);

    // The one consigne that runs alongside its clock rather than in front of it.
    // Half a minute out of thirty is not a duration anything grades, and freezing
    // the phase to protect it would buy nothing.
    h.advanceClock(40);
    assert.equal(h.controller.getSnapshot().elapsed, 40);
    // And « Passer et commencer maintenant » still works while it is talking.
    assert.equal(h.controller.getSnapshot().canAdvance, true);
  });

  it("starts nothing until the consigne has ended AND the candidate has pressed « Enregistrer »", async () => {
    const { h, announcer } = speaking();
    h.controller.start();
    await settle();
    h.advanceClock(120);

    // Not awaited: the transition is deliberately parked inside the consigne, and
    // this is the window everything in #37 lives in.
    const advancing = h.controller.advanceEarly();
    await settle();

    const during = h.controller.getSnapshot();
    assert.equal(during.phase, "monologue", "the phase is open, so its screen is up");
    assert.deepEqual(announcer.played, [
      ANNOUNCEMENTS.preparation.src,
      ANNOUNCEMENTS.monologue.src,
    ]);

    assert.equal(h.recorder.started, true, "the microphone is open: it is asked for first");
    assert.deepEqual(h.recorder.calls, [], "but no phase artefact has been opened");
    assert.equal(during.recording, false, "so the indicator must not claim to be recording");
    assert.equal(h.sessions.length, 0, "and the examiner has not been connected");
    assert.equal(during.awaitingStart, false, "the consigne is talking, not the button waiting");

    // The clock has not started. This is the four per cent of a graded monologue
    // that a twenty-five second consigne would otherwise cost.
    h.advanceClock(25);
    assert.equal(h.controller.getSnapshot().elapsed, 0);
    assert.equal(h.controller.getSnapshot().remaining, PHASE_DURATIONS.monologue);
    // The phase cannot be ended before it has begun: `beginClosingHandshake`
    // would ask an examiner that is not there, then wait on a frozen clock that
    // never reaches its safety timeout.
    assert.equal(h.controller.getSnapshot().canAdvance, false);

    // Audio arriving before the artefact opens belongs to no phase, so the
    // archive discards it. This is the assertion that says the consigne cannot be
    // recorded, rather than merely that we tried to avoid it.
    assert.equal(h.recorder.measuredSeconds("monologue"), 0);

    announcer.reachEnd();
    await advancing;

    // ARMED. The consigne is over and still nothing has started: this is the
    // state the sujet, the document and the plan are read in.
    const armed = h.controller.getSnapshot();
    assert.equal(armed.awaitingStart, true);
    assert.deepEqual(h.recorder.calls, [], "reading the sujet is not being recorded");
    assert.equal(h.sessions.length, 0);
    assert.equal(armed.canAdvance, false);
    // The consigne stays on screen for the part it governs, so its text can be
    // read by someone who did not hear it.
    assert.equal(armed.announcement, "monologue");
    assert.equal(armed.announcementPlaying, false);

    // A candidate can re-read the document for as long as they like, and it costs
    // them none of the seven minutes they are graded on.
    h.advanceClock(90);
    assert.equal(h.controller.getSnapshot().elapsed, 0);
    assert.equal(h.controller.getSnapshot().remaining, PHASE_DURATIONS.monologue);
    assert.equal(h.recorder.measuredSeconds("monologue"), 0);

    await pressRecord(h);

    const after = h.controller.getSnapshot();
    assert.equal(after.awaitingStart, false);
    assert.deepEqual(h.recorder.calls, ["monologue"], "now the artefact opens");
    assert.equal(after.recording, true);
    assert.equal(h.sessions.length, 1, "and the examiner connects");
    assert.equal(after.elapsed, 0, "the clock starts from zero, not from mid-consigne");
    assert.equal(after.remaining, PHASE_DURATIONS.monologue);
  });

  it("ignores a second « Enregistrer » on a part already running", async () => {
    // It is a button, and buttons get double-clicked. A second press must not
    // re-anchor the clock or open a second session onto the same phase.
    const { h } = speaking("played");
    h.controller.start();
    h.advanceClock(120);
    await h.controller.advanceEarly();
    await pressRecord(h);

    h.advanceClock(45);
    await pressRecord(h);

    assert.equal(h.controller.getSnapshot().elapsed, 45, "the clock was not rewound");
    assert.deepEqual(h.recorder.calls, ["monologue"], "no second artefact");
    assert.equal(h.sessions.length, 1, "no second session");
  });

  it("refuses to start a part while its consigne is still being given", async () => {
    // The button is disabled on screen; this is the controller refusing anyway,
    // because the disabled state is a UI condition somebody could refactor away.
    const { h, announcer } = speaking();
    h.controller.start();
    await settle();
    h.advanceClock(120);
    void h.controller.advanceEarly();
    await settle();

    await pressRecord(h);

    assert.deepEqual(h.recorder.calls, [], "the examiner is still talking");
    assert.equal(h.sessions.length, 0);
    assert.equal(h.controller.getSnapshot().remaining, PHASE_DURATIONS.monologue);

    announcer.reachEnd();
    await settle();
    await pressRecord(h);
    assert.deepEqual(h.recorder.calls, ["monologue"]);
  });

  it("no longer has the model greet the candidate at the monologue", async () => {
    // The greeting used to be a fixed script the model was asked to read
    // verbatim. It is now the consigne, which cannot drift, cannot depend on the
    // socket being up, and is not spoken into the recording.
    const { h, announcer } = speaking("played");
    h.controller.start();
    h.advanceClock(120);
    await h.controller.advanceEarly();
    await pressRecord(h);

    assert.equal(h.session().phase, "monologue");
    assert.deepEqual(h.session().directives, [], "the monologue session says nothing on open");
    assert.equal(h.session().activityStarts, 1, "but the candidate's floor is still opened");
    assert.ok(announcer.played.includes(ANNOUNCEMENTS.monologue.src));
  });

  it("speaks one consigne at the monologue-to-débat handover", async () => {
    const { h, announcer } = speaking("played");
    h.controller.start();
    h.advanceClock(120);
    await h.controller.advanceEarly();
    await pressRecord(h);

    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    await h.controller.advanceEarly();
    h.session().finishTurn();
    await settle();
    await settle();

    assert.equal(h.controller.getSnapshot().phase, "debate");
    assert.equal(h.controller.getSnapshot().awaitingStart, true, "the débat waits too");
    await pressRecord(h);
    // One clip for the boundary, not two: the monologue ending and the débat
    // opening are the same moment.
    assert.deepEqual(announcer.played, [
      ANNOUNCEMENTS.preparation.src,
      ANNOUNCEMENTS.monologue.src,
      ANNOUNCEMENTS.debate.src,
    ]);
    // The débat keeps its model-spoken opening, because it has to quote an
    // argument the candidate actually made.
    assert.equal(h.session().phase, "debate");
    assert.equal(h.session().directives.length, 1);
  });

  it("forfeits a consigne the browser refuses, and arms the phase anyway", async () => {
    // The time-out path into the monologue: preparation's clock simply ran out,
    // so there has been no gesture for thirty minutes and autoplay is refused.
    // This used to HOLD the phase behind a panel and two buttons; the panel is
    // gone on the user's call, and a refused consigne is now a skipped one. The
    // ordering guarantee survives without the hold: the phase arms rather than
    // starts, so nothing is recorded and nothing is charged until the
    // candidate's own « Enregistrer » — the one gate that was ever load-bearing.
    const { h, announcer } = speaking("blocked");
    h.controller.start();
    h.advanceClock(PHASE_DURATIONS.preparation);
    await settle();
    await settle();

    const armed = h.controller.getSnapshot();
    assert.equal(armed.phase, "monologue");
    // It was attempted and refused, rather than never tried: the forfeit is the
    // browser's answer, not a decision this controller made on its own.
    assert.ok(announcer.played.includes(ANNOUNCEMENTS.monologue.src));
    assert.equal(armed.announcementPlaying, false);
    assert.equal(armed.awaitingStart, true, "armed, not held, and not started");
    assert.equal(armed.recording, false);
    assert.deepEqual(h.recorder.calls, []);
    assert.equal(h.sessions.length, 0);

    // Nothing is being spent: the clock waits for « Enregistrer » exactly as it
    // does after a consigne that played.
    h.advanceClock(30);
    assert.equal(h.controller.getSnapshot().remaining, PHASE_DURATIONS.monologue);

    await pressRecord(h);
    assert.deepEqual(h.recorder.calls, ["monologue"], "the part starts on the press");
    assert.equal(h.sessions.length, 1);
    assert.equal(h.controller.getSnapshot().recording, true);
  });

  it("silences one clip and still speaks at the next boundary", async () => {
    // « Passer » is per-clip, and that is the whole of what it is (#59). The
    // sticky « Couper les annonces » went with the card it lived on, so a
    // candidate who skips the briefing still hears the monologue's consigne —
    // and the phase it opens still waits for it.
    const { h, announcer } = speaking();
    h.controller.start();
    await settle();

    h.controller.skipAnnouncement();
    assert.equal(h.controller.getSnapshot().announcementPlaying, false);
    assert.equal(announcer.stops, 1, "the briefing was silenced mid-sentence");

    // The time-out path into the monologue, so nothing here awaits a consigne
    // that is deliberately left mid-sentence.
    const playedByThen = announcer.played.length;
    h.advanceClock(PHASE_DURATIONS.preparation);
    await settle();

    assert.equal(
      announcer.played.length,
      playedByThen + 1,
      "the monologue's consigne is a different clip and still plays",
    );
    assert.equal(h.controller.getSnapshot().announcementPlaying, true);
    announcer.reachEnd();
    await settle();
    await settle();

    assert.equal(h.controller.getSnapshot().awaitingStart, true);
    await pressRecord(h);
    assert.deepEqual(h.recorder.calls, ["monologue"]);
    assert.equal(h.sessions.length, 1);
  });

  it("does not start a phase whose consigne was still in flight when it was destroyed", async () => {
    // `announcer.close()` resolves the in-flight `play()` as skipped, and the
    // boundary checks `destroyed` on the far side of the await — so a tab that
    // goes away mid-consigne strands nothing and starts nothing.
    const { h, announcer } = speaking("hold");
    h.controller.start();
    h.advanceClock(PHASE_DURATIONS.preparation);
    await settle();
    assert.equal(h.controller.getSnapshot().announcementPlaying, true);

    h.controller.destroy();
    await settle();
    await settle();

    assert.equal(announcer.closed, true);
    assert.deepEqual(h.recorder.calls, [], "no phase was started on a page that had gone");
    assert.equal(h.sessions.length, 0);
  });

  it("finishes speaking the closing consigne before the sitting is handed over", async () => {
    // Awaited before `onFinished`, because that is what navigates to the results
    // page: the examiner's voice must not carry on over a screen that has moved on.
    const { h, announcer } = speaking("played");
    h.controller.start();
    h.advanceClock(120);
    await h.controller.advanceEarly();
    await pressRecord(h);

    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    await h.controller.advanceEarly();
    h.session().finishTurn();
    await settle();
    await pressRecord(h);
    assert.equal(h.controller.getSnapshot().phase, "debate");

    announcer.behaviour = "hold";
    h.advanceClock(60);
    await h.controller.advanceEarly();
    h.session().finishTurn();
    await settle();
    await settle();

    assert.equal(h.controller.getSnapshot().phase, "finished");
    assert.ok(announcer.played.includes(ANNOUNCEMENTS.finished.src));
    assert.equal(h.finished.length, 0, "the sitting is not handed over mid-sentence");

    announcer.reachEnd();
    await settle();
    await settle();

    assert.equal(h.finished.length, 1, "and it is handed over once the voice has finished");
  });
});

/**
 * A part that has ended must end, whatever the things being closed have to say
 * about it (#65).
 *
 * Every step between one part finishing and the next one opening is some form
 * of "tell a thing that is going away that it is going away" — the socket's
 * activity marker, the socket, the recorder's open artefact, the development
 * text mode. They all run BEFORE `advance()` changes the phase, and none of them
 * used to be allowed to fail: one throw and the épreuve stayed on a part the
 * candidate had finished, with no control on screen that could move it.
 *
 * It was found through the typed exposé, which made the failure loudest — the
 * panel had already reported the exposé accepted, so the box emptied and the
 * screen did not move — but nothing about it was development-only. The last two
 * tests here are the candidate's own « Terminer » on a socket that has gone.
 */
describe("a teardown step that throws does not strand the épreuve", () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /** Preparation → a monologue that has actually begun, with a live session. */
  async function intoStartedMonologue(h: Harness): Promise<void> {
    h.controller.start();
    await h.controller.advanceEarly();
    await pressRecord(h);
    h.controller.startSpeaking();
    await settle();
  }

  /** What a real socket does once it has gone: `endCandidateActivity` and
   *  `close` reach the SDK, which throws rather than returning. */
  const gone = () => {
    throw new Error("WebSocket is not open");
  };

  it("leaves for the débat when the session throws on the way out", async () => {
    const h = harness();
    await intoStartedMonologue(h);
    h.controller.setDevTextMode(true);
    h.session().endCandidateActivity = gone;

    const accepted = await h.controller.submitTypedExpose("Un exposé complet, tapé.", 330);

    assert.equal(accepted, true);
    assert.equal(
      h.controller.getSnapshot().phase,
      "debate",
      "the exposé counted, so the part it ended is over",
    );
  });

  it("leaves for the débat when closing the session throws", async () => {
    const h = harness();
    await intoStartedMonologue(h);
    h.controller.setDevTextMode(true);
    h.session().close = gone;

    await h.controller.submitTypedExpose("Un exposé complet, tapé.", 330);

    assert.equal(h.controller.getSnapshot().phase, "debate");
  });

  it("leaves for the débat when the recorder throws while closing the artefact", async () => {
    const h = harness();
    await intoStartedMonologue(h);
    h.controller.setDevTextMode(true);
    h.recorder.endPhase = () => {
      throw new Error("the framer could not be flushed");
    };

    await h.controller.submitTypedExpose("Un exposé complet, tapé.", 330);

    assert.equal(h.controller.getSnapshot().phase, "debate");
  });

  it("says which step failed, rather than swallowing it", async () => {
    // The phase change surviving is not the same as nothing having gone wrong.
    // A recording short by one phase has to have something to be explained by.
    const h = harness();
    await intoStartedMonologue(h);
    h.controller.setDevTextMode(true);
    h.session().endCandidateActivity = gone;

    await h.controller.submitTypedExpose("Un exposé complet, tapé.", 330);

    const failure = h.controller
      .getSnapshot()
      .events.find((event) => event.name === "teardown-failed");
    assert.ok(failure, "the event log carries the failure");
    assert.match(String(failure.detail), /end-candidate-activity/);
    assert.match(String(failure.detail), /WebSocket is not open/);
  });

  it("ends a spoken monologue whose socket throws on « Terminer »", async () => {
    // No development tooling in this one. The candidate presses the button, the
    // examiner is asked for its closing sentence on a socket that has gone, and
    // the épreuve must still be able to reach the débat.
    const h = harness();
    await intoStartedMonologue(h);
    h.session().candidateSays("Le télétravail a transformé le rapport au bureau.");
    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    h.session().sendDirective = gone;
    h.session().endCandidateActivity = gone;

    await h.controller.advanceEarly();
    assert.equal(h.controller.getSnapshot().closing, true, "the handshake opened all the same");

    h.session().finishTurn();
    await settle();

    assert.equal(h.controller.getSnapshot().phase, "debate");
  });

  it("names the part it was leaving when the transition itself fails", async () => {
    // `finish()` is not a teardown step this guards — it is the whole of the
    // sitting being handed over — but it runs inside `advance()` and can still
    // throw, and that is the case `advanceDetached` exists to report. The phase
    // has already flipped by then, so the label has to have been read before.
    const h = harness();
    await intoStartedMonologue(h);
    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    await h.controller.advanceEarly();
    h.session().finishTurn();
    await settle();
    await pressRecord(h);
    assert.equal(h.controller.getSnapshot().phase, "debate");

    h.players[h.players.length - 1].interrupt = () => {
      throw new Error("the speaker is gone");
    };
    // The débat ends the way it always does: its clock runs out, the examiner is
    // asked for a closing sentence, and its turn completing is what releases the
    // phase into `finished`.
    h.advanceClock(PHASE_DURATIONS.debate);
    h.session().finishTurn();
    await settle();
    await settle();

    const failure = h.controller
      .getSnapshot()
      .events.find((event) => event.name === "advance-failed");
    assert.ok(failure, "the rejection reached the event log rather than the void");
    assert.match(String(failure.detail), /"from":"debate"/, "the part it was leaving");
    assert.match(String(failure.detail), /the speaker is gone/);
  });

  it("still times the handshake out when the closing directive throws", async () => {
    // The safety timeout is what stops a silent examiner stranding the
    // candidate. It is stamped after the directive goes out, so a directive that
    // threw used to take the stamp with it — and the one guard against being
    // stuck on a finished part was itself stuck.
    const h = harness();
    await intoStartedMonologue(h);
    h.session().candidateSays("Le télétravail a transformé le rapport au bureau.");
    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    h.session().sendDirective = gone;

    await h.controller.advanceEarly();
    assert.equal(h.controller.getSnapshot().phase, "monologue", "waiting on the examiner");

    // The examiner never speaks. The deadline is the only way out — twelve
    // seconds, driven off the injected clock like the test above.
    h.advanceClock(13);
    await settle();

    assert.equal(h.controller.getSnapshot().phase, "debate");
  });
});

/**
 * The examiner's opening question (#74).
 *
 * The débat opens with the examiner speaking, and the candidate reads that
 * question in the conversation as it is transcribed. The two halves of it travel
 * separately — the text on one callback, the voice on another — so anything that
 * takes the voice away leaves the feed printing an objection nobody spoke, which
 * is what this covers: an interruption reported before the candidate has said
 * anything, which is automatic VAD reacting to the room rather than to them.
 */
describe("the examiner's opening question", () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /** Preparation → a débat that has begun, with its own live session. */
  async function intoDebate(h: Harness): Promise<void> {
    h.controller.start();
    await h.controller.advanceEarly();
    await pressRecord(h);
    h.session().candidateSays("Le télétravail a transformé le rapport au bureau.");
    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    await h.controller.advanceEarly();
    // Ends the handshake and presses « Enregistrer » on the part it lands in.
    await completeClosing(h);
  }

  it("is not thrown away by an interruption the candidate did not make", async () => {
    const h = harness();
    await intoDebate(h);
    const player = h.players[h.players.length - 1];

    // The examiner opens the débat. Gemini reports an interruption before a word
    // of it has been answered — there is nothing yet to answer.
    h.session().examinerSays(
      "Vous dites que le télétravail isole. N'est-ce pas plutôt le bureau ?",
    );
    h.session().examinerVoice("the opening question");
    h.session().interrupts();

    assert.equal(player.interrupts, 0, "the speaker was not told to drop the turn");
    assert.deepEqual(player.chunks, ["the opening question"], "so it is still there to hear");
    const refused = h.controller
      .getSnapshot()
      .events.find((event) => event.name === "interruption-refused");
    assert.ok(refused, "and the refusal is in the session log rather than silent");
    assert.match(
      String(refused.detail),
      /"buffered":1/,
      "carrying how much playback it kept, which is what makes the log worth reading",
    );
  });

  it("stops the examiner once the candidate really does take the floor", async () => {
    const h = harness();
    await intoDebate(h);
    const player = h.players[h.players.length - 1];

    h.session().examinerVoice("the opening question");
    h.session().finishTurn();

    h.session().examinerVoice("a second question, spoken over");
    h.session().interrupts();

    assert.equal(player.interrupts, 1, "the examiner gives way, which is the débat working");
    assert.deepEqual(player.chunks, []);
  });

  it("gives way again once the speaker has stayed out of the opening turn", async () => {
    // The other release, and the one that stops this being a trap: an
    // interrupted generation is not guaranteed to be followed by a turn
    // completing, so a guard only that could open could stay shut for a whole
    // débat — an examiner the candidate is structurally unable to talk over.
    const h = harness();
    await intoDebate(h);
    const player = h.players[h.players.length - 1];

    player.speak(true);
    player.speak(false);
    h.advanceClock(2); // the speaker is dry, and stays dry
    h.session().interrupts();

    assert.equal(player.interrupts, 1, "the question was delivered; the next one can be cut");
  });

  it("is not released by the gap between two chunks of one question (#94)", async () => {
    // The remaining path to a question printed and never heard. A turn arrives
    // as many chunks and the queue empties whenever one finishes before the next
    // lands; read as "the turn is over", one moment of jitter opened the guard
    // mid-question and the next noise in the room flushed the rest of it.
    const h = harness();
    await intoDebate(h);
    const player = h.players[h.players.length - 1];

    h.session().examinerVoice("the opening question, chunk one");
    player.speak(true);
    player.speak(false); // the stream stumbles
    h.advanceClock(0.5); // …and picks up again well inside the grace
    player.speak(true);
    h.session().examinerVoice("chunk two, still the same question");
    h.session().interrupts();

    assert.equal(player.interrupts, 0, "the room did not take the question away");
    assert.equal(player.chunks.length, 2, "both chunks are still there to hear");
    assert.deepEqual(
      h.controller.getSnapshot().events.filter((event) => event.name === "opening-turn-drained"),
      [],
      "and nothing claimed the turn was over",
    );
  });

  it("wakes the speaker from the candidate's own « Enregistrer » click", async () => {
    // The one guaranteed user gesture at each part's opening. A context the
    // browser suspended since the monologue may accept a resume from nowhere
    // else — the stall detector's attempt has no gesture behind it and autoplay
    // policy can refuse it — and a suspended speaker at the débat's opening is
    // the unheard first question.
    const h = harness();
    h.controller.start();
    await h.controller.advanceEarly();
    await pressRecord(h);
    h.session().candidateSays("Le télétravail a transformé le rapport au bureau.");
    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    await h.controller.advanceEarly();
    h.session().finishTurn(); // the monologue closes; the débat opens armed
    await settle();

    const player = h.players[h.players.length - 1];
    const before = player.resumes;
    h.controller.startSpeaking();
    await settle();

    assert.equal(player.resumes, before + 1, "the click reached the speaker, not only the mic");
  });

  it("holds the floor for the examiner until the question is delivered", async () => {
    // The scene used to read `examinerSpeaking` alone, which is false for the
    // whole connect-and-generate window — so the débat opened with the
    // candidate's ring pulsing and « Vous avez la parole » under it, over an
    // examiner who was about to talk.
    const h = harness();
    await intoDebate(h);
    const player = h.players[h.players.length - 1];

    assert.equal(
      h.controller.getSnapshot().openingQuestionPending,
      true,
      "the question is owed from the candidate's own « Enregistrer »",
    );

    // Becoming audible does not end it: the floor stays the examiner's for as
    // long as the question does.
    player.speak(true);
    assert.equal(h.controller.getSnapshot().openingQuestionPending, true);

    h.session().finishTurn();
    assert.equal(
      h.controller.getSnapshot().openingQuestionPending,
      false,
      "the turn completing is what hands the floor over",
    );
  });

  it("hands the floor over when the speaker stays out of the opening turn", async () => {
    // The same second release the interruption guard has (#94), because it is
    // the same fact about the same turn.
    const h = harness();
    await intoDebate(h);
    const player = h.players[h.players.length - 1];

    player.speak(true);
    player.speak(false);
    h.advanceClock(2); // dry, and stays dry

    assert.equal(h.controller.getSnapshot().openingQuestionPending, false);
  });

  it("does not print the question before a word of it is audible", async () => {
    // The two halves of the question travel at different speeds: the text at
    // generation speed, the voice at speaking speed. Printed as it generates,
    // the whole question sat in the feed while the audio was still connecting —
    // a question shown and not heard, which is #94's report read literally.
    const h = harness();
    await intoDebate(h);
    const player = h.players[h.players.length - 1];

    h.session().examinerSays(
      "Vous dites que le télétravail isole. N'est-ce pas plutôt le bureau ?",
    );
    h.session().examinerVoice("the opening question");

    assert.equal(
      h.controller
        .getSnapshot()
        .transcript.some((entry) => entry.speaker === "examiner" && entry.phase === "debate"),
      false,
      "the feed holds the question back while nothing has played",
    );

    // The candidate's own words are not held — the hold is about the examiner's
    // unheard question, not about the feed.
    h.session().candidateSays("Je peux commencer ?");
    assert.equal(
      h.controller.getSnapshot().transcript.some((entry) => entry.speaker === "candidate"),
      true,
    );

    player.speak(true);
    const heard = h.controller
      .getSnapshot()
      .transcript.find((entry) => entry.speaker === "examiner" && entry.phase === "debate");
    assert.ok(heard, "playback beginning is what reveals the question");
    assert.match(heard.text, /télétravail isole/);

    // The gap between two chunks of one question (#94) must not hide it again.
    player.speak(false);
    assert.equal(
      h.controller
        .getSnapshot()
        .transcript.some((entry) => entry.speaker === "examiner" && entry.phase === "debate"),
      true,
      "once heard, it stays printed",
    );
  });

  it("prints the question at the turn's end when the speaker never played it", async () => {
    // A sitting whose speaker failed still gets the question in the feed — the
    // text is the only voice the examiner has left (#74). It just arrives when
    // the turn is over, rather than while nobody is saying it.
    const h = harness();
    await intoDebate(h);

    h.session().examinerSays("Une question que le haut-parleur n'a jamais portée.");
    assert.equal(
      h.controller
        .getSnapshot()
        .transcript.some((entry) => entry.speaker === "examiner" && entry.phase === "debate"),
      false,
    );

    h.session().finishTurn();
    assert.equal(
      h.controller
        .getSnapshot()
        .transcript.some((entry) => entry.speaker === "examiner" && entry.phase === "debate"),
      true,
      "the server's word releases the hold with or without audio",
    );
  });

  it("still opens the guard on the turn the server says is complete", async () => {
    // `turnComplete` is the server's own word and needs no grace: it is the
    // release that must keep working the moment it arrives, since a candidate
    // answering a finished question should not have to wait out a timer.
    const h = harness();
    await intoDebate(h);
    const player = h.players[h.players.length - 1];

    h.session().examinerVoice("the opening question");
    h.session().finishTurn();
    h.session().examinerVoice("a second question, spoken over");
    h.session().interrupts();

    assert.equal(player.interrupts, 1);
  });

  it("guards each part's own opening, not the sitting's", async () => {
    // The flag belongs to the session. A monologue whose closing line completed
    // must not hand the débat a guard that is already spent.
    const h = harness();
    await intoDebate(h);
    const player = h.players[h.players.length - 1];

    h.session().examinerVoice("the opening question");
    h.session().interrupts();

    assert.equal(player.interrupts, 0, "the débat's own opening is guarded in its own right");
    assert.equal(h.sessions.length, 2, "and this is the débat's session, not the monologue's");
  });

  it("still lets the finish silence a speaker that never drained", async () => {
    // Nothing above touches the interrupt the épreuve itself performs: the
    // part is over, and the examiner does not go on talking into the
    // correction. What changed with #135 is the route there — the boundary now
    // waits for a draining speaker, so a queue that never drains takes the
    // closing handshake's safety deadline before the leftover is dropped.
    const h = harness();
    await intoDebate(h);
    const player = h.players[h.players.length - 1];

    h.session().examinerVoice("an objection nobody will answer");
    h.advanceClock(PHASE_DURATIONS.debate);
    await completeClosing(h);
    await settle();

    assert.equal(
      h.controller.getSnapshot().phase,
      "debate",
      "the queue is not draining, so the part has not turned over yet",
    );

    h.advanceClockSilently(12);
    await settle();

    assert.equal(h.controller.getSnapshot().phase, "finished");
    assert.ok(player.interrupts >= 1, "the speaker was emptied on the way out");
    assert.equal(player.bufferedSeconds, 0, "nothing survived into the correction");
  });
});

/**
 * The monologue → débat handover (#135).
 *
 * The sitting this is written against: « Terminer » pressed at the end of the
 * monologue, a débat-style objection playing on the monologue screen, and the
 * débat's consigne starting on top of it — two voices at once. Two defects
 * compounded: the activityEnd went out before the closing directive, so the
 * turn it released answered the exposé instead of the directive; and the phase
 * turned over on `turnComplete`, which is a fact about generation, while the
 * player was still seconds behind it.
 */
describe("the monologue → débat handover (#135)", () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const events = (h: Harness, name: string) =>
    h.controller.getSnapshot().events.filter((event) => event.name === name);

  /** Preparation → a monologue spoken past the floor, with « Terminer » pressed:
   *  the closing handshake is open and the examiner owes one sentence. */
  async function intoClosingMonologue(h: Harness): Promise<void> {
    h.controller.start();
    await h.controller.advanceEarly();
    await pressRecord(h);
    h.session().candidateSays("Le télétravail a transformé le rapport au bureau.");
    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    await h.controller.advanceEarly();
  }

  it("sends the closing directive before the activityEnd that frees the floor", async () => {
    // With manual VAD the activityEnd IS the turn boundary: the model takes
    // the floor the moment it arrives, with whatever is in context. Sent
    // first, the model answered the exposé it had memorised « pour le débat
    // qui suit » — the objection the report describes — and the directive
    // raced its generation. Both ride the same socket, so this order is the
    // order on the wire.
    const h = harness();
    await intoClosingMonologue(h);

    const wire = h.session().wire;
    const directive = wire.indexOf("directive");
    const activityEnd = wire.indexOf("activity-end");
    assert.notEqual(directive, -1, "the closing directive went out");
    assert.notEqual(activityEnd, -1, "and the floor was freed");
    assert.ok(
      directive < activityEnd,
      "the one turn the boundary releases already carries its execution order",
    );
  });

  it("holds the part until the closing sentence has been heard out", async () => {
    // `turnComplete` arrives at generation speed, seconds ahead of the voice.
    // Advancing on it is what put the débat's consigne on top of the sentence
    // still being spoken.
    const announcer = new FakeAnnouncer();
    const h = harness({ announcer });
    await intoClosingMonologue(h);
    const player = h.players[0];

    h.session().examinerVoice("je vous remercie,");
    h.session().examinerVoice("votre exposé était...");
    h.session().finishTurn();
    await settle();

    const held = h.controller.getSnapshot();
    assert.equal(held.phase, "monologue", "seconds of the sentence are still queued");
    assert.equal(held.closing, true, "the handshake is still open");
    assert.ok(
      !announcer.played.includes(ANNOUNCEMENTS.debate.src),
      "and no consigne is spoken over it",
    );

    // Playback catches up: the queue drains, and the next tick notices.
    player.drain(2);
    h.advanceClock(1);
    await settle();

    assert.equal(h.controller.getSnapshot().phase, "debate");
    assert.ok(
      announcer.played.includes(ANNOUNCEMENTS.debate.src),
      "the consigne got the room to itself",
    );
    assert.equal(player.interrupts, 0, "nothing was cut: the sentence simply finished");
  });

  it("drops what a dead speaker still holds when the deadline crosses the boundary", async () => {
    // The wait trusts the player's queue, and a suspended AudioContext holds
    // its level forever. The safety deadline already bounds the handshake;
    // crossing the boundary on it must not leave the queue to play under the
    // consigne whenever the context wakes back up.
    const h = harness();
    await intoClosingMonologue(h);
    const player = h.players[0];

    h.session().examinerVoice("a sentence no speaker will play");
    h.session().finishTurn();
    await settle();
    assert.equal(h.controller.getSnapshot().phase, "monologue", "the queue is not draining");

    h.advanceClockSilently(12);
    await settle();

    assert.equal(h.controller.getSnapshot().phase, "debate", "the deadline still bounds the wait");
    assert.equal(player.interrupts, 1, "the leftover died with its part");
    assert.equal(events(h, "boundary-audio-dropped").length, 1, "and the sitting says so");
  });

  it("advances on the turn alone when nothing was ever audible", async () => {
    // A socket that delivered no audio — or a browser whose speaker never
    // opened — must not spend the safety deadline waiting for silence to
    // drain. An empty queue IS quiet, so the turn completing advances at once:
    // the behaviour every test above this describe has always leaned on.
    const h = harness();
    await intoClosingMonologue(h);

    h.session().finishTurn();
    await settle();

    assert.equal(h.controller.getSnapshot().phase, "debate");
    assert.deepEqual(events(h, "closing-safety-timeout"), [], "and not via the deadline");
  });
});

describe("breaking a silence in the débat (#84, #101)", () => {
  /** Preparation → a débat that has begun, with a microphone that works and a
   *  candidate who is not using it. `voiced.debate = 0` is the whole fiction:
   *  audio keeps arriving, so the stall watchdog stays quiet, and none of it
   *  carries speech. */
  async function intoSilentDebate(h: Harness): Promise<void> {
    h.controller.start();
    await h.controller.advanceEarly();
    await pressRecord(h);
    h.session().candidateSays("Le télétravail a transformé le rapport au bureau.");
    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    await h.controller.advanceEarly();
    await completeClosing(h);
    h.recorder.voiced.debate = 0;
    // The examiner's opening question, delivered and finished. This is what
    // opens the window: the floor is the candidate's from here.
    h.session().examinerSays(
      "Vous dites que le télétravail isole. N'est-ce pas plutôt le bureau ?",
    );
    h.session().finishTurn();
  }

  /** One whole escalation step: the wait, then the examiner's own nudge landing
   *  and ending, which is what re-arms the window for the next one. */
  function silentStep(h: Harness, seconds = 16): void {
    h.advanceClock(seconds);
    h.session().finishTurn();
  }

  /** Both wordings, matched on what they have in common: the first relance of a
   *  silence repeats the question and the later ones ask a new, simpler one
   *  (#101), and both are forbidden to mention the silence. */
  const relances = (h: Harness) =>
    h
      .session()
      .directives.filter((text) => text.includes("Ne fais aucune remarque sur son silence"));
  const presenceChecks = (h: Harness) =>
    h.session().directives.filter((text) => text.includes("Vous m'entendez"));
  /** Everything the watch says, in one list: the débat's own opening directive
   *  is on `directives` too and is not a nudge. */
  const nudges = (h: Harness) => [...presenceChecks(h), ...relances(h)];
  const events = (h: Harness, name: string) =>
    h.controller.getSnapshot().events.filter((event) => event.name === name);

  it("asks whether the candidate is there after ten seconds of nothing", async () => {
    const h = harness();
    await intoSilentDebate(h);

    h.advanceClock(9);
    assert.deepEqual(presenceChecks(h), [], "nine seconds is a candidate thinking");

    h.advanceClock(2);
    assert.equal(presenceChecks(h).length, 1, "eleven is a candidate who may not have heard");
    assert.deepEqual(relances(h), [], "and the question itself waits for the step after");
    assert.equal(events(h, "silence-presence-check").length, 1, "the sitting's log says so");
  });

  it("repeats the question fifteen seconds after that, not ten", async () => {
    const h = harness();
    await intoSilentDebate(h);

    silentStep(h, 11); // « Vous m'entendez ? »
    h.advanceClock(11);
    assert.deepEqual(relances(h), [], "the steps after the first are longer on purpose");

    h.advanceClock(5);
    assert.equal(relances(h).length, 1, "sixteen seconds of silence earns the question again");
    assert.match(relances(h)[0], /reformule autrement ta question précédente/);
  });

  it("keeps asking at whole steps, not on every tick", async () => {
    const h = harness();
    await intoSilentDebate(h);

    h.advanceClock(11);
    h.advanceClock(1);
    h.advanceClock(1);
    assert.equal(presenceChecks(h).length, 1, "a directive is not a promise the model will speak");
    assert.deepEqual(relances(h), []);
  });

  it("does not count the seconds its own question is still being heard", async () => {
    // `onTurnComplete` fires when generation ends, and Gemini generates a turn
    // faster than it is heard. Without this the examiner interrupts itself on
    // every long question.
    const h = harness();
    await intoSilentDebate(h);
    const player = h.players[h.players.length - 1];

    player.speak(true);
    h.advanceClock(30);
    assert.deepEqual(presenceChecks(h), [], "the candidate has been listening, not silent");

    player.speak(false);
    h.advanceClock(11);
    assert.equal(presenceChecks(h).length, 1, "the window opens when the speaker runs out");
  });

  it("does not talk over a candidate who has started answering", async () => {
    const h = harness();
    await intoSilentDebate(h);

    h.advanceClock(6);
    h.session().candidateSays("Alors, je dirais que");
    h.advanceClock(6);

    assert.deepEqual(nudges(h), [], "the answer cancelled the window it was in");
  });

  it("holds the window open on voiced audio alone, before a word is transcribed", async () => {
    // The transcript is the wrong signal on its own: Gemini emits fragments on
    // its own schedule, so a candidate two seconds into an answer may have
    // produced no text yet.
    const h = harness();
    await intoSilentDebate(h);

    h.recorder.voiced.debate = null; // speech is arriving; none of it is transcribed yet
    h.advanceClock(30);

    assert.deepEqual(nudges(h), [], "somebody is speaking into the microphone");
  });

  it("is not held open by a room that is merely not silent (#101)", async () => {
    // The reported failure: thirty seconds after a question, nothing. Any growth
    // at all in the voiced total used to re-anchor the window, and one 40 ms
    // frame is growth — a cough, a chair, a fan over the threshold. A room is
    // never perfectly quiet, so the countdown never finished.
    const h = harness();
    await intoSilentDebate(h);

    h.recorder.voiced.debate = 0.08; // two frames in eleven seconds
    h.advanceClock(11);

    assert.equal(presenceChecks(h).length, 1, "two clicks in eleven seconds is not an answer");
  });

  it("is still held open by somebody actually speaking through it", async () => {
    const h = harness();
    await intoSilentDebate(h);

    h.recorder.voiced.debate = 8; // eight of the eleven seconds carried speech
    h.advanceClock(11);

    assert.deepEqual(nudges(h), [], "that is an answer in progress, not a room");
  });

  it("goes on relancing a silent candidate, and asks about the connection once", async () => {
    // Six steps into one silence. The escalation used to be two of them and then
    // nothing for the rest of the débat; now only the technical check is spent,
    // and the examiner keeps asking about the sujet.
    const h = harness();
    await intoSilentDebate(h);

    silentStep(h, 11);
    for (let step = 0; step < 5; step += 1) silentStep(h);

    assert.equal(presenceChecks(h).length, 1, "« Vous m'entendez ? » opens the silence, once");
    assert.equal(relances(h).length, 5, "and the question keeps coming back");
    assert.deepEqual(
      events(h, "silence-relance").map((event) => event.detail),
      [1, 2, 3, 4, 5].map((attempt) => JSON.stringify({ attempt, waitedSeconds: 16 })),
      "the log counts them and says what each one waited through, which is what" +
        " replaced the stand-down it used to record",
    );
  });

  it("stops asking for a rephrasing once the relance is repeating itself", async () => {
    // A relance that always said "reformule ta question précédente" would have
    // the model rephrase its own rephrasing, on a context window that is
    // sliding.
    const h = harness();
    await intoSilentDebate(h);

    silentStep(h, 11);
    silentStep(h);
    silentStep(h);

    assert.match(relances(h)[0], /reformule autrement ta question précédente/);
    assert.match(relances(h)[1], /pose une question NOUVELLE/, "the next one changes the ask");
  });

  it("prints each nudge as its own turn, not as more of the question", async () => {
    // The transcript coalesces consecutive fragments from one speaker, which is
    // right for the fragments of a sentence and wrong for two interventions ten
    // seconds apart. Welded, the candidate reads one compound question — on the
    // live feed while it happens and on the correction afterwards.
    const h = harness();
    await intoSilentDebate(h);

    h.advanceClock(11);
    h.session().examinerSays("Vous m'entendez ?");
    h.session().finishTurn();
    h.advanceClock(16);
    h.session().examinerSays("Autrement dit :");
    h.session().examinerSays(" y perd-on des collègues ?");

    const debate = h.controller
      .getSnapshot()
      .transcript.filter((entry) => entry.phase === "debate" && entry.speaker === "examiner");

    assert.equal(debate.length, 3, "the question, the check, and the relance are three turns");
    assert.match(
      debate[0].text,
      /N'est-ce pas plutôt le bureau \?$/,
      "the question ends where it did",
    );
    assert.equal(
      debate[2].text,
      "Autrement dit : y perd-on des collègues ?",
      "and the relance's own fragments still merge into one turn of its own",
    );
    assert.ok(
      debate[2].timestamp > debate[1].timestamp,
      "stamped when it was spoken, not when the question was",
    );
  });

  it("starts the escalation over once the candidate answers", async () => {
    const h = harness();
    await intoSilentDebate(h);

    silentStep(h, 11);
    h.session().candidateSays("Pardon, je réfléchissais.");
    h.session().finishTurn();
    h.advanceClock(11);

    assert.equal(
      presenceChecks(h).length,
      2,
      "a fresh silence opens the way the first one did, ten seconds in",
    );
    assert.deepEqual(relances(h), [], "the question itself has not been repeated yet");
  });

  it("gives way to the closing handshake on the tick that crosses both deadlines", async () => {
    // The one tick where the silence window and the part's own time-up land
    // together. Both would speak, and two directives with no turn boundary
    // between them blend into one sentence — on the very turn the controller
    // waits for to let the candidate's last transcription arrive.
    const h = harness();
    await intoSilentDebate(h);

    h.advanceClock(PHASE_DURATIONS.debate);

    assert.deepEqual(relances(h), [], "the part is ending; this is no moment to relance");
    assert.deepEqual(presenceChecks(h), []);
    assert.match(
      h.session().directives[h.session().directives.length - 1],
      /Le temps de l'épreuve est écoulé/,
      "the closing sentence is the last thing asked for, and asked for alone",
    );
  });

  it("does not weld the closing sentence onto the relance nobody answered", async () => {
    // The other end of the same defect, and the one this change makes likely:
    // the relances now run right up to time-up, so the last transcript entry
    // before the closing handshake is reliably an unanswered examiner turn.
    // Merged, « le temps de l'épreuve est écoulé » is read back as the tail of a
    // question, under that question's timestamp.
    //
    // The examiner is transcribed after each nudge, which is what production
    // does and what spends the pending break: a test where nothing answers the
    // directives would leave the flag set and pass without proving anything.
    const h = harness();
    await intoSilentDebate(h);

    h.advanceClock(11);
    h.session().examinerSays("Vous m'entendez ?");
    h.session().finishTurn();
    for (let step = 0; step < 2; step += 1) {
      h.advanceClock(16);
      h.session().examinerSays(`Reformulons, ${step + 1}.`);
      h.session().finishTurn();
    }
    h.advanceClock(PHASE_DURATIONS.debate);
    h.session().examinerSays("Merci, le temps de l'épreuve est écoulé.");

    const examiner = h.controller
      .getSnapshot()
      .transcript.filter((entry) => entry.phase === "debate" && entry.speaker === "examiner");
    const last = examiner[examiner.length - 1];

    assert.equal(
      last.text,
      "Merci, le temps de l'épreuve est écoulé.",
      "the closing sentence is a turn, not the end of the last relance",
    );
    assert.equal(examiner.length, 5, "the question, the check, two relances, and the closing line");
  });

  it("does not spend a step into a socket that is not up", async () => {
    // `SessionManager.sendDirective` drops a directive on a down socket without
    // throwing, so a step spent mid-reconnect is spent unheard, and the
    // candidate would be left with a silence nobody ever broke.
    const h = harness();
    await intoSilentDebate(h);

    h.session().emitStates("reconnecting");
    h.advanceClock(30);
    assert.deepEqual(nudges(h), [], "nothing was said, so nothing was spent");

    h.session().emitStates("connected");
    h.advanceClock(11);
    assert.equal(presenceChecks(h).length, 1, "and the candidate gets it once they can hear it");

    silentStep(h);
    assert.equal(relances(h).length, 1, "with the whole escalation still intact");
  });

  it("waits for the question to be heard, not for it to be generated", async () => {
    // Gemini generates a turn several times faster than it is spoken, so the
    // player is still working through a long question long after the socket has
    // finished sending it. A window that opened at the end of generation put
    // « Vous m'entendez ? » in the middle of the examiner's own sentence.
    const h = harness();
    await intoSilentDebate(h);
    const player = h.players[h.players.length - 1];

    // Twenty seconds of question queued, and playing: the queue drains a
    // second per second, which is what earns the hold.
    for (let chunk = 0; chunk < 20; chunk += 1) player.enqueue(`chunk-${chunk}`);
    for (let second = 0; second < 20; second += 1) {
      h.advanceClock(1);
      player.drain();
    }
    assert.deepEqual(nudges(h), [], "the candidate was listening to the question");

    h.advanceClock(11); // the queue has run out: the floor is theirs from here
    assert.equal(presenceChecks(h).length, 1, "and the window starts when the speaker does");
  });

  it("stops waiting for queued audio that is not draining, and says so (#94)", async () => {
    // The sitting this is written against: the question printed at 0:02,
    // nothing in the speakers, and no nudge by 0:57. A suspended AudioContext
    // schedules every chunk and plays none, so the speaking flag sticks on and
    // the buffer freezes above zero — and the watch waited for that audio for
    // the rest of the part. A frozen queue is not a candidate listening.
    const h = harness();
    await intoSilentDebate(h);
    const player = h.players[h.players.length - 1];
    const resumesBefore = player.resumes;

    for (let chunk = 0; chunk < 20; chunk += 1) player.enqueue(`chunk-${chunk}`);
    player.speak(true); // the flag sticks on too, exactly as the dead context leaves it

    for (let tick = 0; tick < 8; tick += 1) h.advanceClock(1);
    assert.equal(events(h, "examiner-playback-stalled").length, 1, "the stall is on the record");
    assert.equal(player.resumes, resumesBefore + 1, "and a resume was attempted");

    for (let tick = 0; tick < 11; tick += 1) h.advanceClock(1);
    assert.equal(
      presenceChecks(h).length,
      1,
      "then the escalation runs: « Vous m'entendez ? » is the right question for a dead speaker",
    );
  });

  it("does not read Gemini outrunning the speaker as a stall", async () => {
    // While a turn streams in, the queue GROWS — generation is several times
    // faster than real time, so a 15-second question arrives in about three.
    // The queue never drops during that burst, and the stall threshold is sized
    // so it does not have to: the burst ends well inside it, and the draining
    // that follows is the drop that keeps the hold honest.
    const h = harness();
    await intoSilentDebate(h);
    const player = h.players[h.players.length - 1];

    for (let second = 0; second < 3; second += 1) {
      for (let chunk = 0; chunk < 5; chunk += 1) player.enqueue(`burst-${second}-${chunk}`);
      h.advanceClock(1);
      player.drain();
    }
    for (let second = 0; second < 12; second += 1) {
      h.advanceClock(1);
      player.drain();
    }

    assert.deepEqual(events(h, "examiner-playback-stalled"), [], "that was a turn, playing");
    assert.deepEqual(nudges(h), []);
  });

  it("lets a drop end the stall, and growth not (#94)", async () => {
    // Every relance sent into a stall enqueues more audio. If growth counted as
    // recovery, the nudge would re-arm the very hold that swallowed the last
    // one; only the thing a dead speaker cannot do — actually draining — hands
    // the hold back.
    const h = harness();
    await intoSilentDebate(h);
    const player = h.players[h.players.length - 1];

    for (let chunk = 0; chunk < 5; chunk += 1) player.enqueue(`chunk-${chunk}`);
    for (let tick = 0; tick < 8; tick += 1) h.advanceClock(1);
    assert.equal(events(h, "examiner-playback-stalled").length, 1);

    player.enqueue("the relance, into the same dead speaker");
    h.advanceClock(11);
    assert.deepEqual(events(h, "examiner-playback-recovered"), [], "growth is not recovery");

    player.drain(2); // the context came back: audio is reaching the speaker again
    h.advanceClock(1);
    assert.equal(events(h, "examiner-playback-recovered").length, 1, "a drop is");
  });

  it("says what a nudge waited through, so a long gap can be read afterwards", async () => {
    // The report that produced #101's second round was a transcript with fifty
    // seconds between two examiner turns, and no way to tell which part of it
    // was the window, which was the question still being spoken, and which was
    // the model taking its time. The nudge now carries its own arithmetic.
    const h = harness();
    await intoSilentDebate(h);
    const player = h.players[h.players.length - 1];

    player.speak(true);
    h.advanceClock(20); // the examiner's question is still coming out of the speaker
    player.speak(false);
    h.advanceClock(11);

    const detail = events(h, "silence-presence-check")[0]?.detail ?? "";
    assert.match(detail, /"waitedSeconds":31/, "the whole armed stretch, not just the step");
    assert.match(detail, /"examiner-speaking":/, "and what held it for the other twenty");
  });

  it("says why it has been quiet, once, when something keeps holding the window open", async () => {
    // The failure this could not explain: every guard here re-anchors the window
    // silently, so a watch that is armed and says nothing for a minute leaves no
    // trace at all. It now reports what has been holding it — diagnostics, and
    // nothing branches on them.
    const h = harness();
    await intoSilentDebate(h);
    const player = h.players[h.players.length - 1];

    player.speak(true);
    h.advanceClock(46);
    h.advanceClock(46);

    const held = events(h, "silence-watch-held");
    assert.equal(held.length, 1, "said once per armed watch, not once per tick");
    assert.match(held[0].detail ?? "", /"examiner-speaking":/, "and it names what held it");
  });

  it("says nothing over a microphone that has stopped delivering", async () => {
    // No voiced audio, but the reason is on screen already and the candidate
    // could not answer over that device anyway.
    const h = harness();
    await intoSilentDebate(h);

    h.advanceClockSilently(11);

    assert.deepEqual(nudges(h), []);
    assert.ok(h.controller.getSnapshot().micError, "the candidate was told the real thing instead");
  });

  it("never does any of this during the monologue", async () => {
    // Twice out: the prompt says the silences belong to the candidate, and the
    // transport has no turn boundary to hang this on for the whole phase.
    const h = harness();
    h.controller.start();
    await h.controller.advanceEarly();
    await pressRecord(h);
    h.recorder.voiced.monologue = 0;

    h.session().finishTurn();
    h.advanceClock(60);

    assert.deepEqual(h.session().directives, [], "the examiner listens, and that is the exercise");
  });
});

describe("an examiner that says goodbye seven minutes early (#85)", () => {
  /** Preparation to a débat that has begun, clock at zero. Unlike #84's silent
   *  débat this one has a candidate who speaks, because the failure being
   *  described happens in the middle of a working exchange. */
  async function intoDebate(h: Harness): Promise<void> {
    h.controller.start();
    await h.controller.advanceEarly();
    await pressRecord(h);
    h.session().candidateSays("Le télétravail a transformé le rapport au bureau.");
    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    await h.controller.advanceEarly();
    await completeClosing(h);
  }

  /** Nobody is making a sound: the voiced total stops growing while audio keeps
   *  arriving, so the stall watchdog stays quiet. Two ticks, because the floor
   *  has to have been quiet for two seconds and one tick is not a duration. */
  const quiet = (h: Harness, seconds: number) => {
    h.recorder.voiced.debate = 0;
    h.advanceClock(seconds - 3);
    h.advanceClock(3);
  };

  const cues = (h: Harness) =>
    h.session().directives.filter((text) => text.includes("Information de service"));
  const recoveries = (h: Harness) =>
    h.session().directives.filter((text) => text.includes("n'est PAS terminée"));
  const events = (h: Harness, name: string) =>
    h.controller.getSnapshot().events.filter((event) => event.name === name);

  describe("lending it the clock it does not have", () => {
    it("says how much is left, every three minutes, and never out loud", async () => {
      const h = harness();
      await intoDebate(h);

      quiet(h, 120);
      assert.deepEqual(cues(h), [], "two minutes into a thirteen-minute part is not news");

      h.advanceClock(61);
      assert.equal(cues(h).length, 1, "three minutes in, the examiner is told where it is");
      assert.match(cues(h)[0], /environ 10 minutes/);
      assert.match(cues(h)[0], /ne jamais prononcer/, "for it, not for the candidate");
      assert.equal(events(h, "debate-time-cue").length, 1, "and the sitting's log says so");
    });

    it("waits for a pause rather than talking over the candidate", async () => {
      // A cue goes out through `sendDirective`, which is `sendRealtimeInput`:
      // the examiner WILL speak in response. A candidate interrupted mid-argument
      // loses a graded answer, and the cue loses nothing by being late.
      const h = harness();
      await intoDebate(h);

      h.advanceClock(120); // voiced audio keeps arriving: somebody is talking
      h.advanceClock(70);
      assert.deepEqual(cues(h), [], "the candidate is three minutes into an argument");

      // Nine, not the bare two-second pause: an answer nobody has replied to
      // holds the floor for the reply the examiner may owe (#130).
      quiet(h, 9);
      assert.equal(cues(h).length, 1, "and it arrives at the first settled pause");
    });

    it("waits out the reply the examiner may owe before cueing (#130)", async () => {
      // Between a candidate finishing an answer and the examiner's rebound
      // reaching the speaker, nobody is audible: voice-activity detection has
      // ended the candidate's turn and Gemini is already generating. Two quiet
      // seconds there used to read as a free floor, and a cue sent into it
      // landed beside the reply — two examiner questions back to back.
      const h = harness();
      await intoDebate(h);

      h.advanceClock(120);
      h.advanceClock(70); // the candidate talks through the three-minute boundary
      quiet(h, 4);
      assert.deepEqual(cues(h), [], "four quiet seconds may be a reply on its way");

      h.advanceClock(5);
      assert.equal(cues(h).length, 1, "nine is a reply that is not coming");
    });

    it("does not hold the cue once the examiner has replied", async () => {
      // The hold is for the gap before a rebound, not a new floor rule: an
      // answer the examiner has already replied to leaves the ordinary
      // two-second pause in charge again.
      const h = harness();
      await intoDebate(h);

      h.advanceClock(120);
      h.advanceClock(70);
      h.session().examinerSays("Dans ce cas, le lien social se construit où ?");
      h.session().finishTurn();

      quiet(h, 4);
      assert.equal(cues(h).length, 1, "nothing is owed, so the pause is enough");
    });

    it("owes one cue for a stretch it could not speak into, not a queue of them", async () => {
      const h = harness();
      await intoDebate(h);

      // Seven minutes of unbroken candidate, across two three-minute boundaries.
      h.advanceClock(200);
      h.advanceClock(220);
      quiet(h, 9);

      assert.equal(cues(h).length, 1, "one cue, not the two the grid says are due");
      assert.match(cues(h)[0], /environ 6 minutes/, "and it names the time now, not then");
    });

    it("says nothing in the last two minutes, where the closing handshake belongs", async () => {
      // A cue there would land beside the closing directive with no turn
      // boundary between them, which is the blend #84's ordering is built to
      // avoid.
      const h = harness();
      await intoDebate(h);

      quiet(h, 690);
      const sent = cues(h).length;
      quiet(h, 10);
      assert.equal(cues(h).length, sent, "nothing more is due before the end");
      assert.ok(
        !cues(h).some((text) => /environ 1 minutes?\b/.test(text)),
        "and no cue ever counted down to the close",
      );
    });

    it("holds its tongue while the examiner is still audible", async () => {
      const h = harness();
      await intoDebate(h);
      const player = h.players[h.players.length - 1];

      player.speak(true);
      quiet(h, 190);
      assert.deepEqual(cues(h), [], "its own question is still coming out of the speaker");

      player.speak(false);
      quiet(h, 6);
      assert.equal(cues(h).length, 1, "the floor is free when the speaker runs out");
    });

    it("sends one directive on a tick where a relance is also due, not two", async () => {
      // Both speak, and two `sendRealtimeInput` texts with no turn boundary
      // between them is one blended sentence.
      const h = harness();
      await intoDebate(h);

      quiet(h, 170);
      // The examiner asks something at 2:50, and the candidate says nothing.
      h.session().examinerSays("Et le lien social, il se construit où ?");
      h.session().finishTurn();
      h.advanceClock(11);

      assert.equal(cues(h).length, 1, "three minutes have passed and the cue is due");
      assert.equal(
        h.session().directives.filter((text) => text.includes("Relance-le sur le fond")).length,
        0,
        "and the eight-second relance waits its turn",
      );
    });

    it("never does any of this during the monologue", async () => {
      const h = harness();
      h.controller.start();
      await h.controller.advanceEarly();
      await pressRecord(h);
      h.recorder.voiced.monologue = 0;

      h.advanceClock(180);
      h.advanceClock(180);

      assert.deepEqual(
        h.session().directives,
        [],
        "the examiner listens, and that is the exercise",
      );
    });
  });

  describe("hearing it take its leave anyway", () => {
    const GOODBYE =
      "Je vous remercie pour vos réponses. Nous allons maintenant passer à la troisième partie de l'épreuve. Vous pouvez disposer.";

    it("does not let it end the part, and puts the débat back on its feet", async () => {
      const h = harness();
      await intoDebate(h);
      h.advanceClock(360);

      h.session().examinerSays(GOODBYE);
      assert.equal(
        h.controller.getSnapshot().phase,
        "debate",
        "the timer ends a part, not the model",
      );
      assert.deepEqual(recoveries(h), [], "and nothing is said over the sentence it is answering");
      assert.equal(events(h, "examiner-early-closing").length, 1, "but the log has it already");

      h.session().finishTurn();
      assert.equal(recoveries(h).length, 1, "answered at the first boundary there is");
      assert.match(recoveries(h)[0], /environ 7 minutes/);
      assert.equal(h.controller.getSnapshot().phase, "debate", "with the part still running");
    });

    it("hears a goodbye split across two transcription fragments, once", async () => {
      const h = harness();
      await intoDebate(h);
      h.advanceClock(360);

      h.session().examinerSays("Je vous remercie. Vous pouvez");
      assert.deepEqual(events(h, "examiner-early-closing"), [], "half of it is not a goodbye");
      h.session().examinerSays(" quitter la salle.");

      assert.equal(
        events(h, "examiner-early-closing").length,
        1,
        "and the other half completes it",
      );
    });

    it("stops answering after twice, and keeps logging", async () => {
      // A model that has decided the épreuve is over may say so again, and an app
      // that contradicts it every time is two machines arguing in front of the
      // candidate.
      const h = harness();
      await intoDebate(h);
      h.advanceClock(360);

      for (let turn = 0; turn < 4; turn += 1) {
        h.session().examinerSays("Au revoir.");
        h.session().finishTurn();
      }

      assert.equal(events(h, "examiner-early-closing").length, 4, "every one is on the record");
      assert.equal(recoveries(h).length, 2, "only the first two are answered");
      assert.match(
        events(h, "examiner-early-closing")[3].detail ?? "",
        /"answered":false/,
        "and the log says which were not",
      );
    });

    it("does not re-count a goodbye off its own stale text when the examiner merely keeps talking", async () => {
      // The corner past the recovery cap: nothing is sent, so no turn break is
      // pending, and an examiner that speaks again with no candidate in
      // between coalesces into the goodbye's own entry. The watch re-reads
      // the merged text — and the phrase it finds there must be recognised as
      // the goodbye already counted, not a new one.
      const h = harness();
      await intoDebate(h);
      h.advanceClock(360);

      for (let turn = 0; turn < 3; turn += 1) {
        h.session().examinerSays("Au revoir.");
        h.session().finishTurn();
      }
      assert.equal(events(h, "examiner-early-closing").length, 3);
      assert.equal(recoveries(h).length, 2, "the third went unanswered — no break pending");

      // Coalesces into the third goodbye's entry; the merged text still
      // contains « au revoir », but no NEW goodbye was spoken.
      h.session().examinerSays(" Très bien, je vous écoute encore.");
      assert.equal(
        events(h, "examiner-early-closing").length,
        3,
        "stale goodbye text is not counted again",
      );

      // A repeated goodbye in the same merged entry is new text and still
      // counts — the guarantee the every-one-on-the-record test above pins.
      h.session().examinerSays(" Au revoir.");
      assert.equal(events(h, "examiner-early-closing").length, 4, "a genuine repeat still counts");
    });

    it("leaves the closing sentence the app asked for alone", async () => {
      // The same words, and the difference is who asked: inside a closing
      // handshake this IS the handshake working.
      const h = harness();
      await intoDebate(h);
      h.advanceClock(PHASE_DURATIONS.debate + 1);

      h.session().examinerSays("Je vous remercie, l'épreuve est terminée. Au revoir.");
      assert.deepEqual(events(h, "examiner-early-closing"), []);
      assert.deepEqual(recoveries(h), []);

      await completeClosing(h);
      assert.equal(h.controller.getSnapshot().phase, "finished");
      assert.equal(
        h.finished[0]?.earlyClosingCount,
        0,
        "an ordinary sitting reports no incident (#92)",
      );
    });

    it("carries every goodbye out of the tab on the finish payload (#92)", async () => {
      // The event log below dies with the page; this is the number that does
      // not. Three goodbyes, of which only two were answered — the count is of
      // the fault, not of the recovery, so the third is in it.
      const h = harness();
      await intoDebate(h);
      h.advanceClock(360);

      for (let turn = 0; turn < 3; turn += 1) {
        h.session().examinerSays("Au revoir.");
        h.session().finishTurn();
      }
      assert.equal(recoveries(h).length, 2, "the third goodbye went unanswered");

      // The clock runs out and the app opens the real closing — whose goodbye
      // must NOT be counted, or every sitting would report an incident.
      h.advanceClock(PHASE_DURATIONS.debate);
      await completeClosing(h);

      assert.equal(h.controller.getSnapshot().phase, "finished");
      assert.equal(h.finished[0]?.earlyClosingCount, 3, "answered or not, all three are counted");

      // The invariant the finish route's clamp leans on: a genuine payload's
      // transcript backs its count in MAGNITUDE, not just in presence, because
      // detection ran on these very turns with the same phrase list and each
      // answered goodbye's recovery directive broke the next one into its own
      // entry. If this ever fails, the route is shrinking genuine claims.
      // (An UNANSWERED repeat goodbye — past the recovery cap — can coalesce
      // into the previous entry and be under-counted; that is the clamp's
      // documented trade, not a failure of this invariant.)
      assert.ok(
        countClosingTurns(h.finished[0].transcript) >= h.finished[0].earlyClosingCount,
        "the submitted transcript backs the full count",
      );
    });
  });
});

describe("where a phase started, in the transcript's own time base (#70)", () => {
  /** Preparation → monologue, clock running. */
  async function intoMonologue(h: Harness): Promise<void> {
    h.controller.start();
    await h.controller.advanceEarly();
    await pressRecord(h);
    h.controller.startSpeaking();
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function intoDebate(h: Harness): Promise<void> {
    await intoMonologue(h);
    h.session().candidateSays("Le télétravail a transformé le rapport au bureau.");
    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    await h.controller.advanceEarly();
    await completeClosing(h);
  }

  it("is null before any clock has started", () => {
    const h = harness();
    assert.equal(h.controller.getSnapshot().phaseStartedAt, null);
  });

  it("subtracting it from a turn's timestamp gives the phase clock", async () => {
    // The whole reason it is exposed. `elapsed` answers "how long has this phase
    // run" and `TranscriptEntry.timestamp` counts from the exam; this is the one
    // number that converts between them, so the débat's feed can stamp a turn
    // with the count the scene's clock is already showing.
    const h = harness();
    await intoDebate(h);

    h.advanceClock(45);
    h.session().examinerSays("Vous dites que c'est un progrès. Vraiment ?");
    // The feed withholds an opening question nobody has heard yet, so let this
    // one be heard — the test is about the stamp, not the hold.
    h.players[h.players.length - 1].speak(true);

    const state = h.controller.getSnapshot();
    const turn = state.transcript[state.transcript.length - 1];
    assert.equal(turn.phase, "debate");
    assert.notEqual(state.phaseStartedAt, null);
    assert.equal(
      Math.floor((turn.timestamp - state.phaseStartedAt!) / 1000),
      state.elapsed,
      "the stamp and the clock the candidate is looking at are the same count",
    );
  });

  it("re-anchors on each phase, so the débat does not inherit the monologue's", async () => {
    const h = harness();
    await intoMonologue(h);
    const monologue = h.controller.getSnapshot().phaseStartedAt;

    h.session().candidateSays("Le télétravail a transformé le rapport au bureau.");
    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    await h.controller.advanceEarly();
    await completeClosing(h);

    const debate = h.controller.getSnapshot().phaseStartedAt;
    assert.notEqual(debate, null);
    assert.ok(debate! > monologue!, "the débat starts after the monologue did");
  });
});

describe("the last question and the call of time (#108)", () => {
  /** Preparation to a débat that has begun, clock at zero, with a candidate who
   *  talks: the last-question announcement exists for a working exchange, not
   *  for #84's silent room. */
  async function intoDebate(h: Harness): Promise<void> {
    h.controller.start();
    await h.controller.advanceEarly();
    await pressRecord(h);
    h.session().candidateSays("Le télétravail a transformé le rapport au bureau.");
    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    await h.controller.advanceEarly();
    await completeClosing(h);
  }

  /** Nobody is making a sound. Two ticks, because the floor has to have been
   *  quiet for two seconds and one tick is not a duration. */
  const quiet = (h: Harness, seconds: number) => {
    h.recorder.voiced.debate = 0;
    h.advanceClock(seconds - 3);
    h.advanceClock(3);
  };

  const announcements = (h: Harness) =>
    h.session().directives.filter((text) => text.includes("dernière question"));
  const events = (h: Harness, name: string) =>
    h.controller.getSnapshot().events.filter((event) => event.name === name);

  it("announces the last question, aloud, when the grid stands down at two minutes", async () => {
    const h = harness();
    await intoDebate(h);

    quiet(h, 690);
    assert.equal(announcements(h).length, 1, "the two-minute crossing is the moment");
    assert.match(announcements(h)[0], /à voix haute/, "this one the candidate is meant to hear");
    assert.match(announcements(h)[0], /aucun chiffre/, "but never as a number");
    assert.equal(events(h, "debate-last-question").length, 1, "and the sitting's log says so");

    quiet(h, 20);
    assert.equal(announcements(h).length, 1, "a last question is only ever one");
  });

  it("waits for a pause rather than talking over the candidate's answer", async () => {
    // Same rule as every cue: the directive makes the examiner speak, and a
    // candidate interrupted mid-argument loses a graded answer.
    const h = harness();
    await intoDebate(h);

    h.advanceClock(680); // voiced audio keeps arriving: somebody is talking
    h.advanceClock(20);
    assert.deepEqual(announcements(h), [], "the candidate is mid-answer at the crossing");

    // Nine, not the bare two-second pause: the announcement waits out the reply
    // the examiner may owe that answer, like every cue does (#130).
    quiet(h, 9);
    assert.equal(announcements(h).length, 1, "and it arrives at the first settled pause");
  });

  it("drops it, and says so, when the floor never frees in time", async () => {
    // Under the cutoff a last question no longer fits in front of the closing
    // directive, so the candidate keeps their uninterrupted final answer. The
    // log carries the drop: a sitting where the warning never happened should
    // say so rather than read as covered.
    const h = harness();
    await intoDebate(h);

    h.advanceClock(690); // talking through the whole window
    h.advanceClock(50);
    quiet(h, 6);

    assert.deepEqual(announcements(h), [], "too late to ask and still hear an answer");
    assert.equal(events(h, "debate-last-question-missed").length, 1);
    assert.equal(events(h, "debate-last-question").length, 0);
  });

  it("keeps the promise when the examiner says goodbye after it", async () => {
    // « Une dernière question » followed by a recovery demanding a fresh
    // objection is the app breaking its own announcement through the
    // examiner's mouth. After the announcement, a goodbye is still
    // contradicted, but the examiner is sent back to the answer it heard.
    const h = harness();
    await intoDebate(h);
    quiet(h, 690);
    assert.equal(announcements(h).length, 1);

    h.session().examinerSays("Merci beaucoup, l'épreuve est terminée. Au revoir.");
    h.session().finishTurn();

    const recoveries = h.session().directives.filter((text) => text.includes("n'est PAS terminée"));
    assert.equal(recoveries.length, 1, "the goodbye is still contradicted");
    assert.match(recoveries[0], /Rebondis/, "but towards the answer, not a fresh objection");
    assert.ok(
      !recoveries[0].includes("nouvelle objection"),
      "a new objection would break « une dernière question »",
    );
  });

  it("keeps the promise when the silence outlives the announcement (#130)", async () => {
    // The escalation's later steps order « une question NOUVELLE », which after
    // « une dernière question » is the app breaking its own announcement
    // through the examiner's mouth — and an invitation to frame the fresh
    // question as « une dernière question » a second time. Once the promise is
    // made, every relance re-asks the promised question instead.
    const h = harness();
    await intoDebate(h);
    quiet(h, 690);
    assert.equal(announcements(h).length, 1);
    // The announcement's own turn ends: the floor is the candidate's, and the
    // silence watch opens on it.
    h.session().finishTurn();

    quiet(h, 11); // « Vous m'entendez ? »
    h.session().finishTurn();
    quiet(h, 16); // the first relance
    h.session().finishTurn();
    quiet(h, 16); // the step that used to demand a fresh question

    const reasks = h
      .session()
      .directives.filter((text) => text.includes("Repose cette même question"));
    assert.equal(reasks.length, 2, "every step after the announcement re-asks it");
    assert.ok(
      !h.session().directives.some((text) => text.includes("question NOUVELLE")),
      "no directive asks for a fresh question after « une dernière question »",
    );
    assert.equal(events(h, "debate-last-question").length, 1, "and it is only ever announced once");
  });

  it("asks for a fresh objection when the goodbye comes before the announcement", async () => {
    // The other side of the same switch: with minutes left and no promise made,
    // the recovery keeps its original wording (#85).
    const h = harness();
    await intoDebate(h);
    h.advanceClock(360);

    h.session().examinerSays("Merci beaucoup, l'épreuve est terminée. Au revoir.");
    h.session().finishTurn();

    const recoveries = h.session().directives.filter((text) => text.includes("n'est PAS terminée"));
    assert.equal(recoveries.length, 1);
    assert.match(recoveries[0], /nouvelle objection/);
  });

  it("calls time while the débat's clock still runs", async () => {
    // Sent at 0:00 the examiner only STARTS its sentence there, so « le temps
    // est écoulé » was always heard after time was up. The directive now leads
    // the clock by ten seconds; the teardown still waits on the turn.
    const h = harness();
    await intoDebate(h);

    h.advanceClock(PHASE_DURATIONS.debate - 11);
    assert.equal(h.controller.getSnapshot().closing, false, "eleven seconds out is not the call");

    h.advanceClock(1);
    assert.equal(h.controller.getSnapshot().closing, true, "ten seconds out is");
    assert.equal(h.controller.getSnapshot().phase, "debate", "and the part is still running");
    assert.match(
      h.session().directives[h.session().directives.length - 1],
      /Le temps de l'épreuve est écoulé/,
    );
  });

  it("does not lead the monologue's clock", async () => {
    // Every second before the monologue's boundary is the candidate's graded
    // monologue; an examiner cutting in early there takes speaking time the
    // grille counts.
    const h = harness();
    h.controller.start();
    await h.controller.advanceEarly();
    await pressRecord(h);
    h.session().candidateSays("Le télétravail a transformé le rapport au bureau.");

    h.advanceClock(PHASE_DURATIONS.monologue - 5);
    assert.equal(h.controller.getSnapshot().closing, false, "five seconds still belong to them");

    h.advanceClock(5);
    assert.equal(h.controller.getSnapshot().closing, true, "the boundary itself has not moved");
  });
});

describe("which examiner the controller's sessions are created for (#99)", () => {
  /** Preparation → monologue, clock running. */
  async function intoMonologue(h: Harness): Promise<void> {
    h.controller.start();
    await h.controller.advanceEarly();
    await pressRecord(h);
    h.controller.startSpeaking();
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("hands the choice made during the préparation to both phases' sessions", async () => {
    // The choice lands AFTER the controller is built — the picker lives on the
    // préparation screen — which is exactly why it is a setter and a factory
    // argument rather than a constructor option: a closure captured at
    // construction would open the monologue on a stale choice.
    const h = harness();
    h.controller.start();
    h.controller.setExaminerModel("gemini-2.5-flash-native-audio-preview-12-2025");

    await intoMonologue(h);
    h.session().candidateSays("Le télétravail a transformé le rapport au bureau.");
    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    await h.controller.advanceEarly();
    await completeClosing(h);

    assert.equal(h.sessions.length, 2, "one session per speaking phase");
    assert.deepEqual(h.sessionModels, [
      "gemini-2.5-flash-native-audio-preview-12-2025",
      "gemini-2.5-flash-native-audio-preview-12-2025",
    ]);
  });

  it("leaves the examiner to the server when nothing was ever chosen", async () => {
    const h = harness();
    await intoMonologue(h);
    assert.deepEqual(h.sessionModels, [undefined]);
  });
});

describe("the dev time-skip (#149)", () => {
  /** Preparation → a monologue that has begun. */
  async function intoMonologue(h: Harness): Promise<void> {
    h.controller.start();
    await h.controller.advanceEarly();
    await pressRecord(h);
  }

  /** …and on into a débat that has begun, the spoken way. */
  async function intoDebate(h: Harness): Promise<void> {
    await intoMonologue(h);
    h.session().candidateSays("Le télétravail a transformé le rapport au bureau.");
    h.advanceClock(MONOLOGUE_MIN_SECONDS + 10);
    await h.controller.advanceEarly();
    await completeClosing(h);
  }

  it("advances the part's clock and moves nothing else", async () => {
    // The port's whole design (see the reference's admin time-skip): only the
    // start stamp is rewound, so the derived elapsed jumps while the words
    // already said keep their timestamps and the microphone keeps recording.
    const h = harness();
    await intoMonologue(h);
    h.session().candidateSays("Premièrement, il supprime des trajets subis.");
    h.advanceClock(10);
    const stamped = h.controller.getSnapshot().transcript[0].timestamp;

    h.controller.devSkipTime(120);

    const state = h.controller.getSnapshot();
    assert.equal(state.elapsed, 130, "ten real seconds plus the skipped two minutes");
    assert.equal(state.transcript[0].timestamp, stamped, "no word moved");
    assert.equal(h.recorder.paused, false, "the microphone was never touched");
  });

  it("reaches time-up through the real closing handshake, never around it", async () => {
    // « Fin du temps ». Nothing here bypasses the finalize path: the next tick
    // is the ordinary time-up, so the examiner is asked for its closing
    // sentence and the part ends the way a genuine timeout ends it.
    const h = harness();
    await intoDebate(h);

    h.controller.devSkipToEnd();

    assert.equal(h.controller.getSnapshot().closing, true, "the handshake is running");
    assert.ok(
      h.session().directives.some((text) => text.includes("Le temps de l'épreuve est écoulé")),
      "the examiner was asked to conclude, exactly as at a real 0:00",
    );
    await completeClosing(h);
    assert.equal(h.controller.getSnapshot().phase, "finished");
  });

  it("carries a skipped monologue into the débat, closing sentence and all", async () => {
    const h = harness();
    await intoMonologue(h);
    h.advanceClock(30);

    h.controller.devSkipToEnd();

    assert.equal(h.controller.getSnapshot().closing, true);
    await completeClosing(h);
    assert.equal(h.controller.getSnapshot().phase, "debate");
  });

  it("lands a skip in the cue grid's window and gets one cue, not a backlog", async () => {
    // Jumping over a three-minute boundary must not fire the cues the skip
    // leapt past one after another — the grid is an index, not a count, and a
    // skip proves that design the same way a held-back cue does.
    const h = harness();
    await intoDebate(h);
    h.recorder.voiced.debate = 0;

    h.controller.devSkipTime(185);
    h.advanceClockSilently(3);

    const cues = h.session().directives.filter((text) => text.includes("Information de service"));
    assert.equal(cues.length, 1, "one cue for one boundary crossed");
  });

  it("still refuses to advance a silent monologue: the hold outranks the skip", async () => {
    // The skip exercises the real end-game, and the real end-game refuses a
    // monologue with no speech on it (#39). A dev tool that skipped past that
    // hold would be testing a path no candidate can take.
    const h = harness();
    await intoMonologue(h);
    h.recorder.voiced.monologue = 0;
    h.advanceClock(30);

    h.controller.devSkipToEnd();

    const state = h.controller.getSnapshot();
    assert.equal(state.monologueHeld, true, "held, exactly as a waited-out clock is");
    assert.equal(state.phase, "monologue");
    assert.equal(state.closing, false);
  });

  it("does nothing on an armed part, during a closing, or while the monologue is held", async () => {
    const h = harness();
    h.controller.start();
    await h.controller.advanceEarly();
    // Armed: « Enregistrer » has not been pressed, so there is no clock to move.
    h.controller.devSkipTime(120);
    assert.equal(h.controller.getSnapshot().elapsed, 0, "an armed part has no clock to skip");

    await pressRecord(h);
    h.recorder.voiced.monologue = 0;
    h.advanceClock(30);
    h.controller.devSkipToEnd();
    assert.equal(h.controller.getSnapshot().monologueHeld, true);
    // The hold froze the clock at time-up, exactly where a waited-out silent
    // monologue freezes. Held, `tick()` re-anchors the clock to keep it still,
    // so a further skip would be silently undone — refusal is the honest
    // behaviour, and the frozen number must not move.
    const heldAt = h.controller.getSnapshot().elapsed;
    assert.equal(heldAt, PHASE_DURATIONS.monologue, "held at the end it skipped to");
    h.controller.devSkipTime(120);
    h.advanceClockSilently(5);
    assert.equal(h.controller.getSnapshot().elapsed, heldAt, "a held clock stands still");
  });

  it("never rewinds: a non-positive skip is a no-op", async () => {
    const h = harness();
    await intoMonologue(h);
    h.advanceClock(60);

    h.controller.devSkipTime(0);
    h.controller.devSkipTime(-45);

    assert.equal(h.controller.getSnapshot().elapsed, 60);
  });
});
