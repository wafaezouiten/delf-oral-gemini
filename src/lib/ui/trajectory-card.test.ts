import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scoreBand } from "@/lib/delf/grille";

import type { TrajectoryPoint, TrajectoryView } from "./dashboard-view";
import { barAlign, trajectoryBar, trajectoryHeadline } from "./trajectory-card";

function point(
  score25: number,
  date: string,
  outcome: TrajectoryPoint["outcome"] = "corrected",
): TrajectoryPoint {
  return {
    examId: score25 * 100 + date.length,
    topicTitle: "Le télétravail",
    score25,
    band: scoreBand(score25),
    outcome,
    date,
    percent: (score25 / 25) * 100,
  };
}

function trajectory(points: TrajectoryPoint[]): TrajectoryView {
  const latest = points.at(-1);
  const previous = points.at(-2);
  return {
    points,
    latest: latest ? { score25: latest.score25, band: latest.band, date: latest.date } : null,
    delta: latest && previous ? latest.score25 - previous.score25 : null,
  };
}

describe("the trajectory's headline", () => {
  it("is nothing on an empty record", () => {
    assert.equal(trajectoryHeadline(trajectory([])), null);
  });

  it("calls a lone simulation the first, with no movement and no axis end", () => {
    const only = point(12, "4 août");
    const headline = trajectoryHeadline(trajectory([only]));
    assert.deepEqual(headline, {
      latest: { score25: 12, band: only.band, date: "4 août" },
      delta: null,
      dateLine: "première simulation · 4 août",
      axisEnd: null,
    });
  });

  it("carries the movement's direction on a caret and a tone, never on a band", () => {
    const up = trajectoryHeadline(trajectory([point(10, "1 août"), point(16, "4 août")]));
    assert.deepEqual(up?.delta, { text: "+6 pts", tone: "up", caret: "▲ " });
    assert.equal(up?.latest.score25, 16);
    assert.equal(up?.dateLine, "dernière simulation · 4 août");
    assert.equal(up?.axisEnd, "4 août");

    const down = trajectoryHeadline(trajectory([point(16, "1 août"), point(15, "4 août")]));
    assert.deepEqual(down?.delta, { text: "−1 pt", tone: "down", caret: "▼ " });

    const flat = trajectoryHeadline(trajectory([point(16, "1 août"), point(16, "4 août")]));
    assert.deepEqual(flat?.delta, { text: "±0 pt", tone: "flat", caret: null });
  });
});

describe("one bar", () => {
  it("anchors the edge bars' tooltips to their own side", () => {
    assert.equal(barAlign(0, 3), "left-0");
    assert.equal(barAlign(1, 3), "left-1/2 -translate-x-1/2");
    assert.equal(barAlign(2, 3), "right-0");
    assert.equal(barAlign(0, 1), "left-0", "a single bar is a first bar");
  });

  it("is as tall as its share of the /25 and reads its tooltip aloud", () => {
    const bar = trajectoryBar(point(15, "4 août"));
    assert.deepEqual(bar.style, { height: "60%" });
    assert.equal(bar.sliver, false);
    assert.equal(bar.srText, "Le télétravail — 15/25, 4 août");
    assert.equal(bar.note, null);
  });

  it("draws a walk-out as a sliver on the floor and says so", () => {
    const bar = trajectoryBar(point(0, "4 août", "abandoned"));
    assert.equal(bar.style, undefined);
    assert.equal(bar.sliver, true);
    assert.equal(bar.srText, "Le télétravail — 0/25, 4 août, épreuve abandonnée");
    assert.equal(bar.note, "Épreuve abandonnée");
  });
});
