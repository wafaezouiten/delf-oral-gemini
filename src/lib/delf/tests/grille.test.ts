import assert from "node:assert/strict";
import { test } from "node:test";

import { GRILLE_BANDS, BAND_LABELS, snapToBand, bandLabel } from "../grille";

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
