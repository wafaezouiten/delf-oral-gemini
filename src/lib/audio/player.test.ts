import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OUTPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import { int16ToBase64 } from "./pcm";
import {
  ExaminerAudioPlayer,
  type AudioBufferLike,
  type AudioBufferSourceLike,
  type AudioContextLike,
} from "./player";

// ------------------------------------------------------------------ the fake
//
// A Web Audio graph reduced to the two facts the scheduler reasons about: what
// time it is, and when each buffer was told to start. That is enough to assert
// gaplessness exactly rather than by listening.

/** Shared so a twenty-minute run does not retain thirty thousand buffers. The
 *  player writes samples in and never reads them back, so one is enough. */
const SCRATCH = new Float32Array(OUTPUT_SAMPLE_RATE);

class FakeBuffer implements AudioBufferLike {
  constructor(
    readonly length: number,
    readonly sampleRate: number,
  ) {}
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(): Float32Array {
    return SCRATCH.subarray(0, this.length);
  }
}

class FakeSource implements AudioBufferSourceLike {
  buffer: AudioBufferLike | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  connects = 0;
  disconnects = 0;

  connect(): void {
    this.connects += 1;
  }
  disconnect(): void {
    this.disconnects += 1;
  }
  start(when = 0): void {
    this.startedAt = when;
  }
  stop(): void {
    this.stopped = true;
  }

  get endsAt(): number {
    return (this.startedAt ?? 0) + (this.buffer?.duration ?? 0);
  }
  /** What the audio thread would do when the buffer runs out. */
  finish(): void {
    this.onended?.();
  }
}

class FakeAudioContext implements AudioContextLike {
  currentTime = 0;
  state: "suspended" | "running" | "closed" = "suspended";
  destination: unknown = { id: "speakers" };
  /** Every source ever created, in order. */
  sources: FakeSource[] = [];
  /** Only those still scheduled, so `advance` stays linear over a long run. */
  private live: FakeSource[] = [];
  closes = 0;
  /** When set, `resume()` blocks on it — the "context still opening" window. */
  gate: Promise<void> | null = null;

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBufferLike {
    return new FakeBuffer(length, sampleRate);
  }
  createBufferSource(): AudioBufferSourceLike {
    const source = new FakeSource();
    this.sources.push(source);
    this.live.push(source);
    return source;
  }
  async resume(): Promise<void> {
    if (this.gate) await this.gate;
    this.state = "running";
  }
  async close(): Promise<void> {
    this.closes += 1;
    this.state = "closed";
  }

  /** Move the clock, retiring anything that has finished playing. */
  advance(seconds: number): void {
    this.currentTime += seconds;
    this.live = this.live.filter((source) => {
      if (source.stopped) return false;
      if (source.startedAt !== null && source.endsAt <= this.currentTime) {
        source.stopped = true;
        source.finish();
        return false;
      }
      return true;
    });
  }
}

function harness(options: { leadSeconds?: number; gate?: Promise<void> } = {}) {
  const contexts: FakeAudioContext[] = [];
  const speaking: boolean[] = [];
  const events: Array<{ name: string; detail?: unknown }> = [];

  const player = new ExaminerAudioPlayer({
    createContext: () => {
      const context = new FakeAudioContext();
      // Installed before the player can touch it: `open()` calls `resume()`
      // synchronously, so a gate set afterwards would come too late.
      context.gate = options.gate ?? null;
      contexts.push(context);
      return context;
    },
    onSpeakingChange: (value) => speaking.push(value),
    onEvent: (name, detail) => events.push({ name, detail }),
    leadSeconds: options.leadSeconds ?? 0.02,
  });

  return { player, contexts, speaking, events, context: () => contexts[contexts.length - 1] };
}

/** Audio times are sums of binary fractions; `0.1 + 0.02 !== 0.12`. */
function approx(actual: number | null | undefined, expected: number, what: string): void {
  assert.ok(
    actual !== null && actual !== undefined && Math.abs(actual - expected) < 1e-9,
    `${what}: got ${actual}, wanted ${expected}`,
  );
}

