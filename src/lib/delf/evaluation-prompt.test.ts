import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BAND_SCALE,
  COMPLETE_STAGE_DIRECTIVE,
  EVALUATION_RULES,
  ORAL_CRITERIA,
  STYLE_RULE,
} from "./criteria";
import { PRODUCTION_CASES } from "./production-cases";
import { buildEvaluationPrompt } from "./evaluation-prompt";
import { ORAL_TOPICS } from "./topics";
import type { TranscriptEntry } from "./transcript";

const TOPIC = ORAL_TOPICS[0];

const TRANSCRIPT: TranscriptEntry[] = [
  {
    phase: "monologue",
    speaker: "candidate",
    timestamp: 1_000,
    text: "Le télétravail a libéré du temps, mais il isole les plus jeunes.",
  },
  {
    phase: "debate",
    speaker: "examiner",
    timestamp: 400_000,
    text: "Vous dites qu'il isole. Ne peut-on pas y voir un choix personnel ?",
  },
  {
    phase: "debate",
    speaker: "candidate",
    timestamp: 410_000,
    text: "C'est un choix, oui, mais il se prend dans un cadre que l'entreprise fixe.",
  },
];

function prompt(overrides: Partial<Parameters<typeof buildEvaluationPrompt>[0]> = {}) {
  return buildEvaluationPrompt({
    topic: TOPIC,
    transcript: TRANSCRIPT,
    monologueSeconds: 402,
    debateSeconds: 738,
    ...overrides,
  });
}

describe("the corrector's prompt", () => {
  it("opens on the official grille, out of 25", () => {
    assert.match(prompt(), /^Vous êtes un correcteur officiel du DELF B2 \(production orale\)/);
    assert.match(prompt(), /France Éducation international.*notée sur 25 points/);
  });

  it("carries every ported block, in the main project's order", () => {
    // The order is the reference template's: attendus, partie évaluée, échelle,
    // critères, style, règles, cas particuliers (#189, this project's own),
    // appréciation and conseil, durée, transcription, contrat de réponse —
    // then the directives. Asserted as positions rather
    // than as presence, because a block that has moved above the transcript is
    // still present and no longer read the same way.
    const text = prompt();
    const at = (needle: string) => {
      const index = text.indexOf(needle);
      assert.notEqual(index, -1, `missing from the prompt: ${needle}`);
      return index;
    };

    const positions = [
      at("Niveau B2 (utilisateur indépendant"),
      at("PARTIE ÉVALUÉE :"),
      at(BAND_SCALE),
      at("CRITÈRES DE LA GRILLE À NOTER"),
      at(STYLE_RULE),
      at(EVALUATION_RULES),
      at(PRODUCTION_CASES),
      at("APPRÉCIATION GLOBALE"),
      at("Durée de production du candidat"),
      at("Transcript :"),
      at("Répondez avec :"),
      at(COMPLETE_STAGE_DIRECTIVE),
    ];
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
    );
  });

  it("lists all five criteria under their schema keys", () => {
    const text = prompt();
    assert.match(text, /LES 5 CRITÈRES DE LA GRILLE À NOTER/);
    ORAL_CRITERIA.forEach((key, index) => {
      assert.ok(text.includes(`${index + 1}. ${key} - `), `criterion ${key} is not listed`);
    });
  });

  it("hands the corrector the document the candidate prepared against", () => {
    // « dégage clairement une problématique à partir du document » cannot be
    // judged by a corrector that has not seen the document.
    assert.ok(prompt().includes(TOPIC.document));
    assert.ok(prompt().includes(TOPIC.title));
  });

  it("never tells the corrector what the candidate was supposed to say", () => {
    // The candidate's consigne is an instruction to the candidate, not a model
    // answer, and it is the closest thing this project has to one. A corrector
    // handed it starts marking conformity to an expected answer instead of the
    // performance in front of it, which is exactly what the grille forbids.
    assert.ok(!prompt().includes(TOPIC.consigne));
    assert.match(prompt(), /Évaluez la MANIÈRE de s'exprimer, JAMAIS l'opinion défendue/);
  });

  it("gives both parts' measured durations, and their total", () => {
    // Context only, so a thin monologue reads as thin rather than as a bad one.
    assert.match(prompt(), /Durée de production du candidat : 1140 secondes/);
    assert.match(prompt(), /monologue suivi : 402 s ; débat : 738 s/);
  });

  it("prints the transcript under its two numbered part headings", () => {
    const text = prompt();
    assert.ok(text.includes("=== PARTIE 1 : MONOLOGUE SUIVI"));
    assert.ok(text.includes("=== PARTIE 2 : DÉBAT"));
    assert.ok(text.includes("CANDIDAT: Le télétravail a libéré du temps"));
    assert.ok(text.includes("EXAMINATEUR: Vous dites qu'il isole."));
  });

  it("says so rather than showing an empty block when nothing was said", () => {
    assert.ok(prompt({ transcript: [] }).includes("(aucune production)"));
  });

  it("asks for exactly the fields the response schema requires", () => {
    const text = prompt();
    for (const field of [
      "total25",
      "phonologieNonEvaluable",
      "appreciationGlobale",
      "pointsForts",
      "axesPrioritaires",
      "conseil",
    ]) {
      assert.ok(text.includes(field), `the response contract does not mention ${field}`);
    }
  });
});

describe("the directives appended after the contract", () => {
  const PHONOLOGY = "PHONOLOGIE : vous disposez de l'ENREGISTREMENT AUDIO réel du candidat.";
  const INCIDENT = "INCIDENT PENDANT LE DEBAT : l'examinateur a annoncé À TORT la fin.";

  it("come last, after the transcript and after the stage contract", () => {
    // Position is the whole point: these are the paragraphs that describe what
    // this particular sitting was, and the reference appends its own the same
    // way so nothing above can talk them down.
    const text = prompt({ directives: [PHONOLOGY, INCIDENT] });
    assert.ok(text.indexOf("Transcript :") < text.indexOf(COMPLETE_STAGE_DIRECTIVE));
    assert.ok(text.indexOf(COMPLETE_STAGE_DIRECTIVE) < text.indexOf(PHONOLOGY));
    assert.ok(text.indexOf(PHONOLOGY) < text.indexOf(INCIDENT));
    assert.ok(text.endsWith(INCIDENT));
  });

  it("drop the empty ones instead of leaving a hole", () => {
    // An ordinary sitting has no incident to report, and `earlyClosingInstruction`
    // returns "" for it. Joining unconditionally would leave a stray blank
    // paragraph at the end of every prompt that never had one.
    const ordinary = prompt({ directives: [PHONOLOGY, ""] });
    assert.ok(ordinary.endsWith(PHONOLOGY));
    assert.ok(!ordinary.includes("\n\n\n"));
  });

  it("leave an ordinary sitting ending on the contract", () => {
    assert.ok(prompt().endsWith(COMPLETE_STAGE_DIRECTIVE));
  });
});
