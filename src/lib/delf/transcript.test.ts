import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendFragment,
  candidateSpeech,
  candidateWordCount,
  entriesForPhase,
  formatTranscript,
  monologueAsHistory,
  type TranscriptEntry,
} from "./transcript";

function build(...fragments: Array<Partial<TranscriptEntry> & { text: string }>) {
  let entries: TranscriptEntry[] = [];
  fragments.forEach((fragment, index) => {
    entries = appendFragment(entries, {
      phase: fragment.phase ?? "monologue",
      speaker: fragment.speaker ?? "candidate",
      timestamp: fragment.timestamp ?? index * 1000,
      text: fragment.text,
    });
  });
  return entries;
}

describe("transcript", () => {
  it("coalesces streamed fragments from the same speaker into one turn", () => {
    const entries = build(
      { text: "Je pense" },
      { text: "que le télétravail" },
      { text: "a changé nos vies." },
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, "Je pense que le télétravail a changé nos vies.");
  });

  it("starts a new turn when the speaker changes", () => {
    const entries = build(
      { text: "Voilà ma position.", speaker: "candidate" },
      { text: "Mais ne pensez-vous pas le contraire ?", speaker: "examiner" },
      { text: "Non, justement.", speaker: "candidate" },
    );
    assert.equal(entries.length, 3);
  });

  it("starts a new turn when the phase changes, even for the same speaker", () => {
    const entries = build(
      { text: "Ma conclusion.", phase: "monologue" },
      { text: "Ma réponse.", phase: "debate" },
    );
    assert.equal(entries.length, 2);
    assert.equal(entries[0].phase, "monologue");
    assert.equal(entries[1].phase, "debate");
  });

  it("drops empty fragments instead of creating silent turns", () => {
    const entries = build({ text: "Bonjour." }, { text: "   " }, { text: "" });
    assert.equal(entries.length, 1);
  });

  it("does not weld words together or double-space punctuation", () => {
    const entries = build({ text: "Le télétravail" }, { text: ", selon moi" }, { text: "." });
    assert.equal(entries[0].text, "Le télétravail, selon moi.");
  });

  it("never mutates the array it is given", () => {
    const first = build({ text: "Un." });
    const second = appendFragment(first, {
      phase: "debate",
      speaker: "examiner",
      timestamp: 1,
      text: "Deux.",
    });
    assert.equal(first.length, 1);
    assert.equal(second.length, 2);
  });

  it("keeps the monologue and the debate as separate blocks when formatted", () => {
    const entries = build(
      { text: "Mon exposé.", phase: "monologue", speaker: "candidate" },
      { text: "Une objection.", phase: "debate", speaker: "examiner" },
      { text: "Ma défense.", phase: "debate", speaker: "candidate" },
    );
    const formatted = formatTranscript(entries);
    assert.match(formatted, /^MONOLOGUE/);
    assert.ok(formatted.includes("DEBAT"));
    assert.ok(formatted.indexOf("MONOLOGUE") < formatted.indexOf("DEBAT"));
    assert.ok(formatted.includes("CANDIDAT: Mon exposé."));
    assert.ok(formatted.includes("EXAMINATEUR: Une objection."));
  });

  it("filters and counts the candidate's own speech only", () => {
    const entries = build(
      { text: "un deux trois", speaker: "candidate" },
      { text: "quatre cinq six sept", speaker: "examiner" },
    );
    assert.equal(candidateSpeech(entries), "un deux trois");
    assert.equal(candidateWordCount(entries), 3);
    assert.equal(entriesForPhase(entries, "debate").length, 0);
  });

  it("hands the monologue to the debate session as seedable history", () => {
    const entries = build({ text: "Je défends le télétravail." });
    const history = monologueAsHistory(entries);
    assert.equal(history.length, 2);
    assert.equal(history[0].role, "user");
    assert.ok(history[0].parts[0].text.includes("Je défends le télétravail."));
    assert.equal(history[1].role, "model");
  });

  it("seeds nothing when the monologue produced no speech", () => {
    assert.deepEqual(monologueAsHistory([]), []);
  });
});
