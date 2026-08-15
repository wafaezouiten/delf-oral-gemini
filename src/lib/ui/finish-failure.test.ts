import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeFinishFailure } from "./finish-failure";

describe("finish failures", () => {
  it("shows the route's own words, because they were written for a candidate", () => {
    const { message } = describeFinishFailure(
      502,
      "L'évaluation a échoué. Réessayez dans un instant.",
    );
    assert.equal(message, "L'évaluation a échoué. Réessayez dans un instant.");
  });

  it("offers a retry when the server was having a bad moment", () => {
    assert.equal(describeFinishFailure(500, "…").retryable, true);
    assert.equal(describeFinishFailure(502, "…").retryable, true);
    assert.equal(describeFinishFailure(503, "…").retryable, true);
    assert.equal(describeFinishFailure(429, "…").retryable, true);
    assert.equal(describeFinishFailure(408, "…").retryable, true);
  });

  it("offers a retry when the request never arrived at all", () => {
    // `fetch` threw: offline, DNS, a connection dropped mid-upload. Nothing was
    // refused, so there is every reason to try again.
    const failure = describeFinishFailure(null, undefined);
    assert.equal(failure.retryable, true);
    assert.match(failure.message, /ne le fermez pas/);
  });

  it("does not offer a retry for a refusal that would refuse again", () => {
    // The 413 and the 422 are the two the earlier phases actually produce: a
    // recording over the per-file cap, and a transcript with nothing in it. The
    // same bytes get the same answer, so a retry button here is a promise the
    // product cannot keep.
    for (const status of [400, 401, 404, 413, 422]) {
      assert.equal(describeFinishFailure(status, "…").retryable, false, `status ${status}`);
    }
  });

  it("says plainly that a terminal failure will not change", () => {
    const { message } = describeFinishFailure(
      422,
      "La transcription ne contient presque aucune parole du candidat.",
    );
    assert.match(message, /parole du candidat/);
    assert.match(message, /même résultat/);
  });

  it("falls back to French prose when the failure arrived without any", () => {
    // A platform 502 is an HTML page, not this route's JSON, so there is no
    // `error` field to show. The candidate still gets a sentence.
    for (const body of [undefined, null, "", "   ", 42, { error: "nested" }]) {
      const { message } = describeFinishFailure(502, body);
      assert.match(message, /pas pu être envoyée/);
    }
  });
});
