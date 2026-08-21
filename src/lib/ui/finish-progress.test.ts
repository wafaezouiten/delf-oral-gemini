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
  });

  it("warns about the tab while the recording still lives only in it", () => {
    assert.match(finishStageMessage({ kind: "compressing" }), /Préparation/);
    assert.match(finishStageMessage({ kind: "correcting" }), /ne fermez pas cet onglet/);
  });
});
