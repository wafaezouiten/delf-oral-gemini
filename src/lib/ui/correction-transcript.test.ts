import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatTranscript, type TranscriptEntry } from "@/lib/delf/transcript";
import {
  CORRECTION_TRANSCRIPT_COPY,
  PHASE_HEADINGS,
  correctionTranscriptView,
} from "./correction-transcript";

function turn(
  phase: TranscriptEntry["phase"],
  speaker: TranscriptEntry["speaker"],
  text: string,
  timestamp = 0,
): TranscriptEntry {
  return { phase, speaker, timestamp, text };
}

/** An épreuve sat all the way through. */
const FULL: TranscriptEntry[] = [
  turn("monologue", "examiner", "Vous pouvez commencer.", 1_000),
  turn("monologue", "candidate", "Le sujet aborde la place du télétravail…", 2_000),
  turn("debate", "examiner", "Vous dites que c'est un progrès. Vraiment ?", 3_000),
  turn("debate", "candidate", "Je maintiens que oui, et voici pourquoi…", 4_000),
];

const DURATIONS = { monologueSeconds: 422, debateSeconds: 278 };

describe("cutting the correction into the two parts", () => {
  it("prints the parts in the order they were sat", () => {
    const view = correctionTranscriptView(FULL, DURATIONS);

    assert.deepEqual(
      view.sections.map((s) => s.phase),
      ["monologue", "debate"],
    );
  });

  it("names the parts as the épreuve named them", () => {
    // Not a third set of names for the same two parts: these are the déroulé's
    // own words (`po-player-view.ts`), which is what the candidate sat under.
    assert.equal(PHASE_HEADINGS.monologue, "Monologue suivi");
    assert.equal(PHASE_HEADINGS.debate, "Débat");

    const view = correctionTranscriptView(FULL, DURATIONS);
    assert.deepEqual(
      view.sections.map((s) => s.heading),
      ["Monologue suivi", "Débat"],
    );
  });

  it("gives each part its own duration, and pairs it with the right half", () => {
    const view = correctionTranscriptView(FULL, DURATIONS);

    assert.equal(view.sections[0].durationLabel, "7:02");
    assert.equal(view.sections[1].durationLabel, "4:38");
  });

  it("puts every turn under its own part, and loses none of them", () => {
    const view = correctionTranscriptView(FULL, DURATIONS);

    assert.deepEqual(
      view.sections[0].turns.map((t) => t.entry.text),
      ["Vous pouvez commencer.", "Le sujet aborde la place du télétravail…"],
    );
    assert.deepEqual(
      view.sections[1].turns.map((t) => t.entry.text),
      ["Vous dites que c'est un progrès. Vraiment ?", "Je maintiens que oui, et voici pourquoi…"],
    );
    assert.equal(
      view.sections.reduce((n, s) => n + s.turns.length, 0),
      FULL.length,
    );
  });

  it("says nothing about silence when both parts were spoken", () => {
    const view = correctionTranscriptView(FULL, DURATIONS);

    assert.equal(view.silentNotice, null);
    assert.deepEqual(
      view.sections.map((s) => s.emptyNote),
      [null, null],
    );
  });
});

describe("an épreuve walked out of mid-exposé", () => {
  const WALKED_OUT = FULL.slice(0, 2);

  it("prints the débat's heading anyway, over its quiet line", () => {
    // The opposite of `formatTranscript`, on purpose. That one skips an empty
    // phase to save the evaluator's context window; here an absent débat is a
    // fact of the correction — and it is the fact the rail's duration penalty
    // is about — so it gets a heading a candidate can check the penalty against.
    const view = correctionTranscriptView(WALKED_OUT, {
      monologueSeconds: 180,
      debateSeconds: 0,
    });

    const debate = view.sections[1];
    assert.equal(debate.heading, "Débat");
    assert.equal(debate.durationLabel, "0:00");
    assert.deepEqual(debate.turns, []);
    assert.equal(debate.emptyNote, CORRECTION_TRANSCRIPT_COPY.emptySection);
  });

  it("leaves the part that did happen alone", () => {
    const view = correctionTranscriptView(WALKED_OUT, {
      monologueSeconds: 180,
      debateSeconds: 0,
    });

    assert.equal(view.sections[0].emptyNote, null);
    assert.equal(view.sections[0].turns.length, 2);
  });

  it("does not raise the whole-page block for a half that is merely missing", () => {
    const view = correctionTranscriptView(WALKED_OUT, {
      monologueSeconds: 180,
      debateSeconds: 0,
    });

    assert.equal(view.silentNotice, null);
  });

  it("still prints both headings where `formatTranscript` prints one", () => {
    // The divergence stated as a comparison, so that a future change to either
    // side has to be deliberate about the other.
    assert.ok(!formatTranscript(WALKED_OUT).includes("PARTIE 2"));
    assert.equal(correctionTranscriptView(WALKED_OUT, DURATIONS).sections.length, 2);
  });
});

