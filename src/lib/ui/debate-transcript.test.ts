import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { appendFragment, entriesForPhase, type TranscriptEntry } from "@/lib/delf/transcript";
import {
  DEBATE_TRANSCRIPT_COPY,
  STICK_THRESHOLD_PX,
  isNearBottom,
  speakerLabel,
  turnKey,
} from "./debate-transcript";

describe("naming the two speakers", () => {
  it("addresses the candidate, and names the examiner", () => {
    assert.equal(speakerLabel("candidate"), "Vous");
    assert.equal(speakerLabel("examiner"), "Examinateur");
  });

  it("uses the same words as the results page's transcript", () => {
    // Not a style point: the same exchange is printed twice, live and in the
    // correction, and « Vous » becoming « Candidat » between them reads as two
    // different transcripts of two different sittings.
    assert.equal(speakerLabel("candidate"), "Vous");
  });
});

describe("deciding whether the feed follows the conversation", () => {
  it("follows when the scroller is at the bottom", () => {
    assert.equal(isNearBottom({ scrollTop: 400, scrollHeight: 600, clientHeight: 200 }), true);
  });

  it("follows within a line of the bottom, because the last turn grows", () => {
    // `appendFragment` merges a fragment into the last entry rather than adding
    // one, so the content gets taller under a reader who has not moved. Exactly
    // at the bottom is a position nothing stays in.
    assert.equal(
      isNearBottom({ scrollTop: 400 - STICK_THRESHOLD_PX, scrollHeight: 600, clientHeight: 200 }),
      true,
    );
  });

  it("stops following once the candidate has scrolled back to re-read", () => {
    assert.equal(isNearBottom({ scrollTop: 120, scrollHeight: 600, clientHeight: 200 }), false);
  });

  it("follows when there is nothing to scroll", () => {
    // The empty state, and the first turn or two: no overflow, so the distance
    // is zero and the feed must not decide it has been scrolled away from.
    assert.equal(isNearBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 200 }), true);
  });
});

describe("keying a turn while it is still being spoken", () => {
  it("keeps the same key as fragments merge into the last turn", () => {
    let entries: TranscriptEntry[] = [];
    entries = appendFragment(entries, {
      phase: "debate",
      speaker: "examiner",
      timestamp: 1_000,
      text: "Vous dites que le télétravail",
    });
    const first = turnKey(entries[0], 0);

    entries = appendFragment(entries, {
      phase: "debate",
      speaker: "examiner",
      timestamp: 1_800,
      text: "isole les salariés.",
    });

    assert.equal(entries.length, 1, "the fragment merged rather than starting a turn");
    assert.equal(turnKey(entries[0], 0), first, "so the turn must not remount");
  });

  it("gives a new turn its own key when the speaker changes", () => {
    let entries: TranscriptEntry[] = [];
    entries = appendFragment(entries, {
      phase: "debate",
      speaker: "examiner",
      timestamp: 1_000,
      text: "Une objection.",
    });
    entries = appendFragment(entries, {
      phase: "debate",
      speaker: "candidate",
      timestamp: 4_200,
      text: "Je ne suis pas d'accord.",
    });

    assert.notEqual(turnKey(entries[0], 0), turnKey(entries[1], 1));
  });
});

describe("what the feed is given to print", () => {
  it("is the débat's turns only — the monologue never reaches this panel", () => {
    let entries: TranscriptEntry[] = [];
    entries = appendFragment(entries, {
      phase: "monologue",
      speaker: "candidate",
      timestamp: 500,
      text: "Mon exposé.",
    });
    entries = appendFragment(entries, {
      phase: "debate",
      speaker: "examiner",
      timestamp: 9_000,
      text: "Première objection.",
    });

    const shown = entriesForPhase(entries, "debate");
    assert.deepEqual(
      shown.map((turn) => turn.text),
      ["Première objection."],
    );
  });
});

describe("the copy", () => {
  it("warns that the text can lag the voice", () => {
    // The one thing about this panel a candidate would otherwise read as a bug:
    // transcription does not arrive in step with the audio it transcribes.
    assert.match(DEBATE_TRANSCRIPT_COPY.footnote, /décalage/);
  });

  it("offers the way back in the same words the button carries", () => {
    assert.match(DEBATE_TRANSCRIPT_COPY.show, /transcription/i);
    assert.equal(DEBATE_TRANSCRIPT_COPY.hide, "Masquer");
  });
});
