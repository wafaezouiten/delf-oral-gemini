import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLOCK_MILESTONES,
  clockLabel,
  crossedMilestone,
  isClockUrgent,
  milestoneMessage,
} from "./clock-announcements";

describe("clock milestones", () => {
  it("announces a milestone on the tick that crosses it, and not again", () => {
    assert.equal(crossedMilestone(61, 60), 60);
    assert.equal(crossedMilestone(60, 59), null);
    assert.equal(crossedMilestone(59, 58), null);
  });

  it("says nothing on an ordinary tick", () => {
    assert.equal(crossedMilestone(400, 399), null);
    assert.equal(crossedMilestone(200, 199), null);
  });

  it("announces the most urgent one when the clock jumps past several", () => {
    // The case this function exists for: a backgrounded tab comes back with a
    // clock driven from a wall-clock delta, so `remaining` never lands exactly
    // on a milestone. Announcing 2 minutes when 30 seconds are left would be
    // worse than silence.
    assert.equal(crossedMilestone(125, 25), 30);
    assert.equal(crossedMilestone(700, 10), 30);
  });

  it("announces nothing when the clock goes backwards", () => {
    // A new phase resets the countdown upwards. Every milestone is then
    // technically "above" the new reading, and announcing them all would open
    // the débat by reading out six sentences.
    assert.equal(crossedMilestone(30, 780), null);
    assert.equal(crossedMilestone(0, 420), null);
  });

  it("treats zero as a milestone of its own", () => {
    assert.ok(CLOCK_MILESTONES.includes(0));
    assert.equal(crossedMilestone(1, 0), 0);
  });

  it("survives a clock that is not a number", () => {
    assert.equal(crossedMilestone(Number.NaN, 60), null);
    assert.equal(crossedMilestone(60, Number.NaN), null);
  });
});

describe("milestone wording", () => {
  it("agrees in French rather than saying « 1 minutes »", () => {
    assert.match(milestoneMessage("debate", 60), /1 minute\b/);
    assert.match(milestoneMessage("debate", 300), /5 minutes/);
    assert.match(milestoneMessage("debate", 30), /30 secondes/);
  });

  it("names the phase, because the same number means different things", () => {
    assert.match(milestoneMessage("preparation", 60), /préparation/);
    assert.match(milestoneMessage("monologue", 60), /monologue/);
    assert.match(milestoneMessage("debate", 60), /débat/);
  });

  it("says what happens next when the clock reaches zero", () => {
    assert.match(milestoneMessage("preparation", 0), /monologue/i);
    assert.match(milestoneMessage("monologue", 0), /débat/i);
    assert.match(milestoneMessage("debate", 0), /termine/i);
  });

  it("labels the clock with the phase and the time", () => {
    assert.equal(clockLabel("monologue", 90), "Monologue : 1:30 restantes");
    assert.equal(clockLabel("finished", 0), "Épreuve terminée");
  });
});

describe("clock urgency", () => {
  it("turns urgent in the last minute of a speaking phase", () => {
    assert.equal(isClockUrgent("monologue", 61), false);
    assert.equal(isClockUrgent("monologue", 60), true);
    assert.equal(isClockUrgent("debate", 5), true);
  });

  it("never rushes the preparation", () => {
    // Thirty minutes of notes ending on time is not an emergency, and colouring
    // it as one would teach the candidate to ignore the colour in the phase
    // where it matters.
    assert.equal(isClockUrgent("preparation", 30), false);
    assert.equal(isClockUrgent("finished", 0), false);
  });
});
