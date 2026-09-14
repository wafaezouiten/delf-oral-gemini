import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COMPETENCY_FLOOR } from "@/lib/delf/constants";
import { findTopic } from "@/lib/delf/topics";

import { CRITERIA_GROUPS, criterionRowView, resultsView } from "./results-view";
import type { StoredResult } from "./stored-result";

const feedback: StoredResult["evaluation"]["feedback"] = {
  justifications: {
    realisationTache: "position claire",
    interaction: "défend sa position",
    lexique: "vocabulaire suffisant",
    morphosyntaxe: "accords fautifs",
    phonologie: "intelligible",
  },
  appreciationGlobale: "prestation honnête",
  pointsForts: ["structure"],
  axesPrioritaires: ["accords"],
  conseil: "relisez les accords",
  phonologieNonEvaluable: false,
};

/** A full, unpenalised sitting: five bands that already are the mark. */
const plain: StoredResult = {
  evaluation: {
    mode: "audio",
    criteria: { realisationTache: 5, interaction: 3, lexique: 3, morphosyntaxe: 1, phonologie: 3 },
    rawScore25: 15,
    score25: 15,
    durationPenalty: 0,
    absencePenalty: 0,
    durationCharges: [],
    absentParts: [],
    model: "gemini-3.6-flash",
    latencySeconds: 40,
    feedback,
  },
  topic: findTopic("teletravail")!,
  transcript: [],
  monologueSeconds: 330,
  debateSeconds: 640,
  reconnectCount: 0,
  earlyClosingCount: 0,
  examinerModel: "gemini-3.1-flash-live-preview",
};

describe("the results view", () => {
  it("prints the mark, its band in a word, and the meta line", () => {
    const view = resultsView(plain);
    assert.equal(view.score25, "15");
    assert.equal(view.outOf, 25);
    assert.equal(view.passed, true);
    assert.equal(typeof view.toneLabel, "string");
    assert.match(view.meta, /5 critères/);
    assert.match(view.floorNote, new RegExp(`au-dessus du seuil .*${COMPETENCY_FLOOR}/25`));
  });

  it("groups the five criteria by compétence in the grille's order", () => {
    const view = resultsView(plain);
    assert.deepEqual(
      view.groups.map((group) => group.rows.map((row) => row.key)),
      CRITERIA_GROUPS.map((group) => group.criteria),
    );
    assert.equal(view.groups.flatMap((g) => g.rows).length, 5);
  });

  it("says nothing under the mark, and prints no totals, when the bands already are the mark", () => {
    const view = resultsView(plain);
    assert.deepEqual(view.notes, []);
    assert.equal(view.totals, null);
    assert.equal(view.textMode, false);
  });

  it("names both models on the provenance line, and only the corrector when the examiner is unknown", () => {
    assert.deepEqual(resultsView(plain).provenance, {
      examinerModel: "gemini-3.1-flash-live-preview",
      correctorModel: "gemini-3.6-flash",
    });
    assert.equal(
      resultsView({ ...plain, examinerModel: undefined }).provenance.examinerModel,
      null,
    );
  });

  it("hands the transcript the recordings it can play, and none for a stash", () => {
    assert.deepEqual(resultsView(plain).playable, []);
    const kept = [{ phase: "debate" as const, mimeType: "audio/ogg", durationSeconds: 640 }];
    assert.deepEqual(resultsView({ ...plain, playable: kept }).playable, kept);
  });

  it("flags a correction made from the transcript alone, and words the floor when it is breached", () => {
    const view = resultsView({
      ...plain,
      evaluation: { ...plain.evaluation, mode: "text", score25: 4, rawScore25: 4 },
    });
    assert.equal(view.textMode, true);
    assert.equal(view.passed, false);
    assert.match(view.floorNote, /inférieure à 5\/25 est éliminatoire/);
  });

  it("puts the halving, the duration charge and the examiner's fault under the mark, in that order", () => {
    const view = resultsView({
      ...plain,
      earlyClosingCount: 2,
      evaluation: {
        ...plain.evaluation,
        rawScore25: 15,
        score25: 6,
        absencePenalty: 7,
        absentParts: ["debate"],
      },
    });
    assert.equal(view.notes.length, 2);
    assert.match(view.notes[0], /débat/i);
    assert.match(view.notes[1], /examinateur/i);
  });

  it("prints the totals only when something moved between the rows and the mark", () => {
    const halved = resultsView({
      ...plain,
      evaluation: {
        ...plain.evaluation,
        rawScore25: 15,
        score25: 8,
        absencePenalty: 7,
        absentParts: ["debate"],
      },
    });
    assert.ok(halved.totals);
    assert.equal(halved.totals.criteriaTotal, "15/25");
    assert.equal(halved.totals.finalLabel, "Note finale");
    assert.equal(halved.totals.final, "08/25");
    assert.deepEqual(
      halved.totals.deductions.map((d) => [d.key, d.points]),
      [["absence", 7]],
    );
  });
});

describe("one criterion row", () => {
  it("reads its colour, band name and bar off the awarded band, and speaks one figure when nothing was charged", () => {
    const row = criterionRowView("lexique", 3, 3, feedback);
    assert.equal(row.label, "Lexique");
    assert.equal(row.charged, 0);
    assert.equal(row.tone, "green");
    assert.equal(row.barPercent, 60);
    assert.equal(row.low, false);
    assert.equal(row.spoken, "3 sur 5");
    assert.equal(row.chargeNote, null);
    assert.equal(row.justification, "vocabulaire suffisant");
    assert.equal(row.note, undefined);
  });

  it("speaks both figures and explains the arithmetic when the clock took points (#203)", () => {
    const row = criterionRowView("realisationTache", 5, 3, feedback);
    assert.equal(row.charged, 2);
    assert.equal(row.tone, "green", "the AWARDED band's tone, not the earned one's");
    assert.equal(row.spoken, "note du correcteur 5 sur 5, note retenue 3 sur 5");
    assert.match(row.chargeNote ?? "", /coûté 2 points sur ce critère, d'où 3\/5/);
    assert.match(criterionRowView("lexique", 3, 1, feedback).chargeNote ?? "", /coûté 2 points/);
    assert.match(criterionRowView("lexique", 1, 0, feedback).chargeNote ?? "", /coûté 1 point sur/);
  });

  it("marks a zero as low, and carries the phonology note on that row alone", () => {
    const unheard = { ...feedback, phonologieNonEvaluable: true };
    assert.equal(criterionRowView("morphosyntaxe", 0, 0, feedback).low, true);
    assert.match(criterionRowView("phonologie", 3, 3, unheard).note ?? "", /phonologie/);
    assert.equal(criterionRowView("lexique", 3, 3, unheard).note, undefined);
  });
});
