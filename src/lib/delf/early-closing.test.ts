import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { countClosingTurns, readsAsClosing, resolveEarlyClosingCount } from "./early-closing";
import type { TranscriptEntry } from "./transcript";

describe("hearing an examiner say goodbye seven minutes early (#85)", () => {
  it("recognises the sitting that produced the issue", () => {
    // Verbatim from #85's transcript. Two failures in one turn: a third part of
    // an épreuve that has two, and a candidate dismissed into it at 6:00 of
    // 13:00.
    assert.ok(
      readsAsClosing(
        "Je vous remercie pour vos réponses. Nous allons maintenant passer à la troisième partie de l'épreuve. Vous pouvez disposer.",
      ),
    );
    assert.ok(
      readsAsClosing(
        "L'épreuve est terminée. Nous avons complété les deux parties, le monologue suivi et le débat.",
      ),
    );
    assert.ok(
      readsAsClosing(
        "Je vous confirme que l'épreuve est bien terminée. Vous pouvez maintenant quitter la salle. Au revoir.",
      ),
    );
  });

  it("reads through the accents and the apostrophes Gemini happens to choose", () => {
    // The transcript is whatever the service produced, not something normalised
    // upstream: a missing accent or a typographic apostrophe must not be the
    // difference between a débat rescued and a candidate abandoned.
    for (const text of [
      "L’épreuve est terminée.",
      "L'epreuve est terminee",
      "VOUS POUVEZ DISPOSER",
      "Vous pouvez, si vous le souhaitez, quitter la salle.",
    ]) {
      assert.ok(readsAsClosing(text), `missed: ${text}`);
    }
  });

  it("leaves an examiner doing its job alone", () => {
    // The cost of a false positive is one directive telling an examiner to carry
    // on with a débat it was already carrying on with, so the list can afford to
    // be broad. It still must not fire on the ordinary business of a débat.
    for (const text of [
      "Vous dites que le télétravail isole. N'est-ce pas plutôt le bureau qui isole ?",
      "Vous avez terminé votre exposé sur une note optimiste, je vais vous contredire.",
      "Prenons la deuxième partie de votre raisonnement : elle me paraît fragile.",
      "Merci, mais donnez-moi un exemple nouveau.",
    ]) {
      assert.ok(!readsAsClosing(text), `false positive: ${text}`);
    }
  });
});

describe("corroborating the finish payload's count against its own transcript (#92)", () => {
  const turn = (over: Partial<TranscriptEntry>): TranscriptEntry => ({
    phase: "debate",
    speaker: "examiner",
    timestamp: 360_000,
    text: "Vous pouvez quitter la salle.",
    ...over,
  });

  it("honours a claim the transcript backs, in full", () => {
    // The guarantee the route's clamp leans on: the controller detected each
    // goodbye on the very examiner turns the payload re-submits, with the same
    // phrase list — so a true claim has its turns to show, and passes whole.
    const transcript = [
      turn({ speaker: "candidate", text: "Je pense que le télétravail isole." }),
      turn({ text: "Nous allons passer à la troisième partie de l'épreuve. Au revoir." }),
      turn({ speaker: "candidate", text: "Mais il reste sept minutes, non ?" }),
      turn({ text: "Vous pouvez disposer." }),
    ];

    assert.equal(countClosingTurns(transcript), 2);
    assert.equal(resolveEarlyClosingCount(2, transcript), 2);
  });

  it("zeroes a claim whose transcript shows no goodbye anywhere", () => {
    // The tamper the corroboration exists for: `earlyClosingCount: 1` pasted
    // into an otherwise ordinary payload, to shed a duration penalty measured
    // out of real audio. No turn tells the story the number does.
    const ordinary = [
      turn({ text: "Vous dites que le bureau isole. N'est-ce pas l'inverse ?" }),
      turn({ speaker: "candidate", text: "Non, je maintiens ma position." }),
    ];

    assert.equal(resolveEarlyClosingCount(1, ordinary), 0);
  });

  it("caps an inflated claim at the turns that back it", () => {
    // The magnitude half of the same trust problem: one real goodbye does not
    // corroborate `count: 500`. The rubric only asks whether the count is
    // positive, but the column is an analytics signal and a 32-bit integer —
    // an unbounded pass-through poisons the first and, past 2³¹, refuses the
    // sender's own INSERT.
    const oneGoodbye = [turn({})];

    assert.equal(resolveEarlyClosingCount(500, oneGoodbye), 1);
    assert.equal(resolveEarlyClosingCount(2_147_483_648, oneGoodbye), 1);
  });

  it("never raises a claim, however many turns match", () => {
    // The clamp is a ceiling, not a re-derivation: the server cannot tell an
    // early goodbye from the legitimate closing sentence — `closing` does not
    // survive into the transcript — so extra matching turns must not talk a
    // count upwards. An honest zero above a transcript that ends with the
    // app's own closing stays zero.
    assert.equal(resolveEarlyClosingCount(0, [turn({}), turn({})]), 0);
    assert.equal(resolveEarlyClosingCount(1, [turn({}), turn({})]), 1);
  });

  it("cannot tell a fabricated goodbye from a real one — the accepted limit, pinned", () => {
    // The adversarial case, asserted so it reads as a decision rather than an
    // oversight: the transcript is client-authored in the SAME request, so a
    // forger who sets `earlyClosingCount: 1` can paste the matching examiner
    // turn beside it, and the clamp passes the claim — fabricated text alone
    // waives penalties otherwise anchored to measured audio. Accepted with
    // #92: the browser is the only witness this architecture has, and the
    // only mark at stake is the sender's own practice score. If this
    // assertion ever needs to fail, the fix is a different witness — not a
    // sharper phrase list, which the forger copies from this repository.
    const forged = [
      turn({ speaker: "candidate", text: "Voilà, c'est tout ce que j'avais à dire." }),
      turn({ text: "Vous pouvez disposer." }), // pasted into the JSON, never spoken
    ];

    assert.equal(resolveEarlyClosingCount(1, forged), 1);
  });

  it("only counts where detection ever listened: examiner turns, in the débat", () => {
    // A goodbye in the candidate's own mouth corroborates nothing — they can
    // type it — and the monologue has no examiner to take its leave.
    assert.equal(countClosingTurns([turn({ speaker: "candidate" })]), 0);
    assert.equal(countClosingTurns([turn({ phase: "monologue" })]), 0);
    assert.equal(countClosingTurns([]), 0);
  });
});
