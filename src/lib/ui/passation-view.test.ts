import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PHASE_DURATIONS } from "@/lib/delf/phases";

import { passationView, type PassationInput } from "./passation-view";
import { DEBATE_TITLE, MONOLOGUE_TITLE } from "./po-player-view";

/** A débat in full swing: connected, the candidate talking, nobody closing. */
const talking: PassationInput = {
  phase: "debate",
  remaining: 300,
  recording: true,
  examinerSpeaking: false,
  openingQuestionPending: false,
  connected: true,
  connecting: false,
  awaitingStart: false,
  closing: false,
  awaitingConsigne: false,
  notes: "",
};

describe("the passation screen's view", () => {
  it("names the part, sets the column for it, and times it", () => {
    const debate = passationView(talking);
    assert.equal(debate.partTitle, DEBATE_TITLE);
    assert.equal(debate.layout, "debate");
    assert.equal(debate.total, PHASE_DURATIONS.debate);

    const monologue = passationView({ ...talking, phase: "monologue" });
    assert.equal(monologue.partTitle, MONOLOGUE_TITLE);
    assert.equal(monologue.layout, "monologue");
    assert.equal(monologue.total, PHASE_DURATIONS.monologue);
  });

  it("gives the candidate the floor when the examiner has neither spoken nor a question owed", () => {
    const { scene } = passationView(talking);
    assert.equal(scene.examinerSpeaking, false);
    assert.equal(scene.candidateRecording, true);
    assert.equal(scene.candidateStatus, "Vous avez la parole");
    assert.equal(scene.examinerStatus, "Vous écoute attentivement.");
    assert.equal(scene.candidateStatusUrgent, false);
  });

  it("hands the floor to the examiner while a question is owed, exactly as while one is spoken", () => {
    const owed = passationView({ ...talking, openingQuestionPending: true }).scene;
    const spoken = passationView({ ...talking, examinerSpeaking: true }).scene;
    for (const scene of [owed, spoken]) {
      assert.equal(scene.examinerSpeaking, true);
      assert.equal(scene.candidateRecording, false, "the microphone is held, not the candidate's");
      assert.equal(scene.candidateStatus, "En écoute…");
    }
    assert.equal(owed.examinerStatus, "L'examinateur prépare sa question…");
    assert.equal(spoken.examinerStatus, "L'examinateur intervient…");
  });

  it("says the candidate's status urgently in the last minute", () => {
    assert.equal(passationView({ ...talking, remaining: 61 }).scene.candidateStatusUrgent, false);
    assert.equal(passationView({ ...talking, remaining: 60 }).scene.candidateStatusUrgent, true);
  });

  it("prints the monologue's status line only once the part has started and the consigne is over", () => {
    const monologue = { ...talking, phase: "monologue" as const };
    assert.equal(typeof passationView(monologue).statusLine, "string");
    assert.equal(passationView({ ...monologue, awaitingStart: true }).statusLine, null);
    assert.equal(passationView({ ...monologue, awaitingConsigne: true }).statusLine, null);
    assert.equal(
      passationView(talking).statusLine,
      null,
      "the débat's conversation says it instead",
    );
  });

  it("holds « Commencer » while the consigne plays, and knows whether there are notes to open", () => {
    assert.equal(passationView(talking).startDisabled, false);
    assert.equal(passationView({ ...talking, awaitingConsigne: true }).startDisabled, true);
    assert.equal(passationView(talking).hasNotes, false);
    assert.equal(passationView({ ...talking, notes: "   " }).hasNotes, false);
    assert.equal(passationView({ ...talking, notes: "thèse, antithèse" }).hasNotes, true);
  });
});
