import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  B2_EXPECTATION,
  BAND_SCALE,
  COMPLETE_STAGE_DIRECTIVE,
  EVALUATION_RULES,
  ORAL_CRITERIA,
  ORAL_CRITERIA_COMPETENCE,
  ORAL_CRITERIA_DESCRIPTIONS,
  ORAL_CRITERIA_LABELS,
  ORAL_CRITERIA_SUMMARIES,
  SITTING_FOCUS,
  SITTING_TASK_LABELS,
  STYLE_RULE,
  promptCriterionLabel,
  renderOralCriteriaList,
} from "./criteria";
import { GRILLE_BANDS } from "./grille";

/**
 * Parity with the main project (`delf-preps@5170f0dd`,
 * `src/lib/prompts/orale/index.ts`).
 *
 * These assertions are not style checks. Every one of them names a sentence the
 * reference corrector is given and this one therefore has to be given too: which
 * five criteria exist, what each of them is told to look at, which four numbers
 * may be returned, and which halves of the épreuve each pragmatic criterion may
 * read. A correction produced without one of them is not comparable with a
 * correction produced by the main project, which is the whole point of the port
 * (#173).
 *
 * The reference itself cannot be imported — it is a separate repository — so
 * parity is asserted against its text, quoted. A change on that side shows up
 * here as a test that still passes while the reference has moved, which is why
 * the port note in `criteria.ts` pins the exact commit it was taken from.
 */

const ALL_BLOCKS = [
  B2_EXPECTATION,
  SITTING_FOCUS,
  BAND_SCALE,
  STYLE_RULE,
  EVALUATION_RULES,
  COMPLETE_STAGE_DIRECTIVE,
  renderOralCriteriaList(),
].join("\n\n");

describe("the five DELF criteria", () => {
  it("are the official five, in the grille's order", () => {
    assert.deepEqual(
      [...ORAL_CRITERIA],
      ["realisationTache", "interaction", "lexique", "morphosyntaxe", "phonologie"],
    );
  });

  it("split two/three across the grille's two compétences", () => {
    // The grid groups them; the results page prints one heading per group, and
    // grouping them any other way would print a competence the grid does not
    // have.
    const pragmatic = ORAL_CRITERIA.filter((key) =>
      ORAL_CRITERIA_COMPETENCE[key].startsWith("Compétence pragmatique"),
    );
    const linguistic = ORAL_CRITERIA.filter(
      (key) => ORAL_CRITERIA_COMPETENCE[key] === "Compétence linguistique",
    );
    assert.deepEqual(pragmatic, ["realisationTache", "interaction"]);
    assert.deepEqual(linguistic, ["lexique", "morphosyntaxe", "phonologie"]);
  });

  it("name phonologie as the grid names it, in full", () => {
    // « Maîtrise phonologique » was this repo's shortening. The reference spells
    // it out, and a criterion heading that does not match the grid the candidate
    // is marked against is a small lie on the results page.
    assert.equal(ORAL_CRITERIA_LABELS.phonologie, "Maîtrise du système phonologique");
  });

  it("name the two pragmatic criteria per part in the prompt, per criterion in the UI", () => {
    // The grid has two « réalisation de la tâche » lines on a two-part sitting.
    // The prompt uses them, because that is where the distinction decides a
    // band; the results page keeps the short headings, which are what fits a row.
    assert.equal(promptCriterionLabel("realisationTache"), SITTING_TASK_LABELS.realisationTache);
    assert.equal(promptCriterionLabel("interaction"), SITTING_TASK_LABELS.interaction);
    assert.match(SITTING_TASK_LABELS.realisationTache, /monologue suivi/);
    assert.match(SITTING_TASK_LABELS.interaction, /exercice en interaction/);
    assert.equal(promptCriterionLabel("lexique"), ORAL_CRITERIA_LABELS.lexique);
  });
});

