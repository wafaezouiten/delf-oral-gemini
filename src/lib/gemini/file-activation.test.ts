import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACTIVATION_DELAY_MS,
  ACTIVATION_POLLS,
  waitForFileActive,
  type UploadedFileSnapshot,
} from "./file-activation";

/**
 * The race #73 is about, run under a referee: an uploaded file is `PROCESSING`
 * until the service says otherwise, and referencing it early is the
 * intermittent failure. These tests pin every exit of the wait — immediate,
 * eventual, failed, unpollable, and exhausted — with the getter and the sleeper
 * both injected so nothing here touches a network or a clock.
 */

interface TestFile extends UploadedFileSnapshot {
  uri?: string;
}

/** A getter that serves a scripted sequence of states and counts its calls. */
function scriptedGet(states: TestFile[]) {
  const calls: string[] = [];
  return {
    calls,
    get: async (name: string) => {
      calls.push(name);
      const next = states.shift();
      assert.ok(next, "polled more times than the script expected");
      return next;
    },
  };
}

const noSleep = async () => {};

describe("waiting for an uploaded file", () => {
  it("returns an ACTIVE file without polling at all", async () => {
    const { calls, get } = scriptedGet([]);
    const file: TestFile = { name: "files/ready", state: "ACTIVE", uri: "gs://ready" };

    const active = await waitForFileActive(file, get, { sleep: noSleep });

    assert.equal(active, file);
    assert.deepEqual(calls, [], "an ACTIVE file must cost zero requests");
  });

  it("returns a file that reports no state, as the pre-#73 code assumed", async () => {
    // An SDK that stopped reporting state must not become an evaluator that
    // stopped working — no state means nothing to wait on, not a failure.
    const { calls, get } = scriptedGet([]);
    const file: TestFile = { name: "files/mute", uri: "gs://mute" };

    assert.equal(await waitForFileActive(file, get, { sleep: noSleep }), file);
    assert.deepEqual(calls, []);
  });

  it("polls a PROCESSING file into ACTIVE and returns the fresh snapshot", async () => {
    const { calls, get } = scriptedGet([
      { name: "files/slow", state: "PROCESSING" },
      { name: "files/slow", state: "ACTIVE", uri: "gs://slow" },
    ]);
    const slept: number[] = [];
    const polled: Array<[string, number]> = [];

    const active = await waitForFileActive({ name: "files/slow", state: "PROCESSING" }, get, {
      delayMs: 250,
      sleep: async (ms) => void slept.push(ms),
      onPoll: (state, poll) => polled.push([state, poll]),
    });

    // The returned snapshot is the getter's last answer — the caller reads
    // `uri` and `mimeType` off it, and only the fresh read carries them.
    assert.equal(active.uri, "gs://slow");
    assert.deepEqual(calls, ["files/slow", "files/slow"]);
    assert.deepEqual(slept, [250, 250], "one flat wait before each poll");
    assert.deepEqual(polled, [
      ["PROCESSING", 1],
      ["PROCESSING", 2],
    ]);
  });

  it("fails a FAILED upload immediately, with the file's own account", async () => {
    const { calls, get } = scriptedGet([]);

    await assert.rejects(
      waitForFileActive(
        { name: "files/dead", state: "FAILED", error: { message: "Audio too short" } },
        get,
        { sleep: noSleep },
      ),
      /FAILED: Audio too short/,
    );
    assert.deepEqual(calls, [], "a FAILED file is not worth a single poll");
  });

  it("fails a file that turns FAILED mid-poll", async () => {
    const { get } = scriptedGet([{ name: "files/dying", state: "FAILED" }]);

    await assert.rejects(
      waitForFileActive({ name: "files/dying", state: "PROCESSING" }, get, { sleep: noSleep }),
      /came back FAILED/,
    );
  });

  it("fails a PROCESSING file that carries no name to poll", async () => {
    // Waiting the whole budget to discover the same dead end would only delay
    // the identical answer by thirty seconds of a candidate's wait.
    const { calls, get } = scriptedGet([]);

    await assert.rejects(
      waitForFileActive({ state: "PROCESSING" }, get, { sleep: noSleep }),
      /no name to poll/,
    );
    assert.deepEqual(calls, []);
  });

  it("gives up after the budgeted polls, naming the state it was left with", async () => {
    const { calls, get } = scriptedGet(
      Array.from({ length: 3 }, () => ({ name: "files/stuck", state: "PROCESSING" }) as TestFile),
    );

    await assert.rejects(
      waitForFileActive({ name: "files/stuck", state: "PROCESSING" }, get, {
        polls: 3,
        delayMs: 1000,
        sleep: noSleep,
      }),
      /still PROCESSING after 3 polls \(3s\)/,
    );
    assert.equal(calls.length, 3, "exactly the budgeted polls, no more");
  });

  it("keeps the default budget inside the route's", () => {
    // `maxDuration` is 300 s and one grading attempt can spend most of it; the
    // wait must stay a slice of the budget, never the budget. The files are
    // polled concurrently, so this bounds the whole wait, not per-file sums.
    assert.ok((ACTIVATION_POLLS * ACTIVATION_DELAY_MS) / 1000 <= 60);
  });
});
