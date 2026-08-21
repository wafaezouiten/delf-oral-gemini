import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { earlyClosingInstruction } from "./early-closing-instruction";

/**
 * The paragraph that stands between the examiner's goodbye and the candidate's
 * bands (#92). What matters is not the wording but the commitments: that an
 * ordinary sitting's prompt is untouched, and that an incident sitting's
 * corrector is told whose fault the goodbye was, in both media it will meet it
 * in.
 */
describe("what the corrector is told about an early closing", () => {
  it("says nothing on the ordinary sitting", () => {
    // Empty string, not a reassurance: the prompt of a sitting with no
    // incident must be byte-identical to the previous version's, which is what
    // keeps EVAL_PROMPT_VERSION's bump honest about what actually changed.
    assert.equal(earlyClosingInstruction(0), "");
  });

  it("attributes the fault to the examiner, not the candidate", () => {
    const instruction = earlyClosingInstruction(1);
    assert.match(instruction, /DÉFAILLANCE DE L'EXAMINATEUR/);
    assert.match(instruction, /pas un fait de la prestation du candidat/);
  });

  it("tells the corrector not to punish the shortened exchange", () => {
    // The half the rubric's waiver cannot reach: the waiver zeroes the two
    // penalties, but the five bands are the model's, and a model reading a
    // dismissal as the shape of the exchange marks « interaction » down for it.
    const instruction = earlyClosingInstruction(1);
    assert.match(instruction, /ne pénalisez le candidat sur AUCUN critère/);
    assert.match(instruction, /cesse légitimement de parler/);
  });

  it("covers the recording as well as the transcript", () => {
    // The goodbye is audible in the débat's audio, which the audio mode grades
    // (docs/AUDIO_EVALUATION.md) — a paragraph about the text alone would leave
    // the corrector hearing the same dismissal untold.
    assert.match(earlyClosingInstruction(1), /audible dans l'enregistrement/);
  });

  it("promises no arithmetic", () => {
    // The waiver is orale-rubric.ts's, tested there. A prompt that also said
    // « aucune pénalité » would be a second implementation of it in French —
    // unversioned, untestable, and free to drift from the real one (#9).
    assert.doesNotMatch(earlyClosingInstruction(1), /pénalité|points|score|note/i);
  });

  it("reads the same however many times it happened", () => {
    // A count reaches this function; a fact leaves it. One goodbye and three
    // are the same instruction, exactly as they are the same waiver.
    assert.equal(earlyClosingInstruction(1), earlyClosingInstruction(3));
  });
});
