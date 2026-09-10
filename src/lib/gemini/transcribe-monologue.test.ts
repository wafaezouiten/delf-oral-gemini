/**
 * The transcriber, and the silence it exists to make impossible.
 *
 * This module is the app's answer to the failure #206 recorded: past somewhere
 * under four minutes inside one manual-VAD activity, the Live session stops
 * producing an `inputTranscription` and never produces one, so every spoken
 * exposé of a realistic length reached the finish as zero candidate words. The
 * words now come off the recording instead.
 *
 * The remedy has the same shape as the failure — it can go wrong by producing
 * NOTHING, quietly, with no error anywhere — and it can go wrong that way for a
 * reason no reviewer would see: `gemini-3.5-transcribe` does not answer in text
 * parts. It answers in `audioTranscription` parts, and `response.text` is ""
 * however good the transcription was. Read through `.text` alone, a perfect
 * exposé is indistinguishable from a recording of an empty room, and the
 * corrector then grades a candidate who said nothing.
 *
 * So the cases below are mostly about where the words are read from, and about
 * the request that goes out — `temperature: 0` and NOTHING else, because this
 * model refuses `thinkingConfig` with a 400.
 *
 * `@google/genai` is mocked, which is what makes any of this testable without a
 * key and without a model. `./transient` is not: the real retry policy runs,
 * and while `transient.test.ts` owns which statuses are worth another attempt,
 * what this file adds is that the transcriber rides that policy at all.
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

import { mockPackage } from "@/lib/testing/mock-package";

/** One request, as the SDK received it. */
type Sent = {
  model: string;
  contents: {
    role: string;
    parts: { inlineData?: { data: string; mimeType: string }; text?: string }[];
  }[];
  config: Record<string, unknown>;
};

/**
 * What the fake model does. Mutable rather than re-mocked per test: the module
 * graph is loaded once, so the mock is installed once too, and a case changes
 * the world rather than the wiring.
 */
const world = {
  /** Every request that reached the SDK, in order. */
  sent: [] as Sent[],
  /** The key each client was constructed with. */
  keys: [] as (string | undefined)[],
  /** Queued answers, one per call. A function is called instead, to throw. */
  answers: [] as unknown[],
};

mockPackage("server-only", {});

mockPackage("@google/genai", {
  GoogleGenAI: class {
    constructor(options: { apiKey?: string }) {
      world.keys.push(options.apiKey);
    }

    models = {
      generateContent: async (request: Sent) => {
        world.sent.push(request);
        const answer = world.answers.shift();
        if (typeof answer === "function") answer();
        return answer;
      },
    };
  },
});

/** Loaded after the mocks, which is the whole reason it is loaded dynamically. */
let transcribe: typeof import("./transcribe-monologue");

before(async () => {
  // The id is read once, as the module loads, so an override has to be gone
  // before that: a developer with `GEMINI_TRANSCRIBE_MODEL` set in their shell
  // would otherwise fail the case below that names the default, for no reason
  // that has anything to do with their branch.
  delete process.env.GEMINI_TRANSCRIBE_MODEL;
  transcribe = await import("./transcribe-monologue");
});

/** Eight bytes that begin like a real Ogg page, so the base64 is worth checking. */
const AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]).buffer;
const AUDIO_BASE64 = Buffer.from(AUDIO).toString("base64");
const MIME = "audio/ogg;codecs=opus";

/** An answer in the shape this model returns: the words in parts of their own. */
const spoken = (...texts: string[]) => ({
  candidates: [{ content: { parts: texts.map((text) => ({ audioTranscription: { text } })) } }],
  // Empty, exactly as the SDK leaves it when the parts are not text parts.
  text: "",
});

/** What `@google/genai` throws: a plain Error carrying a status. */
const apiError = (status: number) => Object.assign(new Error(`boom ${status}`), { status });

beforeEach(() => {
  world.sent = [];
  world.keys = [];
  world.answers = [];
  process.env.GEMINI_API_KEY = "test-key";
});

describe("where the exposé's words are read from", () => {
  it("reads the transcription out of the part this model puts it in", async () => {
    // The case the module exists for. A `readTranscription` that trusted
    // `response.text` would return "" here — and "" is a legal answer meaning
    // "nobody spoke", so nothing downstream would report a problem. The finish
    // route would refuse the sitting, and a candidate who had just spoken for
    // seven minutes would be told they had said nothing.
    world.answers = [spoken("Bonjour, euh, je vais vous parler du télétravail.")];

    assert.equal(
      await transcribe.transcribeMonologue(AUDIO, MIME),
      "Bonjour, euh, je vais vous parler du télétravail.",
    );
  });

  it("joins every spoken part, in the order they arrived", async () => {
    world.answers = [spoken("Premièrement,", "le télétravail isole.", "Deuxièmement…")];

    assert.equal(
      await transcribe.transcribeMonologue(AUDIO, MIME),
      "Premièrement, le télétravail isole. Deuxièmement…",
    );
  });

  it("falls back to the text a general model answers with", async () => {
    // `GEMINI_TRANSCRIBE_MODEL` overrides the id, and the override exists for
    // the day this preview id is renamed. A general model answers in text
    // parts, and the same function has to keep working through it.
    world.answers = [
      { candidates: [{ content: { parts: [{ text: "ignored" }] } }], text: "  Le télétravail.  " },
    ];

    assert.equal(await transcribe.transcribeMonologue(AUDIO, MIME), "Le télétravail.");
  });

  it("treats a recording with nobody in it as an empty string, not a failure", async () => {
    // A real answer: the instruction asks for an empty string when there is no
    // speech, and the caller — the handover to the débat — decides what an
    // exposé of no words is worth. Throwing here would cost the épreuve.
    world.answers = [{ candidates: [{ content: { parts: [] } }], text: "" }];

    assert.equal(await transcribe.transcribeMonologue(AUDIO, MIME), "");
  });

  it("does not mistake whitespace for a transcription", async () => {
    // A part carrying only spaces is not speech, and it must not shadow the
    // text fallback the way any other non-empty string would.
    world.answers = [
      {
        candidates: [{ content: { parts: [{ audioTranscription: { text: "   " } }] } }],
        text: "Le télétravail.",
      },
    ];

    assert.equal(await transcribe.transcribeMonologue(AUDIO, MIME), "Le télétravail.");
  });

  it("survives an answer with no candidate in it at all", async () => {
    // What a filtered or truncated response looks like. The module reads
    // through optionals the whole way down; this is the case that says so.
    world.answers = [{}];

    assert.equal(await transcribe.transcribeMonologue(AUDIO, MIME), "");
  });
});

