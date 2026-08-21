import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CORRECTION_POLL_MS,
  CORRECTION_WAIT_LIMIT_MS,
  fetchCorrectionStatus,
  waitForCorrection,
} from "./correction-wait";

/**
 * The wait behind an answered finish (#86): every exit, without a network or a
 * clock. The property the whole loop exists for is the middle test — a poll
 * that errors reads as "not yet", never as "give up" — because the audio is
 * already safe when this runs, and a blink of hotel wifi must not turn a
 * correction in progress into a retry screen.
 */

const noSleep = async () => {};

describe("waiting for the correction to land", () => {
  it("returns the moment a poll says the correction exists", async () => {
    let polls = 0;
    const outcome = await waitForCorrection(async () => ++polls >= 3, {
      pollMs: 1000,
      limitMs: 60_000,
      sleep: noSleep,
    });

    assert.equal(outcome, "corrected");
    assert.equal(polls, 3, "and it stops asking once it has its answer");
  });

  it("sleeps before the first poll — the route just said the correction was not there", async () => {
    const slept: number[] = [];
    await waitForCorrection(async () => true, {
      pollMs: 2500,
      limitMs: 60_000,
      sleep: async (ms) => void slept.push(ms),
    });

    assert.deepEqual(slept, [2500]);
  });

  it("reads a failing poll as not-yet, never as give-up", async () => {
    let polls = 0;
    const outcome = await waitForCorrection(
      async () => {
        polls += 1;
        if (polls < 3) throw new Error("the wifi blinked");
        return true;
      },
      { pollMs: 1000, limitMs: 60_000, sleep: noSleep },
    );

    assert.equal(outcome, "corrected", "two failed polls cost nothing but time");
  });

  it("times out at the limit, having asked the whole way", async () => {
    let polls = 0;
    const outcome = await waitForCorrection(
      async () => {
        polls += 1;
        return false;
      },
      { pollMs: 1000, limitMs: 5_000, sleep: noSleep },
    );

    assert.equal(outcome, "timed-out");
    assert.equal(polls, 5);
  });

  it("waits past the finish route's own budget before giving up", () => {
    // `maxDuration` is 300 s and the grading runs inside it, behind the
    // response. A limit under that would declare corrections dead while their
    // request was still legally alive; the slack past it is for the answer to
    // travel. And the poll must stay invisible next to a thirty-second
    // grading, not become its own load.
    assert.ok(CORRECTION_WAIT_LIMIT_MS > 300_000);
    assert.ok(CORRECTION_POLL_MS >= 1_000);
  });
});

describe("one status poll", () => {
  const answer = (status: number, body: unknown) =>
    (async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })) as unknown as typeof fetch;

  it("reads the route's boolean, and only true as true", async () => {
    assert.equal(await fetchCorrectionStatus("41", answer(200, { corrected: true })), true);
    assert.equal(await fetchCorrectionStatus("41", answer(200, { corrected: false })), false);
    // A body that says something strange is not a correction.
    assert.equal(await fetchCorrectionStatus("41", answer(200, { corrected: "yes" })), false);
    assert.equal(await fetchCorrectionStatus("41", answer(200, {})), false);
  });

  it("throws on a refused answer, for the loop to read as not-yet", async () => {
    await assert.rejects(fetchCorrectionStatus("41", answer(502, {})), /502/);
  });
});
