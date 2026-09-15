import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TOPBAR_STEPS, topbarStepView } from "./topbar-steps";

describe("the top bar's steps", () => {
  it("ticks what is done, numbers the rest, and marks the current one", () => {
    assert.deepEqual(
      TOPBAR_STEPS.map((_, index) => topbarStepView(index, 1)),
      [
        { label: "Préparation", state: "done", marker: "✓" },
        { label: "Exposé", state: "current", marker: "2" },
        { label: "Débat", state: "todo", marker: "3" },
      ],
    );
  });

  it("starts with nothing done and ends with nothing to do", () => {
    assert.equal(topbarStepView(0, 0).state, "current");
    assert.equal(topbarStepView(2, 2).state, "current");
    assert.equal(topbarStepView(1, 2).state, "done");
  });
});
