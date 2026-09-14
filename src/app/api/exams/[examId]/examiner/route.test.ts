/**
 * The examiner choice as HTTP: a body that must name an allow-listed model,
 * and three answers — no row, written, refused by the row's own guard — all
 * 200, because none of them is something the client could act on by retrying.
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import type { ExamAccess } from "@/lib/auth/exam-access";
import { LIVE_MODEL } from "@/lib/gemini/constants";
import { mockPackage } from "@/lib/testing/mock-package";

const world = {
  access: { status: "denied", reason: "unauthenticated" } as ExamAccess,
  /** What the statement answers, or throws when it is an Error. */
  recorded: true as boolean | Error,
  chosen: [] as unknown[],
};

mockPackage("server-only", {});
mockPackage("@/lib/auth/exam-guard", { authorizeExam: async () => world.access });
mockPackage("@/lib/db/sittings", {
  chooseExaminerModel: async (ref: unknown, model: string) => {
    world.chosen.push([ref, model]);
    if (world.recorded instanceof Error) throw world.recorded;
    return world.recorded;
  },
});

let POST: typeof import("./route").POST;

before(async () => {
  ({ POST } = await import("./route"));
});

beforeEach(() => {
  world.access = {
    status: "owned",
    userId: "user_1",
    examId: 41,
    topicSlug: null,
    examinerModel: null,
  };
  world.recorded = true;
  world.chosen = [];
});

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/exams/41/examiner", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ examId: "41" }) },
  );

describe("POST /api/exams/[examId]/examiner", () => {
  it("refuses a model outside the allow-list with 400, before touching the row", async () => {
    const response = await post({ model: "gemini-9-ultra" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Modèle inconnu" });
    assert.deepEqual(world.chosen, []);
  });

  it("refuses a body with no model, and one that is not JSON, the same way", async () => {
    assert.equal((await post({})).status, 400);
    assert.equal((await post("{nope")).status, 400);
  });

  it("answers recorded:false persisted:false when there is no row to write", async () => {
    world.access = { status: "no-sitting", userId: "user_1", reason: "unpersisted-id" };
    const response = await post({ model: LIVE_MODEL });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { recorded: false, persisted: false });
    assert.deepEqual(world.chosen, []);
  });

  it("writes the choice onto the owned row and answers what the statement said", async () => {
    const response = await post({ model: LIVE_MODEL });
    assert.deepEqual(await response.json(), { recorded: true, persisted: true });
    assert.deepEqual(world.chosen, [[{ examId: 41, userId: "user_1" }, LIVE_MODEL]]);
  });

  it("answers 200 with recorded:false when the row's guard refused — a stale tab is not an error", async () => {
    world.recorded = false;
    const response = await post({ model: LIVE_MODEL });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { recorded: false, persisted: true });
  });

  it("answers 503 when the statement throws", async () => {
    world.recorded = new Error("neon is away");
    const original = console.error;
    console.error = () => {};
    try {
      const response = await post({ model: LIVE_MODEL });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "Choix non enregistré" });
    } finally {
      console.error = original;
    }
  });

  it("is refused by examRoute for a denied access, and reads no body", async () => {
    world.access = { status: "denied", reason: "not-found" };
    const response = await post({ model: LIVE_MODEL });
    assert.equal(response.status, 404);
  });
});