describe("a sitting the microphone caught nothing in", () => {
  const SILENT: TranscriptEntry[] = [
    turn("monologue", "examiner", "Vous pouvez commencer.", 1_000),
    turn("debate", "examiner", "Vous n'avez rien dit. Souhaitez-vous réagir ?", 2_000),
  ];

  it("raises the block, because the candidate is nowhere in the transcript", () => {
    // The test is « did the candidate ever speak », not « are there any turns »:
    // an examiner talking to silence still fills the transcript, and that
    // sitting is exactly the one the block exists for.
    const view = correctionTranscriptView(SILENT, DURATIONS);

    assert.equal(view.silentNotice?.title, CORRECTION_TRANSCRIPT_COPY.silentTitle);
    assert.equal(view.silentNotice?.body, CORRECTION_TRANSCRIPT_COPY.silentBody);
  });

  it("never prints the block and a quiet line together", () => {
    // One failure, said once. A sitting with nothing in it at all would
    // otherwise carry the red block plus a line under each empty heading.
    const view = correctionTranscriptView([], DURATIONS);

    assert.notEqual(view.silentNotice, null);
    assert.deepEqual(
      view.sections.map((s) => s.emptyNote),
      [null, null],
    );
  });

  it("still prints both headings and both durations on an empty transcript", () => {
    const view = correctionTranscriptView([], { monologueSeconds: 0, debateSeconds: 0 });

    assert.deepEqual(
      view.sections.map((s) => `${s.heading} ${s.durationLabel}`),
      ["Monologue suivi 0:00", "Débat 0:00"],
    );
  });
});

describe("the footnote", () => {
  it("no longer points at durations above the turns", () => {
    // The combined « Monologue … · Débat … » line is gone from the head, so
    // « les durées ci-dessus » pointed at nothing.
    assert.ok(!CORRECTION_TRANSCRIPT_COPY.footnote.includes("ci-dessus"));
    assert.ok(CORRECTION_TRANSCRIPT_COPY.footnote.includes("Les durées indiquées"));
  });
});

describe("stamping each turn with when it was said", () => {
  it("counts from the start of the part, not the start of the sitting", () => {
    // The whole point. `timestamp` is ms since the exam began, so the débat's
    // first turn carries ~15 minutes — printed under a heading that says the
    // débat lasted 4:38. Re-anchored, the stamps read against that duration.
    const view = correctionTranscriptView(
      [
        turn("monologue", "candidate", "…", 12_000),
        turn("debate", "examiner", "…", 930_000),
        turn("debate", "candidate", "…", 961_000),
      ],
      DURATIONS,
    );

    assert.deepEqual(
      view.sections[0].turns.map((t) => t.timeLabel),
      ["0:00"],
    );
    assert.deepEqual(
      view.sections[1].turns.map((t) => t.timeLabel),
      ["0:00", "0:31"],
    );
  });

  it("starts each part at 0:00, so its two halves are comparable", () => {
    const view = correctionTranscriptView(FULL, DURATIONS);

    assert.equal(view.sections[0].turns[0].timeLabel, "0:00");
    assert.equal(view.sections[1].turns[0].timeLabel, "0:00");
  });

  it("floors, because the stamp marks when a turn started", () => {
    // 1.9 s in is a turn that began during the second second, not the third.
    const view = correctionTranscriptView(
      [turn("monologue", "candidate", "a", 0), turn("monologue", "examiner", "b", 1_900)],
      DURATIONS,
    );

    assert.equal(view.sections[0].turns[1].timeLabel, "0:01");
  });

  it("crosses the minute the way a clock does", () => {
    const view = correctionTranscriptView(
      [turn("monologue", "candidate", "a", 0), turn("monologue", "examiner", "b", 65_000)],
      DURATIONS,
    );

    assert.equal(view.sections[0].turns[1].timeLabel, "1:05");
  });

  it("never prints a negative stamp", () => {
    // Nothing downstream guarantees the entries run forwards, and « -0:01 »
    // beside a turn reads as a defect in the recording rather than in the
    // arithmetic.
    const view = correctionTranscriptView(
      [turn("monologue", "candidate", "a", 9_000), turn("monologue", "examiner", "b", 4_000)],
      DURATIONS,
    );

    assert.equal(view.sections[0].turns[1].timeLabel, "0:00");
  });

  it("keeps each turn's own entry beside its stamp", () => {
    const view = correctionTranscriptView(FULL, DURATIONS);

    assert.equal(view.sections[1].turns[1].entry.text, "Je maintiens que oui, et voici pourquoi…");
    assert.equal(view.sections[1].turns[1].entry.speaker, "candidate");
  });
});

