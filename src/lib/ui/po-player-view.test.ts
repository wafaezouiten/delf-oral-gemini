import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MONOLOGUE_MIN_SECONDS } from "@/lib/delf/phases";
import {
  candidateStatus,
  examinerStatus,
  micCopy,
  passationStatus,
  poKicker,
  secondsToMonologueFloor,
  shortPartLabel,
  partieKicker,
  EXPOSE_PLAN,
  topbarStep,
} from "./po-player-view";

describe("the masthead", () => {
  it("names the épreuve, the diploma and the part", () => {
    assert.equal(poKicker("Monologue suivi"), "Production orale · DELF B2 · Monologue suivi");
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
});

/*
 * "the déroulé" tests went with `buildDeroule` and its rail card: the durations
 * the list derived are now printed once, on the sujet's launch dialog.
 */

describe("the exposé plan", () => {
  it("gives the argued arc, which is the only one B2 has a caller for", () => {
    assert.equal(EXPOSE_PLAN.length, 4);
    assert.match(EXPOSE_PLAN[0].detail, /problématique/);
    assert.equal(EXPOSE_PLAN[3].title, "Conclusion");
  });

  it("keeps « Point de vue » as a beat of its own", () => {
    // B2's « présenter et défendre un point de vue » is graded on the candidate
    // taking a position, not on surveying the arguments. Folding it into the
    // développement is how an exposé comes out sounding like a B1 summary.
    assert.equal(EXPOSE_PLAN[2].title, "Point de vue");
    assert.match(EXPOSE_PLAN[2].detail, /concession/);
  });

  it("gives every beat a title and a usable instruction", () => {
    // One list, printed twice: the préparation rail's « Structure attendue » and
    // the exposé's « Votre plan » are the same four steps, so the structure a
    // candidate absorbs is the one still in front of them while they speak.
    for (const step of EXPOSE_PLAN) {
      assert.ok(step.title.length > 0);
      assert.ok(step.detail.length > 20, `"${step.title}" has no instruction`);
      assert.ok(!step.title.includes("—"), "no em dash in text a candidate reads");
    }
  });
});

describe("the mic copy", () => {
  it("names the task, because the label is the control's only name", () => {
    assert.match(micCopy("monologue", "recording").label, /exposé/);
    assert.match(micCopy("debate", "recording").label, /débat/);
  });

  it("says the microphone is live before it says what the button does", () => {
    // The commonest confusion on this screen is not knowing whether anything is
    // being recorded. The badge and the ring say so too; this is the one place
    // it is said in words, right next to the control.
    const { hint } = micCopy("monologue", "recording");
    assert.match(hint, /^Vous parlez\./);
    assert.match(hint, /Cliquez pour terminer votre exposé\.$/);
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

  it("stops counting down to a floor once the part is closing", () => {
    // `canAdvance` goes false the moment the handshake starts, so the control
    // used to fall back to `locked` and print « Encore 0 min avant de pouvoir
    // conclure » over a monologue that was already concluding (#55).
    const { hint, button } = micCopy("monologue", "closing", 0);
    assert.doesNotMatch(hint, /Encore/);
    assert.match(hint, /Fin de l'exposé/);
    // The button is no longer an offer, and stops being worded as one.
    assert.equal(button, "Terminé");
  });

  it("names what comes next at the close, per part", () => {
    assert.match(micCopy("monologue", "closing").hint, /consigne du débat/);
    assert.match(micCopy("debate", "closing").hint, /correction/);
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

  it("says the examiner is speaking when the consigne is playing, not that they are offline", () => {
    // The one state where the examiner is audible with no session behind them
    // (#37). This said « L'examinateur n'est pas en ligne » over the sound of the
    // examiner talking.
    assert.match(
      examinerStatus({ connected: false, connecting: false, speaking: true, announcing: true }),
      /consigne/,
    );
  });

  it("says the examiner is preparing their question, not listening, at the débat's opening", () => {
    // The connect-and-generate window before the opening question is audible.
    // « Vous écoute attentivement » here handed the candidate the floor over an
    // examiner who was about to ask.
    assert.match(
      examinerStatus({ connected: true, connecting: false, speaking: false, opening: true }),
      /prépare sa question/,
    );
    // The moment the voice starts, speaking is the truer sentence.
    assert.match(
      examinerStatus({ connected: true, connecting: false, speaking: true, opening: true }),
      /intervient/,
    );
    // And while the socket is still connecting, that is the better explanation
    // for the silence.
    assert.match(
      examinerStatus({ connected: false, connecting: true, speaking: false, opening: true }),
      /Connexion/,
    );
  });

  it("says the examiner is finishing while the part is being closed", () => {
    // The socket is being torn down while the voice is still audible (#55), so
    // the connection's answer is the wrong one to give.
    assert.match(
      examinerStatus({ connected: false, connecting: false, speaking: false, closing: true }),
      /conclut/,
    );
  });

  it("puts listening above speaking: the examiner talking outranks the mic", () => {
    // Both are true while the examiner interrupts, and « Vous avez la parole »
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
});

describe("the status card", () => {
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

  it("does not claim the clock has started before the part has begun", () => {
    // The two claims a candidate is most entitled to rely on, and both are false
    // while the consigne is being given and while the part sits armed: nothing is
    // recorded yet, and the clock has not begun. It used to say the opposite of
    // both, in a window that was milliseconds wide before #37 and is now as long
    // as the candidate takes to read the sujet.
    const status = passationStatus("monologue", false, true);
    assert.ok(!/déjà commencé/.test(status.body), "must not claim the clock is running");
    assert.match(status.body, /pas encore commencé/);
    assert.match(status.body, /Rien n'est enregistré/);
    // And the ordinary connecting card is untouched: outside a consigne the clock
    // really is running while the socket opens.
    assert.match(passationStatus("monologue", false).body, /déjà commencé/);
  });

  it("acknowledges the click that ended the part, and says what follows", () => {
    // Between « Terminer » and the next consigne the examiner is asked for a
    // closing sentence, which takes seconds. Nothing on screen said so, so the
    // click read as ignored on the one screen where pressing it twice is exactly
    // what should not happen (#55).
    const monologue = passationStatus("monologue", true, false, true);
    assert.equal(monologue.title, "Fin de l'exposé");
    assert.match(monologue.body, /consigne du débat/);
    const debate = passationStatus("debate", true, false, true);
    assert.match(debate.body, /correction/);
  });

  it("lets the close outrank the connection and the consigne", () => {
    // The part is ending: what the socket is doing, and what the last consigne
    // was, are both answers to a question the candidate has stopped asking.
    assert.equal(passationStatus("monologue", false, true, true).title, "Fin de l'exposé");
  });
});

describe("the topbar stepper", () => {
  it("stands on the préparation for the whole of it", () => {
    // It stood on « Exposé » instead, for as long as the briefing screen took
    // the first step: the préparation screen wrote its own index and wrote 1.
    // Nothing derives it now — the phase is the answer (#55).
    assert.equal(topbarStep("preparation"), 0);
  });

  it("names the épreuve's parts, so the exposé and the débat are not one step", () => {
    // It used to fold both into a single « Passage », which told a candidate
    // halfway through the épreuve they were on the last step — and forced a
    // second stepper inside the scene to say which half they were in.
    assert.equal(topbarStep("monologue"), 1);
    assert.equal(topbarStep("debate"), 2);
    // `finished` is the évaluation's loading state, not a fourth part.
    assert.equal(topbarStep("finished"), 2);
  });

  it("numbers the parts as the DELF does", () => {
    assert.equal(partieKicker("monologue"), "Partie 1 · Monologue suivi");
    assert.equal(partieKicker("debate"), "Partie 2 · Débat");
  });
});
