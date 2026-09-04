import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DRAWER_AT_DEFAULT_TOLERANCE_PX,
  DRAWER_FLING_VELOCITY,
  DRAWER_PEEK_PX,
  clampDrawerY,
  drawerExposedHeight,
  drawerGeometry,
  drawerReleaseVelocity,
  drawerSettleAfterRelease,
  drawerTapTarget,
  isDrawerDrag,
  isDrawerOpen,
} from "./results-drawer";

describe("the correction's evaluation drawer (#190)", () => {
  const phone = drawerGeometry(800);

  it("sizes the panel to the main project's shares of the viewport", () => {
    assert.equal(phone.fullHeight, 736); // 92 %
    assert.equal(phone.closedY, 736 - DRAWER_PEEK_PX);
    assert.equal(phone.defaultY, 736 - 440); // 55 % showing
    assert.equal(phone.canOpen, true);
  });

  it("has nothing to open into on a viewport that is mostly handle", () => {
    const tiny = drawerGeometry(100);
    assert.equal(tiny.canOpen, false);
    assert.equal(drawerTapTarget(tiny.closedY, tiny), tiny.closedY);
    assert.deepEqual(drawerGeometry(Number.NaN), drawerGeometry(0));
  });

  it("holds the panel inside its travel, without elasticity", () => {
    assert.equal(clampDrawerY(-40, phone), 0);
    assert.equal(clampDrawerY(phone.closedY + 40, phone), phone.closedY);
    assert.equal(clampDrawerY(300, phone), 300);
    assert.equal(clampDrawerY(Number.NaN, phone), phone.closedY);
  });

  it("is open at any height above the handle", () => {
    assert.equal(isDrawerOpen(phone.closedY, phone), false);
    assert.equal(isDrawerOpen(phone.closedY - 0.5, phone), false);
    assert.equal(isDrawerOpen(phone.defaultY, phone), true);
    assert.equal(isDrawerOpen(0, phone), true);
  });

  it("reports how much screen the drawer covers, in whole pixels", () => {
    assert.equal(drawerExposedHeight(phone.closedY, phone), DRAWER_PEEK_PX);
    assert.equal(drawerExposedHeight(0, phone), phone.fullHeight);
    assert.equal(drawerExposedHeight(phone.defaultY, phone), 440);
    assert.equal(drawerExposedHeight(phone.closedY + 500, phone), DRAWER_PEEK_PX);
  });

  it("stays where it was released unless the release was a flick", () => {
    assert.equal(drawerSettleAfterRelease(0, phone), null);
    assert.equal(drawerSettleAfterRelease(DRAWER_FLING_VELOCITY, phone), null);
    assert.equal(drawerSettleAfterRelease(DRAWER_FLING_VELOCITY + 1, phone), phone.closedY);
    assert.equal(drawerSettleAfterRelease(-(DRAWER_FLING_VELOCITY + 1), phone), 0);
  });

  it("opens on a tap, and a second tap at the default closes", () => {
    assert.equal(drawerTapTarget(phone.closedY, phone), phone.defaultY);
    assert.equal(drawerTapTarget(0, phone), phone.defaultY);
    assert.equal(drawerTapTarget(phone.defaultY, phone), phone.closedY);
    assert.equal(
      drawerTapTarget(phone.defaultY + DRAWER_AT_DEFAULT_TOLERANCE_PX - 1, phone),
      phone.closedY,
    );
    assert.equal(
      drawerTapTarget(phone.defaultY + DRAWER_AT_DEFAULT_TOLERANCE_PX, phone),
      phone.defaultY,
    );
  });

  it("tells a drag from a tap by the slop", () => {
    assert.equal(isDrawerDrag(6), false);
    assert.equal(isDrawerDrag(-6), false);
    assert.equal(isDrawerDrag(7), true);
  });

  it("reads the release velocity off the trailing window, not the whole gesture", () => {
    // A slow drag down for 500 ms, then a fast flick in the last 50 ms.
    const samples = [
      { time: 0, y: 100 },
      { time: 250, y: 120 },
      { time: 500, y: 140 },
      { time: 550, y: 240 },
    ];
    assert.equal(drawerReleaseVelocity(samples), 2000);
    // The other way round: a flick that ends resting is read as the rest.
    assert.equal(
      drawerReleaseVelocity([
        { time: 0, y: 0 },
        { time: 50, y: 300 },
        { time: 400, y: 300 },
      ]),
      0,
    );
    assert.equal(drawerReleaseVelocity([{ time: 0, y: 0 }]), 0);
    assert.equal(
      drawerReleaseVelocity([
        { time: 10, y: 0 },
        { time: 10, y: 50 },
      ]),
      0,
    );
  });
});
