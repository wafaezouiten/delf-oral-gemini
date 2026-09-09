/**
 * The binding itself — Clerk on one side, Drizzle on the other.
 *
 * `exam-access.test.ts` covers the policy, and covers it well: hand
 * `resolveExamAccess` two users and a fake lookup and every branch is reachable.
 * What no test reached until this file is the wiring — the module that decides
 * WHICH user id and WHICH row the policy is handed. That is the only place the
 * real ownership decision is made, and it is the one place a refactor can reopen
 * the cross-user hole with every other test still green, because the pure
 * modules would carry on passing while being fed the wrong facts (#21).
 *
 * So the seams are pushed as far out as they will go:
 *
 *  - **Clerk** is mocked, because there is no other way to be two people.
 *  - **Drizzle is not.** `getDb()` returns a real query builder over
 *    `drizzle-orm/pg-proxy`, so the SQL in `findExamOwner` is really planned and
 *    really parameterised; the fake starts at the wire, where Neon would be.
 *    A test that stubbed `.select().from().where()` would assert that the chain
 *    was called, which is not the same as asserting it asks about the right
 *    sitting — and asking about the wrong sitting is the whole bug class.
 *  - **`server-only`** is mocked to nothing. It is a marker package that throws
 *    on import outside a React Server Component, and it is the reason this file
 *    is the first test in the codebase to load a module from `app/`'s side of
 *    the fence. Mocking it needs `--experimental-test-module-mocks`, which is
 *    why `test:unit` carries the flag.
 *
 * The two-account check on a Vercel preview (Phase 3, #5) proved this once, by
 * hand, and then never ran again. These cases are that check, in CI.
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

import { drizzle } from "drizzle-orm/pg-proxy";

import * as schema from "@/lib/db/schema";
import { mockPackage } from "@/lib/testing/mock-package";

const OWNER = "user_owner";
const INTRUDER = "user_intruder";

const SLUG = "vie-professionnelle";

/**
 * Two sittings, one each, so "someone else's exam" is a real row and not a gap.
 *
 * The second names no subject. `topic_id` is `not null` with a restricted FK, so
 * the `leftJoin` should always match — and the row that proves it does not have
 * to is the one that keeps the join from getting a vote on ownership (#22).
 */
const ROWS = [
  { id: 41, userId: OWNER, topicSlug: SLUG, examinerModel: "gemini-3.1-flash-live-preview" },
  { id: 42, userId: INTRUDER, topicSlug: null, examinerModel: null },
];

/**
 * What the mocked boundaries answer with. Mutable rather than re-mocked per
 * test: the module graph is loaded once, so the mocks have to be installed once
 * too, and a test changes the world rather than the wiring.
 */
const world = {
  /** Who Clerk says is calling. */
  userId: null as string | null,
  databaseConfigured: true,
  /** Whether the database refuses to answer, as Neon does during an incident. */
  lookupFails: false,
  /** Every statement that reached the wire, in order. */
  queries: [] as { sql: string; params: unknown[] }[],
};

/** Stand-ins for the two control-flow exits, each thrown as the real one is. */
class RedirectedToSignIn extends Error {}
class NotFound extends Error {}

mockPackage("server-only", {});

mockPackage("@clerk/nextjs/server", {
  auth: async () => ({
    userId: world.userId,
    redirectToSignIn: () => {
      throw new RedirectedToSignIn();
    },
  }),
});

mockPackage("next/navigation", {
  notFound: () => {
    throw new NotFound();
  },
});

/**
 * Neon, replaced by a function of the rows above.
 *
 * `pg-proxy` is Drizzle's own escape hatch: it builds the query exactly as the
 * `neon-http` driver would and then hands us the SQL string and its parameters
 * instead of opening a connection. Rows go back positionally, in the order the
 * `select({ ... })` named its columns.
 */
const db = drizzle(async (sql, params) => {
  world.queries.push({ sql, params });
  if (world.lookupFails) throw new Error("connection terminated unexpectedly");

  const row = ROWS.find((candidate) => candidate.id === Number(params[0]));
  return { rows: row ? [[row.id, row.userId, row.topicSlug, row.examinerModel]] : [] };
});

