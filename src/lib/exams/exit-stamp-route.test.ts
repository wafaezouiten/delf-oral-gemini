/**
 * The shape both exit routes answer with, checked once for both.
 *
 * `authorizeExam` is mocked whole, as in `exam-route.test.ts`; what is under
 * test is what happens after a granted access — the three answers and the one
 * flag they are keyed by.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import type { ExamAccess } from "@/lib/auth/exam-access";
import { mockPackage } from "@/lib/testing/mock-package";

const world: { access: ExamAccess } = {
  access: { status: "denied", reason: "unauthenticated" },
};

mockPackage("server-only", {});
mockPackage("@/lib/auth/exam-guard", { authorizeExam: async () => world.access });

let exitStampRoute: typeof import("./exit-stamp-route").exitStampRoute;

before(async () => {
  ({ exitStampRoute } = await import("./exit-stamp-route"));
});

const OWNED: ExamAccess = {
  status: "owned",
  userId: "user_1",
  examId: 41,
  topicSlug: null,
  examinerModel: null,
};

const call = (route: ReturnType<typeof exitStampRoute>, examId = "41") =>
  route(new Request("http://localhost/api/exams/41/abandon", { method: "POST" }), {
    params: Promise.resolve({ examId }),
  });

describe("exitStampRoute", () => {
  it("answers 200 with the flag false and persisted false when there is no row", async () => {
    world.access = { status: "no-sitting", userId: "user_1", reason: "unpersisted-id" };
    let stamped = 0;
    const route = exitStampRoute({
      flag: "archived",
      stamp: async () => {
        stamped++;
        return true;
      },
      failure: () => "never",
      failureBody: "never",
    });

    const response = await call(route);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { archived: false, persisted: false });
    assert.equal(stamped, 0, "nothing to stamp, so the statement never runs");
  });

  it("stamps the owned sitting and answers what the statement said, under the flag", async () => {
    world.access = OWNED;
    const seen: unknown[] = [];
    const route = exitStampRoute({
      flag: "abandoned",
      stamp: async (ref, at) => {
        seen.push(ref, at);
        return false;
      },
      failure: () => "never",
      failureBody: "never",
    });

    const response = await call(route);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { abandoned: false, persisted: true });
    assert.deepEqual(seen[0], { examId: 41, userId: "user_1" });
    assert.ok(seen[1] instanceof Date);
  });

  it("logs a thrown statement for the id as requested, and answers 503", async () => {
    world.access = OWNED;
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const route = exitStampRoute({
        flag: "abandoned",
        stamp: async () => {
          throw new Error("neon is away");
        },
        failure: (examId) => `[abandon] could not mark exam ${examId} as abandoned`,
        failureBody: "Abandon non enregistré",
      });

      const response = await call(route, "41");
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "Abandon non enregistré" });
      assert.equal(logged.length, 1);
      assert.equal(logged[0][0], "[abandon] could not mark exam 41 as abandoned");
      assert.equal((logged[0][1] as Error).message, "neon is away");
    } finally {
      console.error = original;
    }
  });

  it("is refused before any of that for a denied access", async () => {
    world.access = { status: "denied", reason: "not-found" };
    const route = exitStampRoute({
      flag: "archived",
      stamp: async () => {
        throw new Error("must not run");
      },
      failure: () => "never",
      failureBody: "never",
    });
    const response = await call(route);
    assert.equal(response.status, 404);
  });
});
