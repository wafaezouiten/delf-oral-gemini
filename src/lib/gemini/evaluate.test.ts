/**
 * The corrector call, end to end, with Google mocked at the SDK.
 *
 * Everything this function composes is tested on its own — the prompt, the
 * reply's contract, the rubric, the retry, the file activation. What was never
 * under a test is the composition: which parts reach the model in which mode,
 * which failure becomes which `EvaluationFailure`, and that the result the
 * route stores is the rubric's reading of the model's numbers rather than the
 * model's own total. That is what this file holds.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

// The real SDK's enums and helpers (`Type`, `createPartFromUri`) under a client
// whose three calls are ours.
import * as genai from "@google/genai";

import { findTopic } from "@/lib/delf/topics";
import type { TranscriptEntry } from "@/lib/delf/transcript";
import { mockPackage } from "@/lib/testing/mock-package";

import { EvaluationFailure } from "./evaluation-failure";

const world = {
  /** What `generateContent` answers: the reply text, or a throw. */
  reply: "" as string | Error,
  /** What `files.upload` answers, per call, or a throw for all of them. */
  upload: { name: "files/x", uri: "https://files/x", mimeType: "audio/ogg", state: "ACTIVE" } as
    Record<string, unknown> | Error,
  generated: [] as { model: string; parts: unknown[] }[],
  uploaded: [] as { mimeType: string; size: number }[],
};

mockPackage("server-only", {});
mockPackage("@google/genai", {
  ...genai,
  GoogleGenAI: class {
    files = {
      upload: async ({ file, config }: { file: Blob; config: { mimeType: string } }) => {
        world.uploaded.push({ mimeType: config.mimeType, size: file.size });
        if (world.upload instanceof Error) throw world.upload;
        return world.upload;
      },
      get: async () => world.upload,
    };
    models = {
      generateContent: async (args: { model: string; contents: { parts: unknown[] }[] }) => {
        world.generated.push({ model: args.model, parts: args.contents[0].parts });
        if (world.reply instanceof Error) throw world.reply;
        return {
          text: world.reply,
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        };
      },
    };
  },
});

let evaluateExam: typeof import("./evaluate").evaluateExam;
let EVAL_MODEL: string;
const savedKey = process.env.GEMINI_API_KEY;

before(async () => {
  ({ evaluateExam, EVAL_MODEL } = await import("./evaluate"));
});

after(() => {
  if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedKey;
});

beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-key";
  world.reply = reply();
  world.upload = {
    name: "files/x",
    uri: "https://files/x",
    mimeType: "audio/ogg",
    state: "ACTIVE",
  };
  world.generated = [];
  world.uploaded = [];
});

function reply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    realisationTache: { score: 5, justification: "position claire" },
    interaction: { score: 3, justification: "défend sa position" },
    lexique: { score: 3, justification: "vocabulaire suffisant" },
    morphosyntaxe: { score: 1, justification: "accords fautifs" },
    phonologie: { score: 3, justification: "intelligible" },
    total25: 15,
    phonologieNonEvaluable: false,
    appreciationGlobale: "prestation honnête",
    pointsForts: ["structure"],
    axesPrioritaires: ["accords"],
    conseil: "relisez les accords",
    ...overrides,
  });
}

/** A sitting long and wordy enough that no duration or absence penalty applies. */
const words = (n: number) => Array.from({ length: n }, (_, i) => `mot${i}`).join(" ");
const transcript: TranscriptEntry[] = [
  { phase: "monologue", speaker: "candidate", timestamp: 0, text: words(700) },
  { phase: "debate", speaker: "examiner", timestamp: 400_000, text: "Pourquoi ?" },
  { phase: "debate", speaker: "candidate", timestamp: 410_000, text: words(900) },
];
const topic = findTopic("teletravail")!;
const base = { topic, transcript, monologueSeconds: 400, debateSeconds: 620 };

const quiet = <T>(fn: () => Promise<T>) => {
  const { info, warn } = console;
  console.info = () => {};
  console.warn = () => {};
  return fn().finally(() => Object.assign(console, { info, warn }));
};

