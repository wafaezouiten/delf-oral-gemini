import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { zeroCriteria } from "@/lib/ui/dashboard-view";

import { sittingFromRow, type HistoryRow } from "./history-row";

const FINISHED = new Date("2026-09-10T10:00:00Z");
const LEFT = new Date("2026-09-11T10:00:00Z");

const corrected: HistoryRow = {
  examId: 41,
  topicSlug: "teletravail",
  topicTitle: "Le télétravail",
  phase: "finished",
  finishedAt: FINISHED,
  abandonedAt: null,
  archivedAt: null,
  score25: 15,
  meetsFloor: true,
  mode: "audio",
  spokenSeconds: "612.5",
  recordings: [
    { phase: "debate", mimeType: "audio/ogg", durationSeconds: 400 },
    { phase: "monologue", mimeType: "audio/ogg", durationSeconds: 212 },
  ],
  realisationTache: 5,
  interaction: 3,
  lexique: 3,
  morphosyntaxe: 1,
  phonologie: 3,
};

describe("reading one row of the candidate's history", () => {
  it("reads a corrected sitting as the correction says, with the halves in the order they were sat", () => {
    const sitting = sittingFromRow(corrected);
    assert.equal(sitting.outcome, "corrected");
    assert.equal(sitting.score25, 15);
    assert.equal(sitting.meetsFloor, true);
    assert.equal(sitting.mode, "audio");
    assert.deepEqual(sitting.criteria, {
      realisationTache: 5,
      interaction: 3,
      lexique: 3,
      morphosyntaxe: 1,
      phonologie: 3,
    });
    assert.equal(sitting.spokenSeconds, 612.5, "the sum comes back from SQL as text");
    assert.equal(sitting.endedAt, FINISHED);
    assert.deepEqual(
      sitting.recordings.map((r) => r.phase),
      ["monologue", "debate"],
    );
    assert.equal(sitting.archivedAt, null);
  });

  it("reads a walk-out as a zero that is the consequence, not a grading", () => {
    const sitting = sittingFromRow({
      ...corrected,
      phase: "debate",
      finishedAt: null,
      abandonedAt: LEFT,
      // A correction that landed anyway is outranked: the row is abandoned.
      score25: 18,
      meetsFloor: true,
      mode: "text",
    });
    assert.equal(sitting.outcome, "abandoned");
    assert.equal(sitting.score25, 0);
    assert.equal(sitting.meetsFloor, false);
    assert.equal(sitting.mode, null);
    assert.deepEqual(sitting.criteria, zeroCriteria());
    assert.equal(sitting.endedAt, LEFT);
    assert.equal(sitting.phase, "debate", "where the candidate stopped, printed beside the zero");
  });

  it("files a walk-out by when it left even when the sitting also has a finish stamp", () => {
    const sitting = sittingFromRow({ ...corrected, abandonedAt: LEFT });
    assert.equal(sitting.endedAt, LEFT);
  });

  it("fills what the joins left null rather than failing the page", () => {
    const sitting = sittingFromRow({
      ...corrected,
      score25: null,
      meetsFloor: null,
      spokenSeconds: null,
      recordings: null,
      realisationTache: null,
      interaction: null,
      lexique: null,
      morphosyntaxe: null,
      phonologie: null,
    });
    assert.equal(sitting.score25, 0);
    assert.equal(sitting.meetsFloor, false);
    assert.equal(sitting.spokenSeconds, 0);
    assert.deepEqual(sitting.recordings, []);
    assert.deepEqual(sitting.criteria, zeroCriteria());
  });

  it("sorts a row with neither stamp first rather than throwing", () => {
    const sitting = sittingFromRow({ ...corrected, finishedAt: null });
    assert.equal(sitting.endedAt.getTime(), 0);
  });

  it("keeps the archive flag on the row for the historique to partition on", () => {
    const archived = new Date("2026-09-12T10:00:00Z");
    assert.equal(sittingFromRow({ ...corrected, archivedAt: archived }).archivedAt, archived);
  });
});
