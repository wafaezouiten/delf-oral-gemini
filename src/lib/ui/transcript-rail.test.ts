import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EVALUATION_MIN_PX,
  RAIL_CONTENT_MAX_PX,
  RAIL_DEFAULT_PX,
  RAIL_KEY_STEP_PX,
  clampRailPx,
  railMaxPx,
  railPxFromPointer,
  steppedRailPx,
} from "./transcript-rail";

describe("pulling the correction's transcript rail open (#141)", () => {
  // A comfortable desktop: wide enough that only the content cap binds.
  const WIDE = 1600;
  // The smallest viewport the two-column layout exists on (`lg`).
  const NARROW = 1024;

  it("opens at the floor, and cannot be pushed below it", () => {
    assert.equal(clampRailPx(0, WIDE), RAIL_DEFAULT_PX);
    assert.equal(clampRailPx(RAIL_DEFAULT_PX - 1, WIDE), RAIL_DEFAULT_PX);
    assert.equal(clampRailPx(RAIL_DEFAULT_PX, WIDE), RAIL_DEFAULT_PX);
  });

  it("stops where the transcript's own measure is served, on a wide screen", () => {
    // 1600 − 384 leaves more room than the content can use, so the content
    // cap is the one that binds: pulling past it only grows empty ground.
    assert.equal(railMaxPx(WIDE), RAIL_CONTENT_MAX_PX);
    assert.equal(clampRailPx(10_000, WIDE), RAIL_CONTENT_MAX_PX);
  });

  it("stops where the evaluation's minimum begins, on a narrow one", () => {
    // At 1024 the evaluation's 384 px floor binds first: the rail may take
    // what is left and no more, because the marks are the page's main pane.
    assert.equal(railMaxPx(NARROW), NARROW - EVALUATION_MIN_PX);
    assert.equal(clampRailPx(10_000, NARROW), NARROW - EVALUATION_MIN_PX);
  });

  it("degrades to a fixed rail when the container cannot afford both caps", () => {
    // A body narrower than floor + evaluation minimum has nothing to give.
    // The max collapses onto the floor rather than under it, so every clamp
    // returns the one width the layout already had — resizing simply stops.
    const tiny = RAIL_DEFAULT_PX + EVALUATION_MIN_PX - 100;
    assert.equal(railMaxPx(tiny), RAIL_DEFAULT_PX);
    assert.equal(clampRailPx(10_000, tiny), RAIL_DEFAULT_PX);
    assert.equal(clampRailPx(0, tiny), RAIL_DEFAULT_PX);
  });

  it("reads the pointer as a distance from the body's right edge", () => {
    // Body spanning [100, 1700]: a pointer at 1200 leaves 500 px of rail.
    assert.equal(railPxFromPointer(1200, 1700, WIDE), 500);
    // Dragged past both caps either way, the same clamps hold.
    assert.equal(railPxFromPointer(1700, 1700, WIDE), RAIL_DEFAULT_PX);
    assert.equal(railPxFromPointer(100, 1700, WIDE), RAIL_CONTENT_MAX_PX);
  });

  it("steps by keyboard the way the drag teaches: left is wider", () => {
    assert.equal(steppedRailPx(RAIL_DEFAULT_PX, "wider", WIDE), RAIL_DEFAULT_PX + RAIL_KEY_STEP_PX);
    assert.equal(
      steppedRailPx(RAIL_DEFAULT_PX + RAIL_KEY_STEP_PX, "narrower", WIDE),
      RAIL_DEFAULT_PX,
    );
    // And the ends are the same ends the drag has.
    assert.equal(steppedRailPx(RAIL_DEFAULT_PX, "narrower", WIDE), RAIL_DEFAULT_PX);
    assert.equal(steppedRailPx(RAIL_CONTENT_MAX_PX, "wider", WIDE), RAIL_CONTENT_MAX_PX);
  });
});
