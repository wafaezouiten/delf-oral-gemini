/**
 * The choke point: every handler under `api/exams/[examId]/` obtains its
 * `access` through `examRoute`, so a wrong turn here is a wrong turn in all of
 * them at once. `exam-access.test.ts` covers the policy and `exam-guard.test.ts`
 * the wiring to Clerk and the row; this covers the last inch, the HTTP shape of
 * a refusal and what a handler is handed when it is not refused.
 *
 * `authorizeExam` is mocked whole — the decision is somebody else's test — and
 * `server-only` to nothing, for the reason `exam-guard.test.ts` gives.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { mockPackage } from "@/lib/testing/mock-package";

import type { ExamAccess } from "./exam-access";

/** What the mocked guard answers with; a test sets it before calling. */
const world: { access: ExamAccess; askedFor: string[] } = {
  access: { status: "denied", reason: "unauthenticated" },
  askedFor: [],
};

mockPackage("server-only", {});
mockPackage("@/lib/auth/exam-guard", {
  authorizeExam: async (examId: string) => {
    world.askedFor.push(examId);
    return world.access;
  },
});

let examRoute: typeof import("./exam-route").examRoute;

before(async () => {
  ({ examRoute } = await import("./exam-route"));
});

const context = <P extends { examId: string }>(params: P) => ({ params: Promise.resolve(params) });
const request = () => new Request("http://localhost/api/exams/41/status");

describe("examRoute", () => {
  it("answers a denial as EXAM_ACCESS_DENIALS says, and never runs the handler", async () => {
    world.access = { status: "denied", reason: "unauthenticated" };
    let ran = 0;
    const handler = examRoute(async () => {
      ran++;
      return new Response("never");
    });

    const response = await handler(request(), context({ examId: "41" }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Non authentifié" });
    assert.equal(ran, 0);

    world.access = { status: "denied", reason: "not-found" };
    const missing = await handler(request(), context({ examId: "41" }));
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "Épreuve introuvable" });
    assert.equal(ran, 0, "somebody else's sitting is refused without reaching the route");
  });

  it("asks the guard about the id as written in the URL", async () => {
    world.access = { status: "no-sitting", userId: "user_1", reason: "unpersisted-id" };
    world.askedFor = [];
    await examRoute(async () => new Response())(request(), context({ examId: "local-abc" }));
    assert.deepEqual(world.askedFor, ["local-abc"]);
  });

  it("hands a granted access, the params and the entry time to the handler", async () => {
    const owned: ExamAccess = {
      status: "owned",
      userId: "user_1",
      examId: 41,
      topicSlug: "vie-professionnelle",
      examinerModel: null,
    };
    world.access = owned;
    const before = Date.now();

    const response = await examRoute<{ examId: string; phase: string }>(async (_request, exam) => {
      assert.deepEqual(exam.access, owned);
      assert.deepEqual(exam.params, { examId: "41", phase: "debate" });
      assert.ok(exam.receivedAt >= before && exam.receivedAt <= Date.now());
      return Response.json({ ok: true });
    })(request(), context({ examId: "41", phase: "debate" }));

    assert.deepEqual(await response.json(), { ok: true });
  });

  it("stamps the entry time before the params are awaited, not after", async () => {
    world.access = { status: "no-sitting", userId: "user_1", reason: "no-database" };
    // A `params` promise that takes a measurable while: `receivedAt` must land
    // before it resolves, or the finish route's total would omit the wait.
    let resolvedAt = 0;
    const slowParams = new Promise<{ examId: string }>((resolve) =>
      setTimeout(() => {
        resolvedAt = Date.now();
        resolve({ examId: "41" });
      }, 25),
    );

    let receivedAt = 0;
    await examRoute(async (_request, exam) => {
      receivedAt = exam.receivedAt;
      return new Response();
    })(request(), { params: slowParams });

    assert.ok(receivedAt < resolvedAt, `receivedAt ${receivedAt} should precede ${resolvedAt}`);
  });

  it("passes no-sitting through: that answer is the route's to give", async () => {
    world.access = { status: "no-sitting", userId: "user_1", reason: "lookup-failed" };
    const response = await examRoute(async (_request, { access }) =>
      Response.json({ status: access.status }),
    )(request(), context({ examId: "41" }));
    assert.deepEqual(await response.json(), { status: "no-sitting" });
  });
});
