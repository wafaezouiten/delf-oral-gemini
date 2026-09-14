/**
 * The exposé's transcription as HTTP: the size ladder, the format decided by
 * the bytes, the floor under which there is nothing to transcribe, and the
 * one failure that answers 502 rather than stopping an épreuve.
 *
 * The transcriber is mocked whole — it is a model call, and what it does with
 * audio is `transcribe-monologue.test.ts`'s. What is under test is which bytes
 * reach it, and what the candidate hears back when they do not.
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import type { ExamAccess } from "@/lib/auth/exam-access";
import { pcm16ToWav } from "@/lib/audio/pcm";
import { MAX_RECORDING_BYTES, MIN_RECORDING_SECONDS } from "@/lib/exams/uploaded-recording";
import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import { mockPackage } from "@/lib/testing/mock-package";

const world = {
  access: { status: "no-sitting", userId: "user_1", reason: "unpersisted-id" } as ExamAccess,
  text: "Bonjour, je vais parler du télétravail." as string | Error,
  transcribed: [] as { bytes: number; mimeType: string }[],
};

mockPackage("server-only", {});
mockPackage("@/lib/auth/exam-guard", { authorizeExam: async () => world.access });
mockPackage("@/lib/gemini/transcribe-monologue", {
  transcribeMonologue: async (audio: ArrayBuffer, mimeType: string) => {
    world.transcribed.push({ bytes: audio.byteLength, mimeType });
    if (world.text instanceof Error) throw world.text;
    return world.text;
  },
});

let POST: typeof import("./route").POST;

before(async () => {
  ({ POST } = await import("./route"));
});

beforeEach(() => {
  world.access = { status: "no-sitting", userId: "user_1", reason: "unpersisted-id" };
  world.text = "Bonjour, je vais parler du télétravail.";
  world.transcribed = [];
});

/** A mono WAV at the capture rate — the one fallback format the route admits. */
const wav = (seconds: number) =>
  pcm16ToWav(new Int16Array(Math.round(seconds * INPUT_SAMPLE_RATE)), INPUT_SAMPLE_RATE);

function upload(audio: Blob | null, headers: Record<string, string> = {}) {
  const form = new FormData();
  if (audio) form.set("audio", audio, "expose.wav");
  return POST(
    new Request("http://localhost/api/exams/41/monologue-transcript", {
      method: "POST",
      body: form,
      headers,
    }),
    { params: Promise.resolve({ examId: "41" }) },
  );
}

const quiet = (fn: () => Promise<Response>) => {
  const { info, error } = console;
  console.info = () => {};
  console.error = () => {};
  return fn().finally(() => Object.assign(console, { info, error }));
};

describe("POST /api/exams/[examId]/monologue-transcript", () => {
  it("transcribes a readable recording and answers its text", async () => {
    const response = await quiet(() => upload(wav(MIN_RECORDING_SECONDS + 5)));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "Bonjour, je vais parler du télétravail." });
    assert.equal(world.transcribed.length, 1);
    assert.equal(
      world.transcribed[0].mimeType,
      "audio/wav",
      "the type the bytes were measured to be",
    );
  });

  it("refuses a declared length over the cap with 413 before reading the body", async () => {
    const response = await upload(wav(1), { "content-length": String(MAX_RECORDING_BYTES + 1) });
    assert.equal(response.status, 413);
    assert.deepEqual(world.transcribed, []);
  });

  it("refuses a file over the cap with 413 once it has been read, before measuring it", async () => {
    // A chunked upload declares no length, so the header check above cannot
    // catch it; the blob's own size is the second half of the same guard.
    const response = await upload(new Blob([new Uint8Array(MAX_RECORDING_BYTES + 1)]));
    assert.equal(response.status, 413);
    assert.deepEqual(world.transcribed, []);
  });

  it("refuses a body that is not a form with 400", async () => {
    const response = await POST(
      new Request("http://localhost/api/exams/41/monologue-transcript", {
        method: "POST",
        body: "not a form",
        headers: { "content-type": "text/plain" },
      }),
      { params: Promise.resolve({ examId: "41" }) },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Requête illisible" });
  });

  it("refuses a missing or empty audio part with 400", async () => {
    assert.deepEqual(await (await upload(null)).json(), { error: "audio manquant" });
    assert.deepEqual(await (await upload(new Blob([]))).json(), { error: "audio manquant" });
  });

  it("refuses bytes that are neither Ogg Opus nor a capture-rate WAV with 400", async () => {
    const response = await upload(new Blob([new Uint8Array(4096)]));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Enregistrement illisible" });
    assert.deepEqual(world.transcribed, []);
  });

  it("answers an empty transcript for a recording under the floor, without a model call", async () => {
    const response = await quiet(() => upload(wav(MIN_RECORDING_SECONDS - 1)));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "" });
    assert.deepEqual(world.transcribed, []);
  });

  it("answers 502 when the transcriber fails: a missing transcript, not a stopped épreuve", async () => {
    world.text = new Error("model unavailable");
    const response = await quiet(() => upload(wav(MIN_RECORDING_SECONDS + 5)));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "La transcription a échoué" });
  });

  it("is refused by examRoute for a denied access, before the upload is read", async () => {
    world.access = { status: "denied", reason: "unauthenticated" };
    const response = await upload(wav(MIN_RECORDING_SECONDS + 5));
    assert.equal(response.status, 401);
    assert.deepEqual(world.transcribed, []);
  });
});
