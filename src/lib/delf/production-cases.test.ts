/**
 * The twelve cases #189 lists, held against the block that answers them.
 *
 * A prompt test can only assert that the corrector was TOLD something, never
 * that it obeyed — `pnpm verify:eval` is where obedience is measured, against
 * the real model. What this suite is for is the failure that costs nothing to
 * catch and everything to miss: a case quietly dropped from the block by a
 * later edit, leaving a rule nobody states and a corrector improvising over it
 * again.
 *
 * Each case names the row of the issue's table it covers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EVALUATION_RULES, ORAL_CRITERIA } from "./criteria";
import { PRODUCTION_CASES } from "./production-cases";

/** Case-insensitive and accent-tolerant enough to survive a re-wording. */
function says(...needles: string[]): boolean {
  return needles.every((needle) => PRODUCTION_CASES.toLowerCase().includes(needle.toLowerCase()));
}

describe("the behaviour cases the corrector is given", () => {
  it("1. no answer at all in the débat: interaction very low, possibly 0", () => {
    assert.ok(says("ne répond à aucune question", "interaction", "0"));
  });

  it("2. the candidate starts and then goes silent: score what came before", () => {
    assert.ok(says("puis se tait", "avant le silence"));
  });

  it("3. one very short answer: assess it, but the interaction stays very limited", () => {
    assert.ok(says("une seule réponse très brève", "pour ce qu'elle vaut", "très limitée"));
  });

  it("4. several very short answers: low interaction, other abilities still credited", () => {
    assert.ok(
      says(
        "plusieurs réponses très brèves",
        "conservent les points",
        "une prestation courte n'est pas une prestation faible sur tous les plans",
      ),
    );
  });

  it("5. answers without defending the position: charged to interaction", () => {
    assert.ok(says("sans défendre sa position", "faiblesse de « interaction »"));
  });

  it("6. off-topic answers: charged to the task, not to the language criteria", () => {
    assert.ok(
      says("hors sujet", "ne réalise pas la tâche", "sans rien retirer aux critères de langue"),
    );
  });

  it("7. heavy hesitation but an answer arrives: no automatic heavy penalty", () => {
    assert.ok(says("hésite beaucoup", "ne pénalisez pas lourdement de façon automatique"));
  });

  it("8. many grammar mistakes but the message passes: never an automatic 0", () => {
    assert.ok(says("morphosyntaxe", "ne mettez jamais 0 automatiquement"));
  });

  it("9. faulty pronunciation but the candidate is understood: judged on intelligibility", () => {
    assert.ok(says("intelligibilité", "ne valent pas 0"));
  });

  it("10. silence throughout: a very low or zero mark is the right answer", () => {
    assert.ok(says("silence complet sur toute l'épreuve", "très basse ou nulle"));
  });

  it("10b. and one empty part is NOT that case", () => {
    // A thin but real exposé plus four monosyllables of débat used to satisfy
    // the all-zero rule on a literal reading, and 0 on lexique and
    // morphosyntaxe for a monologue the corrector actually had is precisely the
    // automatic zero the issue forbids. `pnpm verify:eval` caught the corrector
    // doing it. This block now says which of the two cases it is.
    assert.ok(
      says(
        "dans AUCUNE des deux parties",
        "le seul qui autorise 0 partout",
        "une seule partie vide ne le déclenche PAS",
      ),
    );
  });

  it("10c. and the rules block it used to contradict now says the same thing", () => {
    // The fix the third review of #196 asked for, and the guard that makes it
    // stick. Scoping this block alone left two sentences in one prompt that
    // disagreed on a literal reading, with only the model's sense of
    // precedence between them — and a later edit to `EVALUATION_RULES` could
    // silently widen the gap again, where only a live-model run would notice.
    //
    // So `CAS LIMITE` is scoped at the source too, and the two are pinned
    // against each other here: the unit suite now fails on the contradiction
    // that previously cost an API call to find.
    assert.match(EVALUATION_RULES, /CAS LIMITE/);
    assert.match(
      EVALUATION_RULES,
      /dans AUCUNE des deux parties/,
      "the all-zero rule must name the whole sitting, not one part",
    );
    assert.match(
      EVALUATION_RULES,
      /Une seule partie vide ne suffit PAS/,
      "and must say so in the same breath",
    );
  });

  it("11. a technical incident: never the candidate's fault", () => {
    assert.ok(
      says("incident technique", "n'est jamais imputable au candidat", "aucun critère"),
      "the general rule; the per-sitting evidence is technical-incident-instruction.ts",
    );
  });

  it("12. a transcription failure is not proof of silence", () => {
    assert.ok(says("ne prouve pas que le candidat n'a rien dit"));
  });
});

