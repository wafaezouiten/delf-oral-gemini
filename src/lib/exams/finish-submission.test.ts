import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findTopic } from "@/lib/delf/topics";
import type { ExamFinishedPayload } from "@/lib/live/exam-controller";
import { CORRECTION_TIMED_OUT } from "@/lib/ui/finish-failure";

import { MAX_RECORDING_BYTES } from "./uploaded-recording";
import {
  buildFinishForm,
  finishStash,
  submitFinish,
  type FinishOutcome,
} from "./finish-submission";

const topic = findTopic("teletravail")!;

const recording = (phase: "monologue" | "debate", bytes: number, mimeType = "audio/ogg") => ({
  phase,
  blob: new Blob([new Uint8Array(bytes)], { type: mimeType }),
  mimeType,
});

const payload = (recordings = [recording("monologue", 1000), recording("debate", 2000)]) =>
  ({
    transcript: [{ phase: "monologue", speaker: "candidate", timestamp: 0, text: "Bonjour" }],
    recordings,
    phases: [
      { phase: "monologue", elapsedSeconds: 400, recordedSeconds: 398, startedAt: 0, endedAt: 1 },
      { phase: "debate", elapsedSeconds: 600, recordedSeconds: 590, startedAt: 2, endedAt: 3 },
    ],
    reconnectCount: 1,
    earlyClosingCount: 0,
    soloVoicedSeconds: { monologue: 380, debate: 300 },
    soloSeconds: { monologue: 398, debate: 320 },
  }) as ExamFinishedPayload;

const quiet = <T>(fn: () => Promise<T> | T) => {
  const { warn, error, info } = console;
  console.warn = console.error = console.info = () => {};
  return Promise.resolve(fn()).finally(() => Object.assign(console, { warn, error, info }));
};

describe("the finish form", () => {
  it("carries the payload as JSON and each recording under its phase, named by what the bytes are", async () => {
    const { form, dropped } = buildFinishForm(
      payload([recording("monologue", 10), recording("debate", 20, "audio/wav")]),
      "teletravail",
    );
    const json = JSON.parse(form.get("payload") as string);
    assert.equal(json.topicSlug, "teletravail");
    assert.equal(json.reconnectCount, 1);
    assert.deepEqual(json.soloSeconds, { monologue: 398, debate: 320 });
    assert.equal((form.get("audio-monologue") as File).name, "monologue.ogg");
    assert.equal((form.get("audio-debate") as File).name, "debate.wav");
    assert.deepEqual(dropped, []);
  });

  it("leaves out a recording that does not fit beside the rest, and names the phase", async () => {
    const { form, dropped } = await quiet(() =>
      buildFinishForm(
        payload([recording("monologue", 1000), recording("debate", MAX_RECORDING_BYTES + 1)]),
        "teletravail",
      ),
    );
    assert.ok(form.get("audio-monologue"));
    assert.equal(form.get("audio-debate"), null);
    assert.deepEqual(dropped, ["debate"]);
  });
});

describe("what the results page is handed", () => {
  it("stashes the correction with the recorder's own measurement per phase", () => {
    const evaluation = { score25: 15 } as never;
    const stash = finishStash(payload(), topic, evaluation, "gemini-3.1-flash-live-preview");
    assert.equal(stash.evaluation, evaluation);
    assert.equal(stash.topic, topic);
    assert.equal(stash.monologueSeconds, 398);
    assert.equal(stash.debateSeconds, 590);
    assert.equal(stash.reconnectCount, 1);
    assert.equal(stash.examinerModel, "gemini-3.1-flash-live-preview");
    assert.equal("playable" in stash, false, "the response carries no uris");
  });

  it("measures a phase that never reported as zero", () => {
    const stash = finishStash({ ...payload(), phases: [] }, topic, {} as never, "m");
    assert.equal(stash.monologueSeconds, 0);
  });
});

describe("submitting the sitting", () => {
  const submit = (
    answer: { status: number; body: unknown } | Error,
    extra: Partial<Parameters<typeof submitFinish>[0]> = {},
  ) => {
    const events: string[] = [];
    const outcome = quiet(() =>
      submitFinish({
        examId: "41",
        topic,
        payload: payload(),
        form: new FormData(),
        examinerModel: "m",
        onUploadProgress: (fraction) => void events.push(`progress ${fraction}`),
        onAwaitingCorrection: () => void events.push("awaiting"),
        cancelled: () => false,
        post: async (url, _form, onProgress) => {
          events.push(`POST ${url}`);
          if (answer instanceof Error) throw answer;
          onProgress(1);
          return answer as never;
        },
        isCorrected: async () => true,
        waitOptions: { pollMs: 1, limitMs: 3, sleep: async () => {} },
        ...extra,
      }),
    );
    return { outcome, events };
  };

  it("posts to the sitting's finish route and stashes a correction that came in the answer", async () => {
    const { outcome, events } = submit({ status: 200, body: { evaluation: { score25: 15 } } });
    const result = (await outcome) as Extract<FinishOutcome, { kind: "stashed" }>;
    assert.equal(result.kind, "stashed");
    assert.deepEqual(result.stash.evaluation, { score25: 15 });
    assert.deepEqual(events, ["POST /api/exams/41/finish", "progress 1"]);
  });

  it("words a refusal with the route's own status and message", async () => {
    const { outcome } = submit({ status: 413, body: { error: "Requête trop volumineuse" } });
    const result = await outcome;
    assert.equal(result.kind, "failed");
    assert.ok(result.kind === "failed" && /trop volumineuse/.test(result.failure.message));
    assert.ok(result.kind === "failed" && !result.failure.retryable, "a 413 is not worth a retry");
  });

  it("waits for a correction the route is computing behind a 202, then reports it corrected", async () => {
    const { outcome, events } = submit({ status: 202, body: { pending: true } });
    assert.deepEqual(await outcome, { kind: "corrected" });
    assert.ok(events.includes("awaiting"), "the screen is told to draw the wait");
  });

  it("gives up on a correction that never comes, with the timeout's own words", async () => {
    const { outcome } = submit(
      { status: 202, body: { pending: true } },
      { isCorrected: async () => false },
    );
    assert.deepEqual(await outcome, { kind: "failed", failure: CORRECTION_TIMED_OUT });
  });

  it("reports a wait the screen left as cancelled, not as a failure", async () => {
    const { outcome } = submit(
      { status: 202, body: { pending: true } },
      { isCorrected: async () => false, cancelled: () => true },
    );
    assert.deepEqual(await outcome, { kind: "cancelled" });
  });

  it("treats a 200 with no JSON, or with neither word, as a plain failure", async () => {
    assert.equal((await submit({ status: 200, body: null }).outcome).kind, "failed");
    assert.equal((await submit({ status: 200, body: {} }).outcome).kind, "failed");
  });

  it("treats a request that never reached the route as a plain failure", async () => {
    const { outcome } = submit(new Error("network down"));
    assert.equal((await outcome).kind, "failed");
  });
});
