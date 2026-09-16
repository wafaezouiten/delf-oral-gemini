/**
 * The binding around `parseLiveTokenRequest` and `gateLiveToken`, which are
 * tested on their own in `lib/gemini/live-token-request.test.ts`. What is left
 * to this file is the route's own order and its answers: the key is checked
 * before anything costs a round trip, a refusal is the gate's over HTTP, and
 * a mint is one `authTokens.create` whose constraint carries the whole config.
 *
 * Google is mocked at the SDK — the constraint is asserted on, never sent.
 * `authorizeExam` is mocked whole; the decision is `exam-guard.test.ts`'s.
 * `DEV_TOOLS_ENABLED` is pinned false so the route runs as production does.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

// The real SDK's enums and types — `liveConfigForPhase` reads `Modality` —
// under a client whose one method is ours.
import * as genai from "@google/genai";

import type { ExamAccess } from "@/lib/auth/exam-access";
import { LIVE_MODEL } from "@/lib/gemini/constants";
import { mockPackage } from "@/lib/testing/mock-package";

const world = {
  access: { status: "denied", reason: "unauthenticated" } as ExamAccess,
  /** What `authTokens.create` answers, or throws when it is an Error. */
  token: { name: "auth_tokens/abc" } as { name?: string } | Error,
  /** Every constraint the SDK was asked to pin. */
  minted: [] as unknown[],
};

mockPackage("server-only", {});
mockPackage("@/lib/dev-tools", { DEV_TOOLS_ENABLED: false });
mockPackage("@/lib/auth/exam-guard", { authorizeExam: async () => world.access });
mockPackage("@google/genai", {
  ...genai,
  GoogleGenAI: class {
    authTokens = {
      create: async (args: unknown) => {
        world.minted.push(args);
        if (world.token instanceof Error) throw world.token;
        return world.token;
      },
    };
  },
});

let POST: typeof import("./route").POST;
const savedKey = process.env.GEMINI_API_KEY;

before(async () => {
  ({ POST } = await import("./route"));
});

after(() => {
  if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedKey;
});

beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-key";
  world.access = { status: "denied", reason: "unauthenticated" };
  world.token = { name: "auth_tokens/abc" };
  world.minted = [];
});

const OWNED: ExamAccess = {
  status: "owned",
  userId: "user_1",
  examId: 41,
  topicSlug: "teletravail",
  examinerModel: null,
};

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/live-token", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );

const valid = { phase: "monologue", examId: "41", topicSlug: "teletravail" };

describe("POST /api/live-token", () => {
  it("refuses with 500 before reading anything when the key is not configured", async () => {
    delete process.env.GEMINI_API_KEY;
    const response = await post(valid);
    assert.equal(response.status, 500);
    assert.deepEqual(world.minted, []);
  });

  it("answers the parser's refusal, before the sitting is looked up", async () => {
    const response = await post({ ...valid, phase: "lunch" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Phase invalide" });
  });

  it("answers a body that is not JSON as the parser's 400, not a crash", async () => {
    const response = await post("{not json");
    assert.equal(response.status, 400);
  });

  it("answers the gate's denial over HTTP, and mints nothing", async () => {
    world.access = { status: "denied", reason: "not-found" };
    const response = await post(valid);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Épreuve introuvable" });
    assert.deepEqual(world.minted, []);
  });

  it("mints one single-use token whose constraint pins the model AND the config", async () => {
    world.access = OWNED;
    const response = await post({ ...valid, resumptionHandle: "h".repeat(40) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { token: "auth_tokens/abc", model: LIVE_MODEL });

    assert.equal(world.minted.length, 1);
    const { config } = world.minted[0] as {
      config: {
        uses: number;
        expireTime: string;
        newSessionExpireTime: string;
        liveConnectConstraints: { model: string; config: unknown };
      };
    };
    assert.equal(config.uses, 1);
    assert.ok(Date.parse(config.expireTime) > Date.now());
    assert.ok(Date.parse(config.newSessionExpireTime) < Date.parse(config.expireTime));
    assert.equal(config.liveConnectConstraints.model, LIVE_MODEL);
    // Model alone => 1011 on connect; the config has to be in the constraint.
    assert.ok(config.liveConnectConstraints.config, "the constraint carries the session config");
  });

  it("mints with the sitting's own examiner when the row names one on the allow-list", async () => {
    world.access = { ...OWNED, examinerModel: LIVE_MODEL };
    const response = await post({
      ...valid,
      model: "gemini-2.5-flash-native-audio-preview-12-2025",
    });
    assert.deepEqual(await response.json(), { token: "auth_tokens/abc", model: LIVE_MODEL });
  });

  it("mints for the requested subject when there is no sitting to read", async () => {
    world.access = { status: "no-sitting", userId: "user_1", reason: "unpersisted-id" };
    const response = await post({ ...valid, examId: "local-1" });
    assert.equal(response.status, 200);
    assert.equal(world.minted.length, 1);
  });

  it("answers 404 when the sitting names a subject the catalogue no longer has", async () => {
    world.access = { ...OWNED, topicSlug: "sujet-retire" };
    const response = await post(valid);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Sujet inconnu" });
    assert.deepEqual(world.minted, []);
  });

  it("answers 502 with a generic body when the mint fails, and never echoes the error", async () => {
    world.access = OWNED;
    world.token = new Error("API key not valid: test-key");
    const response = await post(valid);
    assert.equal(response.status, 502);
    const body = JSON.stringify(await response.json());
    assert.doesNotMatch(body, /test-key/, "the message may carry the key; it stays server-side");
  });

  it("treats a mint that returns no token name as a failure", async () => {
    world.access = OWNED;
    world.token = {};
    const response = await post(valid);
    assert.equal(response.status, 502);
  });
});
