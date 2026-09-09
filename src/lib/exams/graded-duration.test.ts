import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { gradedPhaseSeconds } from "./graded-duration";

/**
 * The one number a mark is computed from, and the two development claims that
 * are allowed anywhere near it. The route this was extracted from cannot be
 * loaded by `node --test` (`server-only`, Clerk, the database client), which is
 * exactly why the arithmetic does not live there.
 */

const spoken = {
  measuredSeconds: 402.6,
  hasRecording: true,
  devToolsEnabled: false,
};

describe("the duration a part is graded on", () => {
  it("is the measured audio on a real sitting, and nothing else", () => {
    assert.equal(gradedPhaseSeconds(spoken), 402.6);
  });

  it("is zero for a part with no recording, rather than a gap", () => {
    // A candidate who talked into a dead microphone has not been shown to have
    // produced the épreuve, and the penalty is what says so.
    assert.equal(
      gradedPhaseSeconds({ measuredSeconds: 0, hasRecording: false, devToolsEnabled: false }),
      0,
    );
  });

  describe("the typed part's claim (#36)", () => {
    it("stands in for a measurement that does not exist", () => {
      assert.equal(
        gradedPhaseSeconds({
          measuredSeconds: 0,
          hasRecording: false,
          devClaimedSeconds: 330,
          devToolsEnabled: true,
        }),
        330,
      );
    });

    it("loses to any recording, so a short sitting cannot be talked up", () => {
      assert.equal(
        gradedPhaseSeconds({ ...spoken, devClaimedSeconds: 900, devToolsEnabled: true }),
        402.6,
      );
    });
  });

  describe("the time-skip's claim (#203)", () => {
    it("is added to the measurement, not substituted for it", () => {
      // Eight minutes spoken, two minutes skipped: the épreuve reached ten, and
      // ten is what the examiner’s own clock called time on.
      assert.equal(
        gradedPhaseSeconds({ ...spoken, devSkippedSeconds: 120, devToolsEnabled: true }),
        522.6,
      );
    });

    it("adds to a typed part's claim too, since the two describe different time", () => {
      assert.equal(
        gradedPhaseSeconds({
          measuredSeconds: 0,
          hasRecording: false,
          devClaimedSeconds: 330,
          devSkippedSeconds: 150,
          devToolsEnabled: true,
        }),
        480,
      );
    });

    it("moves nothing when nobody skipped anything", () => {
      assert.equal(gradedPhaseSeconds({ ...spoken, devToolsEnabled: true }), 402.6);
      assert.equal(
        gradedPhaseSeconds({ ...spoken, devSkippedSeconds: 0, devToolsEnabled: true }),
        402.6,
      );
    });
  });

  it("drops both claims unread where marks are real", () => {
    // The guard that matters most: a hand-crafted payload reaching a production
    // deployment moves no duration at all, in either direction.
    assert.equal(
      gradedPhaseSeconds({
        ...spoken,
        devClaimedSeconds: 900,
        devSkippedSeconds: 900,
        devToolsEnabled: false,
      }),
      402.6,
    );
    assert.equal(
      gradedPhaseSeconds({
        measuredSeconds: 0,
        hasRecording: false,
        devClaimedSeconds: 900,
        devSkippedSeconds: 900,
        devToolsEnabled: false,
      }),
      0,
    );
  });

  it("never returns a negative or a NaN, whatever it is handed", () => {
    // Neither can arrive — the schema bounds both claims and the measurement
    // comes from a byte count — but the floor is what stops a poisoned number
    // reaching an integer column with a `>= 0` check on it.
    assert.equal(
      gradedPhaseSeconds({
        measuredSeconds: Number.NaN,
        hasRecording: true,
        devToolsEnabled: true,
      }),
      0,
    );
    assert.equal(
      gradedPhaseSeconds({
        measuredSeconds: 10,
        hasRecording: true,
        devSkippedSeconds: -60,
        devToolsEnabled: true,
      }),
      0,
    );
  });
});
