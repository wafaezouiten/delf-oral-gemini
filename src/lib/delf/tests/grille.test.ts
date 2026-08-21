import assert from "node:assert/strict";
import { test } from "node:test";

import { COMPETENCY_FLOOR, COMPETENCY_MAX } from "../constants";
import {
  GRILLE_BANDS,
  BAND_LABELS,
  SCORE_BANDS,
  scoreBand,
  scoreTone,
  snapToBand,
  bandLabel,
} from "../grille";

test("GRILLE_BANDS is exactly the official 0/1/3/5 scale", () => {
  assert.deepEqual([...GRILLE_BANDS], [0, 1, 3, 5]);
});

test("snapToBand returns legal bands unchanged", () => {
  assert.equal(snapToBand(0), 0);
  assert.equal(snapToBand(1), 1);
  assert.equal(snapToBand(3), 3);
  assert.equal(snapToBand(5), 5);
});

test("snapToBand nudges illegal 2 and 4 to the lower band (conservative)", () => {
  assert.equal(snapToBand(2), 1); // tie between 1 and 3 → lower
  assert.equal(snapToBand(4), 3); // tie between 3 and 5 → lower
});

test("snapToBand snaps to the nearest band and clamps out-of-range input", () => {
  assert.equal(snapToBand(0.4), 0);
  assert.equal(snapToBand(2.6), 3);
  assert.equal(snapToBand(4.9), 5);
  assert.equal(snapToBand(9), 5);
  assert.equal(snapToBand(-3), 0);
  assert.equal(snapToBand(Number.NaN), 0);
});

test("bandLabel snaps then labels", () => {
  assert.equal(bandLabel(5), BAND_LABELS[5]);
  assert.equal(bandLabel(4), BAND_LABELS[3]); // 4 → band 3
  assert.equal(bandLabel(0), BAND_LABELS[0]);
});

/* The /25 scale (#50). Every boundary is asserted from both sides, because the
   whole point of a five-step scale is where the steps are. */

test("scoreTone colours every /25 on the five-step scale", () => {
  const tones = Array.from({ length: COMPETENCY_MAX + 1 }, (_, score) => scoreTone(score));
  assert.deepEqual(tones, [
    // 0–5
    "red",
    "red",
    "red",
    "red",
    "red",
    "red",
    // 6–10
    "coral",
    "coral",
    "coral",
    "coral",
    "coral",
    // 11–15
    "orange",
    "orange",
    "orange",
    "orange",
    "orange",
    // 16–20
    "yellow",
    "yellow",
    "yellow",
    "yellow",
    "yellow",
    // 21–25
    "green",
    "green",
    "green",
    "green",
    "green",
  ]);
});

test("scoreTone steps at 5/6, 10/11, 15/16 and 20/21", () => {
  assert.equal(scoreTone(5), "red");
  assert.equal(scoreTone(6), "coral");
  assert.equal(scoreTone(10), "coral");
  assert.equal(scoreTone(11), "orange");
  assert.equal(scoreTone(15), "orange");
  assert.equal(scoreTone(16), "yellow");
  assert.equal(scoreTone(20), "yellow");
  assert.equal(scoreTone(21), "green");
});

test("the reddest band holds the whole éliminatoire range and the floor itself", () => {
  // The scale's first band is six marks wide on purpose: a 5/25 clears the DELF
  // floor and is still a bad mark, and the colour says so.
  assert.equal(scoreTone(COMPETENCY_FLOOR), "red");
  assert.equal(scoreTone(COMPETENCY_FLOOR - 1), "red");
});

test("scoreBand guards out-of-range and non-finite input", () => {
  assert.equal(scoreTone(COMPETENCY_MAX + 4), "green");
  assert.equal(scoreTone(-3), "red");
  assert.equal(scoreTone(Number.NaN), "red");
  assert.equal(scoreTone(Number.POSITIVE_INFINITY), "red");
  assert.equal(scoreTone(Number.NEGATIVE_INFINITY), "red");
});

test("scoreBand takes a fractional average on the same scale, boundary included", () => {
  // The dashboard's « Note moyenne » is a mean, not a mark. 5.9 is not "nearly
  // 6": the band starts at 6.
  assert.equal(scoreTone(5.9), "red");
  assert.equal(scoreTone(6.0), "coral");
  assert.equal(scoreTone(20.9), "yellow");
  assert.equal(scoreTone(12.5), "orange");
});

test("the five bands are five distinct tones", () => {
  // A scale of five steps that painted two of them the same colour would be a
  // scale of four, and the token family in globals.css has one pair per tone.
  assert.equal(new Set(SCORE_BANDS.map((band) => band.tone)).size, SCORE_BANDS.length);
  assert.equal(SCORE_BANDS.length, 5);
});

test("SCORE_BANDS covers 0–25 with no gap, descending, from zero", () => {
  const mins = SCORE_BANDS.map((band) => band.min);
  assert.deepEqual(
    mins,
    [...mins].sort((a, b) => b - a),
    "bands must be highest-first",
  );
  assert.equal(mins[mins.length - 1], 0, "the lowest band must start at 0");
  assert.ok(mins[0] <= COMPETENCY_MAX, "the highest band must be reachable");
  for (let score = 0; score <= COMPETENCY_MAX; score += 1) {
    assert.ok(scoreBand(score), `no band for ${score}`);
  }
});
