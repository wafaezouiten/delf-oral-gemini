import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clampSeek,
  DELETION_IDLE,
  deletionReducer,
  formatName,
  playableCandidate,
  playbackProgress,
  seekKeyOffset,
  type DeletionEvent,
} from "./recording-player";

describe("what the player asks and shows", () => {
  it("asks the browser about Ogg with its codec, and names it plainly", () => {
    assert.equal(playableCandidate("audio/ogg"), 'audio/ogg; codecs="opus"');
    assert.equal(playableCandidate("audio/webm"), "audio/webm");
    assert.equal(formatName("audio/ogg"), "Ogg Opus");
    assert.equal(formatName("audio/webm"), "audio/webm");
  });

  it("holds a seek inside the recording", () => {
    assert.equal(clampSeek(-3, 98), 0);
    assert.equal(clampSeek(120, 98), 98);
    assert.equal(clampSeek(40, 98), 40);
    assert.equal(clampSeek(40, 0), 0, "no duration yet pins the head");
  });

  it("fills the bar as a share, capped, and empty with no duration", () => {
    assert.equal(playbackProgress(49, 98), 0.5);
    assert.equal(playbackProgress(200, 98), 1);
    assert.equal(playbackProgress(10, 0), 0);
  });

  it("moves the head five seconds on the arrows and not otherwise", () => {
    assert.equal(seekKeyOffset("ArrowLeft"), -5);
    assert.equal(seekKeyOffset("ArrowRight"), 5);
    assert.equal(seekKeyOffset("Enter"), null);
  });
});

describe("deleting in two presses", () => {
  const run = (events: DeletionEvent[]) => events.reduce(deletionReducer, DELETION_IDLE);

  it("arms, cancels, and only deletes once confirmed", () => {
    assert.deepEqual(run(["arm"]), { stage: "confirming", failed: false });
    assert.deepEqual(run(["arm", "cancel"]), { stage: "idle", failed: false });
    assert.deepEqual(run(["arm", "start", "ok"]), { stage: "deleted", failed: false });
  });

  it("disarms on a failure and keeps the sentence until the next attempt", () => {
    const failed = run(["arm", "start", "fail"]);
    assert.deepEqual(failed, { stage: "idle", failed: true });
    assert.deepEqual(deletionReducer(failed, "arm"), { stage: "confirming", failed: true });
    assert.deepEqual(deletionReducer(deletionReducer(failed, "arm"), "start"), {
      stage: "deleting",
      failed: false,
    });
  });
});
