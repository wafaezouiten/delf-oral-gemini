import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pendingLabel } from "./action-label";

const words = { idle: "Abandonner", pending: "Abandon en cours…" };

describe("a sending button's label", () => {
  it("climbs the ladder: the verb, the wait, the retry", () => {
    assert.equal(pendingLabel({ pending: false, failed: false }, words), "Abandonner");
    assert.equal(pendingLabel({ pending: true, failed: false }, words), "Abandon en cours…");
    assert.equal(pendingLabel({ pending: false, failed: true }, words), "Réessayer");
  });

  it("says the wait over the failure while the retry is out, and takes its own retry word", () => {
    assert.equal(pendingLabel({ pending: true, failed: true }, words), "Abandon en cours…");
    assert.equal(
      pendingLabel({ pending: false, failed: true }, { ...words, retry: "Encore" }),
      "Encore",
    );
  });
});
