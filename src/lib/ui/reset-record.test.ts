import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { archivedMessage, resetButtonLabel, resetFailure, resetSlot } from "./reset-record";

describe("what « Réinitialiser » says", () => {
  it("names the failure by what it asks the candidate to do", () => {
    assert.match(resetFailure({ reset: false, reason: "unreachable" }), /connexion/);
    assert.match(
      resetFailure({ reset: false, reason: "refused", status: 401 }),
      /session a expiré/,
    );
    assert.match(resetFailure({ reset: false, reason: "refused", status: 500 }), /dans un instant/);
  });

  it("reports the count after, in the singular and the plural, and the empty case", () => {
    assert.equal(archivedMessage(0), "Il n'y avait aucune épreuve à archiver.");
    assert.equal(
      archivedMessage(1),
      "1 épreuve est passée aux archives. Vous la retrouvez dans l'historique.",
    );
    assert.equal(
      archivedMessage(4),
      "4 épreuves sont passées aux archives. Vous les retrouvez dans l'historique.",
    );
  });

  it("fills the one slot with the failure first, then the count, then the warning", () => {
    assert.deepEqual(resetSlot("boom", 3), { kind: "failed", text: "boom" });
    assert.equal(resetSlot(null, 0).kind, "archived");
    assert.match(resetSlot(null, null).text, /^Archive vos épreuves/);
  });

  it("labels the button on the ladder", () => {
    assert.equal(resetButtonLabel(false, false), "Réinitialiser");
    assert.equal(resetButtonLabel(true, false), "Réinitialisation…");
    assert.equal(resetButtonLabel(false, true), "Réessayer");
  });
});
