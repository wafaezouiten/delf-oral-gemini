import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEBATE_FLOOR_SECONDS, MONOLOGUE_FLOOR_SECONDS } from "@/lib/delf/orale-rubric";
import {
  DEV_PANEL_COPY,
  MAX_DEV_SECONDS,
  SPOKEN_WORDS_PER_MINUTE,
  countWords,
  describeDraft,
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

  it("is long enough to clear the monologue's own penalty floor", () => {
    // Otherwise the one button that exists to produce a gradeable sitting
    // produces one that is docked for its length instead. Asserted against the
    // rubric's constant rather than a number copied out of it, so moving the
    // floor fails here instead of quietly making the sample too short.
    const estimate = estimateSpokenSeconds(countWords(exampleExpose("un sujet")));
    assert.ok(
      estimate >= MONOLOGUE_FLOOR_SECONDS,
      `the sample estimates ${estimate}s, under the ${MONOLOGUE_FLOOR_SECONDS}s floor`,
    );
  });

  it("does not on its own make a penalty-free sitting, because the débat has a floor too", () => {
    // Documented as a test because it is the surprising half: type a full
    // exposé, send nothing for the débat, and the flat −3 still fires.
    const estimate = estimateSpokenSeconds(countWords(exampleExpose("un sujet")));
    assert.ok(estimate < DEBATE_FLOOR_SECONDS, "the débat still has to be claimed");
  });
});
