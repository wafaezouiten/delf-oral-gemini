/**
 * The prompt editor's read of the shipped instruction. `DEV_TOOLS_ENABLED` is
 * a module-scope constant read off the environment, so one file pins it one
 * way: this one runs the route as a development build sees it. The refusal on
 * every other build is one line — `if (!DEV_TOOLS_ENABLED) 404` — and the
 * flag's own decision is `dev-tools.test.ts`'s.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { buildExaminerInstruction, EXAMINER_PROMPT_VERSION } from "@/lib/delf/examiner-prompt";
import { findTopic } from "@/lib/delf/topics";
import { mockPackage } from "@/lib/testing/mock-package";

mockPackage("@/lib/dev-tools", { DEV_TOOLS_ENABLED: true });

let GET: typeof import("./route").GET;

before(async () => {
  ({ GET } = await import("./route"));
});

const get = (query: string) =>
  GET(new Request(`http://localhost/api/dev/examiner-prompt?${query}`));

describe("GET /api/dev/examiner-prompt", () => {
  it("answers the instruction this repository would mint, and its version", async () => {
    const response = await get("phase=debate&topicSlug=teletravail");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.version, EXAMINER_PROMPT_VERSION);
    assert.equal(body.prompt, buildExaminerInstruction("debate", findTopic("teletravail")!));
  });

  it("refuses a phase that is not a speaking phase with 400", async () => {
    assert.equal((await get("phase=preparation&topicSlug=teletravail")).status, 400);
    assert.equal((await get("topicSlug=teletravail")).status, 400);
  });

  it("refuses a subject the catalogue does not have, or none, with 404", async () => {
    assert.equal((await get("phase=monologue&topicSlug=sujet-retire")).status, 404);
    assert.equal((await get("phase=monologue")).status, 404);
  });
});
