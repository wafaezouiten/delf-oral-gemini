import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EVALUATION_FAILURE_REASONS,
  EvaluationFailure,
  evaluationFailureReason,
} from "./evaluation-failure";

/**
 * The vocabulary the finish route's 502 speaks (#73).
 *
 * The route's catch is the branch every grading failure funnels into, and each
 * of the five used to arrive there identically. These tests are the "one test
 * per throw path" the issue asked for, at the seam `node --test` can reach:
 * every word of the taxonomy round-trips through the classification, and
 * everything that is not a tagged failure honestly reads as none.
 */

describe("tagging a grading failure", () => {
  it("round-trips every reason in the taxonomy", () => {
    // One assertion per throw site: upload (the Files API or activation),
    // model (the corrector), empty (no output), contract (#9's parser), and
    // store (persistence — spoken only in the graded-not-stored log line,
    // because that path answers 200 rather than reaching the catch).
    for (const reason of EVALUATION_FAILURE_REASONS) {
      const failure = new EvaluationFailure(reason, `the ${reason} half died`);
      assert.equal(evaluationFailureReason(failure), reason);
    }
  });

  it("keeps the original error as the cause", () => {
    // The tag must never cost the log the API's own message and stack —
    // « reason=upload » with nothing underneath would be a worse log line
    // than the untagged one it replaces.
    const original = Object.assign(new Error("File processing failed"), { status: 400 });
    const failure = new EvaluationFailure("upload", "the monologue recording died", {
      cause: original,
    });

    assert.equal(failure.cause, original);
    assert.equal(failure.name, "EvaluationFailure");
    assert.equal(failure.message, "the monologue recording died");
  });

  it("survives losing the class identity", () => {
    // Duck-typed on purpose: the route and the evaluator can be bundled into
    // different module instances, so a re-thrown or structured-cloned failure
    // must still classify by its fields alone.
    const shaped = { name: "EvaluationFailure", message: "boom", reason: "model" };
    assert.equal(evaluationFailureReason(shaped), "model");
  });

  it("reads no reason off anything untagged", () => {
    assert.equal(evaluationFailureReason(new Error("GEMINI_API_KEY is not set")), null);
    assert.equal(evaluationFailureReason("a string"), null);
    assert.equal(evaluationFailureReason(null), null);
    assert.equal(evaluationFailureReason(undefined), null);
    assert.equal(evaluationFailureReason(42), null);
  });

  it("refuses a foreign reason it does not speak", () => {
    // Some other library's error carrying a `reason` field must not masquerade
    // as one of ours — a 502 saying `reason: "ECONNRESET"` would send whoever
    // reads it hunting for a throw site that does not exist.
    assert.equal(evaluationFailureReason(Object.assign(new Error(), { reason: "banana" })), null);
    assert.equal(evaluationFailureReason({ reason: 503 }), null);
  });
});
