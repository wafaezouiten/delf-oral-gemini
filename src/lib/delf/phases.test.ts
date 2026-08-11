import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MONOLOGUE_MIN_SECONDS,
  PHASE_DURATIONS,
  canAdvanceEarly,
  formatClock,
  isPhaseTimeUp,
  nextPhase,
  phaseDurationSeconds,
  phaseUsesLiveSession,
  remainingSeconds,
} from "./phases";

describe("exam state machine", () => {
  it("runs preparation to monologue to debate to finished, and stops", () => {
    assert.equal(nextPhase("preparation"), "monologue");
    assert.equal(nextPhase("monologue"), "debate");
    assert.equal(nextPhase("debate"), "finished");
    assert.equal(nextPhase("finished"), "finished");
  });

  it("gives each phase its own clock rather than one exam-wide timer", () => {
    assert.equal(phaseDurationSeconds("preparation"), 30 * 60);
    assert.equal(phaseDurationSeconds("monologue"), 7 * 60);
    assert.equal(phaseDurationSeconds("debate"), 13 * 60);
    assert.equal(phaseDurationSeconds("finished"), 0);
    // The three phases are genuinely different lengths: a single shared timer
    // could not satisfy this.
    const distinct = new Set(Object.values(PHASE_DURATIONS));
    assert.equal(distinct.size, 3);
  });

  it("ends a phase exactly once, even when the clock jumps past the boundary", () => {
    assert.equal(isPhaseTimeUp("monologue", 419), false);
    assert.equal(isPhaseTimeUp("monologue", 420), true);
    // A backgrounded tab can resume well past the deadline.
    assert.equal(isPhaseTimeUp("monologue", 900), true);
  });

  it("holds the monologue open until the DELF five-minute floor", () => {
    assert.equal(canAdvanceEarly("monologue", MONOLOGUE_MIN_SECONDS - 1), false);
    assert.equal(canAdvanceEarly("monologue", MONOLOGUE_MIN_SECONDS), true);
    assert.equal(canAdvanceEarly("preparation", 0), true);
    assert.equal(canAdvanceEarly("finished", 999), false);
  });

  it("keeps Gemini out of the preparation phase", () => {
    assert.equal(phaseUsesLiveSession("preparation"), false);
    assert.equal(phaseUsesLiveSession("monologue"), true);
    assert.equal(phaseUsesLiveSession("debate"), true);
    assert.equal(phaseUsesLiveSession("finished"), false);
  });

  it("never reports negative or NaN time remaining", () => {
    assert.equal(remainingSeconds("monologue", 500), 0);
    assert.equal(remainingSeconds("monologue", Number.NaN), 420);
    assert.equal(remainingSeconds("debate", 60), 720);
  });

  it("formats the clock as m:ss", () => {
    assert.equal(formatClock(0), "0:00");
    assert.equal(formatClock(65), "1:05");
    assert.equal(formatClock(780), "13:00");
    assert.equal(formatClock(-10), "0:00");
  });
});