/** `ms` of silence, as Gemini would send it: base64 PCM16 at 24 kHz. */
function chunk(ms: number): string {
  return int16ToBase64(new Int16Array((OUTPUT_SAMPLE_RATE * ms) / 1000));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ------------------------------------------------------------------- tests

describe("opening the speaker", () => {
  it("builds exactly one AudioContext however many callers ask at once", async () => {
    const h = harness();
    await Promise.all([h.player.resume(), h.player.resume(), h.player.resume()]);
    assert.equal(h.contexts.length, 1, "a second context would leak the first");
    assert.equal(h.context().state, "running");
  });

  it("resumes a context the browser suspended without building another", async () => {
    const h = harness();
    await h.player.resume();
    h.context().state = "suspended";
    await h.player.resume();
    assert.equal(h.contexts.length, 1);
    assert.equal(h.context().state, "running");
  });

  it("closes a context that arrives after the sitting ended", async () => {
    // The candidate navigates away while the context is still resuming. Without
    // the generation check the context is installed on a player nobody will call
    // again, and stays open — with, on some platforms, the output device.
    const gate = deferred();
    const h = harness({ gate: gate.promise });

    const opening = h.player.resume();
    await h.player.close();
    gate.resolve();
    await opening;

    assert.equal(h.contexts.length, 1);
    assert.equal(h.context().closes, 1, "the late context was closed, not adopted");
    assert.ok(h.events.some((e) => e.name === "playback-context-discarded"));
  });
});

describe("the playback queue", () => {
  it("schedules consecutive chunks end to end, with no gap and no overlap", async () => {
    const h = harness({ leadSeconds: 0.02 });
    await h.player.resume();

    // Gemini sends faster than real time, which is exactly when naive playback
    // garbles: five `start()` calls at `currentTime` play five chunks at once.
    for (let i = 0; i < 5; i += 1) h.player.enqueue(chunk(100));

    const starts = h.context().sources.map((s) => s.startedAt ?? NaN);
    assert.equal(starts.length, 5);
    approx(starts[0], 0.02, "the first is scheduled a lead ahead of now");
    for (let i = 1; i < starts.length; i += 1) {
      approx(starts[i], starts[i - 1] + 0.1, `chunk ${i} joins the one before it`);
    }
  });

  it("never schedules in the past when the stream stalls", async () => {
    // The cursor falls behind `currentTime` whenever Gemini goes quiet. A start
    // time already behind the audio thread is not an error the browser reports —
    // it just drops the leading samples, clipping the first syllable of every
    // sentence after a pause.
    const h = harness({ leadSeconds: 0.02 });
    await h.player.resume();

    h.player.enqueue(chunk(100));
    h.context().advance(5);
    h.player.enqueue(chunk(100));

    const [, second] = h.context().sources;
    approx(second.startedAt, 5.02, "scheduled ahead of the clock, not behind it");
  });

  it("reports the examiner speaking once, not once per chunk", async () => {
    const h = harness();
    await h.player.resume();

    for (let i = 0; i < 4; i += 1) h.player.enqueue(chunk(40));
    assert.deepEqual(h.speaking, [true]);
    assert.equal(h.player.isSpeaking, true);

    h.context().advance(1);
    assert.deepEqual(h.speaking, [true, false], "and falls silent exactly once");
    assert.equal(h.player.isSpeaking, false);
  });

  it("ignores an empty chunk", async () => {
    const h = harness();
    await h.player.resume();
    h.player.enqueue("");
    assert.equal(h.context().sources.length, 0);
    assert.deepEqual(h.speaking, []);
  });

  it("plays audio that arrived before the context was ready", async () => {
    // The examiner's opening line can beat the AudioContext: the session is
    // connected the moment the token resolves, and `resume()` waits on the
    // browser. Dropping those chunks means the épreuve opens on a sentence with
    // its first words missing.
    const h = harness();
    h.player.enqueue(chunk(40));
    h.player.enqueue(chunk(40));

    await h.player.resume();

    assert.equal(h.context().sources.length, 2, "held, then played");
    assert.ok(h.events.some((e) => e.name === "playback-preroll-flush"));
  });

  it("bounds the pre-roll and says so rather than growing without limit", async () => {
    const h = harness();
    for (let i = 0; i < 1100; i += 1) h.player.enqueue(chunk(40));

    await h.player.resume();
    assert.equal(h.context().sources.length, 1000, "capped");
    const overflow = h.events.find((e) => e.name === "playback-preroll-overflow");
    assert.ok(overflow, "and reported");
    assert.equal(
      h.events.filter((e) => e.name === "playback-preroll-overflow").length,
      1,
      "once per outage, not once per dropped chunk",
    );
  });
});

describe("a context the browser suspended (#94)", () => {
  // The unheard first question. A suspended AudioContext accepts `start()` and
  // plays nothing: its clock is frozen, so scheduling into it queues sources at
  // times that have already passed — silence now, one garbled burst whenever
  // the context finally resumes. The player must treat "suspended" the way it
  // treats "not open yet": hold, wake, and play in order once it can.

  it("holds new audio instead of scheduling it into a frozen clock", async () => {
    const gate = deferred();
    const h = harness();
    await h.player.resume();
    h.context().gate = gate.promise; // the wake attempt will hang on the browser
    h.context().state = "suspended";

    for (let i = 0; i < 3; i += 1) h.player.enqueue(chunk(100));

    assert.equal(h.context().sources.length, 0, "nothing was scheduled into the frozen graph");
    assert.deepEqual(h.speaking, [], "and nobody was told the examiner is audible");

    // The browser lets the resume through — a user gesture arrived.
    gate.resolve();
    await h.player.resume();

    const starts = h.context().sources.map((s) => s.startedAt ?? NaN);
    assert.equal(starts.length, 3, "everything held was played");
    approx(starts[0], h.context().currentTime + 0.02, "from now, not from the frozen past");
    approx(starts[1], starts[0] + 0.1, "in order");
    approx(starts[2], starts[1] + 0.1, "all of it");
    assert.deepEqual(h.speaking, [true], "and the examiner is audible only now");
  });

  it("wakes the context on its own when a chunk finds it suspended", async () => {
    // The fake's resume() succeeds immediately — the case where the suspension
    // was the browser's housekeeping rather than autoplay policy, which is the
    // one the enqueue-side attempt exists to recover without waiting for a
    // click.
    const h = harness();
    await h.player.resume();
    h.context().state = "suspended";

    h.player.enqueue(chunk(100));
    await new Promise((resolve) => setImmediate(resolve)); // let the wake's resume() settle

    assert.equal(h.context().state, "running", "the enqueue asked the browser to resume");
    assert.equal(h.context().sources.length, 1, "and the held chunk played");
  });

  it("abandons sources already scheduled into the frozen graph", async () => {
    // Their base64 is gone — a buffer handed to the graph cannot be read back —
    // and replaying them on resume would fire the whole backlog at once. The
    // bounded loss is the player's lead over real time; the alternative is
    // garble.
    const gate = deferred();
    const h = harness();
    await h.player.resume();
    for (let i = 0; i < 3; i += 1) h.player.enqueue(chunk(100));
    assert.deepEqual(h.speaking, [true]);

    h.context().gate = gate.promise;
    h.context().state = "suspended";
    h.player.enqueue(chunk(100));

    const [first, second, third] = h.context().sources;
    assert.equal(first.stopped && second.stopped && third.stopped, true, "the backlog is dropped");
    assert.deepEqual(h.speaking, [true, false], "and the silence is reported honestly");
    assert.ok(
      h.events.some((e) => e.name === "playback-frozen-dropped"),
      "with the drop on the record",
    );

    gate.resolve();
    await h.player.resume();
    assert.equal(h.context().sources.length, 4, "the held chunk still plays");
    assert.equal(h.context().sources[3].stopped, false);
  });
});

describe("interruption", () => {
  it("drops everything queued and rewinds the cursor to now", async () => {
    // What `serverContent.interrupted` means: the examiner has abandoned the
    // question it was in the middle of. Anything still queued is a sentence it
    // is no longer asking.
    const h = harness();
    await h.player.resume();
    for (let i = 0; i < 5; i += 1) h.player.enqueue(chunk(500));

    h.context().advance(0.1);
    h.player.interrupt();

    for (const source of h.context().sources) {
      assert.equal(source.stopped, true);
      assert.ok(source.disconnects >= 1, "and detached from the graph");
    }
    assert.equal(h.player.isSpeaking, false);
    assert.equal(h.player.bufferedSeconds, 0, "nothing left scheduled");

    // The examiner's next question starts immediately, not after the 2.5 s of
    // audio that was just thrown away.
    h.player.enqueue(chunk(100));
    approx(h.context().sources.at(-1)?.startedAt, 0.12, "the next question starts now");
  });

  it("discards audio still waiting for the context, too", async () => {
    const h = harness();
    h.player.enqueue(chunk(40));
    h.player.interrupt();
    await h.player.resume();
    assert.equal(h.context().sources.length, 0, "abandoned speech is abandoned either way");
  });

  it("reports silence once, not once per stopped node", async () => {
    const h = harness();
    await h.player.resume();
    for (let i = 0; i < 6; i += 1) h.player.enqueue(chunk(100));
    h.player.interrupt();
    assert.deepEqual(h.speaking, [true, false]);
  });
});

describe("teardown", () => {
  it("closes the context and leaves nothing playing", async () => {
    const h = harness();
    await h.player.resume();
    h.player.enqueue(chunk(100));

    await h.player.close();

    assert.equal(h.context().closes, 1);
    assert.equal(h.context().state, "closed");
    assert.equal(h.context().sources[0].stopped, true);
    assert.equal(h.player.isSpeaking, false);
  });

  it("is safe to call twice", async () => {
    const h = harness();
    await h.player.resume();
    await h.player.close();
    await h.player.close();
    assert.equal(h.context().closes, 1);
  });

  it("ignores audio arriving after the context closed", async () => {
    const h = harness();
    await h.player.resume();
    const context = h.context();
    await h.player.close();

    h.player.enqueue(chunk(40));
    assert.equal(context.sources.length, 0);
  });
});

describe("a full monologue and débat", () => {
  it("plays twenty minutes without the schedule drifting away from the clock", async () => {
    // The failure mode being excluded: a cursor that creeps ahead of real time
    // buys the examiner a longer and longer delay, so by the end of the débat it
    // is answering the question before last. It stays bounded only because a
    // chunk is scheduled from `max(now + lead, cursor)` and the cursor advances
    // by exactly the buffer's duration.
    const h = harness({ leadSeconds: 0.02 });
    await h.player.resume();
    const context = h.context();
    const payload = chunk(40);

    const CHUNKS = 30_000; // 40 ms each: twenty minutes
    let maxBuffered = 0;
    for (let i = 0; i < CHUNKS; i += 1) {
      h.player.enqueue(payload);
      context.advance(0.04);
      maxBuffered = Math.max(maxBuffered, h.player.bufferedSeconds);
    }

    assert.ok(maxBuffered <= 0.06, `the examiner drifted ${maxBuffered.toFixed(3)} s behind`);

    const sources = context.sources;
    assert.equal(sources.length, CHUNKS);
    for (let i = 1; i < sources.length; i += 1) {
      const expected = (sources[i - 1].startedAt ?? 0) + 0.04;
      assert.ok(
        Math.abs((sources[i].startedAt ?? 0) - expected) < 1e-6,
        `chunk ${i} is ${((sources[i].startedAt ?? 0) - expected).toExponential(2)} s off`,
      );
    }
  });
});
