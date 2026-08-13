import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import {
  EXAM_ACCESS_DENIALS,
  parsePersistedExamId,
  resolveExamAccess,
  type ExamOwnerLookup,
  type ExamOwnerRow,
} from "./exam-access";

const OWNER = "user_owner";
const INTRUDER = "user_intruder";

/** Two sittings, one each, so "someone else's exam" is a real row and not a gap. */
const ROWS: ExamOwnerRow[] = [
  { id: 41, userId: OWNER },
  { id: 42, userId: INTRUDER },
];

const lookup: ExamOwnerLookup = async (examId) => ROWS.find((row) => row.id === examId);

/** The database is reachable and configured unless a test says otherwise. */
function query(overrides: Partial<Parameters<typeof resolveExamAccess>[0]> = {}) {
  return { userId: OWNER, examId: "41", databaseConfigured: true, lookup, ...overrides };
}

describe("exam access", () => {
  it("lets the owner reach their own sitting", async () => {
    const access = await resolveExamAccess(query());
    assert.deepEqual(access, { status: "owned", userId: OWNER, examId: 41 });
  });

  it("refuses another signed-in user's sitting", async () => {
    const access = await resolveExamAccess(query({ userId: INTRUDER, examId: "41" }));
    assert.deepEqual(access, { status: "denied", reason: "not-found" });
  });

  it("answers a foreign sitting exactly as it answers a missing one", async () => {
    // The whole point of 404-not-403: an intruder must not be able to tell the
    // two apart and map which ids exist.
    const foreign = await resolveExamAccess(query({ userId: INTRUDER, examId: "41" }));
    const missing = await resolveExamAccess(query({ examId: "9999" }));
    assert.deepEqual(foreign, missing);
  });

  it("refuses a signed-out caller before it looks anything up", async () => {
    const spy = mock.fn(lookup);
    const access = await resolveExamAccess(query({ userId: null, lookup: spy }));
    assert.deepEqual(access, { status: "denied", reason: "unauthenticated" });
    assert.equal(spy.mock.callCount(), 0);
  });

  it("maps the two denials to 401 and 404", () => {
    assert.equal(EXAM_ACCESS_DENIALS.unauthenticated.status, 401);
    assert.equal(EXAM_ACCESS_DENIALS["not-found"].status, 404);
  });

  it("never reports a sitting as owned when the database cannot answer", async (t) => {
    t.mock.method(console, "error", () => {});
    const failing: ExamOwnerLookup = async () => {
      throw new Error("connection terminated");
    };
    const access = await resolveExamAccess(query({ lookup: failing }));
    assert.deepEqual(access, { status: "no-sitting", userId: OWNER, reason: "lookup-failed" });
  });

  it("degrades rather than denies when there is no database at all", async () => {
    const access = await resolveExamAccess(query({ databaseConfigured: false }));
    assert.deepEqual(access, { status: "no-sitting", userId: OWNER, reason: "no-database" });
  });

  it("treats a local id as addressing no row, without querying", async () => {
    const spy = mock.fn(lookup);
    const access = await resolveExamAccess(query({ examId: "local-1770000000000", lookup: spy }));
    assert.deepEqual(access, { status: "no-sitting", userId: OWNER, reason: "unpersisted-id" });
    assert.equal(spy.mock.callCount(), 0);
  });

  it("grants nothing for an id no row can have", async () => {
    for (const examId of ["", "0", "-1", "1.5", " 41", "41 ", "41; drop table", "1e3"]) {
      assert.equal(parsePersistedExamId(examId), null, examId);
      const access = await resolveExamAccess(query({ examId }));
      assert.notEqual(access.status, "owned", examId);
    }
  });

  it("does not round an oversized id onto a real sitting", () => {
    // 2^53 + 1 parses to a Number that is not itself, and 41 followed by enough
    // digits must not become 41.
    assert.equal(parsePersistedExamId("9007199254740993"), null);
    assert.equal(parsePersistedExamId("41"), 41);
  });
});
