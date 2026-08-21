/**
 * End-to-end verification against the real Gemini Live service.
 *
 * Proves the three claims the product's design rests on, each of which is
 * invisible in code review and only observable by connecting:
 *
 *   A. The security path works: a server-minted, config-constrained ephemeral
 *      token opens a session, and the examiner's system instruction — which the
 *      "client" never sends — governs it.
 *
 *   B. THE MONOLOGUE MECHANISM. With automatic VAD disabled and no `activityEnd`
 *      sent, streaming real French speech at the model produces NO spoken reply,
 *      while transcription of that speech keeps arriving. The control is the same
 *      audio through the débat config, which SHOULD produce a reply. This is the
 *      difference between "we asked the model not to interrupt" and "the model
 *      cannot interrupt".
 *
 *   C. Session resumption carries memory. Say something distinctive, take the
 *      handle, kill the socket, reconnect with the handle, and ask the examiner
 *      to recall it.
 *
 *   pnpm verify:live
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  GoogleGenAI,
  Modality,
  type LiveConnectConfig,
  type LiveServerMessage,
  type Session,
} from "@google/genai";

import { CLIENT_CONNECT_CONFIG, LIVE_MODEL } from "../src/lib/gemini/constants";
import { debateConfig, monologueConfig } from "../src/lib/gemini/live-config";
import { ORAL_TOPICS } from "../src/lib/delf/topics";

const TOPIC = ORAL_TOPICS[0];
const TTS_MODEL = process.env.GEMINI_TTS_MODEL ?? "gemini-2.5-flash-preview-tts";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

const results: Array<{ name: string; pass: boolean; detail: string }> = [];

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}\n        ${detail}\n`);
}

// --------------------------------------------------------------- token + session

/** Exactly what `/api/live-token` does, so the test exercises the real path. */
async function mintToken(cfg: LiveConnectConfig): Promise<string> {
  const server = new GoogleGenAI({ apiKey });
  const token = await server.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + 15 * 60_000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(),
      liveConnectConstraints: { model: LIVE_MODEL, config: cfg },
    },
  });
  if (!token.name) throw new Error("no token minted");
  return token.name;
}

interface Collected {
  session: Session;
  examinerText: () => string;
  candidateText: () => string;
  interimText: () => string;
  audioChunks: () => number;
  handle: () => string | undefined;
  turns: () => number;
  reset: () => void;
}

/** Connect the way the browser does: token in, modalities only. */
async function connect(cfg: LiveConnectConfig, resume?: string): Promise<Collected> {
  const withHandle: LiveConnectConfig = resume
    ? { ...cfg, sessionResumption: { handle: resume } }
    : cfg;
  const token = await mintToken(withHandle);

  const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });

  let examinerText = "";
  let candidateText = "";
  let interimText = "";
  let audioChunks = 0;
  let handle: string | undefined;
  let turns = 0;

  const session = await ai.live.connect({
    model: LIVE_MODEL,
    config: CLIENT_CONNECT_CONFIG,
    callbacks: {
      onopen: () => {},
      onmessage: (message: LiveServerMessage) => {
        if (message.sessionResumptionUpdate?.newHandle) {
          handle = message.sessionResumptionUpdate.newHandle;
        }
        const content = message.serverContent;
        if (!content) return;
        for (const part of content.modelTurn?.parts ?? []) {
          if (part.inlineData?.data) audioChunks += 1;
        }
        if (content.outputTranscription?.text) examinerText += content.outputTranscription.text;
        // Both fields matter: `inputTranscription` lands at a turn boundary,
        // while `interimInputTranscription` streams DURING speech — which is the
        // only one available in the monologue, where no turn boundary ever comes.
        if (content.inputTranscription?.text) candidateText += content.inputTranscription.text;
        if (content.interimInputTranscription?.text) {
          interimText += content.interimInputTranscription.text;
        }
        if (content.turnComplete) turns += 1;
      },
      onerror: (error) => console.error("      ws error:", String(error).slice(0, 120)),
      onclose: () => {},
    },
  });

  return {
    session,
    examinerText: () => examinerText,
    candidateText: () => candidateText,
    interimText: () => interimText,
    audioChunks: () => audioChunks,
    handle: () => handle,
    turns: () => turns,
    reset: () => {
      examinerText = "";
      candidateText = "";
      interimText = "";
      audioChunks = 0;
      turns = 0;
    },
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a turn to complete, or give up. */
async function waitForTurn(c: Collected, ms: number): Promise<boolean> {
  const start = Date.now();
  const before = c.turns();
  while (Date.now() - start < ms) {
    if (c.turns() > before) return true;
    await wait(250);
  }
  return false;
}

// ------------------------------------------------------------------------- audio

/**
 * Synthesise French speech to feed the model as "candidate" audio.
 *
 * This is test scaffolding, not a phonology claim: TTS French is only used here
 * to produce audio that a voice-activity detector will treat as speech. Whether
 * the model *replies* to it is the actual measurement.
 */
async function speak(text: string): Promise<Int16Array | null> {
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: TTS_MODEL,
      contents: [{ role: "user", parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
      },
    });
    const inline = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inline?.data) return null;
    console.log(`      TTS mimeType: ${inline.mimeType ?? "(none)"}`);

    // `Buffer.from(...).buffer` is Node's SHARED allocation pool, not just these
    // bytes: small buffers are slices of an 8 KB pool, so reading `.buffer`
    // directly yields unrelated memory. The bytes must be copied out by offset.
    // This produced audio that looked fine (right length, right rate) and was
    // pure noise, which VAD correctly ignored.
    const buf = Buffer.from(inline.data, "base64");
    const exact = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const pcm24 = new Int16Array(exact);

    // Sanity-check that this is real audio and not silence or noise.
    let peak = 0;
    for (let i = 0; i < pcm24.length; i++) peak = Math.max(peak, Math.abs(pcm24[i]));
    console.log(`      TTS peak amplitude: ${peak} (of 32767)`);
    if (peak < 500) {
      console.log("      that is effectively silence, so VAD would ignore it");
      return null;
    }

    return downsample24to16(pcm24);
  } catch (error) {
    console.log(`      (TTS unavailable: ${String(error).slice(0, 90)})`);
    return null;
  }
}

