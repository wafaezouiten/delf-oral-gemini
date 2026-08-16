import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { requestAbandon } from "./abandon";

/** A `fetch` that answers with a given status and body. */
function fakeFetch(status: number, body: unknown) {
  return mock.fn(async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response,
  );
}

describe("requesting an abandon", () => {
  it("posts to the sitting's own abandon route", async () => {
    const fetchImpl = fakeFetch(200, { abandoned: true });
    await requestAbandon("12", fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0].arguments as unknown as [
      string,
      RequestInit,
    ];
    assert.equal(url, "/api/exams/12/abandon");
    assert.equal(init.method, "POST");
  });

  it("reports recorded only when the server says it wrote something", async () => {
    const outcome = await requestAbandon(
      "12",
      fakeFetch(200, { abandoned: true }) as unknown as typeof fetch,
    );
    assert.deepEqual(outcome, { recorded: true });
  });

  it("does not treat a 200 that wrote nothing as recorded", async () => {
    // The route answers 200 for three no-ops: already abandoned, a correction
    // landed first, or ownership could not be established. This is the bug the
    // module exists to stop — the dialog promises the candidate a zero, and it
    // must not make that claim on a status code alone.
    const outcome = await requestAbandon(
      "12",
      fakeFetch(200, { abandoned: false, persisted: false }) as unknown as typeof fetch,
    );
    assert.deepEqual(outcome, { recorded: false, reason: "refused", status: 200 });
  });

  it("does not guess when the body is not the shape it expects", async () => {
    for (const body of [null, {}, { abandoned: "yes" }, "nonsense"]) {
      const outcome = await requestAbandon(
        "12",
        fakeFetch(200, body) as unknown as typeof fetch,
      );
      assert.equal(outcome.recorded, false, `body ${JSON.stringify(body)}`);
    }
  });

  it("reports a refusal with its status", async () => {
    const outcome = await requestAbandon(
      "12",
      fakeFetch(403, { error: "non" }) as unknown as typeof fetch,
    );
    assert.deepEqual(outcome, { recorded: false, reason: "refused", status: 403 });
  });

  it("survives a body that is not JSON at all", async () => {
    // A platform error is an HTML page, not this route's JSON.
    const fetchImpl = mock.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      }) as unknown as Response,
    );
    const outcome = await requestAbandon("12", fetchImpl as unknown as typeof fetch);
    assert.equal(outcome.recorded, false);
  });

  it("reports unreachable when the request never gets an answer", async () => {
    const fetchImpl = mock.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const outcome = await requestAbandon("12", fetchImpl as unknown as typeof fetch);
    assert.deepEqual(outcome, { recorded: false, reason: "unreachable" });
  });

  it("gives up rather than holding a departing candidate on the exam screen", async () => {
    // They have already decided to go. Losing the stamp is a smaller failure
    // than a screen that appears frozen.
    const fetchImpl = mock.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const outcome = await requestAbandon("12", fetchImpl as unknown as typeof fetch, 20);
    assert.deepEqual(outcome, { recorded: false, reason: "unreachable" });
  });
});