describe("a directive the examiner read aloud, on a correction written before #187", () => {
  it("shows the candidate what was said, and not the app's instruction", () => {
    const stored: TranscriptEntry[] = [
      turn("monologue", "candidate", "Mon exposé.", 1_000),
      turn(
        "debate",
        "examiner",
        "[Information de service, à ne jamais prononcer : le débat est terminé. Dis exactement ceci : « Je vous remercie, nous avons terminé. »]\n\nJe vous remercie, nous avons terminé.",
        900_000,
      ),
      turn("debate", "examiner", "[Le candidat n'a toujours rien répondu.]", 905_000),
    ];
    const view = correctionTranscriptView(stored, { monologueSeconds: 84, debateSeconds: 774 });
    const debate = view.sections[1];
    assert.deepEqual(
      debate.turns.map((t) => t.entry.text),
      ["Je vous remercie, nous avons terminé."],
      "the echo is gone and the turn that was nothing but an echo is gone with it",
    );
    // Re-anchored on the surviving turn's own timestamp, as ever.
    assert.equal(debate.turns[0].timeLabel, "0:00");
  });
});

describe("how each part is set, and what plays above it", () => {
  it("sets a part as a monologue only when nobody but the candidate spoke in it", () => {
    const [monologue, debate] = correctionTranscriptView(FULL, DURATIONS).sections;
    assert.equal(monologue.shape, "exchange", "the examiner's « Vous pouvez commencer » is a turn");
    assert.equal(debate.shape, "exchange");

    const solo = correctionTranscriptView([FULL[1], FULL[3]], DURATIONS).sections;
    assert.equal(solo[0].shape, "monologue");
    assert.equal(solo[1].shape, "monologue", "who talked decides, not which phase it is");
  });

  it("reads an empty part as an exchange rather than as an empty exposé", () => {
    const [monologue] = correctionTranscriptView([FULL[2], FULL[3]], DURATIONS).sections;
    assert.equal(monologue.shape, "exchange");
  });

  it("pairs each part with the recording kept for it, and says so when there is none", () => {
    const view = correctionTranscriptView(FULL, DURATIONS, [
      { phase: "debate", mimeType: "audio/ogg", durationSeconds: 278 },
    ]);
    const [monologue, debate] = view.sections;
    assert.deepEqual(debate.recording, {
      phase: "debate",
      mimeType: "audio/ogg",
      durationSeconds: 278,
    });
    assert.equal(debate.recordingNote, null);
    assert.equal(monologue.recording, null);
    assert.equal(monologue.recordingNote, CORRECTION_TRANSCRIPT_COPY.recordingUnavailable);
  });

  it("says nothing about a recording for a part that never ran", () => {
    const [, debate] = correctionTranscriptView([FULL[0], FULL[1]], {
      monologueSeconds: 422,
      debateSeconds: 0,
    }).sections;
    assert.equal(debate.recording, null);
    assert.equal(debate.recordingNote, null, "there was no audio to lose");
  });
});
