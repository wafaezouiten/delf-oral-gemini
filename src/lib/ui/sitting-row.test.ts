import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { zeroCriteria, type DashboardSitting } from "./dashboard-view";
import { sittingRowView } from "./sitting-row";

function sitting(overrides: Partial<DashboardSitting> = {}): DashboardSitting {
  return {
    examId: 7,
    topicSlug: "teletravail",
    topicTitle: "Le télétravail",
    outcome: "corrected",
    score25: 15,
    meetsFloor: true,
    mode: "audio",
    criteria: { ...zeroCriteria(), lexique: 3 },
    spokenSeconds: 600,
    phase: "finished",
    endedAt: new Date("2026-08-16T10:00:00Z"),
    archivedAt: null,
    recordings: [
      { phase: "monologue", mimeType: "audio/ogg", durationSeconds: 300 },
      { phase: "debate", mimeType: "audio/ogg", durationSeconds: 420 },
    ],
    ...overrides,
  };
}

const walkOut = sitting({
  outcome: "abandoned",
  score25: 0,
  meetsFloor: false,
  mode: null,
  spokenSeconds: 0,
  phase: "preparation",
});

describe("one row of the record", () => {
  it("links a corrected sitting to its correction and a walk-out nowhere", () => {
    assert.equal(sittingRowView(sitting(), true).href, "/app/results/7");
    assert.equal(sittingRowView(walkOut, true).href, null);
    assert.equal(sittingRowView(walkOut, false).abandoned, true);
  });

  it("marks the seuil met or missed", () => {
    assert.equal(sittingRowView(sitting({ score25: 10, meetsFloor: true }), false).mark, "✓");
    assert.equal(sittingRowView(sitting({ score25: 9, meetsFloor: false }), false).mark, "✕");
  });

  it("says the date and a word on the tableau de bord", () => {
    assert.equal(sittingRowView(sitting(), false).stamp, "16 août");
    assert.equal(
      sittingRowView(sitting({ mode: "text" }), false).stamp,
      "16 août · corrigée sans l'audio",
    );
    assert.equal(sittingRowView(walkOut, false).stamp, "16 août · abandonnée");
  });

  it("says the full stamp, what happened and the speaking time on the historique", () => {
    const { stamp } = sittingRowView(sitting(), true);
    assert.match(
      stamp,
      /^16 août 2026 à \d{2}:\d{2} · Corrigée sur l'audio et la transcription · 10:00 de parole$/,
    );
  });

  it("prints no speaking time for a walk-out that never spoke", () => {
    const { stamp } = sittingRowView(walkOut, true);
    assert.match(stamp, /Abandonnée pendant la préparation, avant toute prise de parole$/);
    assert.doesNotMatch(stamp, /0:00 de parole/);
  });

  it("offers the players only on the historique, and never for a walk-out", () => {
    assert.deepEqual(sittingRowView(sitting(), false).players, []);
    assert.deepEqual(sittingRowView(walkOut, true).players, []);
    const players = sittingRowView(sitting(), true).players;
    assert.deepEqual(
      players.map((player) => [player.phase, player.heading, player.duration, player.src]),
      [
        ["monologue", "Monologue suivi", "5:00", "/api/exams/7/recordings/monologue"],
        ["debate", "Débat", "7:00", "/api/exams/7/recordings/debate"],
      ],
    );
    assert.equal(players[0].mimeType, "audio/ogg");
    assert.equal(players[1].durationSeconds, 420);
  });
});
