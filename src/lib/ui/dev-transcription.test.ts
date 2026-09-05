import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SHORT_DEVELOPMENT_SECONDS, durationTier } from "@/lib/delf/orale-rubric";
import {
  DEV_PANEL_COPY,
  DEV_SUBMIT_COPY,
  MAX_DEV_SECONDS,
  SPOKEN_WORDS_PER_MINUTE,
  countWords,
  describeDraft,
  devSubmitDisabled,
  devSubmitState,
  estimateSpokenSeconds,
  exampleExpose,
  parseDurationInput,
  resolveDevSeconds,
} from "./dev-transcription";

describe("counting a typed draft", () => {
  it("reads zero for an empty field, and for one holding only spaces", () => {
    // The counter is on screen before anything is typed, so this is the state
    // it spends most of its life in.
    assert.equal(countWords(""), 0);
    assert.equal(countWords("   \n\t "), 0);
  });

  it("counts words across newlines and runs of spaces", () => {
    assert.equal(countWords("Le télétravail a transformé le rapport au bureau."), 8);
    assert.equal(countWords("premier paragraphe\n\n  second   paragraphe"), 4);
  });
});

describe("estimating how long that would take to say", () => {
  it("turns the words-per-minute rate into seconds", () => {
    assert.equal(estimateSpokenSeconds(SPOKEN_WORDS_PER_MINUTE), 60);
    assert.equal(estimateSpokenSeconds(SPOKEN_WORDS_PER_MINUTE * 5), 300);
  });

  it("answers zero rather than NaN for nothing typed", () => {
    assert.equal(estimateSpokenSeconds(0), 0);
    assert.equal(estimateSpokenSeconds(-4), 0);
    assert.equal(estimateSpokenSeconds(Number.NaN), 0);
  });
});

describe("reading the duration field", () => {
  it("treats an empty field as auto", () => {
    assert.equal(parseDurationInput(""), null);
    assert.equal(parseDurationInput("   "), null);
  });

  it("treats an unreadable field as auto rather than as zero", () => {
    // A half-typed number still shows the "auto" placeholder's behaviour, which
    // is the least surprising thing for a field being typed into.
    assert.equal(parseDurationInput("-"), null);
    assert.equal(parseDurationInput("abc"), null);
    assert.equal(parseDurationInput("-30"), null);
  });

  it("accepts a typed zero, because a phase of no seconds is the penalty case", () => {
    assert.equal(parseDurationInput("0"), 0);
  });

  it("rounds, accepts a comma, and clamps to the audit column's bound", () => {
    assert.equal(parseDurationInput("312.6"), 313);
    assert.equal(parseDurationInput("312,4"), 312);
    assert.equal(parseDurationInput(String(MAX_DEV_SECONDS * 10)), MAX_DEV_SECONDS);
  });
});

describe("resolving what a submission claims", () => {
  it("prefers what was typed over the estimate", () => {
    assert.equal(resolveDevSeconds("deux mots", "420"), 420);
  });

  it("falls back to the estimate on auto", () => {
    const text = Array.from({ length: SPOKEN_WORDS_PER_MINUTE * 2 }, () => "mot").join(" ");
    assert.equal(resolveDevSeconds(text, ""), 120);
  });

  it("claims nothing for an empty draft on auto", () => {
    assert.equal(resolveDevSeconds("", ""), 0);
  });
});

describe("the counter under the field", () => {
  it("starts at nothing", () => {
    assert.equal(describeDraft("", ""), "0 mots · 0:00");
  });

  it("keeps « mot » singular", () => {
    assert.equal(describeDraft("bonjour", "").startsWith("1 mot ·"), true);
  });

  it("shows the typed duration rather than the estimate once one is given", () => {
    assert.equal(describeDraft("trois petits mots", "377"), "3 mots · 6:17");
  });
});

