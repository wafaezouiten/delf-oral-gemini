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

describe("hearing an examiner wind the débat up early", () => {
  // The sitting in #213, verbatim. Thirteen minutes of débat, four announced endings,
  // and not one of them on any list before this: the candidate answered the
  // second with « Mais il en reste 7 minutes, non ? » and got the silence
  // watch's « Vous m'entendez ? » back.

  it("hears the end announced before the app has authorised one", () => {
    for (const text of [
      "Nous arrivons au terme de notre débat. Pour finir, concentrer l'attention sur les particules fines ne risque-t-il pas de masquer d'autres problèmes ?",
      "Nous arrivons à la fin de cet échange. Pour terminer, pensez-vous que cette mesure soit vraiment l'unique façon de rendre les centres-villes plus agréables ?",
    ]) {
      assert.ok(readsAsClosing(text), `missed at 4:56 and 9:39: ${text}`);
    }
  });

  it("says nothing about the same sentence once the app has asked for it", () => {
    // The gate, from the other side. `lastQuestionInstruction` orders exactly
    // this announcement in the closing two minutes; contradicting it would be
    // the app arguing with its own directive in the examiner's mouth.
    assert.equal(
      readsAsClosing("Nous arrivons à la fin de cet échange. Pour terminer, une question.", {
        lastQuestionAnnounced: true,
      }),
      false,
    );
  });

  it("gives up the wrap-up reading for the rest of the débat, and that is the trade", () => {
    // `lastQuestionCue` only ever moves `pending → sent`, so past the
    // announcement this list is off until the part ends — a SECOND wind-up
    // there, one the app did not order, goes unanswered. Deliberate rather
    // than overlooked: after the announcement the examiner really is at the
    // end, the closing handshake is at most two minutes away, and « nous
    // arrivons à la fin » has stopped being false. What the app cannot afford
    // is to contradict its own directive to buy that case.
    //
    // The cost is bounded because the unconditional list is not gated at all:
    // a wind-up that goes on to dismiss the candidate is still caught, in the
    // closing two minutes as anywhere else, and dismissal is the failure #85
    // was written for.
    const windUp = "Nous arrivons à la fin de cet échange. Merci beaucoup.";

    assert.equal(
      readsAsClosing(windUp, { lastQuestionAnnounced: true, turnComplete: true }),
      false,
      "a second wind-up after the announcement is not answered",
    );
    assert.equal(
      readsAsClosing(`${windUp} Vous pouvez disposer.`, {
        lastQuestionAnnounced: true,
        turnComplete: true,
      }),
      true,
      "but sending the candidate away is a goodbye whenever it is said",
    );
  });

  it("hears a summary and a thank-you as the dead stop it was", () => {
    // 5:33 and 7:10. No dismissal, no « au revoir », nothing the goodbye list
    // could see — and then silence for the rest of the minute.
    for (const text of [
      "Vous proposez donc une approche globale pour évaluer l'ensemble des impacts de cette mesure. Je vous remercie.",
      "Vous insistez sur la transparence de la communication pour favoriser l'adhésion. Je vous remercie.",
    ]) {
      assert.ok(readsAsClosing(text, { turnComplete: true }), `missed: ${text}`);
    }
  });

  it("leaves a thank-you that still asks something alone", () => {
    // The discriminator, and the reason the thanks reading waits for a whole
    // turn: a wrap-up hands the floor back with nothing to answer. Contradicting
    // a polite mid-objection thank-you would order « une nouvelle objection » on
    // top of a question just asked, which is #193's two-questions-in-a-row.
    for (const text of [
      "Je vous remercie pour cette précision, mais ne pensez-vous pas que le coût reste prohibitif ?",
      "Je vous remercie. Alors, comment financer un tel réseau ?",
    ]) {
      assert.ok(!readsAsClosing(text, { turnComplete: true }), `false positive: ${text}`);
    }
  });

  it("does not read a thank-you off half a turn", () => {
    // Mid-turn the question mark has not arrived yet, so the same sentence must
    // read as nothing at all until the turn is whole. This is what keeps the
    // controller's fragment-by-fragment watch from firing on politeness.
    const half = "Je vous remercie pour cette précision,";

    assert.equal(readsAsClosing(half), false, "still being spoken");
    assert.equal(
      readsAsClosing(half, { turnComplete: true }),
      true,
      "and a goodbye once it is not",
    );
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
