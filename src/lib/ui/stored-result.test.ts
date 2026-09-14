import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findTopic } from "@/lib/delf/topics";
import type { TranscriptEntry } from "@/lib/delf/transcript";
import type { StoredCorrection, StoredSitting } from "@/lib/exams/sitting-persistence";

import { parseStoredResult, storedResultFromSitting } from "./stored-result";

const topic = findTopic("teletravail")!;
const words = (n: number) => Array.from({ length: n }, (_, i) => `mot${i}`).join(" ");

/** A full sitting: both halves spoken at length, both recordings kept. */
const transcript: TranscriptEntry[] = [
  { phase: "monologue", speaker: "candidate", timestamp: 0, text: words(400) },
  { phase: "debate", speaker: "examiner", timestamp: 300_000, text: "Pourquoi ?" },
  { phase: "debate", speaker: "candidate", timestamp: 310_000, text: words(600) },
];

const correction: StoredCorrection = {
  id: 9,
  createdAt: new Date("2026-09-10T10:00:00Z"),
  mode: "audio",
  criteria: { realisationTache: 5, interaction: 3, lexique: 3, morphosyntaxe: 3, phonologie: 3 },
  rawScore25: 17,
  absencePenalty: 0,
  durationPenalty: 0,
  score25: 17,
  meetsFloor: true,
  feedback: {
    justifications: {
      realisationTache: "…",
      interaction: "…",
      lexique: "…",
      morphosyntaxe: "…",
      phonologie: "…",
    },
    appreciationGlobale: "prestation honnête",
    pointsForts: ["structure"],
    axesPrioritaires: ["accords"],
    conseil: "relisez",
    phonologieNonEvaluable: false,
  },
  model: "gemini-3.6-flash",
  promptVersion: "2026-09-04.1",
  latencySeconds: 41.2,
};

const sitting: StoredSitting = {
  examId: 41,
  topicSlug: "teletravail",
  phase: "finished",
  outcome: "corrected",
  transcript,
  reconnectCount: 1,
  earlyClosingCount: 0,
  examinerModel: "gemini-3.1-flash-live-preview",
  startedAt: new Date("2026-09-10T09:00:00Z"),
  finishedAt: new Date("2026-09-10T09:25:00Z"),
  phases: [
    { phase: "monologue", spokenSeconds: 330, startedAt: null, endedAt: null },
    { phase: "debate", spokenSeconds: 640, startedAt: null, endedAt: null },
  ],
  recordings: [
    {
      phase: "monologue",
      uri: "vault://41/m",
      mimeType: "audio/ogg",
      byteSize: 1,
      durationSeconds: 335,
      deletedAt: null,
    },
    {
      phase: "debate",
      uri: null,
      mimeType: "audio/ogg",
      byteSize: 1,
      durationSeconds: 645,
      deletedAt: null,
    },
  ],
  correction,
};