describe("what the transcriber is asked for", () => {
  it("sends the recording under the type it turned out to be", async () => {
    world.answers = [spoken("…")];
    await transcribe.transcribeMonologue(AUDIO, MIME);

    const [audio] = world.sent[0].contents[0].parts;
    assert.deepEqual(audio.inlineData, { data: AUDIO_BASE64, mimeType: MIME });
    // Inline rather than the Files API: one part's Opus is about 840 kB at
    // seven minutes, and skipping the upload-then-wait-for-ACTIVE dance is
    // skipping #73's best-fit race, on a call a candidate is waiting through.
    assert.equal(world.sent.length, 1, "one call, and no upload before it");
    assert.deepEqual(world.keys, ["test-key"]);
  });

  it("asks the model whose job this is", async () => {
    world.answers = [spoken("…")];
    await transcribe.transcribeMonologue(AUDIO, MIME);

    assert.equal(world.sent[0].model, transcribe.TRANSCRIBE_MODEL);
    assert.equal(transcribe.TRANSCRIBE_MODEL, "gemini-3.5-transcribe");
  });

  it("asks at temperature 0, and asks for nothing else", async () => {
    world.answers = [spoken("…")];
    await transcribe.transcribeMonologue(AUDIO, MIME);

    // `deepEqual`, not a property check, and that is the point: this model
    // refuses `thinkingConfig` outright — « Thinking level is not supported for
    // this model », 400 — so a helpful addition to this config is a transcriber
    // that stops answering. The absence is load-bearing.
    assert.deepEqual(world.sent[0].config, { temperature: 0 });
  });

  it("asks in French for a transcript with nothing of its own in it", async () => {
    world.answers = [spoken("…")];
    await transcribe.transcribeMonologue(AUDIO, MIME);

    const instruction = world.sent[0].contents[0].parts[1].text ?? "";
    // The hesitations are evidence: « euh » is what the grille's phonologie and
    // its aisance are read off.
    assert.match(instruction, /hésitations/);
    // The model's own voice is not. A transcriber that writes « [silence] » or
    // « L'étudiant dit : » puts its words in the corrector's ear as the
    // candidate's, which is the failure #187 spent a release removing from the
    // examiner's side.
    assert.match(instruction, /aucun crochet/);
    assert.match(instruction, /aucun nom de locuteur/);
  });
});

describe("when the call fails", () => {
  it("refuses to call at all without a key", async () => {
    delete process.env.GEMINI_API_KEY;

    await assert.rejects(
      () => transcribe.transcribeMonologue(AUDIO, MIME),
      /GEMINI_API_KEY is not set/,
    );
    assert.deepEqual(world.sent, [], "nothing should have reached the SDK");
  });

  it("asks a busy transcriber again", async (t) => {
    // The retry logs what it is riding out, deliberately and loudly. Silence it
    // for this case alone, so a passing run stays readable.
    t.mock.method(console, "warn", () => {});

    // The wiring, not the policy. A 503 here is a candidate's exposé, and the
    // identical request goes through moments later.
    world.answers = [
      () => {
        throw apiError(503);
      },
      spoken("Le télétravail."),
    ];

    // The backoff is two real seconds by default, and this test is not going to
    // spend them: the wait is fired by hand as soon as it has been scheduled.
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = transcribe.transcribeMonologue(AUDIO, MIME);
      // Let the first attempt reject and the retry schedule its wait. The
      // rejection travels by microtask; `setImmediate` is a later turn than any
      // of them, and is not among the mocked APIs.
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.runAll();

      assert.equal(await pending, "Le télétravail.");
    } finally {
      mock.timers.reset();
    }

    assert.equal(world.sent.length, 2, "the second attempt should be the identical request");
    assert.deepEqual(world.sent[0], world.sent[1]);
  });

  it("does not retry a failure that will fail the same way forever", async () => {
    // A retired model id is a 404, and this preview id will be retired.
    // Retrying it would spend the whole backoff proving what the first attempt
    // already knew, while the candidate waits on the débat's consigne.
    world.answers = [
      () => {
        throw apiError(404);
      },
    ];

    await assert.rejects(() => transcribe.transcribeMonologue(AUDIO, MIME), /boom 404/);
    assert.equal(world.sent.length, 1);
  });
});
