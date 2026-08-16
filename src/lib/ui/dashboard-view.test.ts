import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ORAL_CRITERIA, type OralCriterion } from "@/lib/delf/criteria";
import {
  buildDashboardView,
  currentStreak,
  formatPracticeTime,
  RECENT_LIMIT,
  type DashboardSitting,
} from "./dashboard-view";

const BANDS: Record<OralCriterion, number> = {
  realisationTache: 3,
  interaction: 3,
  lexique: 3,
  morphosyntaxe: 1,
  phonologie: 5,
};

function sitting(overrides: Partial<DashboardSitting> = {}): DashboardSitting {
  return {
    examId: 1,
    topicSlug: "teletravail",
    topicTitle: "Le télétravail a-t-il vraiment amélioré nos vies ?",
    score25: 15,
    meetsFloor: true,
    mode: "audio",
    criteria: { ...BANDS },
    spokenSeconds: 600,
    finishedAt: new Date("2026-08-16T10:00:00Z"),
    ...overrides,
  };
}

describe("practice time", () => {
  it("reports seconds rather than rounding a real sitting to zero", () => {
    // A candidate who has just recorded forty seconds has not practised for
    // "0 min", and being told so is how they conclude nothing was recorded.
    assert.equal(formatPracticeTime(40), "40 s");
    assert.equal(formatPracticeTime(0), "0 s");
  });

  it("switches to minutes, then to hours", () => {
    assert.equal(formatPracticeTime(60), "1 min");
    assert.equal(formatPracticeTime(48 * 60), "48 min");
    assert.equal(formatPracticeTime(3600), "1 h 00");
  });

  it("pads the minutes inside an hour so 1 h 05 cannot read as 1 h 50", () => {
    assert.equal(formatPracticeTime(3600 + 5 * 60), "1 h 05");
    assert.equal(formatPracticeTime(3600 + 50 * 60), "1 h 50");
  });

  it("survives a nonsense input rather than printing NaN at a candidate", () => {
    assert.equal(formatPracticeTime(Number.NaN), "0 s");
    assert.equal(formatPracticeTime(-90), "0 s");
  });
});

describe("the streak", () => {
  const today = new Date("2026-08-16T09:00:00");

  it("is zero with nothing to count", () => {
    assert.equal(currentStreak([], today), 0);
  });

  it("counts consecutive days back from today", () => {
    const dates = [
      new Date("2026-08-16T09:00:00"),
      new Date("2026-08-15T20:00:00"),
      new Date("2026-08-14T08:00:00"),
    ];
    assert.equal(currentStreak(dates, today), 3);
  });

  it("still counts a streak that ends yesterday", () => {
    // Resetting at midnight tells someone who practised all week and has not
    // opened the app this morning that they are on zero.
    const dates = [new Date("2026-08-15T20:00:00"), new Date("2026-08-14T08:00:00")];
    assert.equal(currentStreak(dates, today), 2);
  });

  it("breaks at a missed day", () => {
    const dates = [
      new Date("2026-08-16T09:00:00"),
      // 15 August missing.
      new Date("2026-08-14T08:00:00"),
    ];
    assert.equal(currentStreak(dates, today), 1);
  });

  it("counts two sittings on one day once", () => {
    const dates = [new Date("2026-08-16T09:00:00"), new Date("2026-08-16T18:00:00")];
    assert.equal(currentStreak(dates, today), 1);
  });

  it("is zero when the last sitting is older than yesterday", () => {
    assert.equal(currentStreak([new Date("2026-08-01T09:00:00")], today), 0);
  });
});

describe("the dashboard view", () => {
  const today = new Date("2026-08-16T12:00:00");

  it("averages the /25 across corrected sittings", () => {
    const view = buildDashboardView(
      [sitting({ score25: 20 }), sitting({ score25: 10 })],
      today,
    );
    const moyenne = view.tiles.find((tile) => tile.key === "moyenne");
    assert.equal(moyenne?.value, "15");
  });

  it("reports the share above the floor, not the share of full marks", () => {
    const view = buildDashboardView(
      [
        sitting({ meetsFloor: true }),
        sitting({ meetsFloor: true }),
        sitting({ meetsFloor: false }),
        sitting({ meetsFloor: false }),
      ],
      today,
    );
    assert.equal(view.tiles.find((tile) => tile.key === "reussite")?.value, "50 %");
  });

  it("sums measured audio for the practice tile, never the phase clocks", () => {
    const view = buildDashboardView(
      [sitting({ spokenSeconds: 600 }), sitting({ spokenSeconds: 1200 })],
      today,
    );
    assert.equal(view.tiles.find((tile) => tile.key === "pratique")?.value, "30 min");
  });

  it("gives every criterion a row, including one nothing has scored", () => {
    // Built from ORAL_CRITERIA rather than from the keys present on the rows: a
    // criterion that quietly disappears from the chart is a criterion the
    // candidate stops working on.
    const view = buildDashboardView([sitting()], today);
    assert.deepEqual(
      view.criteria.map((row) => row.key),
      [...ORAL_CRITERIA],
    );
  });

  it("scales each bar against the grille's top band", () => {
    const view = buildDashboardView([sitting()], today);
    const morpho = view.criteria.find((row) => row.key === "morphosyntaxe");
    const phono = view.criteria.find((row) => row.key === "phonologie");
    assert.equal(morpho?.average, 1);
    assert.equal(morpho?.percent, 20);
    assert.equal(phono?.percent, 100);
  });

  it("orders newest first regardless of how the query returned them", () => {
    const older = sitting({ examId: 1, finishedAt: new Date("2026-08-10T09:00:00Z") });
    const newer = sitting({ examId: 2, finishedAt: new Date("2026-08-15T09:00:00Z") });
    const view = buildDashboardView([older, newer], today);
    assert.deepEqual(
      view.recent.map((row) => row.examId),
      [2, 1],
    );
  });

  it("trims the recent list without trimming the arithmetic", () => {
    const many = Array.from({ length: RECENT_LIMIT + 3 }, (_, index) =>
      sitting({
        examId: index,
        score25: 10,
        finishedAt: new Date(2026, 7, index + 1),
      }),
    );
    const view = buildDashboardView(many, today);
    assert.equal(view.recent.length, RECENT_LIMIT);
    // The average is still over all of them, not over the five shown.
    assert.equal(view.count, RECENT_LIMIT + 3);
    assert.equal(view.tiles.find((tile) => tile.key === "moyenne")?.value, "10");
  });

  it("renders an empty history without dividing by zero", () => {
    const view = buildDashboardView([], today);
    assert.equal(view.count, 0);
    assert.equal(view.tiles.find((tile) => tile.key === "moyenne")?.value, "0");
    assert.equal(view.tiles.find((tile) => tile.key === "reussite")?.value, "0 %");
    assert.equal(view.criteria.length, ORAL_CRITERIA.length);
  });
});
