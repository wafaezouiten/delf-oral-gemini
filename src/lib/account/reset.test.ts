import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { requestRecordReset } from "./reset";

/** A `fetch` that answers with a given status and body. */
function fakeFetch(status: number, body: unknown) {
  return mock.fn(
    async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      }) as unknown as Response,
  );
}

describe("requesting a record reset", () => {
  it("posts to the account route, and posts nothing with it", async () => {
    const fetchImpl = fakeFetch(200, { archived: 3 });
    await requestRecordReset(fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0].arguments as unknown as [string, RequestInit];
    assert.equal(url, "/api/account/reset");
    assert.equal(init.method, "POST");
    // The route derives the candidate from the session. A body would be a
    // client-chosen scope for a write that empties somebody's record.
    assert.equal(init.body, undefined);
  });

  it("reports what was archived", async () => {
    const outcome = await requestRecordReset(
      fakeFetch(200, { archived: 14 }) as unknown as typeof fetch,
    );
    assert.deepEqual(outcome, { reset: true, archived: 14 });
  });

  it("treats nothing left to archive as done, not as a refusal", async () => {
    // A second press. The candidate asked for an empty record and has one, so
    // reporting a failure here would send them looking for a problem that is
    // not there.
    const outcome = await requestRecordReset(
      fakeFetch(200, { archived: 0 }) as unknown as typeof fetch,
    );
    assert.deepEqual(outcome, { reset: true, archived: 0 });
  });

  it("does not guess when the body is not the shape it expects", async () => {
    // A 200 carrying something else means something other than the route
    // answered. Claiming the record was reset on that would empty the screen on
    // the strength of a status code.
    for (const body of [null, {}, { archived: "3" }, { archived: true }, "nonsense"]) {
      const outcome = await requestRecordReset(fakeFetch(200, body) as unknown as typeof fetch);
      assert.equal(outcome.reset, false, `body ${JSON.stringify(body)}`);
    }
  });

  it("reports a refusal with its status", async () => {
    assert.deepEqual(await requestRecordReset(fakeFetch(401, {}) as unknown as typeof fetch), {
      reset: false,
      reason: "refused",
      status: 401,
    });
    assert.deepEqual(await requestRecordReset(fakeFetch(503, {}) as unknown as typeof fetch), {
      reset: false,
      reason: "refused",
      status: 503,
    });
  });

  it("reports an unreachable server rather than throwing at the caller", async () => {
    const outcome = await requestRecordReset(
      mock.fn(async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    );
    assert.deepEqual(outcome, { reset: false, reason: "unreachable" });
  });

  it("sends no abort signal, so a slow answer is waited for", async () => {
    // The one difference from `requestAbandon`, and it is deliberate: giving up
    // early would report a failure for a write that then lands, and the
    // candidate would find an emptied tableau de bord under a message saying
    // nothing had changed. Asserted on the request rather than by waiting out a
    // clock, because that is where the decision actually is.
    const fetchImpl = fakeFetch(200, { archived: 1 });
    await requestRecordReset(fetchImpl as unknown as typeof fetch);

    const [, init] = fetchImpl.mock.calls[0].arguments as unknown as [string, RequestInit];
    assert.equal(init.signal, undefined);
  });
});
