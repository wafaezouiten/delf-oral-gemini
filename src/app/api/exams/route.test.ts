/**
 * Opening a sitting as HTTP. Clerk is mocked to be somebody or nobody;
 * Drizzle is real over `pg-proxy`, as in `exam-guard.test.ts`, so the three
 * statements — find the subject's row, create it if the catalogue has not been
 * written yet, create the sitting — are really built, and the row the route
 * answers with is the one the last of them returned.
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/pg-proxy";

import * as schema from "@/lib/db/schema";
import { LIVE_MODEL } from "@/lib/gemini/constants";
import { mockPackage } from "@/lib/testing/mock-package";

const world = {
  userId: "user_1" as string | null,
  databaseConfigured: true,
  /** The catalogue row for the requested subject, if it has been written. */
  topicRowId: 7 as number | null,
  /** Whether Neon refuses every statement. */
  databaseFails: false,
  queries: [] as { sql: string; params: unknown[] }[],
};

mockPackage("@clerk/nextjs/server", { auth: async () => ({ userId: world.userId }) });

const db = drizzle(async (sql, params) => {
  world.queries.push({ sql, params });
  if (world.databaseFails) throw new Error("connection terminated unexpectedly");
  if (/^select/i.test(sql)) return { rows: world.topicRowId === null ? [] : [[world.topicRowId]] };
  if (/insert into "oral_topics"/.test(sql)) return { rows: [[8]] };
  if (/insert into "oral_exams"/.test(sql)) return { rows: [[41]] };
  throw new Error(`unexpected statement: ${sql}`);
});

mockPackage("@/lib/db", {
  ...schema,
  getDb: () => db,
  isDatabaseConfigured: () => world.databaseConfigured,
});

let POST: typeof import("./route").POST;

before(async () => {
  ({ POST } = await import("./route"));
});

beforeEach(() => {
  world.userId = "user_1";
  world.databaseConfigured = true;
  world.topicRowId = 7;
  world.databaseFails = false;
  world.queries = [];
});

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/exams", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("POST /api/exams", () => {
  it("refuses a caller who is nobody with 401, before reading the body", async () => {
    world.userId = null;
    const response = await post({ topicSlug: "teletravail" });
    assert.equal(response.status, 401);
    assert.deepEqual(world.queries, []);
  });

  it("refuses a missing subject with 400 and an unknown one with 404", async () => {
    assert.equal((await post({})).status, 400);
    assert.equal((await post("{nope")).status, 400);
    assert.equal((await post({ topicSlug: "sujet-retire" })).status, 404);
    assert.deepEqual(world.queries, []);
  });

  it("creates the sitting on the subject's existing row, for the signed-in caller, on the default examiner", async () => {
    const response = await post({ topicSlug: "teletravail" });
    assert.deepEqual(await response.json(), { examId: "41", persisted: true });

    assert.equal(world.queries.length, 2, "one lookup, one insert — no catalogue write");
    const [, insert] = world.queries;
    assert.match(insert.sql, /insert into "oral_exams"/);
    assert.ok(insert.params.includes("user_1"), "the sitting belongs to the caller Clerk named");
    assert.ok(insert.params.includes(7), "on the catalogue row the lookup found");
    assert.ok(insert.params.includes("preparation"));
    assert.ok(insert.params.includes(LIVE_MODEL));
  });

  it("writes the subject to the catalogue first when it is not there yet", async () => {
    world.topicRowId = null;
    const response = await post({ topicSlug: "teletravail" });
    assert.deepEqual(await response.json(), { examId: "41", persisted: true });
    assert.equal(world.queries.length, 3);
    assert.match(world.queries[1].sql, /insert into "oral_topics"/);
    assert.ok(world.queries[2].params.includes(8), "the sitting points at the row just written");
  });

  it("hands out a local id when there is no database, and says so", async () => {
    world.databaseConfigured = false;
    const body = await (await post({ topicSlug: "teletravail" })).json();
    assert.match(body.examId, /^local-\d+$/);
    assert.equal(body.persisted, false);
    assert.deepEqual(world.queries, []);
  });

  it("degrades to a local id when the database refuses, rather than refusing the épreuve", async () => {
    world.databaseFails = true;
    const original = console.error;
    console.error = () => {};
    try {
      const body = await (await post({ topicSlug: "teletravail" })).json();
      assert.match(body.examId, /^local-\d+$/);
      assert.equal(body.persisted, false);
    } finally {
      console.error = original;
    }
  });
});
