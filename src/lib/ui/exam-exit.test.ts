import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { examExitRoute } from "./exam-exit";

describe("what « Retour » costs (#199)", () => {
  it("archives the préparation, whatever the flag says about a part that is not open", () => {
    // `awaitingStart` is a fact about a speaking phase and the controller reports
    // false for the préparation. Pinned both ways so a change to that convention
    // cannot silently turn the préparation's exit into a zero.
    assert.equal(examExitRoute("preparation", false), "archive");
    assert.equal(examExitRoute("preparation", true), "archive");
  });

  // The four corners the issue asks for: two parts, each armed and running.

  it("archives an armed monologue — nothing has been said yet", () => {
    assert.equal(examExitRoute("monologue", true), "archive");
  });

  it("abandons a running monologue", () => {
    assert.equal(examExitRoute("monologue", false), "abandon");
  });

  it("finishes an armed débat — the exposé exists and is owed a correction", () => {
    assert.equal(examExitRoute("debate", true), "finish");
  });

  it("abandons a running débat", () => {
    assert.equal(examExitRoute("debate", false), "abandon");
  });

  it("never answers « archive » for a part that has begun", () => {
    // The rule in one line: the zero is owed from « Enregistrer ». Anything that
    // has been started is a performance, and leaving it is a walk-out.
    for (const phase of ["monologue", "debate"] as const) {
      assert.notEqual(examExitRoute(phase, false), "archive");
    }
  });

  it("writes the sitting down for a phase it cannot otherwise place", () => {
    // `finished` has no exit dialog, so this is unreachable — and the direction
    // it fails in is the point: an unnamed route must not become a silent exit.
    assert.equal(examExitRoute("finished", true), "abandon");
    assert.equal(examExitRoute("finished", false), "abandon");
  });
});