describe("what each criterion is told to read", () => {
  it("pins réalisation de la tâche to part 1 and interaction to part 2", () => {
    // The one instruction a corrector grading both halves at once cannot do
    // without: a candidate who argues well alone and folds under contradiction
    // is a real profile, and a corrector not told where to look grades both
    // pragmatic criteria off whichever half it read last.
    assert.match(ORAL_CRITERIA_DESCRIPTIONS.realisationTache, /^PARTIE 1 \(monologue suivi\)/);
    assert.match(ORAL_CRITERIA_DESCRIPTIONS.realisationTache, /jamais le débat/);
    assert.match(ORAL_CRITERIA_DESCRIPTIONS.interaction, /^PARTIE 2 \(débat\)/);
    assert.match(ORAL_CRITERIA_DESCRIPTIONS.interaction, /jamais l'exposé/);
  });

  it("treats an argued concession as a valid B2 reaction, not an abandonment", () => {
    // FEI's own parenthesis: « défendre sa position (ou faire des concessions,
    // rectifier…) ». Only unargued capitulation is a weakness, and the previous
    // wording here read every concession as one.
    assert.match(ORAL_CRITERIA_DESCRIPTIONS.interaction, /une concession argumentée/);
    assert.match(ORAL_CRITERIA_DESCRIPTIONS.interaction, /l'abandon pur et simple/);
  });

  it("does not ask for a formal introduction the grille does not expect", () => {
    assert.match(ORAL_CRITERIA_DESCRIPTIONS.realisationTache, /N'EXIGEZ PAS une introduction/);
  });

  it("does not charge the candidate for the sujet's own key words", () => {
    assert.match(ORAL_CRITERIA_DESCRIPTIONS.lexique, /NE PÉNALISEZ PAS les répétitions/);
  });

  it("credits a successful self-correction on morphosyntaxe", () => {
    assert.match(ORAL_CRITERIA_DESCRIPTIONS.morphosyntaxe, /S'AUTOCORRIGER/);
  });

  it("renders one numbered line per criterion, keyed to the response schema", () => {
    const lines = renderOralCriteriaList().split("\n");
    assert.equal(lines.length, ORAL_CRITERIA.length);
    ORAL_CRITERIA.forEach((key, index) => {
      // « N. <schemaKey> - <Name> (<tag>) : <desc> ». The schema key is what
      // stops a carefully argued band arriving under the wrong field.
      assert.ok(lines[index].startsWith(`${index + 1}. ${key} - ${promptCriterionLabel(key)} (`));
      assert.ok(lines[index].includes(ORAL_CRITERIA_DESCRIPTIONS[key]));
    });
  });
});

describe("the band scale", () => {
  it("offers exactly the four legal bands and forbids the two illegal ones", () => {
    for (const band of GRILLE_BANDS) assert.ok(BAND_SCALE.includes(String(band)));
    assert.match(BAND_SCALE, /N'utilisez JAMAIS 2 ni 4/);
  });

  it("defines each band as a level, not as a number", () => {
    assert.match(BAND_SCALE, /0 = Non répondu ou production insuffisante/);
    assert.match(BAND_SCALE, /1 = En dessous du niveau ciblé/);
    assert.match(BAND_SCALE, /3 = Au niveau ciblé :/);
    assert.match(BAND_SCALE, /5 = Au niveau ciblé \+/);
  });

  it("carries the reference's use-the-whole-scale instruction", () => {
    // This replaces the `SCALE_USE` block that used to live in `evaluate.ts`.
    // Without an instruction of this kind the corrector puts 3 on everything and
    // stops telling a good candidate from a weak one (docs/EVALUATION_FINDINGS.md).
    assert.match(BAND_SCALE, /UTILISEZ TOUTE L'ÉCHELLE/);
    assert.match(BAND_SCALE, /n'attribuez pas 3 par défaut/);
    // And a C1-grade performance is still a 5: the top band is « au niveau
    // ciblé + », not « au niveau supérieur », so waiting for C1 before awarding
    // it pushes the whole scale down by a band.
    assert.match(BAND_SCALE, /n'attendez PAS un niveau C1 pour l'accorder/);
  });
});

describe("the evaluation rules", () => {
  it("grade the candidate's lines only", () => {
    assert.match(EVALUATION_RULES, /Seules les répliques préfixées « CANDIDAT: » sont notées/);
    assert.match(EVALUATION_RULES, /ne notez JAMAIS le vocabulaire, les idées ou les structures/);
  });

  it("grade the manner, never the opinion", () => {
    // The acceptance criterion in prose: the corrector marks the performance it
    // was given, not the candidate's conformity to an expected answer.
    assert.match(EVALUATION_RULES, /Évaluez la MANIÈRE de s'exprimer, JAMAIS l'opinion défendue/);
  });

  it("do not charge the candidate for an examiner who did not question them", () => {
    assert.match(EVALUATION_RULES, /ÉQUITÉ ENVERS LE CANDIDAT/);
    assert.match(EVALUATION_RULES, /ne pénalisez PAS le candidat pour un échange/);
  });

  it("do not count one self-correction twice against the candidate", () => {
    assert.match(EVALUATION_RULES, /AUTOCORRECTIONS/);
    assert.match(EVALUATION_RULES, /Ne comptez donc pas la même autocorrection deux fois/);
  });

  it("zero everything when there is nothing evaluable, rather than guess", () => {
    assert.match(EVALUATION_RULES, /mettez 0 à TOUS les critères/);
  });

  it("require every justification to quote the transcript", () => {
    assert.match(EVALUATION_RULES, /FONDÉE SUR LA TRANSCRIPTION/);
  });

  it("omit the reference's transcript-only phonologie bullet", () => {
    // The audit's one deliberate break, unchanged since the first port. That
    // bullet tells the model to infer fluency from filler counts BECAUSE the
    // incumbent's corrector has no audio; this project's justification is real
    // audio, and `gemini/phonology-instruction.ts` replaces the evidence the
    // criterion reasons from without touching the criterion itself.
    assert.ok(!EVALUATION_RULES.includes("PHONOLOGIE À PARTIR D'UN TEXTE"));
  });
});

describe("the complete-sitting contract", () => {
  it("grades the monologue and the débat as one production out of 25", () => {
    assert.match(COMPLETE_STAGE_DIRECTIVE, /La transcription couvre les DEUX parties/);
    assert.match(COMPLETE_STAGE_DIRECTIVE, /Notez les cinq critères sur 25 points au total/);
  });

  it("says which criterion reads which half, and which read both", () => {
    assert.match(COMPLETE_STAGE_DIRECTIVE, /« realisationTache » évalue UNIQUEMENT la partie 1/);
    assert.match(COMPLETE_STAGE_DIRECTIVE, /« interaction » évalue UNIQUEMENT la partie 2/);
    assert.match(COMPLETE_STAGE_DIRECTIVE, /évaluent les DEUX parties ensemble/);
  });

  it("outranks everything above it", () => {
    assert.match(COMPLETE_STAGE_DIRECTIVE, /PRIORITAIRE SUR TOUTE CONSIGNE CI-DESSUS/);
  });

  it("describes the same épreuve the focus block describes", () => {
    assert.match(SITTING_FOCUS, /épreuve complète en deux parties sur le même document/);
    assert.match(SITTING_FOCUS, /chacun ne porte QUE sur sa partie/);
    assert.match(B2_EXPECTATION, /^Niveau B2/);
  });
});

describe("what the ported blocks must never contain", () => {
  it("state no arithmetic about the mark", () => {
    // The sum, the duration penalty, the absent-part halving and the competency
    // floor are `orale-rubric.ts`'s, in the order it defines. A prompt that also
    // stated them would be a second rubric, written in French, unversioned and
    // untestable (#9). The one number the corrector is given is the sum rule,
    // which is the definition of `total25`, not a calculation over it.
    for (const forbidden of [/pénalité/i, /soustray/i, /retranch/i, /divisez/i, /la moitié/i]) {
      assert.ok(!forbidden.test(ALL_BLOCKS), `${forbidden} must not appear in the prompt blocks`);
    }
    assert.match(EVALUATION_RULES, /total25 est EXACTEMENT la somme des cinq notes/);
  });

  it("hold the house style on dashes", () => {
    assert.match(STYLE_RULE, /n'utilisez jamais de tiret cadratin/);
  });
});

describe("the candidate-facing summaries", () => {
  it("cover all five criteria", () => {
    for (const key of ORAL_CRITERIA) assert.ok(ORAL_CRITERIA_SUMMARIES[key].length > 0);
  });

  it("never hand the candidate the corrector's imperative mood", () => {
    // The reference's UI reads only the label and the compétence off its
    // criteria, so its descriptions are free to shout at a corrector. Ours are
    // printed under a criterion row on the results page, and « NE PÉNALISEZ PAS
    // les répétitions » read by a candidate is the marking scheme's instructions
    // masquerading as advice.
    for (const key of ORAL_CRITERIA) {
      const summary = ORAL_CRITERIA_SUMMARIES[key];
      for (const shouted of [/NE PÉNALISEZ/, /N'EXIGEZ/, /N'évaluez/, /PARTIE [12]/]) {
        assert.ok(!shouted.test(summary), `${key} summary must not read as a corrector directive`);
      }
    }
  });
});
