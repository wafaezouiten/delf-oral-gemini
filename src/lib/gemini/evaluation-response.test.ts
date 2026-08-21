import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ORAL_CRITERIA } from "@/lib/delf/criteria";
import { scoreSitting } from "@/lib/delf/orale-rubric";
import {
  criterionJustifications,
  criterionScores,
  parseEvaluationResponse,
} from "./evaluation-response";

/**
 * What the corrector is allowed to return.
 *
 * The failure this exists to prevent is specific and was live until #9: the
 * evaluator read scores with `Number(entry?.score ?? 0)`, so a reply missing one
 * criterion scored it zero and graded the candidate anyway. Every test here is a
 * shape a language model actually produces when something goes wrong —
 * truncated, refused, renamed, out of range — and the question each asks is
 * whether it fails loudly or quietly costs someone five points.
 */

/** A complete, well-formed correction. */
function reply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    realisationTache: { score: 5, justification: "position claire" },
    interaction: { score: 3, justification: "défend sa position" },
    lexique: { score: 3, justification: "vocabulaire suffisant" },
    morphosyntaxe: { score: 1, justification: "accords fautifs" },
    phonologie: { score: 3, justification: "intelligible" },
    total25: 15,
    phonologieNonEvaluable: false,
    appreciationGlobale: "prestation honnête",
    pointsForts: ["structure"],
    axesPrioritaires: ["accords"],
    conseil: "relisez les accords",
    ...overrides,
  });
}

describe("a correction that can be trusted", () => {
  it("comes back with all five scores and their justifications", () => {
    const parsed = parseEvaluationResponse(reply());

    assert.deepEqual(criterionScores(parsed), {
      realisationTache: 5,
      interaction: 3,
      lexique: 3,
      morphosyntaxe: 1,
      phonologie: 3,
    });
    assert.equal(criterionJustifications(parsed).morphosyntaxe, "accords fautifs");
    assert.equal(parsed.total25, 15);
  });

  it("keeps a 2 or a 4 for the rubric to snap rather than refusing it", () => {
    // The prompt forbids them and `snapToBand` is the net underneath. Failing
    // the whole sitting over a band the rubric knows how to read would throw
    // away a correction for nothing.
    const parsed = parseEvaluationResponse(reply({ lexique: { score: 4, justification: "…" } }));

    assert.equal(criterionScores(parsed).lexique, 4);
    assert.equal(
      scoreSitting(criterionScores(parsed), {
        monologueSeconds: 400,
        debateSeconds: 700,
        monologueWords: 400,
        debateWords: 300,
        phonologyHeard: true,
        examinerClosedEarly: false,
      }).criteria.lexique,
      3,
    );
  });

  it("accepts an empty justification, which is a weak correction and not a broken one", () => {
    const parsed = parseEvaluationResponse(reply({ phonologie: { score: 0, justification: "" } }));

    assert.equal(criterionJustifications(parsed).phonologie, "");
  });

  it("does not care what the model's own total says", () => {
    // Kept for comparison and never used as the mark, so a model that adds up
    // wrong is a fact to notice rather than a correction to reject.
    const parsed = parseEvaluationResponse(reply({ total25: 99 }));

    assert.equal(parsed.total25, 99);
  });
});

describe("a correction that must not be trusted", () => {
  const rejected = (text: string, why: RegExp) =>
    assert.throws(() => parseEvaluationResponse(text), why);

  it("refuses a reply that is missing a criterion", () => {
    // The exact bug: this used to score phonologie 0 and hand back a mark.
    const complete = JSON.parse(reply()) as Record<string, unknown>;
    delete complete.phonologie;
    rejected(JSON.stringify(complete), /phonologie/);
  });

  for (const criterion of ORAL_CRITERIA) {
    it(`refuses a reply whose ${criterion} has no score`, () => {
      rejected(reply({ [criterion]: { justification: "no number" } }), new RegExp(criterion));
    });
  }

  it("refuses a score outside anything the grille could mean", () => {
    rejected(reply({ interaction: { score: 7, justification: "…" } }), /interaction/);
    rejected(reply({ interaction: { score: -1, justification: "…" } }), /interaction/);
  });

  it("refuses a score that is not a number", () => {
    rejected(reply({ lexique: { score: "trois", justification: "…" } }), /lexique/);
    rejected(reply({ lexique: { score: null, justification: "…" } }), /lexique/);
  });

  it("refuses a truncated generation", () => {
    rejected(reply().slice(0, 120), /invalid JSON/);
  });

  it("refuses prose where a correction was asked for", () => {
    // What a refusal looks like: a perfectly valid sentence, and no grade in it.
    rejected("Je ne peux pas évaluer cet enregistrement.", /invalid JSON/);
  });

  it("refuses an empty object", () => {
    rejected("{}", /realisationTache/);
  });

  it("says what was wrong and what arrived", () => {
    // Both questions a failed run asks. The reply is trimmed, not dumped.
    let error: Error | null = null;
    try {
      parseEvaluationResponse(reply({ morphosyntaxe: { score: 42, justification: "x" } }));
    } catch (thrown) {
      error = thrown as Error;
    }

    assert.ok(error, "it threw");
    assert.match(error.message, /morphosyntaxe/);
    assert.match(error.message, /realisationTache/, "a slice of the reply itself");
    assert.ok(error.message.length < 400, `the message is ${error.message.length} chars`);
  });
});
