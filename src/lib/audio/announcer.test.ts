import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExaminerAnnouncer, type ClipPlayback, type ClipPlayer } from "./announcer";

/**
 * A clip that ends when the test says so.
 *
 * The gate is the point: every interesting thing about this class happens *while*
 * a clip is playing, which is a window a real `<audio>` element gives a test no
 * way to sit inside.
 */
class FakeClip implements ClipPlayback {
  finished: Promise<void>;
  stopped = false;
  private end!: () => void;
  private fail!: (error: unknown) => void;

  constructor(readonly src: string) {
    this.finished = new Promise<void>((resolve, reject) => {
      this.end = resolve;
      this.fail = reject;
    });
  }

  /** The clip reaches its end. */
  reachEnd(): void {
    this.end();
  }

  /** The browser refuses to autoplay it. */
  refuse(): void {
    this.fail(new DOMException("play() failed because the user didn't interact", "NotAllowedError"));
  }

  /** The file is missing. */
  breakIt(): void {
    this.fail(new Error("404"));
  }

  stop(): void {
    this.stopped = true;
  }
}

function harness() {
  const clips: FakeClip[] = [];
  const events: string[] = [];
  const createClip: ClipPlayer = (src) => {
    const clip = new FakeClip(src);
    clips.push(clip);
    return clip;
  };
  const announcer = new ExaminerAnnouncer({
    createClip,
    onEvent: (name) => events.push(name),
  });
  return { announcer, clips, events, clip: () => clips[clips.length - 1] };
}

/** Let the microtask queue drain, so an awaited race can settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("ExaminerAnnouncer", () => {
  it("resolves `played` when the clip reaches its end", async () => {
    const h = harness();
    const playing = h.announcer.play("/announcements/monologue.wav");

    assert.equal(h.clips.length, 1);
    assert.equal(h.clip().src, "/announcements/monologue.wav");
    assert.equal(h.announcer.isSpeaking, true);

    h.clip().reachEnd();
    assert.equal(await playing, "played");
    assert.equal(h.announcer.isSpeaking, false, "nothing is audible once it has ended");
  });

  it("resolves `skipped` when it is stopped, and silences the clip", async () => {
    const h = harness();
    const playing = h.announcer.play("/a.wav");
    await settle();

    h.announcer.stop();

    assert.equal(await playing, "skipped");
    assert.equal(h.clip().stopped, true, "the audio must actually stop, not just be reported");
  });

  it("tells a refused autoplay apart from a missing file", async () => {
    // The distinction the controller acts on: `blocked` holds the phase and puts
    // a button on screen, `failed` carries on in silence.
    const blockedRun = harness();
    const blocked = blockedRun.announcer.play("/a.wav");
    blockedRun.clip().refuse();
    assert.equal(await blocked, "blocked");
    assert.ok(blockedRun.events.includes("announcement-blocked"));

    const failedRun = harness();
    const failed = failedRun.announcer.play("/missing.wav");
    failedRun.clip().breakIt();
    assert.equal(await failed, "failed");
    assert.ok(failedRun.events.includes("announcement-failed"));
  });

  it("replaces a clip that is still playing rather than queueing behind it", async () => {
    // The ordering: a candidate skips the préparation while its briefing is still
    // being read, and the monologue's consigne has to take over immediately.
    const h = harness();
    const first = h.announcer.play("/preparation.wav");
    await settle();

    const second = h.announcer.play("/monologue.wav");

    assert.equal(await first, "skipped", "the superseded clip reports itself skipped");
    assert.equal(h.clips[0].stopped, true);
    assert.equal(h.clips.length, 2);

    h.clips[1].reachEnd();
    assert.equal(await second, "played");
    // The clip that was replaced must not tidy away the state of the one that
    // replaced it — the bug the generation guard exists for.
    assert.equal(h.announcer.isSpeaking, false);
  });

  it("does not report a superseded clip's later failure as the current one's", async () => {
    const h = harness();
    const first = h.announcer.play("/preparation.wav");
    await settle();
    const second = h.announcer.play("/monologue.wav");
    await settle();

    // The abandoned element errors on teardown, as some engines do when `src` is
    // cleared. It must not surface as an unhandled rejection or as this clip's
    // outcome.
    h.clips[0].breakIt();
    await settle();

    assert.equal(await first, "skipped");
    h.clips[1].reachEnd();
    assert.equal(await second, "played");
  });

  it("opens nothing once closed", async () => {
    const h = harness();
    const playing = h.announcer.play("/a.wav");
    await settle();

    h.announcer.close();
    assert.equal(await playing, "skipped");
    assert.equal(h.clips[0].stopped, true);

    // Terminal: the sitting is over, and a consigne for a phase nobody is in must
    // not open an audio element on a page that is going away.
    assert.equal(await h.announcer.play("/b.wav"), "skipped");
    assert.equal(h.clips.length, 1, "no second clip was created");
  });

  it("survives a clip factory that throws", async () => {
    // A broken environment, not a blocked one: there is nothing a gesture would
    // fix, so the phase must not be held waiting for one.
    const announcer = new ExaminerAnnouncer({
      createClip: () => {
        throw new Error("no Audio in this environment");
      },
    });
    assert.equal(await announcer.play("/a.wav"), "failed");
  });

  it("is safe to stop when nothing is playing", () => {
    const h = harness();
    h.announcer.stop();
    h.announcer.close();
    h.announcer.close();
    assert.equal(h.clips.length, 0);
  });
});
