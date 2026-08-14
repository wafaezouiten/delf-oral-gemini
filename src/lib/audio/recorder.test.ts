import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import { FRAME_SAMPLES, frameSamplesAt } from "./framing";
import { base64ToInt16, wavDurationSeconds } from "./pcm";
import { MicRecorder, type CaptureStream, type MicrophoneOpener } from "./recorder";

// ------------------------------------------------------------------ the fake
//
// A microphone reduced to what the recorder can observe about one: the rate it
// runs at, the blocks it delivers, and whether it was released. Which is enough
// to assert the property the DoD actually names — no leaked tracks — without a
// browser.

class FakeCapture implements CaptureStream {
  onBlock: ((block: Float32Array) => void) | null = null;
  onLost: ((reason: string) => void) | null = null;
  closes = 0;

  constructor(readonly sampleRate: number = INPUT_SAMPLE_RATE) {}

  async close(): Promise<void> {
    this.closes += 1;
    this.onBlock = null;
    this.onLost = null;
  }

  /** What the audio thread does 25 times a second. */
  emit(samples: number, fill = 0.25): void {
    this.onBlock?.(new Float32Array(samples).fill(fill));
  }

  /** The headset comes out of the socket. The track ends; nothing else happens,
   *  and in particular no more blocks arrive. */
  unplug(reason = "the audio track ended"): void {
    this.onLost?.(reason);
    this.onBlock = null;
  }

  get isReleased(): boolean {
    return this.closes > 0;
  }
}

function harness(
  options: {
    sampleRate?: number;
    open?: MicrophoneOpener;
    /** Off for the twenty-minute run, where keeping every frame would cost
     *  more memory than the property is worth. */
    collect?: boolean;
  } = {},
) {
  const captures: FakeCapture[] = [];
  const chunks: string[] = [];
  const events: Array<{ name: string; detail?: unknown }> = [];
  const losses: string[] = [];
  const collect = options.collect ?? true;
  let sent = 0;

  const openMicrophone: MicrophoneOpener =
    options.open ??
    (async () => {
      const capture = new FakeCapture(options.sampleRate ?? INPUT_SAMPLE_RATE);
      captures.push(capture);
      return capture;
    });

  const recorder = new MicRecorder({
    onChunk: (base64) => {
      sent += 1;
      if (collect) chunks.push(base64);
    },
    onEvent: (name, detail) => events.push({ name, detail }),
    onLost: (reason) => losses.push(reason),
    openMicrophone,
  });

  return {
    recorder,
    captures,
    chunks,
    events,
    losses,
    sent: () => sent,
    capture: () => captures[captures.length - 1],
    /** Samples actually streamed to Gemini. */
    streamed: () => chunks.reduce((n, base64) => n + base64ToInt16(base64).length, 0),
  };
}