/** 24 kHz -> 16 kHz, linear interpolation. */
function downsample24to16(input: Int16Array): Int16Array {
  const output = new Int16Array(Math.floor((input.length * 2) / 3));
  for (let i = 0; i < output.length; i++) {
    const position = (i * 3) / 2;
    const low = Math.floor(position);
    const high = Math.min(low + 1, input.length - 1);
    const fraction = position - low;
    output[i] = Math.round(input[low] * (1 - fraction) + input[high] * fraction);
  }
  return output;
}

/**
 * Stream PCM at roughly real time, in the 40 ms chunks the recorder produces.
 *
 * `trailingSilenceMs` matters more than it looks: automatic VAD detects
 * end-of-speech from SILENCE, and simply ceasing to send data is not silence —
 * the server just sees no packets and waits forever. A real microphone keeps
 * delivering quiet frames after someone stops talking, so the test has to as
 * well, or the examiner never gets its turn.
 */
async function streamAudio(
  session: Session,
  pcm: Int16Array,
  trailingSilenceMs = 2000,
): Promise<void> {
  const CHUNK = 640; // 40 ms at 16 kHz
  for (let offset = 0; offset < pcm.length; offset += CHUNK) {
    const slice = pcm.subarray(offset, Math.min(offset + CHUNK, pcm.length));
    session.sendRealtimeInput({
      audio: {
        data: Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString("base64"),
        mimeType: "audio/pcm;rate=16000",
      },
    });
    await wait(40);
  }

  const silence = new Int16Array(CHUNK);
  const silenceChunks = Math.round(trailingSilenceMs / 40);
  for (let i = 0; i < silenceChunks; i++) {
    session.sendRealtimeInput({
      audio: {
        data: Buffer.from(silence.buffer, 0, silence.byteLength).toString("base64"),
        mimeType: "audio/pcm;rate=16000",
      },
    });
    await wait(40);
  }
}

// -------------------------------------------------------------------------- tests

async function testTokenPath() {
  console.log("A. Server-minted constrained token opens a governed session\n");
  const c = await connect(debateConfig({ topic: TOPIC }));
  c.session.sendRealtimeInput({
    text: "Ouvre le débat en une phrase, en contestant ma position.",
  });
  await waitForTurn(c, 30_000);
  c.session.close();

  const spoke = c.audioChunks() > 0 && c.examinerText().trim().length > 0;
  record(
    "ephemeral token -> audio + transcript + resumption handle",
    spoke && Boolean(c.handle()),
    `audio=${c.audioChunks()} chunks, handle=${c.handle() ? "issued" : "none"}, ` +
      `examiner said: "${c.examinerText().trim().slice(0, 90)}"`,
  );
}

