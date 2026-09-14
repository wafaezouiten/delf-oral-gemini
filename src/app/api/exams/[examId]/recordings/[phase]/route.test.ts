/**
 * Playback and deletion of one recording as HTTP. `decidePlayback` is tested
 * on its own; this is the route's order (phase parsed only for an authorised
 * caller, persistence after that), its answers, and the headers a stream
 * leaves with — `private, no-cache` and an ETag, so a shared computer replays
 * through this route and never out of its own disk cache.
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import type { ExamAccess } from "@/lib/auth/exam-access";
import type { RecordingRowForPlayback } from "@/lib/exams/recording-playback";
import type { OpenedRecording } from "@/lib/storage/recording-vault";
import { mockPackage } from "@/lib/testing/mock-package";

const OWNED: ExamAccess = {
  status: "owned",
  userId: "user_1",
  examId: 41,
  topicSlug: null,
  examinerModel: null,
};

const world = {
  access: OWNED as ExamAccess,
  row: null as RecordingRowForPlayback | null | Error,
  vaultConfigured: true,
  opened: null as OpenedRecording | null | Error,
  /** What `disposeRecording` answers: the uri it stamped, null for nothing, or a throw. */
  disposed: { uri: "vault://41/debate" } as { uri: string } | null | Error,
  discarded: [] as string[],
  discardFails: false,
};

mockPackage("server-only", {});
mockPackage("@/lib/auth/exam-guard", { authorizeExam: async () => world.access });
mockPackage("@/lib/db/sittings", {
  findRecording: async () => {
    if (world.row instanceof Error) throw world.row;
    return world.row;
  },
  disposeRecording: async () => {
    if (world.disposed instanceof Error) throw world.disposed;
    return world.disposed;
  },
});
mockPackage("@/lib/storage/recording-vault", {
  isRecordingVaultConfigured: () => world.vaultConfigured,
  recordingVault: () =>
    world.vaultConfigured
      ? {
          open: async () => {
            if (world.opened instanceof Error) throw world.opened;
            return world.opened;
          },
          discard: async (uri: string) => {
            if (world.discardFails) throw new Error("blob store is away");
            world.discarded.push(uri);
          },
        }
      : null,
});

let route: typeof import("./route");

before(async () => {
  route = await import("./route");
});

beforeEach(() => {
  world.access = OWNED;
  world.row = { uri: "vault://41/debate", mimeType: "audio/ogg", byteSize: 1234, deletedAt: null };
  world.vaultConfigured = true;
  world.opened = {
    status: 200,
    stream: new Blob([new Uint8Array([1, 2, 3])]).stream(),
    byteSize: 3,
    etag: '"abc"',
  };
  world.disposed = { uri: "vault://41/debate" };
  world.discarded = [];
  world.discardFails = false;
});

const context = (phase: string) => ({ params: Promise.resolve({ examId: "41", phase }) });
const get = (phase = "debate", headers: Record<string, string> = {}) =>
  route.GET(
    new Request("http://localhost/api/exams/41/recordings/" + phase, { headers }),
    context(phase),
  );
const del = (phase = "debate") =>
  route.DELETE(
    new Request("http://localhost/api/exams/41/recordings/" + phase, { method: "DELETE" }),
    context(phase),
  );

const quiet = (fn: () => Promise<Response>) => {
  const { error } = console;
  console.error = () => {};
  return fn().finally(() => Object.assign(console, { error }));
};

describe("GET /api/exams/[examId]/recordings/[phase]", () => {
  it("streams the kept bytes with the row's type, an ETag, and no cache but a revalidation", async () => {
    const response = await get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/ogg");
    assert.equal(response.headers.get("etag"), '"abc"');
    assert.equal(response.headers.get("cache-control"), "private, no-cache");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("accept-ranges"), null, "no ranges, on purpose");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  });

  it("answers a bodiless 304 when the store says the ETag still matches", async () => {
    world.opened = { status: 304, etag: '"abc"' };
    const response = await get("debate", { "if-none-match": '"abc"' });
    assert.equal(response.status, 304);
    assert.equal(response.headers.get("etag"), '"abc"');
    assert.equal(await response.text(), "");
  });

  it("answers 404 for a phase that is not a speaking phase — only for an authorised caller", async () => {
    assert.equal((await get("preparation")).status, 404);
    world.access = { status: "denied", reason: "unauthenticated" };
    assert.equal((await get("preparation")).status, 401, "denied before the path is looked at");
  });

  it("answers 404 for a sitting never persisted, with nothing to serve", async () => {
    world.access = { status: "no-sitting", userId: "user_1", reason: "unpersisted-id" };
    assert.equal((await get()).status, 404);
  });

  it("answers 404 for no row, and for bytes that were disposed of", async () => {
    world.row = null;
    assert.equal((await get()).status, 404);
    world.row = { uri: null, mimeType: "audio/ogg", byteSize: 1234, deletedAt: new Date() };
    const disposed = await get();
    assert.equal(disposed.status, 404);
    assert.match((await disposed.json()).error, /pas été conservé/);
  });

  it("answers 503 when the row promises bytes and this deployment has no vault", async () => {
    world.vaultConfigured = false;
    const response = await quiet(() => get());
    assert.equal(response.status, 503);
  });

  it("answers 503 when the vault cannot open the bytes — a blip, not a verdict", async () => {
    world.opened = new Error("blob store is away");
    assert.equal((await quiet(() => get())).status, 503);
    world.opened = null;
    assert.equal((await quiet(() => get())).status, 503);
  });

  it("treats a row that cannot be read as nothing to play, not an error", async () => {
    world.row = new Error("connection terminated");
    assert.equal((await quiet(() => get())).status, 404);
  });
});

describe("DELETE /api/exams/[examId]/recordings/[phase]", () => {
  it("stamps the row first and clears the store second", async () => {
    const response = await del();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: true });
    assert.deepEqual(world.discarded, ["vault://41/debate"]);
  });

  it("answers 404 when there was nothing to delete — an absence is what was asked for", async () => {
    world.disposed = null;
    assert.equal((await del()).status, 404);
    assert.deepEqual(world.discarded, []);
  });

  it("answers 503 and keeps the recording when the stamp itself fails", async () => {
    world.disposed = new Error("connection terminated");
    const response = await quiet(() => del());
    assert.equal(response.status, 503);
    assert.deepEqual(world.discarded, []);
  });

  it("still answers deleted:true when the store keeps the bytes — the row already says deleted", async () => {
    world.discardFails = true;
    const response = await quiet(() => del());
    assert.deepEqual(await response.json(), { deleted: true });
  });

  it("answers 404 for a phase that is not a speaking phase, and for an unpersisted sitting", async () => {
    assert.equal((await del("preparation")).status, 404);
    world.access = { status: "no-sitting", userId: "user_1", reason: "no-database" };
    assert.equal((await del()).status, 404);
  });
});
