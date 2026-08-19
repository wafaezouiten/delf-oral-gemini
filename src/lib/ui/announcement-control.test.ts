import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ANNOUNCEMENT_COPY, announcementControl } from "./announcement-control";

const state = (over: Partial<Parameters<typeof announcementControl>[0]> = {}) =>
  announcementControl({
    announcementPlaying: false,
    announcementBlocked: false,
    ...over,
  });

describe("the consigne control", () => {
  it("draws nothing when no consigne is audible", () => {
    // Before the first one, between two, and for the rest of every phase after
    // its own has been heard. The card used to stay for the phase; this does not
    // outlive the voice it interrupts.
    assert.equal(state(), null);
  });

  it("offers the skip while the consigne plays", () => {
    assert.equal(state({ announcementPlaying: true }), "playing");
  });

  it("reads as held when the browser refused to play it", () => {
    // `held` outranks `playing`: nothing is audible, and the épreuve is waiting on
    // the candidate rather than on the clip.
    assert.equal(state({ announcementBlocked: true, announcementPlaying: true }), "held");
  });

  it("labels the skip « Passer », and nothing else that terse", () => {
    // The préparation's ghost « Passer et commencer maintenant » is gone (#59),
    // so the short label is no longer ambiguous with a control that ends a
    // thirty-minute phase. Every other label still names what it acts on, and the
    // two ways out of a hold must not read the same: one plays a clip, the other
    // starts the part without it.
    assert.equal(ANNOUNCEMENT_COPY.skip, "Passer");
    for (const label of [ANNOUNCEMENT_COPY.play, ANNOUNCEMENT_COPY.blockedSkip]) {
      assert.notEqual(label.trim(), "Passer");
      assert.ok(label.length > 6, `"${label}" is too terse to say what it acts on`);
    }
    assert.notEqual(ANNOUNCEMENT_COPY.blockedSkip, ANNOUNCEMENT_COPY.skip);
  });

  it("explains a hold rather than only labelling a button", () => {
    // A frozen clock with no explanation reads as a bug.
    assert.match(ANNOUNCEMENT_COPY.blocked, /attend/);
  });

  it("says who is talking, since nothing on screen does", () => {
    // The only thing a screen reader gets while the clip plays: the button beside
    // it says « Passer » and names no speaker.
    assert.match(ANNOUNCEMENT_COPY.speaking, /examinateur/i);
  });
});
