import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readsAsClosing } from "./early-closing";

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
