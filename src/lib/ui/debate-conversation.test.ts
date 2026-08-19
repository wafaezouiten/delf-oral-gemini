import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { appendFragment, entriesForPhase, type TranscriptEntry } from "@/lib/delf/transcript";
import {
  DEBATE_CONVERSATION_COPY,
  debateTurns,
  STICK_THRESHOLD_PX,
  isNearBottom,
  speakerLabel,
  turnKey,
} from "./debate-conversation";

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
    assert.match(DEBATE_CONVERSATION_COPY.footnote, /décalage/);
  });

  it("names the panel for what it is, an exchange rather than a document", () => {
    // There is no « Masquer » any more: the exchange is the débat's body, not a
    // panel laid over a status card that could be put back (#48 → #60).
    assert.match(DEBATE_CONVERSATION_COPY.title, /Échange/);
  });

  it("offers the conversation back, not a scroll position", () => {
    // The feed holds still when the candidate has scrolled up (#88), and the way
    // out says what it gives back: the thread of the exchange, not « en bas ».
    assert.match(DEBATE_CONVERSATION_COPY.resume, /fil/);
  });
});

describe("stamping each turn with when it was said", () => {
  const OPENING = 900_000;
  const TRANSCRIPT: TranscriptEntry[] = [
    { phase: "monologue", speaker: "candidate", timestamp: 12_000, text: "Mon exposé…" },
    { phase: "debate", speaker: "examiner", timestamp: OPENING, text: "Vraiment ?" },
    { phase: "debate", speaker: "candidate", timestamp: OPENING + 31_400, text: "Oui, et…" },
  ];

  it("counts from the phase clock, so the stamps agree with the scene above", () => {
    // The candidate is looking at `1:12 / 5:00` in the scene a centimetre above
    // this feed. A stamp anchored anywhere else disagrees with it on screen.
    const turns = debateTurns(TRANSCRIPT, OPENING - 8_000);

    assert.deepEqual(
      turns.map((t) => t.timeLabel),
      ["0:08", "0:39"],
    );
  });

  it("shows only the débat", () => {
    const turns = debateTurns(TRANSCRIPT, OPENING);

    assert.deepEqual(
      turns.map((t) => t.entry.text),
      ["Vraiment ?", "Oui, et…"],
    );
  });

  it("falls back to the first turn while the phase clock has not started", () => {
    // A real window, not a transient: the consigne is spoken before the clock
    // starts (#37) and the opening question can land inside it. Measuring
    // against the exam's origin there would stamp it with a quarter of an hour.
    const turns = debateTurns(TRANSCRIPT, null);

    assert.deepEqual(
      turns.map((t) => t.timeLabel),
      ["0:00", "0:31"],
    );
  });

  it("holds at 0:00 for a turn that beat the clock's start", () => {
    const turns = debateTurns(TRANSCRIPT, OPENING + 5_000);

    assert.equal(turns[0].timeLabel, "0:00");
  });

  it("has nothing to stamp before the débat begins", () => {
    assert.deepEqual(debateTurns(TRANSCRIPT.slice(0, 1), null), []);
  });
});