mockPackage("@/lib/db", {
  // The real tables: `findExamOwner` builds its WHERE out of these columns, and
  // a fake `oralExams` would let a query that names the wrong one pass.
  ...schema,
  getDb: () => db,
  isDatabaseConfigured: () => world.databaseConfigured,
});

/** Loaded after the mocks, which is the whole reason it is loaded dynamically. */
let guard: typeof import("./exam-guard");

before(async () => {
  guard = await import("./exam-guard");
});

beforeEach(() => {
  world.userId = OWNER;
  world.databaseConfigured = true;
  world.lookupFails = false;
  world.queries = [];
  // `lookup-failed` is logged, deliberately and loudly. Silence it here so a
  // passing run stays readable; the cases that care assert on it instead.
  mock.method(console, "error", () => {});
});

/** The last statement that reached the wire, which is the ownership lookup. */
function lastQuery() {
  const query = world.queries.at(-1);
  assert.ok(query, "expected the guard to have asked the database something");
  return query;
}

describe("exam guard (API)", () => {
  it("resolves the owner's own sitting to that row, and its subject", async () => {
    const access = await guard.authorizeExam("41");
    assert.deepEqual(access, {
      status: "owned",
      userId: OWNER,
      examId: 41,
      topicSlug: SLUG,
      examinerModel: "gemini-3.1-flash-live-preview",
    });
  });

  it("asks about the sitting in the URL, and only that one", async () => {
    // The assertion the pure tests cannot make: a binding that looked up the
    // wrong id — or filtered by user instead of by id, or dropped the WHERE —
    // would satisfy every existing test by handing the policy a plausible row.
    await guard.authorizeExam("41");

    const { sql, params } = lastQuery();
    assert.match(sql, /from "oral_exams".* where "oral_exams"\."id" = \$1/);
    // `$2` is the `limit`; the id is the first parameter and is the number in
    // the URL, parsed, not the string.
    assert.equal(params[0], 41);
  });

  it("reads the owner and the subject in one round trip", async () => {
    // The point of #22: this used to be two sequential statements against the
    // same row, on every connect and so on every reconnect — up to ten of them
    // across an exhausted backoff, exactly when the network is already unwell.
    await guard.authorizeExam("41");

    assert.equal(world.queries.length, 1, "one statement per ownership question");
    assert.match(lastQuery().sql, /left join "oral_topics"/);
  });

  it("owns a sitting whose subject could not be joined", async () => {
    // The reason the join is a LEFT one. An inner join would return no row here,
    // and no row is how "someone else's sitting" looks — so the owner of a real
    // épreuve would be 404'd out of it by a broken catalogue row.
    world.userId = INTRUDER;
    const access = await guard.authorizeExam("42");

    assert.deepEqual(access, {
      status: "owned",
      userId: INTRUDER,
      examId: 42,
      topicSlug: null,
      examinerModel: null,
    });
  });

  it("refuses another signed-in user's sitting as a 404", async () => {
    world.userId = INTRUDER;
    const access = await guard.authorizeExam("41");
    assert.deepEqual(access, { status: "denied", reason: "not-found" });
  });

  it("answers a foreign sitting exactly as it answers a missing one", async () => {
    // 404 rather than 403, all the way through the binding: an intruder must not
    // be able to tell an id that exists from one that does not.
    world.userId = INTRUDER;
    const foreign = await guard.authorizeExam("41");
    const missing = await guard.authorizeExam("9999");
    assert.deepEqual(foreign, missing);
  });

  it("takes the caller from Clerk rather than from the row", async () => {
    // The same sitting, twice, differing only in who is asking. If the binding
    // ever compared the row against itself this is the case that notices.
    world.userId = OWNER;
    const owner = await guard.authorizeExam("41");
    world.userId = INTRUDER;
    const intruder = await guard.authorizeExam("41");

    assert.equal(owner.status, "owned");
    assert.equal(intruder.status, "denied");
  });

  it("refuses a signed-out caller without querying anything", async () => {
    world.userId = null;
    const access = await guard.authorizeExam("41");

    assert.deepEqual(access, { status: "denied", reason: "unauthenticated" });
    assert.equal(world.queries.length, 0);
  });

  it("never reports a sitting as owned when the database cannot answer", async () => {
    world.lookupFails = true;
    const access = await guard.authorizeExam("41");

    // Not `denied` — the request is legal and the caller may well own it. The
    // routes degrade to "grade, persist nothing" on this; what must never
    // happen is `owned`, which would be an outage promoted to a bypass.
    assert.deepEqual(access, { status: "no-sitting", userId: OWNER, reason: "lookup-failed" });
  });

  it("names the entry point when it could not verify ownership", async () => {
    // Two callers react oppositely to this outcome — a page 500s, the API
    // grades and persists nothing — so an on-call reading the line has to be
    // able to tell which one it was.
    const logged = mock.method(console, "error", () => {});
    world.lookupFails = true;
    await guard.authorizeExam("41");

    assert.equal(logged.mock.callCount(), 1);
    assert.match(String(logged.mock.calls[0].arguments[0]), /\(api\)/);
  });

  it("reports no sitting, and asks nothing, when there is no database", async () => {
    world.databaseConfigured = false;
    const access = await guard.authorizeExam("41");

    assert.deepEqual(access, { status: "no-sitting", userId: OWNER, reason: "no-database" });
    assert.equal(world.queries.length, 0);
  });

  it("reports no sitting for a degraded id, and asks nothing", async () => {
    // The `local-…` ids `/api/exams` hands out when it cannot persist. No row
    // can have one, so the lookup would be a round trip with a known answer.
    const access = await guard.authorizeExam("local-1770000000000");

    assert.deepEqual(access, { status: "no-sitting", userId: OWNER, reason: "unpersisted-id" });
    assert.equal(world.queries.length, 0);
  });
});

