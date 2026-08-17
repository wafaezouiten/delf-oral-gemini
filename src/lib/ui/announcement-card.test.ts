import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ANNOUNCEMENT_COPY, announcementCard } from "./announcement-card";

const state = (over: Partial<Parameters<typeof announcementCard>[0]> = {}) =>
  announcementCard({
    announcement: "monologue",
    announcementPlaying: false,
    announcementBlocked: false,
    announcementsMuted: false,
    ...over,
  });

describe("the consigne card", () => {
  it("draws nothing before the first consigne of the sitting", () => {
    assert.equal(state({ announcement: null }), null);
  });

  it("stays on screen after the consigne has been heard", () => {
    // It is the written equivalent of something the candidate may have missed, so
    // it outlives its own playback — folded down, with a replay.
    const view = state();
    assert.equal(view?.mode, "heard");
    assert.equal(view?.textOpen, false, "folded away once there is a phase to get on with");
    assert.equal(view?.announcement.id, "monologue");
  });

  it("prints the text while the consigne is playing", () => {
    const view = state({ announcementPlaying: true });
    assert.equal(view?.mode, "playing");
    assert.equal(view?.textOpen, true);
    assert.equal(view?.offerMute, true);
  });

  it("reads as held when the browser refused to play it", () => {
    // `held` outranks `playing`: nothing is audible, and the épreuve is waiting on
    // the candidate rather than on the clip.
    const view = state({ announcementBlocked: true, announcementPlaying: true });
    assert.equal(view?.mode, "held");
    assert.equal(view?.textOpen, true, "the words must be readable when they were not heard");
  });

  it("keeps the text open, and stops offering to mute, once muted", () => {
    const view = state({ announcementsMuted: true });
    assert.equal(view?.textOpen, true, "muting the voice must not withdraw the instruction");
    assert.equal(view?.offerMute, false);
  });

  it("never labels an audio control just « Passer »", () => {
    // The préparation screen already has « Passer et commencer maintenant », which
    // ends a thirty-minute phase. A bare « Passer » beside it would be ambiguous
    // between silencing a clip and skipping the préparation.
    for (const label of [
      ANNOUNCEMENT_COPY.skip,
      ANNOUNCEMENT_COPY.mute,
      ANNOUNCEMENT_COPY.play,
      ANNOUNCEMENT_COPY.replay,
      ANNOUNCEMENT_COPY.blockedSkip,
    ]) {
      assert.notEqual(label.trim(), "Passer");
      assert.ok(label.length > 6, `"${label}" is too terse to say what it acts on`);
    }
    // And the two skips must not read the same: one silences a clip, the other
    // starts the phase without it.
    assert.notEqual(ANNOUNCEMENT_COPY.skip, ANNOUNCEMENT_COPY.blockedSkip);
  });

  it("explains a hold rather than only labelling a button", () => {
    // A frozen clock with no explanation reads as a bug.
    assert.match(ANNOUNCEMENT_COPY.blocked, /attend/);
  });
});
