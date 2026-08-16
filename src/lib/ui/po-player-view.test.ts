import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MONOLOGUE_MIN_SECONDS, PHASE_DURATIONS, formatClock } from "@/lib/delf/phases";
import {
  activeBeat,
  buildDeroule,
  candidateStatus,
  examinerStatus,
  micCopy,
  partSubtitle,
  passationStatus,
  poKicker,
  PASSATION_BEATS,
  secondsToMonologueFloor,
  shortPartLabel,
  structureSteps,
  topbarStep,
} from "./po-player-view";

describe("the masthead", () => {
  it("names the épreuve, the diploma and the part", () => {
    assert.equal(
      poKicker("Monologue suivi"),
      "Production orale · DELF B2 · Monologue suivi",
    );
  });

  it("cuts a part title at its separator, whichever one was typed", () => {
    // The two titles in constants.ts use a colon; a rewrite in the reference's
    // em-dash style must not start printing the whole line as the short label.
    assert.equal(
      shortPartLabel("Monologue suivi : présenter et défendre un point de vue"),
      "Monologue suivi",
    );
    assert.equal(shortPartLabel("Débat — exercice en interaction"), "Débat");
    assert.equal(shortPartLabel("Débat"), "Débat");
  });

  it("keeps the tail as the subtitle, and nothing when there is no tail", () => {
    assert.equal(
      partSubtitle("Monologue suivi : présenter et défendre un point de vue"),
      "présenter et défendre un point de vue",
    );
    assert.equal(partSubtitle("Débat"), "");
  });
});

describe("the déroulé", () => {
  const steps = buildDeroule();

  it("prints the three phases the state machine will actually run", () => {
    assert.deepEqual(
      steps.map((step) => step.title),
      ["Préparation", "Monologue suivi", "Débat"],
    );
    assert.deepEqual(
      steps.map((step) => step.n),
      [1, 2, 3],
    );
  });

  it("prints the clocks the timers will count, not a second copy of them", () => {
    // The whole reason this is derived rather than written out: a briefing that
    // promises seven minutes of a monologue the timer gives five is worse than
    // no briefing.
    assert.equal(steps[0].durationLabel, formatClock(PHASE_DURATIONS.preparation));
    assert.equal(steps[1].durationLabel, formatClock(PHASE_DURATIONS.monologue));
    assert.equal(steps[2].durationLabel, formatClock(PHASE_DURATIONS.debate));
  });

  it("captions the monologue without repeating the duration beside it", () => {
    // The part description ends in "(~5–7 min)", and the row already carries a
    // duration column.
    assert.doesNotMatch(steps[1].caption, /min/);
    assert.ok(steps[1].caption.length > 0);
  });
});

describe("the préparation rail", () => {
  it("gives the argued arc, which is the only one B2 has a caller for", () => {
    const steps = structureSteps();
    assert.equal(steps.length, 4);
    assert.match(steps[0], /problématique/);
    assert.match(steps[3], /débat/);
  });
});

describe("the passation beats", () => {
  it("has exactly the two beats of the B2 épreuve", () => {
    assert.deepEqual([...PASSATION_BEATS], ["Exposé", "Débat"]);
  });

  it("reads the beat off the phase instead of estimating it from the clock", () => {
    assert.equal(activeBeat("monologue"), 0);
    assert.equal(activeBeat("debate"), 1);
  });
});

describe("the mic copy", () => {
  it("names the task, because the label is the control's only name", () => {
    assert.match(micCopy("monologue", "recording").label, /exposé/);
    assert.match(micCopy("debate", "recording").label, /débat/);
  });

  it("says how much time is still owed rather than refusing", () => {
    const { hint, label } = micCopy("monologue", "locked", 150);
    // 150 s rounds UP to 3 minutes: promising "2 min" and then still refusing at
    // 2:00 is the version of this that gets clicked twice.
    assert.match(hint, /Encore 3 min/);
    assert.match(label, /3 minutes/);
  });

  it("says what it is waiting for while the socket opens", () => {
    assert.match(micCopy("debate", "connecting").hint, /Connexion/);
  });
});

describe("the floor", () => {
  it("counts down to the DELF's five-minute minimum", () => {
    assert.equal(secondsToMonologueFloor(0), MONOLOGUE_MIN_SECONDS);
    assert.equal(secondsToMonologueFloor(60), MONOLOGUE_MIN_SECONDS - 60);
  });

  it("never goes negative once the floor is passed", () => {
    assert.equal(secondsToMonologueFloor(MONOLOGUE_MIN_SECONDS), 0);
    assert.equal(secondsToMonologueFloor(MONOLOGUE_MIN_SECONDS + 999), 0);
  });
});

describe("the status lines", () => {
  it("distinguishes connecting from disconnected, which look the same otherwise", () => {
    assert.match(
      examinerStatus({ connected: false, connecting: true, speaking: false }),
      /Connexion/,
    );
    assert.match(
      examinerStatus({ connected: false, connecting: false, speaking: false }),
      /pas en ligne/,
    );
  });

  it("puts listening above speaking: the examiner talking outranks the mic", () => {
    // Both are true while the examiner interrupts, and "vous avez la parole"
    // next to a talking examiner is the one that misleads.
    assert.equal(
      candidateStatus({ connected: true, examinerSpeaking: true, recording: true }),
      "En écoute…",
    );
  });

  it("says the microphone is waiting when it is, rather than claiming the floor", () => {
    assert.match(
      candidateStatus({ connected: true, examinerSpeaking: false, recording: false }),
      /Microphone/,
    );
  });

  it("tells the candidate the clock is already running while the socket opens", () => {
    // The phase clock starts with the phase, not with the connection, and a
    // candidate who thinks otherwise loses the difference in silence.
    const status = passationStatus("monologue", false);
    assert.match(status.body, /déjà commencé/);
  });

  it("gives each speaking phase its own instruction", () => {
    assert.match(passationStatus("monologue", true).body, /ne vous coupera pas/);
    assert.match(passationStatus("debate", true).body, /objections/);
  });
});

describe("the topbar stepper", () => {
  it("stays on Sujet until the épreuve starts", () => {
    assert.equal(topbarStep("preparation", false), 0);
  });

  it("tracks the three screens, not the four phases", () => {
    assert.equal(topbarStep("preparation", true), 1);
    assert.equal(topbarStep("monologue", true), 2);
    assert.equal(topbarStep("debate", true), 2);
    // `finished` is the évaluation's loading state, not a fourth step.
    assert.equal(topbarStep("finished", true), 2);
  });
});
