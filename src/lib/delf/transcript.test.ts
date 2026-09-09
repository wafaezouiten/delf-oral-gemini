import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  closingInstruction,
  lastQuestionInstruction,
  presenceCheckInstruction,
  resumeAfterReconnectInstruction,
  resumeDebateInstruction,
  silenceRelanceInstruction,
  timeRemainingInstruction,
} from "./examiner-prompt";
import {
  appendFragment,
  candidateSpeech,
  candidateWordCount,
  debateSessionHistory,
  entriesForPhase,
  formatTranscript,
  isPresenceCheck,
  monologueAsHistory,
  replaceCandidateSpeech,
  separateDirectiveEcho,
  stripDirectiveEchoes,
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

  it("ignores a fragment that repeats the whole turn so far, word for word (#186)", () => {
    // A reconnect replays the audio held during the outage into the new socket,
    // which transcribes it again: the same answer arrived twice and the
    // corrector graded the candidate for repeating themself.
    const answer = "Je suis d'accord, un déjeuner de temps en temps ne remplace pas les échanges.";
    const entries = build({ text: answer }, { text: ` ${answer}` });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, answer);
  });

  it("still lets a candidate restart a sentence (#186)", () => {
    // Exact and whole is the rule: three repeated words are a false start,
    // which is graded fluency, and stay.
    const entries = build({ text: "Je pense que" }, { text: " je pense que c'est un choix." });
    assert.equal(entries[0].text, "Je pense que je pense que c'est un choix.");
  });

  it("keeps a short turn said twice, which is a person and not a replay (#186)", () => {
    // « Au revoir. » twice is the examiner insisting, and #85 counts every one.
    const entries = build(
      { text: "Au revoir.", speaker: "examiner" },
      { text: " Au revoir.", speaker: "examiner" },
    );
    assert.equal(entries[0].text, "Au revoir. Au revoir.");
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

describe("a directive the examiner read aloud (#187)", () => {
  /** Every bracketed paragraph the app can send the examiner mid-épreuve. */
  const DIRECTIVES = [
    closingInstruction("monologue"),
    closingInstruction("debate"),
    silenceRelanceInstruction(),
    silenceRelanceInstruction(2),
    silenceRelanceInstruction(1, true),
    presenceCheckInstruction(),
    timeRemainingInstruction(7),
    lastQuestionInstruction(),
    resumeDebateInstruction(7),
    resumeDebateInstruction(1, true),
    resumeAfterReconnectInstruction(),
    resumeAfterReconnectInstruction(true),
  ];

  it("keeps only what was spoken, for every directive the app can send", () => {
    // The observed shape: the directive, verbatim, then the line it ordered.
    for (const directive of DIRECTIVES) {
      const { spoken, held } = separateDirectiveEcho(
        `${directive}\n\nJe vous remercie, nous avons terminé.`,
      );
      assert.equal(spoken.trim(), "Je vous remercie, nous avons terminé.", directive.slice(0, 40));
      assert.equal(held, "");
    }
  });

  it("holds back a bracket that has not closed yet, and only that", () => {
    // Transcription arrives in fragments, and the closing bracket is routinely
    // in a later one than the opening. The opener must neither leak nor be
    // dropped: dropped, the rest of the span arrives bracket-less and leaks.
    const first = separateDirectiveEcho("[Information de service, à ne");
    assert.equal(first.spoken, "");
    assert.equal(first.held, "[Information de service, à ne");

    const second = separateDirectiveEcho(`${first.held} jamais prononcer : conclus.] Merci.`);
    assert.equal(second.spoken, " Merci.");
    assert.equal(second.held, "");
  });

  it("leaves ordinary speech, and speech before the bracket, alone", () => {
    const { spoken, held } = separateDirectiveEcho("Vous parlez d'organisation, mais [Erreur :");
    assert.equal(spoken, "Vous parlez d'organisation, mais ");
    assert.equal(held, "[Erreur :");
    assert.deepEqual(separateDirectiveEcho("Ne pensez-vous pas ?"), {
      spoken: "Ne pensez-vous pas ?",
      held: "",
    });
  });

  it("scrubs a stored transcript's examiner turns and drops the ones that were only the echo", () => {
    const stored: TranscriptEntry[] = [
      { phase: "debate", speaker: "candidate", timestamp: 1, text: "Je pense [sic] que oui." },
      {
        phase: "debate",
        speaker: "examiner",
        timestamp: 2,
        text: `${closingInstruction("debate")}\n\nJe vous remercie, nous avons terminé.`,
      },
      { phase: "debate", speaker: "examiner", timestamp: 3, text: timeRemainingInstruction(4) },
      { phase: "debate", speaker: "examiner", timestamp: 4, text: "Une dernière question ?" },
    ];
    const clean = stripDirectiveEchoes(stored);
    assert.deepEqual(
      clean.map((entry) => entry.text),
      [
        "Je pense [sic] que oui.",
        "Je vous remercie, nous avons terminé.",
        "Une dernière question ?",
      ],
    );
    // The bracket rule is about what the app says; the candidate is untouched.
    assert.equal(clean[0], stored[0]);
    // Timestamps survive the scrub: the correction re-anchors on them.
    assert.equal(clean[1].timestamp, 2);
  });

  it("never reaches the corrector, nor a fresh session's seed", () => {
    const entries: TranscriptEntry[] = [
      { phase: "monologue", speaker: "candidate", timestamp: 1, text: "Mon exposé." },
      {
        phase: "debate",
        speaker: "examiner",
        timestamp: 2,
        text: `${closingInstruction("debate")}\n\nJe vous remercie, nous avons terminé.`,
      },
    ];
    const formatted = formatTranscript(entries);
    assert.ok(!formatted.includes("["), formatted);
    assert.ok(formatted.includes("EXAMINATEUR: Je vous remercie, nous avons terminé."));

    const seed = debateSessionHistory(entries);
    const model = seed.filter((turn) => turn.role === "model").map((turn) => turn.parts[0].text);
    assert.ok(model.includes("Je vous remercie, nous avons terminé."));
    assert.ok(!model.some((text) => text.includes("[")), "the directive is not history");
  });
});

describe("the app's presence check in the corrector's transcript (#187)", () => {
  it("recognises « Vous m'entendez » as Gemini renders it, and nothing near it", () => {
    assert.ok(isPresenceCheck("Vous m'entendez ?"));
    assert.ok(isPresenceCheck("Vous m'entendez"), "the question mark is dropped half the time");
    assert.ok(isPresenceCheck("Vous m\u2019entendez ?"), "typographic apostrophe");
    assert.ok(!isPresenceCheck("Vous m'entendez dire que le télétravail isole ?"));
    assert.ok(!isPresenceCheck("Est-ce que vous m'entendez ?"));
  });

  it("labels it as the app's technical check, not as an examiner question", () => {
    const entries: TranscriptEntry[] = [
      { phase: "debate", speaker: "examiner", timestamp: 1, text: "Ne pensez-vous pas ?" },
      { phase: "debate", speaker: "examiner", timestamp: 2, text: "Vous m'entendez" },
      { phase: "debate", speaker: "candidate", timestamp: 3, text: "Oui, je pense que non." },
    ];
    const formatted = formatTranscript(entries);
    assert.ok(formatted.includes("EXAMINATEUR: Ne pensez-vous pas ?"));
    assert.ok(
      formatted.includes(
        "LOGICIEL (vérification technique de la connexion, hors épreuve, à ne pas évaluer): Vous m'entendez",
      ),
      formatted,
    );
    assert.ok(!formatted.includes("EXAMINATEUR: Vous m'entendez"));
    // A candidate's « vous m'entendez » is theirs and stays theirs.
    const candidate = formatTranscript([
      { phase: "debate", speaker: "candidate", timestamp: 1, text: "Vous m'entendez ?" },
    ]);
    assert.ok(candidate.includes("CANDIDAT: Vous m'entendez ?"));
  });
});

describe("replaceCandidateSpeech", () => {
  const sitting: TranscriptEntry[] = [
    { phase: "monologue", speaker: "candidate", timestamp: 1000, text: "Je vais vous parler" },
    { phase: "monologue", speaker: "candidate", timestamp: 2000, text: "du télétravail." },
    { phase: "monologue", speaker: "examiner", timestamp: 9000, text: "Je vous remercie." },
    { phase: "debate", speaker: "examiner", timestamp: 10_000, text: "Vous avez dit que…" },
    { phase: "debate", speaker: "candidate", timestamp: 11_000, text: "Oui, et je maintiens." },
  ];

  it("puts the part's candidate speech back as one turn", () => {
    const out = replaceCandidateSpeech(sitting, "monologue", "L'exposé entier.", 1000);
    const monologue = entriesForPhase(out, "monologue");
    assert.deepEqual(
      monologue.map((e) => `${e.speaker}: ${e.text}`),
      ["candidate: L'exposé entier.", "examiner: Je vous remercie."],
    );
  });

  it("leads the part, because that is where an exposé is spoken", () => {
    const out = replaceCandidateSpeech(sitting, "monologue", "L'exposé entier.", 1000);
    assert.equal(out[0].text, "L'exposé entier.");
    assert.equal(out[0].timestamp, 1000);
  });

  it("does not double the words it replaces", () => {
    const out = replaceCandidateSpeech(sitting, "monologue", "Je vais vous parler", 1000);
    assert.equal(candidateWordCount(out, "monologue"), 4);
  });

  it("leaves the other part alone", () => {
    const out = replaceCandidateSpeech(sitting, "monologue", "L'exposé entier.", 1000);
    assert.deepEqual(entriesForPhase(out, "debate"), entriesForPhase(sitting, "debate"));
  });

  it("writes a part that had no turns at all", () => {
    const debateOnly: TranscriptEntry[] = [
      { phase: "debate", speaker: "examiner", timestamp: 10_000, text: "Vous avez dit que…" },
    ];
    const out = replaceCandidateSpeech(debateOnly, "monologue", "L'exposé entier.", 500);
    assert.equal(out.length, 2);
    assert.equal(out[0].phase, "monologue");
    assert.equal(out[1].phase, "debate");
  });

  it("erases nothing when the transcription came back empty", () => {
    assert.deepEqual(replaceCandidateSpeech(sitting, "monologue", "   ", 1000), sitting);
  });
});
