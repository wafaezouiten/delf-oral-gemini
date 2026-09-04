import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { transcriptReliabilityInstruction } from "./transcript-reliability-instruction";

/**
 * What the corrector is told the transcript is worth (#186). The wording is
 * free; the commitments are not: that the text is named as automatic and
 * fallible in both modes, that the three artefacts the sitting produced are
 * named as artefacts, and that where there is audio, the audio wins — for every
 * criterion, since the charge that started this was on lexique, not phonologie.
 */
describe("what the corrector is told the transcript is worth", () => {
  it("names the transcript as automatic and unreviewed, in both modes", () => {
    for (const mode of ["audio", "text"] as const) {
      const instruction = transcriptReliabilityInstruction(mode);
      assert.match(instruction, /^TRANSCRIPTION : /, `${mode} opens as a paragraph of its own`);
      assert.match(instruction, /AUTOMATIQUE/);
      assert.match(instruction, /ni relue ni corrigée/);
    }
  });

  it("names the three artefacts the sitting actually produced", () => {
    // A whole answer in Portuguese, an answer arriving twice word for word, and
    // words the transcriber invented. Each was charged to the candidate once.
    for (const mode of ["audio", "text"] as const) {
      const instruction = transcriptReliabilityInstruction(mode);
      assert.match(instruction, /autre langue/, `${mode}: the wrong-language passage`);
      assert.match(instruction, /mot pour mot/, `${mode}: the duplicated turn`);
      assert.match(
        instruction,
        /mal reconnus|sans (aucun )?rapport avec le contexte/,
        `${mode}: the invented word`,
      );
    }
  });

  it("makes the audio outrank the text for every criterion, not only phonologie", () => {
    const instruction = transcriptReliabilityInstruction("audio");
    assert.match(instruction, /L'AUDIO QUI FAIT FOI/);
    assert.match(instruction, /TOUS les critères/);
    assert.match(instruction, /pas seulement la phonologie/);
    // And says what to do with an artefact it cannot hear: nothing, nowhere.
    assert.match(instruction, /ne pèse sur aucune note/);
    assert.match(instruction, /ne figure dans aucune justification/);
  });

  it("gives the candidate the benefit of the doubt when there is no audio to check", () => {
    const instruction = transcriptReliabilityInstruction("text");
    assert.match(instruction, /pas le son/);
    assert.match(instruction, /erreurs de transcription et non des faits de la prestation/);
    assert.match(instruction, /ne les comptez pas contre le candidat/);
    // Without promising the audio it does not have.
    assert.doesNotMatch(instruction, /FAIT FOI/);
    // And keeps the language bands on what a transcript does show reliably.
    assert.match(instruction, /erreurs cohérentes et récurrentes/);
  });
});