describe("evaluateExam", () => {
  it("refuses to start without an API key", async () => {
    delete process.env.GEMINI_API_KEY;
    await assert.rejects(evaluateExam({ ...base, mode: "text" }), /GEMINI_API_KEY/);
    assert.deepEqual(world.generated, []);
  });

  it("in text mode sends the prompt alone, and answers the rubric's reading of the reply", async () => {
    const result = await quiet(() => evaluateExam({ ...base, mode: "text" }));

    assert.equal(world.uploaded.length, 0);
    assert.equal(world.generated.length, 1);
    assert.equal(world.generated[0].model, EVAL_MODEL);
    assert.equal(world.generated[0].parts.length, 1, "the prompt, and nothing attached");

    assert.equal(result.mode, "text");
    assert.deepEqual(result.rawCriteria, {
      realisationTache: 5,
      interaction: 3,
      lexique: 3,
      morphosyntaxe: 1,
      phonologie: 3,
    });
    assert.equal(result.modelTotal25, 15, "the model's own total is kept for the record");
    // Text mode: phonology was not heard, so a 5 the model awarded from a
    // transcript is capped to the unheard ceiling — a 3 is already under it.
    assert.equal(result.phonologyCapped, false);
    assert.equal(result.criteria.phonologie, 3);
    assert.equal(result.feedback.justifications.morphosyntaxe, "accords fautifs");
    assert.equal(result.feedback.conseil, "relisez les accords");
    assert.equal(result.model, EVAL_MODEL);
    assert.equal(result.usage.promptTokens, 10);
    assert.equal(result.usage.responseTokens, 5);
  });

  it("in text mode caps a phonology the model could only have guessed", async () => {
    world.reply = reply({ phonologie: { score: 5, justification: "prononciation parfaite" } });
    const result = await quiet(() => evaluateExam({ ...base, mode: "text" }));
    assert.equal(result.rawCriteria.phonologie, 5, "what the model said is kept");
    assert.equal(result.phonologyCapped, true);
    assert.ok(result.criteria.phonologie < 5, "what is graded is not");
  });

  it("in audio mode uploads each recording, waits for it, and attaches it after the prompt", async () => {
    const result = await quiet(() =>
      evaluateExam({
        ...base,
        mode: "audio",
        audio: [
          { phase: "monologue", blob: new Blob([new Uint8Array(10)]), mimeType: "audio/ogg" },
          { phase: "debate", blob: new Blob([new Uint8Array(20)]) },
        ],
      }),
    );

    assert.deepEqual(world.uploaded, [
      { mimeType: "audio/ogg", size: 10 },
      // A recording that names no type is the archive's WAV fallback.
      { mimeType: "audio/wav", size: 20 },
    ]);
    assert.equal(world.generated[0].parts.length, 3, "the prompt and two file parts");
    assert.equal(result.phonologyCapped, false, "audio mode: a 5 would stand, and a 3 does");
  });

  it("in audio mode a phonology the model heard is graded as awarded", async () => {
    world.reply = reply({ phonologie: { score: 5, justification: "prononciation parfaite" } });
    const result = await quiet(() =>
      evaluateExam({ ...base, mode: "audio", audio: new Blob([new Uint8Array(10)]) }),
    );
    assert.equal(result.criteria.phonologie, 5);
    assert.equal(result.phonologyCapped, false);
  });

  it("in audio mode refuses to run without a recording, before any call", async () => {
    await assert.rejects(
      quiet(() => evaluateExam({ ...base, mode: "audio" })),
      /requires the candidate's recording/,
    );
    assert.deepEqual(world.generated, []);
  });

  it("names the upload as the failure when a recording cannot be made available", async () => {
    world.upload = new Error("400 Bad Request");
    await assert.rejects(
      quiet(() => evaluateExam({ ...base, mode: "audio", audio: new Blob([new Uint8Array(10)]) })),
      (error: unknown) =>
        error instanceof EvaluationFailure &&
        error.reason === "upload" &&
        /sitting/.test(error.message),
    );
    assert.deepEqual(world.generated, [], "the corrector is never asked");
  });

  it("names the model as the failure when it does not answer", async () => {
    world.reply = new Error("500 Internal Server Error");
    await assert.rejects(
      quiet(() => evaluateExam({ ...base, mode: "text" })),
      (error: unknown) => error instanceof EvaluationFailure && error.reason === "model",
    );
  });

  it("names an empty answer, and a reply that is not a correction, for what they are", async () => {
    world.reply = "";
    await assert.rejects(
      quiet(() => evaluateExam({ ...base, mode: "text" })),
      (error: unknown) => error instanceof EvaluationFailure && error.reason === "empty",
    );
    world.reply = "Je ne peux pas évaluer cet enregistrement.";
    await assert.rejects(
      quiet(() => evaluateExam({ ...base, mode: "text" })),
      (error: unknown) => error instanceof EvaluationFailure && error.reason === "contract",
    );
  });
});
