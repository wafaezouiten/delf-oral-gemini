import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RESULTS_RAIL_DEFAULT_PCT,
  RESULTS_RAIL_MAX_PCT,
  RESULTS_RAIL_MIN_PCT,
  clampRailPct,
  railPctAfterKey,
  railPctFromPointer,
} from "./results-rail";

describe("the correction's transcript rail (#190)", () => {
  it("rests at the main project's share and clamps onto its range", () => {
    assert.equal(RESULTS_RAIL_DEFAULT_PCT, 35);
    assert.equal(clampRailPct(10), RESULTS_RAIL_MIN_PCT);
    assert.equal(clampRailPct(90), RESULTS_RAIL_MAX_PCT);
    assert.equal(clampRailPct(40), 40);
    assert.equal(clampRailPct(Number.NaN), RESULTS_RAIL_DEFAULT_PCT);
  });

  it("measures the pointer from the split's right edge, so dragging left grows the rail", () => {
    const rect = { left: 100, width: 1000 };
    // Pointer three-quarters of the way across leaves a quarter for the rail.
    assert.equal(railPctFromPointer(850, rect), 25);
    // Dragging further left asks for more rail, up to the ceiling.
    assert.equal(railPctFromPointer(400, rect), RESULTS_RAIL_MAX_PCT);
    // And past the right edge asks for none, which the floor refuses.
    assert.equal(railPctFromPointer(1200, rect), RESULTS_RAIL_MIN_PCT);
  });

  it("answers the default for a split with no width to measure against", () => {
    assert.equal(railPctFromPointer(500, { left: 0, width: 0 }), RESULTS_RAIL_DEFAULT_PCT);
  });

  it("moves two percent per arrow, in the drag's own direction, and Home resets", () => {
    assert.equal(railPctAfterKey(35, "ArrowLeft"), 37);
    assert.equal(railPctAfterKey(35, "ArrowRight"), 33);
    assert.equal(railPctAfterKey(RESULTS_RAIL_MAX_PCT, "ArrowLeft"), RESULTS_RAIL_MAX_PCT);
    assert.equal(railPctAfterKey(RESULTS_RAIL_MIN_PCT, "ArrowRight"), RESULTS_RAIL_MIN_PCT);
    assert.equal(railPctAfterKey(50, "Home"), RESULTS_RAIL_DEFAULT_PCT);
    assert.equal(railPctAfterKey(50, "Tab"), 50);
  });
});