describe("the panel's copy", () => {
  it("names what it replaces — the exposé, and only the exposé", () => {
    assert.match(DEV_PANEL_COPY.description, /l'exposé/);
    assert.equal(DEV_PANEL_COPY.submit, "Envoyer l'exposé");
  });

  it("promises the rest of the déroulé continues, which is the panel's whole claim", () => {
    assert.match(DEV_PANEL_COPY.description, /débat et la correction/);
  });
});

describe("the example exposé", () => {
  it("quotes the sujet actually on screen", () => {
    const subject = "Faut-il bannir la voiture des centres-villes ?";
    assert.match(exampleExpose(subject), new RegExp(subject.replace(/[?]/g, "\\?")));
  });

  it("is long enough to keep the exposé out of the heaviest duration tier", () => {
    // Otherwise the one button that exists to produce a gradeable sitting
    // produces one charged two bands of « réalisation de la tâche » for its
    // length. Asserted against the rubric's own tiers rather than a number
    // copied out of them, so moving a threshold fails here instead of quietly
    // making the sample too short.
    const estimate = estimateSpokenSeconds(countWords(exampleExpose("un sujet")));
    assert.ok(
      estimate >= SHORT_DEVELOPMENT_SECONDS,
      `the sample estimates ${estimate}s, under the ${SHORT_DEVELOPMENT_SECONDS}s threshold`,
    );
    assert.equal(durationTier("monologue", estimate), "moderate");
  });

  it("does not on its own make a penalty-free sitting (#189)", () => {
    // The surprising half: the sample reads as a full exposé and still lands
    // one tier short, because the monologue's full-development time is the
    // 420 s the épreuve announces (#189) and this estimates around 300. Typing
    // it and sending nothing for the débat is charged on both criteria. A
    // sitting meant to score without a duration charge has to claim both
    // durations, which is what the dev duration field is for.
    const estimate = estimateSpokenSeconds(countWords(exampleExpose("un sujet")));
    assert.notEqual(durationTier("monologue", estimate), "full", "the exposé alone is not enough");
    assert.equal(durationTier("debate", 0), "strong", "and an unclaimed débat is the bottom tier");
  });
});

describe("what « Envoyer l'exposé » can do right now (#53)", () => {
  const state = (over: Partial<Parameters<typeof devSubmitState>[0]> = {}) =>
    devSubmitState({
      text: "Un exposé complet, tapé.",
      awaitingConsigne: false,
      sending: false,
      closing: false,
      ...over,
    });

  it("is ready when there is an exposé and nothing in the way", () => {
    assert.equal(state(), "ready");
    assert.equal(devSubmitDisabled("ready"), false);
  });

  it("has nothing to send for an empty field, or one holding only spaces", () => {
    assert.equal(state({ text: "" }), "empty");
    assert.equal(state({ text: "   \n\t" }), "empty");
  });

  it("waits out the consigne rather than looking pressable", () => {
    // The controller refuses here too — this is the button agreeing with it in
    // advance, which is the difference between a refusal and a no-op.
    assert.equal(state({ awaitingConsigne: true }), "consigne");
    assert.equal(devSubmitDisabled("consigne"), true);
  });

  it("names the press in flight, and the ending it did not start", () => {
    // Both used to look identical to a press that did nothing at all. The
    // second is the mic button's closing handshake: a typed exposé never waits
    // through one, but the panel can be open while one runs.
    assert.equal(state({ sending: true }), "sending");
    assert.equal(state({ closing: true }), "closing");
  });

  it("keeps reporting its own press rather than somebody else's ending", () => {
    // The mic button's handshake can start under a press that is still in
    // flight. The panel finishes reporting the press: it is the one it owns.
    assert.equal(state({ sending: true, closing: true }), "sending");
  });

  it("still refuses an empty field while the examiner talks, without saying so twice", () => {
    // Order matters only in that the more specific reason wins: there is no
    // point telling someone their empty field cannot be sent yet.
    assert.equal(state({ text: "", awaitingConsigne: true }), "consigne");
  });

  it("explains itself exactly where explaining is worth something", () => {
    assert.equal(DEV_SUBMIT_COPY.ready.note, null);
    assert.equal(DEV_SUBMIT_COPY.empty.note, null);
    assert.match(DEV_SUBMIT_COPY.consigne.note ?? "", /consigne/);
    assert.match(DEV_SUBMIT_COPY.closing.note ?? "", /conclut/);
    assert.equal(DEV_SUBMIT_COPY.ready.label, DEV_PANEL_COPY.submit);
  });
});
