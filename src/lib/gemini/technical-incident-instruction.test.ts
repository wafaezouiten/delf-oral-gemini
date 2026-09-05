import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { technicalIncidentInstruction } from "./technical-incident-instruction";

describe("the technical-incident paragraph (#189)", () => {
  it("says nothing when the session never dropped", () => {
    // An ordinary sitting's prompt must not change shape for a fault it did not
    // have — `earlyClosingInstruction`'s rule, and for the same reason: a
    // reassuring "the connection held" line is a paragraph the corrector has to
    // read on every correction to learn nothing.
    assert.equal(technicalIncidentInstruction(0), "");
    assert.equal(technicalIncidentInstruction(-1), "");
    assert.equal(technicalIncidentInstruction(Number.NaN), "");
  });

  it("tells the corrector a gap may be the app's, not a candidate who would not answer", () => {
    const paragraph = technicalIncidentInstruction(1);

    assert.match(paragraph, /INCIDENT TECHNIQUE/);
    assert.match(paragraph, /n'étaient pas transcrites/);
    assert.match(paragraph, /question restée sans réponse/);
    assert.match(paragraph, /ne les traitez pas comme un refus de répondre/i);
  });

  it("protects the continuity of discourse as well as the interaction", () => {
    // The reading that costs the candidate most, and the one a transcript with
    // a hole in it invites: an exchange that stops and restarts looks like a
    // candidate who abandoned it.
    assert.match(technicalIncidentInstruction(2), /continuité du discours/);
    assert.match(technicalIncidentInstruction(2), /AUCUN critère/);
  });

  it("states the count, because one drop and six read differently", () => {
    assert.match(technicalIncidentInstruction(1), /interrompue une fois/);
    assert.match(technicalIncidentInstruction(6), /interrompue 6 fois/);
  });

  it("promises nothing about the mark", () => {
    // The paragraph changes what the corrector believes about the transcript
    // and nothing else. Unlike #92's waiver there is no penalty behind it: the
    // recording is the browser's own file and runs straight through a dropped
    // socket, so a reconnect shortens the transcript and never the measured
    // seconds the duration rule reads. A sentence promising otherwise would be
    // a rule stated in French and implemented nowhere.
    const paragraph = technicalIncidentInstruction(3).toLowerCase();

    // « note » is not on the list and « notez » is why: the paragraph tells the
    // corrector what to grade, which is the one thing it is for. What it must
    // not do is promise an outcome.
    for (const forbidden of ["pénalité", "points", "la note", "score", "/25"]) {
      assert.ok(!paragraph.includes(forbidden), `the paragraph promises « ${forbidden} »`);
    }
  });
});
