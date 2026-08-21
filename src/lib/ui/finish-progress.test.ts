import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { finishStage, finishStageMessage, uploadPercent } from "./finish-progress";

describe("which stage « Épreuve terminée » is in", () => {
  it("is compressing until the request has been built and sent", () => {
    assert.deepEqual(finishStage(false, null), { kind: "compressing" });
  });

  it("is uploading from the send, even before the first progress event", () => {
    // A retry resets the fraction to null; the sentence must not claim the
    // corrector has a body that has not started leaving.
    assert.deepEqual(finishStage(true, null), { kind: "uploading", fraction: null });
    assert.deepEqual(finishStage(true, 0.4), { kind: "uploading", fraction: 0.4 });
  });

  it("is correcting only once the whole body has left the tab", () => {
    assert.deepEqual(finishStage(true, 1), { kind: "correcting" });
    assert.equal(finishStage(true, 0.999).kind, "uploading");
  });

  it("is awaiting the moment the server has accepted the sitting (#86)", () => {
    // The 202 is the server's own word that the bytes arrived, so it outranks
    // whatever the transport still thinks the upload fraction is.
    assert.deepEqual(finishStage(true, 1, true), { kind: "awaiting" });
    assert.deepEqual(finishStage(false, null, true), { kind: "awaiting" });
  });
});

describe("the sentence and the figure", () => {
  it("keeps the percentage out of the live sentence", () => {
    // The paragraph announces on every change; the moving figure is drawn
    // beside it, silently.
    const message = finishStageMessage({ kind: "uploading", fraction: 0.63 });
    assert.doesNotMatch(message, /\d/);
    assert.match(message, /Ne fermez pas cet onglet/);
  });

  it("rounds the fraction to whole percentages for the bar", () => {
    assert.equal(uploadPercent({ kind: "uploading", fraction: 0.634 }), 63);
    assert.equal(uploadPercent({ kind: "uploading", fraction: 1 }), 100);
  });

  it("draws no bar where there is no honest figure", () => {
    assert.equal(uploadPercent({ kind: "uploading", fraction: null }), null);
    assert.equal(uploadPercent({ kind: "compressing" }), null);
    assert.equal(uploadPercent({ kind: "correcting" }), null);
    assert.equal(uploadPercent({ kind: "awaiting" }), null);
  });

  it("warns about the tab while the recording still lives only in it", () => {
    assert.match(finishStageMessage({ kind: "compressing" }), /Préparation/);
    assert.match(finishStageMessage({ kind: "correcting" }), /ne fermez pas cet onglet/);
  });

  it("releases the candidate once the sitting is safe on the server (#86)", () => {
    // The exact reversal of the warning above, and the point of the 202: the
    // recording no longer lives only in the tab, so holding the candidate
    // would be the old wait wearing a new sentence.
    const message = finishStageMessage({ kind: "awaiting" });
    assert.match(message, /Vous pouvez fermer cet onglet/);
    assert.doesNotMatch(message, /[Nn]e fermez pas/);
    assert.match(message, /historique/);
  });
});
