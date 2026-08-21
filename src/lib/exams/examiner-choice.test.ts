import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { requestExaminerChoice } from "./examiner-choice";

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

const MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

describe("requesting an examiner choice", () => {
  it("posts the model to the sitting's own examiner route", async () => {
    const fetchImpl = fakeFetch(200, { recorded: true, persisted: true });
    await requestExaminerChoice("12", MODEL, fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0].arguments as unknown as [string, RequestInit];
    assert.equal(url, "/api/exams/12/examiner");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), { model: MODEL });
  });

  it("applies when the row was written", async () => {
    const outcome = await requestExaminerChoice(
      "12",
      MODEL,
      fakeFetch(200, { recorded: true, persisted: true }) as unknown as typeof fetch,
    );
    assert.deepEqual(outcome, { applied: true, persisted: true });
  });

  it("applies when there is provably no row to write", async () => {
    // The degraded path: no database, or a `local-…` id. There is no row to
    // outrank the choice, and the client forwards it on every mint — so the
    // picker keeps showing it, because it is what the candidate will hear.
    const outcome = await requestExaminerChoice(
      "12",
      MODEL,
      fakeFetch(200, { recorded: false, persisted: false }) as unknown as typeof fetch,
    );
    assert.deepEqual(outcome, { applied: true, persisted: false });
  });

  it("does not apply a 200 whose row was not written", async () => {
    // The sitting has left the préparation — a stale tab, a replay. The row's
    // model is what the token route will mint; showing the new choice would be
    // promising a voice that will never speak.
    const outcome = await requestExaminerChoice(
      "12",
      MODEL,
      fakeFetch(200, { recorded: false, persisted: true }) as unknown as typeof fetch,
    );
    assert.deepEqual(outcome, { applied: false, reason: "refused" });
  });

  it("does not guess when the body is not the shape it expects", async () => {
    for (const body of [null, {}, { recorded: "yes" }, "nonsense"]) {
      const outcome = await requestExaminerChoice(
        "12",
        MODEL,
        fakeFetch(200, body) as unknown as typeof fetch,
      );
      assert.equal(outcome.applied, false, `body ${JSON.stringify(body)}`);
    }
  });

  it("reports a refusal on an error status", async () => {
    const outcome = await requestExaminerChoice(
      "12",
      "gemini-not-a-model",
      fakeFetch(400, { error: "Modèle inconnu" }) as unknown as typeof fetch,
    );
    assert.deepEqual(outcome, { applied: false, reason: "refused" });
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
    const outcome = await requestExaminerChoice("12", MODEL, fetchImpl as unknown as typeof fetch);
    assert.equal(outcome.applied, false);
  });

  it("reports unreachable when the request never gets an answer", async () => {
    const fetchImpl = mock.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const outcome = await requestExaminerChoice("12", MODEL, fetchImpl as unknown as typeof fetch);
    assert.deepEqual(outcome, { applied: false, reason: "unreachable" });
  });

  it("gives up rather than leaving the picker in « Enregistrement… » forever", async () => {
    const fetchImpl = mock.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    // `AbortSignal.timeout()` schedules an unref'd timer — see `abandon.test.ts`
    // for why the loop needs to be held open for the abort to ever fire here.
    const keepLoopAlive = setTimeout(() => {}, 1_000);
    try {
      const outcome = await requestExaminerChoice(
        "12",
        MODEL,
        fetchImpl as unknown as typeof fetch,
        20,
      );
      assert.deepEqual(outcome, { applied: false, reason: "unreachable" });
    } finally {
      clearTimeout(keepLoopAlive);
    }
  });
});
