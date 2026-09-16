import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CORRECTION_TIMED_OUT } from "./finish-failure";
import { finishStage, finishStageMessage, finishedView, uploadPercent } from "./finish-progress";

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

describe("what « Épreuve terminée » says", () => {
  it("announces the stage's own sentence, with a bar only while uploading", () => {
    const uploading = finishedView({ kind: "uploading", fraction: 0.5 }, null, []);
    assert.equal(uploading.failed, false);
    assert.equal(uploading.heading, "Épreuve terminée");
    assert.equal(uploading.live, true);
    assert.equal(uploading.percent, 50);
    assert.equal(uploading.canLeaveWhileWaiting, false);
    assert.equal(uploading.failure, null);
    assert.equal(finishedView({ kind: "correcting" }, null, []).percent, null);
  });

  it("offers the way out only while the server is correcting behind an accepted sitting (#86)", () => {
    assert.equal(finishedView({ kind: "awaiting" }, null, []).canLeaveWhileWaiting, true);
    assert.equal(
      finishedView({ kind: "awaiting" }, CORRECTION_TIMED_OUT, []).canLeaveWhileWaiting,
      false,
    );
  });

  it("names the recording that could not be sent, and both when both", () => {
    assert.equal(finishedView({ kind: "correcting" }, null, []).dropped, null);
    assert.match(
      finishedView({ kind: "correcting" }, null, ["debate"]).dropped ?? "",
      /^Votre débat était trop volumineux/,
    );
    assert.match(
      finishedView({ kind: "correcting" }, null, ["monologue"]).dropped ?? "",
      /^Votre monologue/,
    );
    assert.match(
      finishedView({ kind: "correcting" }, null, ["monologue", "debate"]).dropped ?? "",
      /^Vos deux prises de parole/,
    );
  });

  it("words a retryable failure as an envoi to try again, and leaving as abandoning", () => {
    const view = finishedView(
      { kind: "uploading", fraction: null },
      { message: "Réseau perdu.", retryable: true },
      [],
    );
    assert.equal(view.failed, true);
    assert.equal(view.live, false, "the notice announces; the sentence stops");
    assert.equal(view.heading, "Correction interrompue");
    assert.equal(view.lede, "Votre prestation attend d'être envoyée.");
    assert.deepEqual(view.failure, {
      title: "L'envoi a échoué",
      message: "Réseau perdu.",
      retryable: true,
      leaveLabel: "Abandonner et revenir au tableau de bord",
    });
  });

  it("words a terminal failure without a retry, and leaving as plain leaving", () => {
    const view = finishedView({ kind: "correcting" }, { message: "Refusé.", retryable: false }, []);
    assert.match(view.lede, /n'a pas pu être corrigée/);
    assert.equal(view.failure?.title, "Cette épreuve ne peut pas être corrigée");
    assert.equal(view.failure?.retryable, false);
    assert.equal(view.failure?.leaveLabel, "Revenir au tableau de bord");
  });

  it("lets a failure override every word it carries, as the timeout does", () => {
    const view = finishedView({ kind: "awaiting" }, CORRECTION_TIMED_OUT, []);
    assert.equal(view.heading, CORRECTION_TIMED_OUT.heading);
    assert.equal(view.lede, CORRECTION_TIMED_OUT.lede);
    assert.equal(view.failure?.title, CORRECTION_TIMED_OUT.title);
    assert.equal(view.failure?.leaveLabel, CORRECTION_TIMED_OUT.leaveLabel);
  });
});
