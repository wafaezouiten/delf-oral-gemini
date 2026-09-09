import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PARTICIPATION_VOICED_FLOOR } from "@/lib/delf/orale-rubric";
import type { TranscriptEntry } from "@/lib/delf/transcript";
import { participationRefusal } from "./participation-refusal";

/**
 * The order is the subject. Both refusals were already correct on their own;
 * what was wrong was which one got asked first, and the sitting that exposed
 * it is the one below called "a lost monologue and a walk-out".
 */

/** Twenty-five words, comfortably over the floor. */
const SPEECH = Array.from({ length: 25 }, (_, i) => `mot${i}`).join(" ");

function entry(
  phase: "monologue" | "debate",
  speaker: "candidate" | "examiner",
  text: string,
): TranscriptEntry {
  return { phase, speaker, timestamp: 0, text };
}

const HEARD = PARTICIPATION_VOICED_FLOOR + 1;

describe("participationRefusal", () => {
  it("grades a sitting where both parts were spoken", () => {
    const transcript = [
      entry("monologue", "candidate", SPEECH),
      entry("debate", "candidate", SPEECH),
    ];
    assert.equal(
      participationRefusal(transcript, { monologueSeconds: 300, debateSeconds: 600 }),
      null,
    );
  });

  it("blames the app, not the candidate, for a lost monologue and a walk-out", () => {
    // The sitting this whole file exists for: six minutes of exposé that the
    // Live API never transcribed, and a débat left at once. Zero words in
    // total, so the blanket floor would have answered first — and would have
    // told a candidate who spoke for six minutes that they had said nothing.
    const refusal = participationRefusal([], { monologueSeconds: 360, debateSeconds: 2 });
    assert.equal(refusal?.reason, "transcription");
    assert.deepEqual(refusal?.parts, ["monologue"]);
    assert.match(refusal!.message, /le microphone vous a bien entendu/);
    assert.match(refusal!.message, /ce n'est pas de votre fait/);
  });

  it("still names one part when the other carried the sitting", () => {
    const refusal = participationRefusal([entry("debate", "candidate", SPEECH)], {
      monologueSeconds: 360,
      debateSeconds: 600,
    });
    assert.equal(refusal?.reason, "transcription");
    assert.match(refusal!.message, /de votre monologue/);
  });

  it("names both parts when both were heard and neither arrived", () => {
    const refusal = participationRefusal([], { monologueSeconds: 360, debateSeconds: 600 });
    assert.deepEqual(refusal?.parts, ["monologue", "debate"]);
    assert.match(refusal!.message, /des deux parties/);
  });

  it("calls a silent sitting absent, which is what it is", () => {
    // Nothing said and nothing heard: « euh… non, ça va, merci » clears
    // neither bar, and the refusal that names the candidate is the honest one.
    const refusal = participationRefusal([entry("debate", "candidate", "Non, ça va.")], {
      monologueSeconds: 1,
      debateSeconds: 2,
    });
    assert.equal(refusal?.reason, "absent");
    assert.match(refusal!.message, /presque aucune parole du candidat/);
  });

  it("reads a payload with no voiced seconds exactly as it did before", () => {
    // A client that predates the field offers no evidence, so the count decides.
    const refusal = participationRefusal([], { monologueSeconds: 0, debateSeconds: 0 });
    assert.equal(refusal?.reason, "absent");
  });

  it("does not refuse a part whose words are there, however loud it was", () => {
    const transcript = [
      entry("monologue", "candidate", SPEECH),
      entry("debate", "candidate", SPEECH),
    ];
    assert.equal(
      participationRefusal(transcript, { monologueSeconds: HEARD, debateSeconds: HEARD }),
      null,
    );
  });

  it("ignores the examiner, who is never the one being graded", () => {
    const refusal = participationRefusal([entry("monologue", "examiner", SPEECH)], {
      monologueSeconds: 360,
      debateSeconds: 0,
    });
    assert.equal(refusal?.reason, "transcription");
  });
});
