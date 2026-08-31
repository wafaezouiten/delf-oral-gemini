import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendFragment,
  candidateSpeech,
  candidateWordCount,
  debateSessionHistory,
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

  it("starts a new turn for the same speaker when the caller says so (#101)", () => {
    // The relance: the examiner asked a question, the candidate said nothing,
    // and ten seconds later the app made the examiner speak again. Nothing in
    // the text says those are two interventions — the controller knows.
    let entries = build({ text: "Le télétravail isole-t-il vraiment ?", speaker: "examiner" });
    entries = appendFragment(entries, {
      phase: "monologue",
      speaker: "examiner",
      timestamp: 10_000,
      text: "Autrement dit : y perd-on des collègues ?",
      startsTurn: true,
    });

    assert.equal(entries.length, 2, "the nudge is not more of the question it rephrases");
    assert.equal(entries[1].timestamp, 10_000, "and it is stamped when it was said");
    assert.equal(
      Object.hasOwn(entries[1], "startsTurn"),
      false,
      "the flag is an instruction to appendFragment, not part of a graded transcript",
    );
  });

  it("keeps merging the rest of a turn that was told to start", () => {
    let entries = build({ text: "Première question.", speaker: "examiner" });
    for (const [index, text] of ["Autrement dit,", "y perd-on", "des collègues ?"].entries()) {
      entries = appendFragment(entries, {
        phase: "monologue",
        speaker: "examiner",
        timestamp: 10_000 + index,
        // Only the first fragment of the relance carries the break, which is
        // what the controller does: it clears the flag on the fragment that
        // spent it.
        text,
        startsTurn: index === 0,
      });
    }

    assert.equal(entries.length, 2);
    assert.equal(entries[1].text, "Autrement dit, y perd-on des collègues ?");
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
    // Numbered, not merely named (#173): the corrector's criteria descriptions
    // and its stage contract both pin a criterion to « la partie 1 » or « la
    // partie 2 », so the transcript has to number the halves the same way.
    assert.match(formatted, /^=== PARTIE 1 : MONOLOGUE SUIVI/);
    assert.ok(formatted.includes("=== PARTIE 2 : DÉBAT"));
    assert.ok(formatted.indexOf("PARTIE 1") < formatted.indexOf("PARTIE 2"));
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

  it("seeds a débat session with the monologue handover, then the exchange so far (#133)", () => {
    // What a reconnect that lost its resumption handle is seeded with: a fresh
    // session given the monologue alone believes the débat has not begun, and
    // its standing order is then to open it — again.
    const entries = build(
      { text: "Je défends le télétravail.", phase: "monologue", speaker: "candidate" },
      { text: "N'isole-t-il pas les salariés ?", phase: "debate", speaker: "examiner" },
      { text: "Cela dépend des métiers.", phase: "debate", speaker: "candidate" },
    );
    const history = debateSessionHistory(entries);

    assert.equal(history.length, 4);
    assert.deepEqual(
      history.slice(0, 2),
      monologueAsHistory(entries),
      "the handover comes first, unchanged",
    );
    assert.deepEqual(history[2], {
      role: "model",
      parts: [{ text: "N'isole-t-il pas les salariés ?" }],
    });
    assert.deepEqual(history[3], { role: "user", parts: [{ text: "Cela dépend des métiers." }] });
  });

  it("collapses to the plain monologue seed while the débat has not begun", () => {
    const entries = build({ text: "Je défends le télétravail." });
    assert.deepEqual(debateSessionHistory(entries), monologueAsHistory(entries));
    assert.deepEqual(debateSessionHistory([]), []);
  });
});
