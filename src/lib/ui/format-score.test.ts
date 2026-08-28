import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COMPETENCY_MAX } from "@/lib/delf/constants";

import { formatScore25 } from "./format-score";

describe("the printed /25 (#161)", () => {
  it("pads every mark under 10 to two digits", () => {
    assert.equal(formatScore25(0), "00");
    assert.equal(formatScore25(1), "01");
    assert.equal(formatScore25(7), "07");
    assert.equal(formatScore25(9), "09");
  });

  it("leaves two-digit marks alone, across the whole scale", () => {
    for (let score = 10; score <= COMPETENCY_MAX; score += 1) {
      assert.equal(formatScore25(score), String(score));
    }
  });

  it("pads the whole part of a fractional average, not the string", () => {
    // The « Note moyenne » tile is the one caller that can hand this a
    // fraction. "5.5" is already three characters, so a padStart on the string
    // would return it unchanged — the padding has to key on the whole part.
    assert.equal(formatScore25(5.5), "05.5");
    assert.equal(formatScore25(12.5), "12.5");
  });
});
