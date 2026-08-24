import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type OralCriterion } from "@/lib/delf/criteria";
import {
  buildDashboardView,
  currentStreak,
  describeOutcome,
  formatPracticeTime,
  formatScoreDelta,
  RECENT_LIMIT,
  TRAJECTORY_TICKS,
  zeroCriteria,
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
    outcome: "corrected",
    score25: 15,
    meetsFloor: true,
    mode: "audio",
    criteria: { ...BANDS },
    spokenSeconds: 600,
    phase: "finished",
    endedAt: new Date("2026-08-16T10:00:00Z"),
    archivedAt: null,
    ...overrides,
  };
}

/** A walk-out, as `readCandidateHistory` builds one. */
function abandoned(overrides: Partial<DashboardSitting> = {}): DashboardSitting {
  return sitting({
    outcome: "abandoned",
    score25: 0,
    meetsFloor: false,
    mode: null,
    criteria: zeroCriteria(),
    spokenSeconds: 0,
    phase: "monologue",
    ...overrides,
  });
}

describe("describing an outcome", () => {
  it("distinguishes the two kinds of correction", () => {
    assert.match(describeOutcome(sitting({ mode: "audio" })), /audio et la transcription/);
    assert.match(describeOutcome(sitting({ mode: "text" })), /sans l'audio/);
  });

  it("names the phase a walk-out happened in", () => {
    // "Abandonnée" alone invites the reading that the product lost the épreuve.
    assert.match(describeOutcome(abandoned({ phase: "preparation" })), /préparation/);
    assert.match(describeOutcome(abandoned({ phase: "monologue" })), /monologue/);
    assert.match(describeOutcome(abandoned({ phase: "debate" })), /débat/);
  });

  it("still says something for a phase it does not recognise", () => {
    assert.match(describeOutcome(abandoned({ phase: "finished" })), /Abandonnée/);
  });
});

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
    const view = buildDashboardView([sitting({ score25: 20 }), sitting({ score25: 10 })], today);
    const moyenne = view.tiles.find((tile) => tile.key === "moyenne");
    assert.equal(moyenne?.value, "15");
  });

  it("bands the average on the /25 scale, and only the tile that is a /25", () => {
    const view = buildDashboardView([sitting({ score25: 18 }), sitting({ score25: 14 })], today);
    const moyenne = view.tiles.find((tile) => tile.key === "moyenne");
    assert.equal(moyenne?.value, "16");
    assert.equal(moyenne?.band?.tone, "yellow");

    // A percentage, a duration and a day count are not marks: banding them would
    // put a pass rate in the colour of a grade.
    for (const key of ["reussite", "pratique", "serie"] as const) {
      assert.equal(view.tiles.find((tile) => tile.key === key)?.band, undefined);
    }
  });

  it("bands the fractional average off the number, not off the printed string", () => {
    // 5.5 is not "nearly 6": the coral band starts at 6, so this is still red.
    const view = buildDashboardView([sitting({ score25: 8 }), sitting({ score25: 3 })], today);
    const moyenne = view.tiles.find((tile) => tile.key === "moyenne");
    assert.equal(moyenne?.value, "5.5");
    assert.equal(moyenne?.band?.tone, "red");
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

  it("orders newest first regardless of how the query returned them", () => {
    const older = sitting({ examId: 1, endedAt: new Date("2026-08-10T09:00:00Z") });
    const newer = sitting({ examId: 2, endedAt: new Date("2026-08-15T09:00:00Z") });
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
        endedAt: new Date(2026, 7, index + 1),
      }),
    );
    const view = buildDashboardView(many, today);
    assert.equal(view.recent.length, RECENT_LIMIT);
    // The average is still over all of them, not over the five shown.
    assert.equal(view.count, RECENT_LIMIT + 3);
    assert.equal(view.tiles.find((tile) => tile.key === "moyenne")?.value, "10");
  });

  it("drags the average down with a walk-out, which is the point of counting it", () => {
    // The exit dialog promises the candidate exactly this. If the zero did not
    // reach the average, the warning would be a bluff.
    const view = buildDashboardView([sitting({ score25: 20 }), abandoned()], today);
    assert.equal(view.tiles.find((tile) => tile.key === "moyenne")?.value, "10");
  });

  it("counts a walk-out against the pass rate", () => {
    const view = buildDashboardView([sitting({ meetsFloor: true }), abandoned()], today);
    assert.equal(view.tiles.find((tile) => tile.key === "reussite")?.value, "50 %");
  });

  it("says how many épreuves were abandoned rather than calling them all corrected", () => {
    // "2 épreuves corrigées" over an average containing a walk-out is a lie
    // about where the number came from.
    const view = buildDashboardView([sitting(), abandoned()], today);
    const caption = view.tiles.find((tile) => tile.key === "moyenne")?.caption ?? "";
    assert.match(caption, /1 abandonnée/);
    assert.doesNotMatch(caption, /corrigée/);
  });

  it("adds no practice time for a walk-out", () => {
    const view = buildDashboardView([sitting({ spokenSeconds: 600 }), abandoned()], today);
    assert.equal(view.tiles.find((tile) => tile.key === "pratique")?.value, "10 min");
  });

  it("counts a walk-out toward the streak: turning up and leaving is still a day", () => {
    const view = buildDashboardView([abandoned({ endedAt: today })], today);
    assert.equal(view.tiles.find((tile) => tile.key === "serie")?.value, "1 j");
  });

  it("plots the trajectory oldest first, however the query returned the rows", () => {
    const older = sitting({ examId: 1, score25: 11, endedAt: new Date("2026-07-20T09:00:00Z") });
    const newer = sitting({ examId: 2, score25: 17, endedAt: new Date("2026-08-04T09:00:00Z") });
    const view = buildDashboardView([newer, older], today);
    assert.deepEqual(
      view.trajectory.points.map((point) => point.examId),
      [1, 2],
    );
  });

  it("gives each bar its share of the /25 scale, band attached", () => {
    const view = buildDashboardView([sitting({ score25: 17 })], today);
    const point = view.trajectory.points[0];
    assert.equal(point?.percent, 68);
    // The bar's tint and the tooltip's figure come from the same number.
    assert.equal(point?.band.tone, "yellow");
  });

  it("headlines the latest simulation and its movement since the one before", () => {
    const view = buildDashboardView(
      [
        sitting({ examId: 1, score25: 11, endedAt: new Date("2026-07-20T09:00:00Z") }),
        sitting({ examId: 2, score25: 17, endedAt: new Date("2026-08-04T09:00:00Z") }),
      ],
      today,
    );
    assert.equal(view.trajectory.latest?.score25, 17);
    assert.equal(view.trajectory.latest?.date, "4 août");
    assert.equal(view.trajectory.delta, 6);
  });

  it("offers no delta for a first simulation — there is nothing to compare against", () => {
    const view = buildDashboardView([sitting()], today);
    assert.equal(view.trajectory.delta, null);
    assert.notEqual(view.trajectory.latest, null);
  });

  it("draws a walk-out as a real bar at zero", () => {
    // The exit dialog promises the walk-out counts; a chart that skipped it
    // would draw a record the tiles contradict.
    const view = buildDashboardView([sitting(), abandoned({ examId: 9 })], today);
    const walkOut = view.trajectory.points.find((point) => point.examId === 9);
    assert.equal(walkOut?.score25, 0);
    assert.equal(walkOut?.percent, 0);
    assert.equal(walkOut?.outcome, "abandoned");
  });

  it("rules the chart every 5 points up to the /25", () => {
    assert.deepEqual([...TRAJECTORY_TICKS], [0, 5, 10, 15, 20, 25]);
  });

  it("renders an empty history without dividing by zero", () => {
    const view = buildDashboardView([], today);
    assert.equal(view.count, 0);
    assert.equal(view.tiles.find((tile) => tile.key === "moyenne")?.value, "0");
    assert.equal(view.tiles.find((tile) => tile.key === "reussite")?.value, "0 %");
    assert.deepEqual(view.trajectory, { points: [], latest: null, delta: null });
  });
});

describe("the score delta", () => {
  it("always prints the sign — the direction is the figure's job", () => {
    assert.equal(formatScoreDelta(6), "+6 pts");
    assert.equal(formatScoreDelta(-2), "−2 pts");
    assert.equal(formatScoreDelta(0), "±0 pt");
  });

  it("keeps the singular for a single point either way", () => {
    assert.equal(formatScoreDelta(1), "+1 pt");
    assert.equal(formatScoreDelta(-1), "−1 pt");
  });
});
