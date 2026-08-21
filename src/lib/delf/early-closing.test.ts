import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readsAsClosing, transcriptShowsClosing } from "./early-closing";
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

  it("finds the goodbye a genuine count was read off", () => {
    // The guarantee the route's check leans on: the controller detected the
    // goodbye on the very examiner turns the payload re-submits, with the same
    // phrase list — so a true claim always has this turn to show.
    assert.ok(
      transcriptShowsClosing([
        turn({ speaker: "candidate", text: "Je pense que le télétravail isole." }),
        turn({ text: "Nous allons passer à la troisième partie de l'épreuve. Au revoir." }),
      ]),
    );
  });

  it("denies a claim whose transcript shows no goodbye anywhere", () => {
    // The tamper the check exists for: `earlyClosingCount: 1` pasted into an
    // otherwise ordinary payload, to shed a duration penalty measured out of
    // real audio. No turn tells the story the number does.
    assert.ok(
      !transcriptShowsClosing([
        turn({ text: "Vous dites que le bureau isole. N'est-ce pas l'inverse ?" }),
        turn({ speaker: "candidate", text: "Non, je maintiens ma position." }),
      ]),
    );
  });

  it("only listens where detection ever listened: examiner turns, in the débat", () => {
    // A goodbye in the candidate's own mouth corroborates nothing — they can
    // type it — and the monologue has no examiner to take its leave.
    assert.ok(!transcriptShowsClosing([turn({ speaker: "candidate" })]));
    assert.ok(!transcriptShowsClosing([turn({ phase: "monologue" })]));
    assert.ok(!transcriptShowsClosing([]));
  });
});
