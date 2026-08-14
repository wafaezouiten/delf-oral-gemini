import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { phonologyInstruction } from "./phonology-instruction";

/**
 * The corrector is told what audio it has. These assert that what it is told is
 * true — which matters because phonologie is the criterion the whole project
 * exists to grade from sound rather than from guesswork, and a model that
 * misattributes a recording is back to guessing with extra confidence.
 */

describe("what the corrector is told about the audio", () => {
  it("names both tasks, in exam order, when both were recorded", () => {
    const instruction = phonologyInstruction("audio", [
      { phase: "monologue" },
      { phase: "debate" },
    ]);

    assert.match(instruction, /ordre de l'épreuve/);
    assert.ok(
      instruction.indexOf("MONOLOGUE SUIVI") < instruction.indexOf("DEBAT"),
      "the monologue is named before the débat, because that is the order they are attached in",
    );
    assert.match(instruction, /Écoutez-les/, "plural, since there are two of them");
  });

  it("says which task a lone recording is, and which one is missing", () => {
    // The case this module exists for. A phase can fail to record on its own,
    // and the transcript still contains both tasks — so a model handed one file
    // and told nothing will assume it covers the épreuve.
    const instruction = phonologyInstruction("audio", [{ phase: "monologue" }]);

    assert.match(instruction, /UNIQUEMENT le MONOLOGUE SUIVI/);
    assert.match(instruction, /Le DEBAT n'a pas pu être enregistré/);
    assert.match(instruction, /Écoutez-le/, "singular");
  });

  it("mirrors that when it is the débat that survived", () => {
    const instruction = phonologyInstruction("audio", [{ phase: "debate" }]);
    assert.match(instruction, /UNIQUEMENT le DEBAT/);
    assert.match(instruction, /Le MONOLOGUE SUIVI n'a pas pu être enregistré/);
  });

  it("tells the corrector not to mark down the half it cannot hear", () => {
    // Otherwise the candidate is penalised twice for one dead microphone: once
    // by the duration penalty, which is already measuring the shortfall
    // honestly, and again by a phonologie band inferred from silence.
    const instruction = phonologyInstruction("audio", [{ phase: "debate" }]);
    assert.match(instruction, /ne pénalisez pas le candidat pour la partie manquante/);
  });

  it("calls an unattributed recording what it is: the whole épreuve", () => {
    // The verification scripts and the audio-versus-text experiment hand over a
    // single whole-sitting file rather than the per-phase artefacts.
    const instruction = phonologyInstruction("audio", [{ phase: null }]);

    assert.match(instruction, /l'ensemble de l'épreuve/);
    assert.doesNotMatch(instruction, /UNIQUEMENT/, "nothing is missing from it");
  });

  it("grades an absence honestly in text mode, whatever it is handed", () => {
    const instruction = phonologyInstruction("text", [{ phase: "monologue" }]);
    assert.match(instruction, /QUE de la transcription/);
    assert.doesNotMatch(instruction, /ENREGISTREMENT/);
    assert.equal(instruction, phonologyInstruction("text"));
  });
});
