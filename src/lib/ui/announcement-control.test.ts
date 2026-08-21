import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ANNOUNCEMENT_COPY, announcementControl } from "./announcement-control";

const state = (over: Partial<Parameters<typeof announcementControl>[0]> = {}) =>
  announcementControl({
    announcementPlaying: false,
    ...over,
  });

describe("the consigne control", () => {
  it("draws nothing when no consigne is audible", () => {
    // Before the first one, between two, and for the rest of every phase after
    // its own has been heard. The card used to stay for the phase; this does not
    // outlive the voice it interrupts. This is also now the whole of what a
    // refused autoplay produces: the controller forfeits the clip, so there is
    // no `held` mode left for this function to report.
    assert.equal(state(), null);
  });

  it("offers the skip while the consigne plays", () => {
    assert.equal(state({ announcementPlaying: true }), "playing");
  });

  it("labels the skip « Passer »", () => {
    // The préparation's ghost « Passer et commencer maintenant » is gone (#59),
    // so the short label is no longer ambiguous with a control that ends a
    // thirty-minute phase.
    assert.equal(ANNOUNCEMENT_COPY.skip, "Passer");
  });

  it("says who is talking, since nothing on screen does", () => {
    // The only thing a screen reader gets while the clip plays: the button beside
    // it says « Passer » and names no speaker.
    assert.match(ANNOUNCEMENT_COPY.speaking, /examinateur/i);
  });
});
