import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
   *  `connected`, and never touches anything above the session. */
  async reconnect(): Promise<void> {
    this.reconnects += 1;
    this.callbacks.onStateChange("reconnecting");
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

class FakeRecorder implements RecorderLike {
  started = false;
  stopped = false;
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  toWavBlob(): Blob | null {
    return new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
  }
}

class FakePlayer implements PlayerLike {
  async resume(): Promise<void> {}
  enqueue(): void {}
  interrupt(): void {}
  async close(): Promise<void> {}
}

interface Harness {
  controller: ExamController;
  sessions: FakeSession[];
  recorder: FakeRecorder;
  finished: ExamFinishedPayload[];
  advanceClock: (seconds: number) => void;
  session: () => FakeSession;
}

function harness(): Harness {
  let now = 0;
  const sessions: FakeSession[] = [];
  const recorder = new FakeRecorder();
  const finished: ExamFinishedPayload[] = [];

  const controller = new ExamController({
    topic: TOPIC,
    createSession: (phase, _topic, callbacks, history) => {
      const session = new FakeSession(phase, callbacks, history);
      sessions.push(session);
      return session;
    },
    createRecorder: () => recorder,
    createPlayer: () => new FakePlayer(),
    onFinished: (payload) => finished.push(payload),
    now: () => now,
    autoTick: false,
  });

  return {
    controller,
    sessions,
    recorder,
    finished,
    advanceClock: (seconds: number) => {
      now += seconds * 1000;
      controller.tick();
    },
    session: () => sessions[sessions.length - 1],
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
    assert.ok(payload.audio, "the candidate's audio was captured");
    assert.ok(payload.monologueSeconds >= MONOLOGUE_MIN_SECONDS);
    assert.ok(payload.debateSeconds > 0);

    // The final transcript keeps both tasks, distinctly.
    const phases = new Set(payload.transcript.map((entry) => entry.phase));
    assert.deepEqual([...phases].sort(), ["debate", "monologue"]);

    t.diagnostic(
      `monologue ${payload.monologueSeconds}s · débat ${payload.debateSeconds}s · ` +
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

  it("advances anyway when the examiner never delivers its closing line", async () => {
    const h = harness();
    h.controller.start();
    await h.controller.advanceEarly();
    await new Promise((resolve) => setImmediate(resolve));
    h.advanceClock(MONOLOGUE_MIN_SECONDS);

    await h.controller.advanceEarly();
    assert.equal(h.controller.getSnapshot().closing, true);

    // The safety timeout is the guard against a silent examiner freezing the exam.
    await new Promise((resolve) => setTimeout(resolve, 12_100));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.controller.getSnapshot().phase, "debate");
  });
});
