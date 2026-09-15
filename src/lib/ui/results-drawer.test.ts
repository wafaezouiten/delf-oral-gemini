import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DRAWER_SETTLE_TRANSITION,
  drawerFrame,
  drawerPanelBox,
  DRAWER_AT_DEFAULT_TOLERANCE_PX,
  DRAWER_FLING_VELOCITY,
  DRAWER_PEEK_PX,
  beginDrawerGesture,
  clampDrawerY,
  drawerExposedHeight,
  drawerGeometry,
  drawerReleaseVelocity,
  drawerSettleAfterRelease,
  drawerPlacementY,
  drawerTapTarget,
  moveDrawerGesture,
  releaseDrawerGesture,
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

describe("one drag of the handle, as data", () => {
  const phone = drawerGeometry(800);

  it("is a tap until the finger moves past the slop, and a tap toggles", () => {
    const gesture = beginDrawerGesture(1, 500, phone.closedY, 0);
    moveDrawerGesture(gesture, 503, 16, phone);
    assert.equal(gesture.moved, false, "within the slop");
    assert.equal(releaseDrawerGesture(gesture, phone.closedY, 32, phone), phone.defaultY);
  });

  it("follows the finger, clamped to the panel's travel, once it is a drag", () => {
    const gesture = beginDrawerGesture(1, 500, phone.defaultY, 0);
    assert.equal(moveDrawerGesture(gesture, 540, 16, phone), phone.defaultY + 40);
    assert.equal(gesture.moved, true);
    assert.equal(moveDrawerGesture(gesture, 5000, 32, phone), phone.closedY, "no elasticity below");
    assert.equal(moveDrawerGesture(gesture, -5000, 48, phone), 0, "nor above");
  });

  it("keeps only the trailing samples, so a long drag does not grow without bound", () => {
    const gesture = beginDrawerGesture(1, 500, phone.defaultY, 0);
    for (let i = 1; i <= 40; i += 1) moveDrawerGesture(gesture, 500 + i, i * 16, phone);
    assert.equal(gesture.samples.length, 8);
  });

  it("settles a flick, and leaves a slow release where it was", () => {
    const flick = beginDrawerGesture(1, 500, phone.defaultY, 0);
    // 100 px in 50 ms downwards: well past the fling velocity.
    moveDrawerGesture(flick, 550, 25, phone);
    moveDrawerGesture(flick, 600, 50, phone);
    assert.equal(releaseDrawerGesture(flick, phone.defaultY + 100, 50, phone), phone.closedY);

    const slow = beginDrawerGesture(1, 500, phone.defaultY, 0);
    moveDrawerGesture(slow, 520, 500, phone);
    assert.equal(releaseDrawerGesture(slow, phone.defaultY + 20, 1000, phone), null);
  });

  it("reads the release itself as the last sample, so a finger that stopped is not still moving", () => {
    const gesture = beginDrawerGesture(1, 500, phone.defaultY, 0);
    moveDrawerGesture(gesture, 550, 25, phone);
    moveDrawerGesture(gesture, 600, 50, phone);
    // Held still for a second, then lifted: no flick.
    assert.equal(releaseDrawerGesture(gesture, phone.defaultY + 100, 1050, phone), null);
  });

  it("places the drawer: open to the default first, then hold the reader's position", () => {
    const seed = { first: true, initiallyOpen: true, open: true, y: 0 };
    assert.equal(drawerPlacementY(seed, phone), phone.defaultY);
    // Too short to open into: the default is refused, and the seeded open
    // state then holds the panel at its seeded position — the top. What the
    // component's own comment calls "rests closed" is, measured, y = 0; kept
    // as it was, and worth deciding on its own.
    assert.equal(drawerPlacementY(seed, drawerGeometry(100)), 0);
    // `open` is seeded from `initiallyOpen`, so a drawer not asked to open
    // starts closed.
    assert.equal(
      drawerPlacementY({ first: true, initiallyOpen: false, open: false, y: 0 }, phone),
      phone.closedY,
    );
    assert.equal(
      drawerPlacementY({ first: false, initiallyOpen: true, open: false, y: 200 }, phone),
      phone.closedY,
      "a closed drawer stays closed on a resize",
    );
    assert.equal(
      drawerPlacementY({ first: false, initiallyOpen: true, open: true, y: 200 }, phone),
      200,
      "an open one is left where it was",
    );
    assert.equal(
      drawerPlacementY({ first: false, initiallyOpen: true, open: true, y: 5000 }, phone),
      phone.closedY,
      "re-clamped to the new lower limit",
    );
  });
});

describe("one frame of the panel", () => {
  const geometry = drawerGeometry(800);

  it("writes the clamped position, the settle only on a release, and the visible slice", () => {
    const frame = drawerFrame(geometry.defaultY, geometry, true);
    assert.equal(frame.y, geometry.defaultY);
    assert.equal(frame.transform, `translateY(${geometry.defaultY}px)`);
    assert.equal(frame.transition, DRAWER_SETTLE_TRANSITION);
    assert.equal(frame.exposed, drawerExposedHeight(geometry.defaultY, geometry));
    assert.equal(frame.bodyHeight, `${frame.exposed - DRAWER_PEEK_PX}px`);
    assert.equal(drawerFrame(geometry.defaultY, geometry, false).transition, "none");
  });

  it("never sizes the body below zero, even past the closed position", () => {
    const frame = drawerFrame(geometry.closedY + 500, geometry, false);
    assert.equal(frame.y, geometry.closedY);
    assert.equal(frame.bodyHeight, "0px");
  });
});

describe("the panel's box", () => {
  it("is hidden and unsized until there is a viewport, then the panel's full height", () => {
    assert.deepEqual(drawerPanelBox(0), { height: undefined, visibility: "hidden" });
    assert.deepEqual(drawerPanelBox(800), {
      height: drawerGeometry(800).fullHeight,
      visibility: undefined,
    });
  });
});