describe("the rules that hold the whole block together", () => {
  it("forbids inventing what the candidate did not say", () => {
    // The failure mode a corrector reaches for when handed half a sitting:
    // filling the gap with the answer the question deserved.
    assert.ok(says("n'inventez jamais", "ne complétez pas"));
  });

  it("tells the corrector to grade the production, never the clock", () => {
    // Load-bearing, and not a restatement of the rubric: the duration penalty
    // is `orale-rubric.ts`'s and is charged from measured seconds. A corrector
    // that ALSO marked a band down for shortness would charge the same four
    // minutes twice, once in a band and once in the total.
    assert.ok(says("la durée ne se note pas en elle-même", "ne retirez pas de points pour la"));
  });

  it("keeps the credit a brief but capable performance earned", () => {
    assert.ok(says("une prestation brève qui démontre une réelle maîtrise en garde le crédit"));
  });

  it("still penalises a long performance that is empty", () => {
    assert.ok(says("longue mais répétitive, hors sujet ou non argumentée est pénalisée"));
  });
});

describe("what the block must never contain", () => {
  it("states no arithmetic: no total, no penalty, no threshold in minutes", () => {
    // #9's standing rule. The sum, the tiers, the halving, the phonologie
    // ceiling and the competency floor are all computed from what the model
    // returns; a paragraph restating any of them would be a second
    // implementation of the rubric, written in French and untestable.
    for (const forbidden of [
      "/25",
      "sur 25",
      "pénalité",
      "minutes",
      "secondes",
      "divisée par deux",
      "moitié",
    ]) {
      assert.ok(
        !PRODUCTION_CASES.toLowerCase().includes(forbidden),
        `the block does arithmetic: « ${forbidden} »`,
      );
    }
  });

  it("names no sujet, no question and no expected answer", () => {
    // #189: « Keep everything generic for all DELF B2 subjects. » The same
    // block is rendered for every document in `topics.ts` and for any added
    // later, so anything specific in it would be marking one sitting's
    // conformity to another's content.
    for (const forbidden of ["télétravail", "document déclencheur :", "par exemple, le sujet"]) {
      assert.ok(!PRODUCTION_CASES.toLowerCase().includes(forbidden), forbidden);
    }
  });

  it("addresses criteria only by their schema keys", () => {
    // A case that says « baissez l'interaction » in prose and nothing else
    // leaves the model to guess which output field that is. Every criterion the
    // block charges is named as the key the response schema requires.
    for (const criterion of ["realisationTache", "interaction"] as const) {
      assert.ok(PRODUCTION_CASES.includes(criterion), `${criterion} is not named by its key`);
      assert.ok((ORAL_CRITERIA as readonly string[]).includes(criterion));
    }
  });

  it("uses no em dash, as the house style requires", () => {
    // `STYLE_RULE` forbids them in what the candidate reads; this block is not
    // read by the candidate, but a corrector shown one in an instruction copies
    // it into the justifications that are.
    assert.ok(!PRODUCTION_CASES.includes("—"));
    assert.ok(!PRODUCTION_CASES.includes("–"));
  });
});