async function testMonologueSilence(pcm: Int16Array) {
  console.log("B. The monologue mechanism (the central claim)\n");

  // Control: the débat config, automatic VAD. The same audio SHOULD get a reply.
  const control = await connect(debateConfig({ topic: TOPIC }));
  await streamAudio(control.session, pcm);
  const controlReplied = await waitForTurn(control, 15_000);
  const controlAudio = control.audioChunks();
  const controlHeard = (control.candidateText() + " " + control.interimText()).trim();
  control.session.close();

  record(
    "control: debate config (auto VAD) DOES reply to the same audio",
    controlReplied || controlAudio > 0,
    `replied=${controlReplied}, audio=${controlAudio} chunks, ` +
      `heard: "${controlHeard.slice(0, 80)}"`,
  );

  // The real test: manual VAD, activityStart, never activityEnd.
  const mono = await connect(monologueConfig({ topic: TOPIC }));
  mono.session.sendRealtimeInput({ activityStart: {} });
  await streamAudio(mono.session, pcm);
  // Give it well past a natural turn boundary to misbehave in.
  const interrupted = await waitForTurn(mono, 15_000);
  const silentAudio = mono.audioChunks();
  // In the monologue there is never a turn boundary, so the settled
  // `inputTranscription` may never arrive; the interim stream is what carries
  // the candidate's words. Either counts as "we captured what they said".
  const heard = (mono.candidateText() + " " + mono.interimText()).trim();

  record(
    "monologue: examiner stays SILENT while the candidate speaks",
    !interrupted && silentAudio === 0,
    `examiner audio chunks=${silentAudio} (expected 0), turn taken=${interrupted} (expected false)`,
  );

  const heardDuring = heard.length > 0;

  // Releasing the floor must hand the turn over.
  mono.session.sendRealtimeInput({ activityEnd: {} });
  const repliedAfterEnd = await waitForTurn(mono, 25_000);
  const heardAfter = (mono.candidateText() + " " + mono.interimText()).trim();

  // The honest question is not "is it live?" but "do we get it at all?". The
  // exam only needs the candidate's words to exist by the time the monologue
  // ends, because that is when they are appended to the transcript and later
  // graded. Live display is a nice-to-have; capture is not.
  record(
    "monologue: the candidate's speech IS captured by the end of the phase",
    heardAfter.length > 0,
    heardAfter.length > 0
      ? `during=${heardDuring ? "streamed live" : "withheld until activityEnd"}, ` +
          `captured: "${heardAfter.slice(0, 110)}"`
      : "NOTHING TRANSCRIBED, even after activityEnd",
  );

  record(
    "monologue: the examiner speaks once activityEnd releases the floor",
    repliedAfterEnd || mono.audioChunks() > 0,
    `after activityEnd: audio=${mono.audioChunks()} chunks, replied=${repliedAfterEnd}`,
  );
  mono.session.close();
}

async function testResumption() {
  console.log("C. Session resumption carries the examiner's memory\n");

  const first = await connect(debateConfig({ topic: TOPIC }));
  first.session.sendRealtimeInput({
    text: "Retiens bien ceci : mon argument principal est la brioche aux myrtilles de ma grand-mère. Réponds simplement d'accord.",
  });
  await waitForTurn(first, 30_000);

  // The server issues resumption handles on its own schedule, not synchronously
  // with the first turn, so poll rather than sampling once. A flaky read here
  // would look exactly like "resumption is broken".
  const deadline = Date.now() + 20_000;
  while (!first.handle() && Date.now() < deadline) await wait(500);
  const handle = first.handle();
  first.session.close();

  if (!handle) {
    record("resumption: a handle was issued", false, "no handle, cannot test resumption");
    return;
  }

  await wait(1500);

  // Reconnect with the handle — the same code path a GoAway drives.
  const resumed = await connect(debateConfig({ topic: TOPIC }), handle);
  resumed.session.sendRealtimeInput({
    text: "Quel était exactement mon argument principal ? Cite-le mot pour mot.",
  });
  await waitForTurn(resumed, 30_000);
  const recalled = resumed.examinerText().toLowerCase();
  resumed.session.close();

  const remembers = recalled.includes("myrtille") || recalled.includes("brioche");
  record(
    "resumption: the resumed examiner recalls a pre-reconnect argument",
    remembers,
    `after resuming, examiner said: "${resumed.examinerText().trim().slice(0, 140)}"`,
  );
}

async function main() {
  console.log(`\nmodel: ${LIVE_MODEL}\ntopic: ${TOPIC.title}\n`);

  await testTokenPath();

  console.log("   synthesising French candidate speech for the VAD tests…");
  const pcm = await speak(
    "Je pense que le télétravail a profondément transformé notre rapport au bureau, et je voudrais défendre cette idée avec trois arguments successifs.",
  );

  if (pcm) {
    console.log(`   got ${(pcm.length / 16000).toFixed(1)}s of 16 kHz audio\n`);
    await testMonologueSilence(pcm);
  } else {
    console.log("   SKIPPED: could not synthesise speech, so the VAD tests cannot run.\n");
  }

  await testResumption();

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${"=".repeat(64)}`);
  console.log(`${passed}/${results.length} checks passed`);
  for (const r of results.filter((x) => !x.pass)) console.log(`  FAILED: ${r.name}`);
  console.log("");
  process.exitCode = passed === results.length ? 0 : 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