describe("exam guard (page)", () => {
  it("hands back the row and its subject for a sitting the caller owns", async () => {
    // The subject is here so the exam page does not go back for it: it renders
    // the sujet the examiner will be arguing about, read from the same row that
    // said the candidate may sit it.
    assert.deepEqual(await guard.requireExamAccess("41"), {
      examId: 41,
      topicSlug: SLUG,
      examinerModel: "gemini-3.1-flash-live-preview",
    });
    assert.equal(world.queries.length, 1);
  });

  it("404s on another user's sitting", async () => {
    world.userId = INTRUDER;
    await assert.rejects(guard.requireExamAccess("41"), NotFound);
  });

  it("404s on a sitting that does not exist", async () => {
    await assert.rejects(guard.requireExamAccess("9999"), NotFound);
  });

  it("sends a signed-out caller to sign in", async () => {
    world.userId = null;
    await assert.rejects(guard.requireExamAccess("41"), RedirectedToSignIn);
  });

  it("refuses to render when ownership could not be verified", async () => {
    // Deliberately not a 404: the sitting may well exist and be theirs. What
    // failed is our ability to say so. A gate that opens on a database hiccup
    // would let an attacker who can exhaust connections choose when it opens.
    world.lookupFails = true;
    await assert.rejects(guard.requireExamAccess("41"), /could not be verified/);
  });

  it("returns null, not a sitting, when there is provably no sitting", async () => {
    // The return type is the invariant: a caller that reads persisted data keys
    // off this id, so a row here would be one nobody proved was theirs.
    world.databaseConfigured = false;
    assert.equal(await guard.requireExamAccess("41"), null);

    world.databaseConfigured = true;
    assert.equal(await guard.requireExamAccess("local-1770000000000"), null);
  });

  it("names the entry point when it could not verify ownership", async () => {
    const logged = mock.method(console, "error", () => {});
    world.lookupFails = true;
    await assert.rejects(guard.requireExamAccess("41"));

    assert.equal(logged.mock.callCount(), 1);
    assert.match(String(logged.mock.calls[0].arguments[0]), /\(page\)/);
  });
});

describe("requireUserId", () => {
  it("returns the signed-in caller", async () => {
    assert.equal(await guard.requireUserId(), OWNER);
  });

  it("redirects when there is nobody", async () => {
    world.userId = null;
    await assert.rejects(async () => guard.requireUserId(), RedirectedToSignIn);
  });
});