describe("the correction rebuilt from a persisted sitting", () => {
  it("carries the correction, the sitting's facts and the sujet, and names both models", () => {
    const result = storedResultFromSitting(sitting, correction, topic);
    assert.equal(result.evaluation.score25, 17);
    assert.equal(result.evaluation.mode, "audio");
    assert.deepEqual(result.evaluation.criteria, correction.criteria);
    assert.equal(result.evaluation.model, "gemini-3.6-flash");
    assert.equal(result.examinerModel, "gemini-3.1-flash-live-preview");
    assert.equal(result.topic, topic);
    assert.equal(result.transcript, transcript);
    assert.equal(result.reconnectCount, 1);
    assert.equal(result.earlyClosingCount, 0);
  });

  it("measures each half from its phase row, then from its recording, then as nothing", () => {
    const result = storedResultFromSitting(sitting, correction, topic);
    assert.equal(result.monologueSeconds, 330, "the phase row first");

    const noRows = storedResultFromSitting({ ...sitting, phases: [] }, correction, topic);
    assert.equal(noRows.monologueSeconds, 335, "then the recording's own measurement");

    const nothing = storedResultFromSitting(
      { ...sitting, phases: [], recordings: [] },
      correction,
      topic,
    );
    assert.equal(nothing.debateSeconds, 0);
  });

  it("offers for playback only the recordings whose bytes were kept", () => {
    const result = storedResultFromSitting(sitting, correction, topic);
    assert.deepEqual(result.playable, [
      { phase: "monologue", mimeType: "audio/ogg", durationSeconds: 335 },
    ]);

    const purged = storedResultFromSitting(
      { ...sitting, recordings: [{ ...sitting.recordings[0], deletedAt: new Date() }] },
      correction,
      topic,
    );
    assert.deepEqual(purged.playable, []);
  });

  it("recovers nothing the rubric did not charge: no parts, no charges", () => {
    const result = storedResultFromSitting(sitting, correction, topic);
    assert.deepEqual(result.evaluation.absentParts, []);
    assert.deepEqual(result.evaluation.durationCharges, []);
  });

  it("recovers which half was absent from the transcript when the halving fired", () => {
    const silentDebate: StoredSitting = {
      ...sitting,
      transcript: transcript.filter((entry) => entry.phase === "monologue"),
    };
    const halved: StoredCorrection = { ...correction, absencePenalty: 9, score25: 8 };
    const result = storedResultFromSitting(silentDebate, halved, topic);
    assert.deepEqual(result.evaluation.absentParts, ["debate"]);
  });

  it("does not caption a débat the examiner closed early as absent (#92)", () => {
    const silentDebate: StoredSitting = {
      ...sitting,
      earlyClosingCount: 1,
      transcript: transcript.filter((entry) => entry.phase === "monologue"),
    };
    const halved: StoredCorrection = { ...correction, absencePenalty: 9, score25: 8 };
    const result = storedResultFromSitting(silentDebate, halved, topic);
    assert.deepEqual(result.evaluation.absentParts, [], "excused, not charged");
  });

  it("recovers where the duration charge landed by re-running the rubric over the stored bands", () => {
    const short: StoredSitting = {
      ...sitting,
      phases: [
        { phase: "monologue", spokenSeconds: 90, startedAt: null, endedAt: null },
        { phase: "debate", spokenSeconds: 640, startedAt: null, endedAt: null },
      ],
    };
    const docked: StoredCorrection = { ...correction, durationPenalty: 2, score25: 15 };
    const result = storedResultFromSitting(short, docked, topic);
    const charges = result.evaluation.durationCharges ?? [];
    assert.equal(charges.length, 1);
    assert.equal(charges[0].part, "monologue");
    assert.equal(charges[0].seconds, 90, "the server's measurement, the one the rubric saw");
    assert.equal(result.evaluation.durationPenalty, 2);
  });

  it("does not charge a part the halving already answered for, nor an early-closed débat", () => {
    const shortBoth: StoredSitting = {
      ...sitting,
      earlyClosingCount: 1,
      transcript: transcript.filter((entry) => entry.phase === "monologue"),
      phases: [
        { phase: "monologue", spokenSeconds: 90, startedAt: null, endedAt: null },
        { phase: "debate", spokenSeconds: 30, startedAt: null, endedAt: null },
      ],
    };
    const docked: StoredCorrection = {
      ...correction,
      absencePenalty: 8,
      durationPenalty: 2,
      score25: 7,
    };
    const result = storedResultFromSitting(shortBoth, docked, topic);
    assert.deepEqual(
      (result.evaluation.durationCharges ?? []).map((charge) => charge.part),
      ["monologue"],
      "the débat is excluded twice over — absent, and closed by the examiner",
    );
  });
});

describe("the stash read back out of sessionStorage", () => {
  it("is null when there is nothing, and null when what is there is not JSON", () => {
    assert.equal(parseStoredResult(null), null);
    assert.equal(parseStoredResult("{not json"), null);
  });

  it("parses a stash and hands back the same object for the same string", () => {
    const raw = JSON.stringify({ evaluation: { score25: 12 }, topic: { slug: "x" } });
    const first = parseStoredResult(raw);
    assert.equal(first?.evaluation.score25, 12);
    assert.equal(parseStoredResult(raw), first, "memoised on the string, as the store API needs");
    assert.notEqual(parseStoredResult(raw + " "), first);
  });
});
