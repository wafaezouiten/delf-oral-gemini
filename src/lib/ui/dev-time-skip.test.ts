import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { devTimeSkipAvailable } from "./dev-time-skip";

const running = {
  phase: "debate" as const,
  phaseStartedAt: 1_000,
  closing: false,
  monologueHeld: false,
};

describe("when the dev time-skip is offered", () => {
  it("is offered while a speaking part is running", () => {
    assert.equal(devTimeSkipAvailable(running), true);
    assert.equal(devTimeSkipAvailable({ ...running, phase: "monologue" }), true);
  });

  it("is not offered outside the speaking parts", () => {
    assert.equal(devTimeSkipAvailable({ ...running, phase: "preparation" }), false);
    assert.equal(devTimeSkipAvailable({ ...running, phase: "finished" }), false);
  });

  it("is not offered on an armed clock, during the closing, or while the monologue is held", () => {
    assert.equal(devTimeSkipAvailable({ ...running, phaseStartedAt: null }), false);
    assert.equal(devTimeSkipAvailable({ ...running, closing: true }), false);
    assert.equal(devTimeSkipAvailable({ ...running, monologueHeld: true }), false);
  });
});
