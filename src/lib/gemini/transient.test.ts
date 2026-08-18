import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isTransient, transientStatus, withTransientRetry } from "./transient";

/** What `@google/genai` actually throws: a plain Error carrying a status. */
const apiError = (status: number, message = "boom") =>
  Object.assign(new Error(message), { status });

describe("which failures are worth another attempt", () => {
  it("retries a busy or rate-limited corrector", () => {
    // 503 is the one observed in production: "This model is currently
    // experiencing high demand", and the identical request succeeded next try.
    for (const status of [429, 500, 503, 504]) {
      assert.equal(isTransient(apiError(status)), true, `${status} should be retried`);
    }
  });

  it("does not retry a request that will fail the same way forever", () => {
    // 404 is how a retired model id presents — `EVAL_MODEL`'s comment records
    // two of those. Retrying it delays the error by the whole backoff and
    // spends the route's budget proving what the first attempt already knew.
    for (const status of [400, 401, 403, 404, 422]) {
      assert.equal(isTransient(apiError(status)), false, `${status} should fail fast`);
    }
  });

  it("treats a throw with no status as permanent", () => {
    assert.equal(isTransient(new Error("socket hang up")), false);
    assert.equal(isTransient("a string"), false);
    assert.equal(isTransient(null), false);
    assert.equal(isTransient(undefined), false);
    assert.equal(transientStatus({ status: "503" }), null, "a string status is not a status");
  });
});

describe("retrying the correction", () => {
  it("returns the first success without waiting", async () => {
    let calls = 0;
    const slept: number[] = [];

    const result = await withTransientRetry(
      async () => {
        calls++;
        return "graded";
      },
      { sleep: async (ms) => void slept.push(ms) },
    );

    assert.equal(result, "graded");
    assert.equal(calls, 1);
    assert.deepEqual(slept, []);
  });

  it("rides out a transient failure and returns the retry's result", async () => {
    let calls = 0;
    const slept: number[] = [];

    const result = await withTransientRetry(
      async () => {
        calls++;
        if (calls === 1) throw apiError(503, "high demand");
        return "graded";
      },
      { sleep: async (ms) => void slept.push(ms) },
    );

    assert.equal(result, "graded");
    assert.equal(calls, 2);
    assert.deepEqual(slept, [2000]);
  });

  it("backs off further each time, and gives up after the last attempt", async () => {
    let calls = 0;
    const slept: number[] = [];

    await assert.rejects(
      withTransientRetry(
        async () => {
          calls++;
          throw apiError(503, "still busy");
        },
        { sleep: async (ms) => void slept.push(ms) },
      ),
      /still busy/,
    );

    assert.equal(calls, 3, "three attempts, not three retries");
    assert.deepEqual(slept, [2000, 4000], "no wait after the attempt that cannot be used");
  });

  it("rethrows the API's own error rather than one of its own", async () => {
    // The route logs this. « evaluation failed after 3 attempts » is a worse
    // thing to find in a log than the service's message and its stack.
    const original = apiError(503, "This model is currently experiencing high demand.");

    await assert.rejects(
      withTransientRetry(
        async () => {
          throw original;
        },
        { sleep: async () => {} },
      ),
      (thrown) => thrown === original,
    );
  });

  it("fails a permanent error immediately, without spending the backoff", async () => {
    let calls = 0;
    const slept: number[] = [];

    await assert.rejects(
      withTransientRetry(
        async () => {
          calls++;
          throw apiError(404, "model not found");
        },
        { sleep: async (ms) => void slept.push(ms) },
      ),
      /model not found/,
    );

    assert.equal(calls, 1);
    assert.deepEqual(slept, [], "a retired model does not come back in two seconds");
  });

  it("reports each wait it takes, so the log says what was ridden out", async () => {
    const seen: Array<{ attempt: number; delayMs: number; status: unknown }> = [];
    let calls = 0;

    await withTransientRetry(
      async () => {
        calls++;
        if (calls < 3) throw apiError(429, "rate limited");
        return "graded";
      },
      {
        sleep: async () => {},
        onRetry: (error, attempt, delayMs) =>
          seen.push({ attempt, delayMs, status: (error as { status: number }).status }),
      },
    );

    assert.deepEqual(seen, [
      { attempt: 1, delayMs: 2000, status: 429 },
      { attempt: 2, delayMs: 4000, status: 429 },
    ]);
  });

  it("honours an attempt budget of one, which is the old behaviour", async () => {
    let calls = 0;

    await assert.rejects(
      withTransientRetry(
        async () => {
          calls++;
          throw apiError(503);
        },
        { attempts: 1, sleep: async () => {} },
      ),
      /boom/,
    );

    assert.equal(calls, 1);
  });
});
