import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CORRECTION_TIMED_OUT, describeFinishFailure } from "./finish-failure";

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
    for (const status of [400, 404, 413, 422]) {
      assert.equal(describeFinishFailure(status, "…").retryable, false, `status ${status}`);
    }
  });

  it("treats an expired session as recoverable, because it is", () => {
    // `/api/exams/[examId]/finish` answers a lapsed Clerk session with 401
    // (`EXAM_ACCESS_DENIALS`). A sitting runs about fifty minutes, so this is an
    // ordinary event — and the one place a wrong answer is expensive: the
    // recording exists only in that tab, and telling the candidate that
    // retrying would change nothing sends them away from the only copy.
    for (const status of [401, 403]) {
      assert.equal(describeFinishFailure(status, "Non authentifié").retryable, true);
    }
  });

  it("replaces « Non authentifié » rather than showing it", () => {
    const { message } = describeFinishFailure(401, "Non authentifié");
    assert.doesNotMatch(message, /Non authentifié/);
    // The remedy, and the trap it has to steer around: signing in via this tab
    // is the obvious move and it destroys the recording.
    assert.match(message, /session a expiré/i);
    assert.match(message, /NOUVEL onglet/);
    assert.match(message, /sans fermer/i);
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

describe("the wait that ran out (#86)", () => {
  it("never headlines a successful envoi as a failed one", () => {
    // The one failure whose defaults would lie: the finish answered 202, so
    // the recording is safe — the overrides exist to say so.
    assert.equal(CORRECTION_TIMED_OUT.retryable, true, "the retry is the recovery path");
    assert.ok(CORRECTION_TIMED_OUT.title, "the notice must not fall back to « L'envoi a échoué »");
    assert.doesNotMatch(CORRECTION_TIMED_OUT.title, /envoi a échoué/i);
    assert.match(CORRECTION_TIMED_OUT.lede ?? "", /bien reçue/);
    // And the retry's honesty: a correction that landed late is returned by
    // the duplicate check, not graded twice.
    assert.match(CORRECTION_TIMED_OUT.message, /sans être recomptée/);
  });

  it("leaves every send failure's defaults alone", () => {
    // The overrides are the timeout's and nobody else's — a 502 or a network
    // failure really is a failed envoi, and the default words are theirs.
    const failure = describeFinishFailure(502, null);
    assert.equal(failure.title, undefined);
    assert.equal(failure.lede, undefined);
  });
});
