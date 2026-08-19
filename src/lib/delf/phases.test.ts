import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ORAL_PARTS_B2 } from "./constants";
import {
  MIN_VOICED_SECONDS,
  MONOLOGUE_MIN_SECONDS,
  monologueWasSilent,
  PHASE_DURATIONS,
  canAdvanceEarly,
  formatClock,
  formatTurnOffset,
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

  it("takes its timings from the ported B2 part specs, not a second copy of them", () => {
    // The same three numbers exist in `constants.ts`, where they are the DELF
    // business rule the duration penalty also reads. If the phase clock ever
    // stops deriving them, the timer and the rubric can disagree about how long
    // a monologue is, and nothing will say so.
    const [monologue, debate] = ORAL_PARTS_B2;
    assert.equal(PHASE_DURATIONS.preparation, monologue.preparationSeconds);
    assert.equal(PHASE_DURATIONS.monologue, monologue.durationSeconds);
    assert.equal(PHASE_DURATIONS.debate, debate.durationSeconds);

    // And the official numbers themselves, so a change to either file is loud.
    assert.equal(PHASE_DURATIONS.preparation, 30 * 60);
    assert.equal(PHASE_DURATIONS.monologue, 7 * 60);
    assert.equal(PHASE_DURATIONS.debate, 13 * 60);
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

describe("a silent monologue", () => {
  it("is silent when the microphone worked and carried almost nothing", () => {
    assert.equal(monologueWasSilent(90, 0), true);
    assert.equal(monologueWasSilent(90, MIN_VOICED_SECONDS - 0.1), true);
  });

  it("is not silent once enough speech was carried", () => {
    assert.equal(monologueWasSilent(90, MIN_VOICED_SECONDS), false);
    assert.equal(monologueWasSilent(400, 240), false);
  });

  it("never calls a dead microphone a silent candidate", () => {
    // The asymmetry this function exists for. Someone whose capture failed
    // while they spoke for six minutes must not be told they said nothing —
    // that is the "corrigé sans l'audio" path, not an unattempted task.
    assert.equal(monologueWasSilent(0, 0), false);
  });

  it("treats a nonsense capture the same as none", () => {
    assert.equal(monologueWasSilent(Number.NaN, 0), false);
    assert.equal(monologueWasSilent(-1, 0), false);
  });
});

describe("stamping a turn with when it was said", () => {
  it("reads milliseconds, because that is what the transcript counts in", () => {
    assert.equal(formatTurnOffset(0), "0:00");
    assert.equal(formatTurnOffset(31_000), "0:31");
    assert.equal(formatTurnOffset(65_000), "1:05");
  });

  it("floors, because the stamp marks when a turn started", () => {
    // 1.9 s in is a turn that began during the second second, not the third.
    assert.equal(formatTurnOffset(1_900), "0:01");
  });

  it("never prints a negative stamp", () => {
    // Both callers subtract an anchor from an entry, and « -0:01 » beside a turn
    // reads as a defect in the recording rather than in the arithmetic.
    assert.equal(formatTurnOffset(-5_000), "0:00");
  });

  it("survives a timestamp that is not a number", () => {
    assert.equal(formatTurnOffset(Number.NaN), "0:00");
  });
});