/** Seconds of audio in a WAV, read back out of the blob the recorder produced. */
async function wavSeconds(blob: Blob): Promise<number | null> {
  return wavDurationSeconds(await blob.arrayBuffer());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ------------------------------------------------------------------- tests

describe("framing what reaches Gemini", () => {
  it("sends fixed-size 40 ms frames, whatever the audio thread hands over", async () => {
    const h = harness();
    await h.recorder.start();

    // 128-sample quanta batched into whatever the worklet felt like.
    for (const size of [128, 1000, 7, 2048, 640]) h.capture().emit(size);

    assert.ok(h.chunks.length > 0);
    for (const base64 of h.chunks) {
      assert.equal(base64ToInt16(base64).length, FRAME_SAMPLES);
    }
  });

  it("keeps the recording and the stream in step, remainder included", async () => {
    const h = harness();
    await h.recorder.start();
    h.recorder.beginPhase("monologue");

    const total = FRAME_SAMPLES * 3 + 200;
    h.capture().emit(total);

    assert.equal(h.streamed(), FRAME_SAMPLES * 3, "the partial frame is not sent");
    assert.equal(h.recorder.recordedSeconds, (FRAME_SAMPLES * 3) / INPUT_SAMPLE_RATE);

    // …until capture stops, at which point the candidate's last words join the
    // recording the phonologie score is measured on.
    await h.recorder.stop();
    assert.equal(h.recorder.recordedSeconds, total / INPUT_SAMPLE_RATE);
  });

  it("converts a device the browser would not open at 16 kHz", async () => {
    // The Live API contract is 16 kHz in. A browser that refuses a 16 kHz
    // context must not therefore be allowed to stream 48 kHz samples at an
    // endpoint that will read them as 16 kHz.
    const h = harness({ sampleRate: 48000 });
    await h.recorder.start();
    h.recorder.beginPhase("monologue");

    assert.equal(h.recorder.captureRate, 48000);
    assert.ok(
      h.events.some((e) => e.name === "capture-rate-mismatch"),
      "and it is said out loud, on an exam that grades pronunciation",
    );

    const block = frameSamplesAt(48000);
    for (let i = 0; i < 25; i += 1) h.capture().emit(block); // one second
    await h.recorder.stop();

    assert.ok(
      Math.abs(h.recorder.recordedSeconds - 1) < 0.001,
      `one second of 48 kHz capture archived ${h.recorder.recordedSeconds}s`,
    );
  });

  it("says nothing when the browser gave us the rate we asked for", async () => {
    const h = harness();
    await h.recorder.start();
    assert.equal(
      h.events.some((e) => e.name === "capture-rate-mismatch"),
      false,
    );
  });

  it("records at 16 kHz regardless of the device rate", async () => {
    const h = harness({ sampleRate: 44100 });
    await h.recorder.start();
    h.recorder.beginPhase("monologue");
    h.capture().emit(44_100);
    await h.recorder.stop();

    const recording = h.recorder.recordingFor("monologue");
    assert.ok(recording);
    const view = new DataView(await recording.blob.arrayBuffer());
    assert.equal(view.getUint32(24, true), INPUT_SAMPLE_RATE, "the header is not a lie");
  });

  it("returns no recording for a silent sitting, rather than an empty one", async () => {
    const h = harness();
    await h.recorder.start();
    h.recorder.beginPhase("monologue");
    await h.recorder.stop();

    assert.equal(h.recorder.recordingFor("monologue"), null);
    assert.deepEqual(h.recorder.recordings(), []);
  });
});

describe("pausing", () => {
  it("streams and archives nothing while paused, and picks up after", async () => {
    const h = harness();
    await h.recorder.start();

    h.capture().emit(FRAME_SAMPLES);
    h.recorder.pause();
    assert.equal(h.recorder.isRecording, false);
    h.capture().emit(FRAME_SAMPLES * 4);
    assert.equal(h.chunks.length, 1);

    h.recorder.resume();
    h.capture().emit(FRAME_SAMPLES);
    assert.equal(h.chunks.length, 2);
    assert.equal(h.recorder.isRecording, true);
  });

  it("cannot be resumed into recording without a microphone", async () => {
    const h = harness();
    h.recorder.resume();
    assert.equal(h.recorder.isRecording, false);
  });
});

describe("the microphone's lifetime", () => {
  it("opens exactly one device however many callers ask at once", async () => {
    // Two devices, one of them referenced by nobody: the recording indicator
    // stays lit for the whole épreuve and nothing can turn it off.
    const h = harness();
    await Promise.all([h.recorder.start(), h.recorder.start(), h.recorder.start()]);
    assert.equal(h.captures.length, 1);
    assert.equal(h.recorder.isRecording, true);
  });

  it("is a no-op once already recording", async () => {
    const h = harness();
    await h.recorder.start();
    await h.recorder.start();
    assert.equal(h.captures.length, 1);
  });

  it("releases a device that arrives after the sitting ended", async () => {
    // The permission prompt sits on screen for as long as the candidate takes to
    // click it, and they can navigate away first. The device that arrives then
    // belongs to nobody — and `stop()` had already returned, so nothing else is
    // ever going to close it.
    const pending = deferred<CaptureStream>();
    const captures: FakeCapture[] = [];
    const h = harness({
      open: async () => {
        const capture = await pending.promise;
        captures.push(capture as FakeCapture);
        return capture;
      },
    });

    const starting = h.recorder.start();
    const stopping = h.recorder.stop();

    pending.resolve(new FakeCapture());
    await Promise.all([starting, stopping]);

    assert.equal(captures.length, 1);
    assert.equal(captures[0].isReleased, true, "the late microphone was released");
    assert.equal(h.recorder.isRecording, false);
    assert.ok(h.events.some((e) => e.name === "capture-discarded"));
  });

  it("has really released the device by the time stop() resolves", async () => {
    const pending = deferred<CaptureStream>();
    const capture = new FakeCapture();
    const h = harness({ open: () => pending.promise });

    const starting = h.recorder.start();
    let released = false;
    const stopping = h.recorder.stop().then(() => {
      released = capture.isReleased;
    });

    pending.resolve(capture);
    await Promise.all([starting, stopping]);

    assert.equal(released, true, "stop() awaited the start it superseded");
  });

  it("stops listening and closes the device exactly once", async () => {
    const h = harness();
    await h.recorder.start();
    const capture = h.capture();

    await h.recorder.stop();
    assert.equal(capture.closes, 1);
    assert.equal(capture.onBlock, null, "detached, so a late block cannot be archived");

    await h.recorder.stop();
    assert.equal(capture.closes, 1, "and a second stop closes nothing twice");
  });

  it("drops blocks that arrive after stop rather than archiving them", async () => {
    const h = harness();
    await h.recorder.start();
    const capture = h.capture();
    h.capture().emit(FRAME_SAMPLES);
    await h.recorder.stop();

    capture.onBlock?.(new Float32Array(FRAME_SAMPLES));
    assert.equal(h.chunks.length, 1);
  });

  it("leaves nothing recording when the microphone is refused", async () => {
    // The candidate denies permission. `getUserMedia` rejects, nothing was
    // opened, and the failure has to reach the caller — the exam screen turns it
    // into the message telling them how to fix it.
    const h = harness({
      open: async () => {
        throw new DOMException("Permission denied", "NotAllowedError");
      },
    });

    await assert.rejects(() => h.recorder.start(), /Permission denied/);
    assert.equal(h.recorder.isRecording, false);
    assert.equal(h.recorder.captureRate, null);

    // And the failure is not sticky: plugging in a headset and retrying works.
    const second = new FakeCapture();
    const retry = new MicRecorder({
      onChunk: () => {},
      openMicrophone: async () => second,
    });
    await retry.start();
    assert.equal(retry.isRecording, true);
    await retry.stop();
    assert.equal(second.isReleased, true);
  });
});

describe("one recording per phase", () => {
  it("cuts the monologue and the débat apart, tail included", async () => {
    const h = harness();
    await h.recorder.start();

    // The monologue: two whole frames and a remainder still in the framer.
    h.recorder.beginPhase("monologue");
    const monologueSamples = FRAME_SAMPLES * 2 + 100;
    h.capture().emit(monologueSamples);
    h.recorder.endPhase();

    // The remainder is the candidate's last words of THIS task. If the framer
    // carried it across the boundary it would surface inside the débat, where
    // it was never spoken.
    assert.equal(h.recorder.measuredSeconds("monologue"), monologueSamples / INPUT_SAMPLE_RATE);

    const debateSamples = FRAME_SAMPLES + 50;
    h.recorder.beginPhase("debate");
    h.capture().emit(debateSamples);
    await h.recorder.stop();

    assert.equal(h.recorder.measuredSeconds("debate"), debateSamples / INPUT_SAMPLE_RATE);

    const recordings = h.recorder.recordings();
    assert.deepEqual(
      recordings.map((recording) => recording.phase),
      ["monologue", "debate"],
      "in exam order, which is what the evaluator's prompt promises the model",
    );
    assert.equal(recordings[0].sampleCount, monologueSamples);
    assert.equal(recordings[1].sampleCount, debateSamples);
  });

  it("produces a playable WAV whose header agrees with the measurement", async () => {
    // The measured duration reaches the database and the duration penalty; the
    // blob reaches a player and the evaluator. A recording whose header says
    // something else is a recording that will be graded against the wrong floor.
    const h = harness();
    await h.recorder.start();
    h.recorder.beginPhase("monologue");
    for (let i = 0; i < 100; i += 1) h.capture().emit(FRAME_SAMPLES); // four seconds
    await h.recorder.stop();

    const recording = h.recorder.recordingFor("monologue");
    assert.ok(recording);
    assert.equal(recording.durationSeconds, 4);
    assert.equal(await wavSeconds(recording.blob), 4);
    assert.equal(recording.byteSize, 44 + 4 * INPUT_SAMPLE_RATE * 2, "header plus PCM");
  });

  it("measures the audio it received, not the time that passed", async () => {
    // The property the whole phase exists for. Two seconds of blocks arrive; the
    // device then goes quiet — a suspended audio graph behind a backgrounded
    // tab — while the phase carries on. The recording is two seconds, and
    // nothing anywhere is entitled to round that up to the phase's length.
    const h = harness();
    await h.recorder.start();
    h.recorder.beginPhase("debate");
    for (let i = 0; i < 50; i += 1) h.capture().emit(FRAME_SAMPLES);

    // …and now nothing, for as long as you like.
    h.recorder.endPhase();

    assert.equal(h.recorder.measuredSeconds("debate"), 2);
  });

  it("keeps recording across a phase, whatever the transport is doing", async () => {
    // The independence the issue asks for, stated as a test: the recorder has no
    // idea whether there is a socket. Nothing here consumes the streamed chunks,
    // and the recording is unaffected.
    const h = harness({ collect: false });
    await h.recorder.start();
    h.recorder.beginPhase("debate");
    for (let i = 0; i < 25; i += 1) h.capture().emit(FRAME_SAMPLES);
    await h.recorder.stop();

    assert.equal(h.recorder.measuredSeconds("debate"), 1);
  });

  it("re-entering the same phase continues its recording rather than resetting it", async () => {
    // The controller ensures the microphone is ready on more than one path into
    // a phase. A second `beginPhase` that truncated the artefact would lose
    // whatever came before it, silently and only sometimes.
    const h = harness();
    await h.recorder.start();
    h.recorder.beginPhase("monologue");
    h.capture().emit(FRAME_SAMPLES * 25);
    h.recorder.beginPhase("monologue");
    h.capture().emit(FRAME_SAMPLES * 25);
    h.recorder.endPhase();

    assert.equal(h.recorder.measuredSeconds("monologue"), 2);
  });
});

describe("nothing is recorded before there is something to record", () => {
  it("opens no device until it is asked to", async () => {
    // Consent, at its narrowest: constructing a recorder must not touch the
    // microphone. The permission prompt belongs to `start()`, which the exam
    // calls at the monologue boundary and not before.
    const h = harness();
    assert.equal(h.captures.length, 0);
    assert.deepEqual(h.recorder.recordings(), []);
  });

  it("streams but records nothing until a phase is open", async () => {
    // Between the permission prompt and the exposé there is a moment of room
    // tone. It reaches Gemini, which is warming up its turn detection on it, and
    // it belongs to neither task — so it is in no artefact.
    const h = harness();
    await h.recorder.start();
    h.capture().emit(FRAME_SAMPLES * 10);

    assert.ok(h.chunks.length > 0, "the transport is running");
    assert.equal(h.recorder.recordedSeconds, 0, "and nothing is being recorded");
    assert.deepEqual(h.recorder.recordings(), []);
    assert.equal(h.recorder.recordingPhase, null);

    h.recorder.beginPhase("monologue");
    h.capture().emit(FRAME_SAMPLES * 25);
    assert.equal(h.recorder.measuredSeconds("monologue"), 1, "and now it is");
  });

  it("stops recording at the end of a phase while the session is still open", async () => {
    // The examiner's closing sentence arrives after the phase has ended, and the
    // candidate is often still audible over it. Neither belongs to the task.
    const h = harness();
    await h.recorder.start();
    h.recorder.beginPhase("monologue");
    h.capture().emit(FRAME_SAMPLES * 25);
    h.recorder.endPhase();

    h.capture().emit(FRAME_SAMPLES * 25);
    assert.equal(h.recorder.measuredSeconds("monologue"), 1, "the closing minute is not in it");
    assert.ok(h.chunks.length > 25, "though it was still streamed to the examiner");
  });
});

describe("when the microphone goes away mid-phase", () => {
  it("keeps what it recorded and says so exactly once", async () => {
    const h = harness();
    await h.recorder.start();
    h.recorder.beginPhase("debate");
    for (let i = 0; i < 25; i += 1) h.capture().emit(FRAME_SAMPLES); // one second

    h.capture().unplug("the audio track ended");
    h.capture().unplug("and again, because engines differ");

    assert.deepEqual(h.losses, ["the audio track ended"], "reported once, not per event");
    assert.equal(h.recorder.isLost, true);
    assert.equal(h.recorder.isRecording, false);
    assert.ok(h.events.some((event) => event.name === "capture-lost"));

    // The second the device died is not a reason to lose the minute before it.
    await h.recorder.stop();
    const recording = h.recorder.recordingFor("debate");
    assert.ok(recording, "the audio captured before the loss survives");
    assert.equal(recording.durationSeconds, 1);
    assert.equal(await wavSeconds(recording.blob), 1);
  });

  it("still releases the device it was handed", async () => {
    // A lost track is not a closed AudioContext. The graph is still up and still
    // ours to tear down, and `stop()` remains the only thing that does it.
    const h = harness();
    await h.recorder.start();
    const capture = h.capture();
    capture.unplug();

    await h.recorder.stop();
    assert.equal(capture.closes, 1);
  });

  it("does not report an ordinary teardown as a lost device", async () => {
    // `stop()` ends the tracks, and on some engines that fires `ended`. A
    // candidate whose épreuve finished cleanly must not be told their microphone
    // failed.
    const h = harness();
    await h.recorder.start();
    // The recorder's own handler, kept from before the teardown detached it —
    // which is exactly the shape of a late event fired by a track that has just
    // been stopped.
    const notify = h.capture().onLost;
    await h.recorder.stop();

    notify?.("late ended event");
    assert.deepEqual(h.losses, []);
    assert.equal(h.recorder.isLost, false);
  });
});

describe("a full monologue and débat", () => {
  it("archives twenty minutes without the clock drifting", async () => {
    // What "no audio drift" means on the capture side: the seconds archived have
    // to match the seconds spoken. A framer that dropped its remainder each
    // block would lose a little every 40 ms and nothing would ever say so.
    const h = harness({ sampleRate: 48000, collect: false });
    await h.recorder.start();
    h.recorder.beginPhase("monologue");

    const capture = h.capture();
    const block = frameSamplesAt(48000);
    const blocks = (20 * 60 * 48000) / block;
    for (let i = 0; i < blocks; i += 1) capture.emit(block);
    await h.recorder.stop();

    assert.equal(h.sent(), (20 * 60 * INPUT_SAMPLE_RATE) / FRAME_SAMPLES, "every 40 ms frame");
    assert.ok(
      Math.abs(h.recorder.recordedSeconds - 20 * 60) < 0.001,
      `twenty minutes of speech archived as ${h.recorder.recordedSeconds}s`,
    );
  });
});
