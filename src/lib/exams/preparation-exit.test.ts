import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { requestPreparationExit } from "./preparation-exit";

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

describe("requesting a préparation exit", () => {
  it("posts to the sitting's own leave route", async () => {
    const fetchImpl = fakeFetch(200, { archived: true });
    await requestPreparationExit("12", fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0].arguments as unknown as [
      string,
      RequestInit,
    ];
    assert.equal(url, "/api/exams/12/leave");
    assert.equal(init.method, "POST");
  });

  it("reports recorded only when the server says it wrote something", async () => {
    const outcome = await requestPreparationExit(
      "12",
      fakeFetch(200, { archived: true }) as unknown as typeof fetch,
    );
    assert.deepEqual(outcome, { recorded: true });
  });

  it("does not treat a 200 that wrote nothing as recorded", async () => {
    // The route answers 200 for every no-op — already left, already walked out
    // of, past the préparation, never persisted. Only the log line rides on the
    // distinction, but a log line claiming a write that never happened is the
    // kind that sends a reader hunting for a row that does not exist.
    const outcome = await requestPreparationExit(
      "12",
      fakeFetch(200, { archived: false, persisted: false }) as unknown as typeof fetch,
    );
    assert.deepEqual(outcome, { recorded: false, reason: "refused", status: 200 });
  });

  it("does not guess when the body is not the shape it expects", async () => {
    for (const body of [null, {}, { archived: "yes" }, "nonsense"]) {
      const outcome = await requestPreparationExit(
        "12",
        fakeFetch(200, body) as unknown as typeof fetch,
      );
      assert.equal(outcome.recorded, false, `body ${JSON.stringify(body)}`);
    }
  });

  it("reports a refusal with its status", async () => {
    const outcome = await requestPreparationExit(
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
    const outcome = await requestPreparationExit("12", fetchImpl as unknown as typeof fetch);
    assert.equal(outcome.recorded, false);
  });

  it("reports unreachable when the request never gets an answer", async () => {
    const fetchImpl = mock.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const outcome = await requestPreparationExit("12", fetchImpl as unknown as typeof fetch);
    assert.deepEqual(outcome, { recorded: false, reason: "unreachable" });
  });

  it("gives up rather than holding a departing candidate on the exam screen", async () => {
    // They have already decided to go, and this stamp is bookkeeping — even the
    // abandon call, whose stamp is a promised zero, does not hold them longer.
    const fetchImpl = mock.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    // `AbortSignal.timeout()` schedules an unref'd timer, so a ref'd one keeps
    // the loop alive for the duration — the same CI lesson `abandon.test.ts`
    // records in full.
    const keepLoopAlive = setTimeout(() => {}, 1_000);
    try {
      const outcome = await requestPreparationExit("12", fetchImpl as unknown as typeof fetch, 20);
      assert.deepEqual(outcome, { recorded: false, reason: "unreachable" });
    } finally {
      clearTimeout(keepLoopAlive);
    }
  });
});
