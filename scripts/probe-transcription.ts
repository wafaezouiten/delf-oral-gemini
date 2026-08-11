/**
 * Which transcription field actually delivers the candidate's words?
 *
 * The session manager appends every transcription fragment to the exam
 * transcript. If BOTH `inputTranscription` and `interimInputTranscription`
 * carry the same speech, appending both would duplicate every sentence the
 * candidate says — and then grade them on it. So this counts them separately.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { GoogleGenAI, Modality, type LiveConnectConfig } from "@google/genai";

import { CLIENT_CONNECT_CONFIG, LIVE_MODEL } from "../src/lib/gemini/constants";
import { debateConfig, monologueConfig } from "../src/lib/gemini/live-config";
import { ORAL_TOPICS } from "../src/lib/delf/topics";

const apiKey = process.env.GEMINI_API_KEY!;
const TOPIC = ORAL_TOPICS[0];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function speak(text: string): Promise<Int16Array> {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ role: "user", parts: [{ text }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
    },
  });
  const data = response.candidates![0].content!.parts![0].inlineData!.data!;
  const buf = Buffer.from(data, "base64");
  const pcm24 = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const out = new Int16Array(Math.floor((pcm24.length * 2) / 3));
  for (let i = 0; i < out.length; i++) {
    const p = (i * 3) / 2;
    const lo = Math.floor(p);
    const hi = Math.min(lo + 1, pcm24.length - 1);
    out[i] = Math.round(pcm24[lo] * (1 - (p - lo)) + pcm24[hi] * (p - lo));
  }
  return out;
}

async function probe(label: string, cfg: LiveConnectConfig, manual: boolean, pcm: Int16Array) {
  const server = new GoogleGenAI({ apiKey });
  const token = await server.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + 15 * 60_000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(),
      liveConnectConstraints: { model: LIVE_MODEL, config: cfg },
    },
  });

  const ai = new GoogleGenAI({
    apiKey: token.name!,
    httpOptions: { apiVersion: "v1alpha" },
  });

  const settled: string[] = [];
  const interim: string[] = [];

  const session = await ai.live.connect({
    model: LIVE_MODEL,
    config: CLIENT_CONNECT_CONFIG,
    callbacks: {
      onopen: () => {},
      onmessage: (m) => {
        const c = m.serverContent;
        if (!c) return;
        if (c.inputTranscription?.text) settled.push(c.inputTranscription.text);
        if (c.interimInputTranscription?.text) interim.push(c.interimInputTranscription.text);
      },
      onerror: () => {},
      onclose: () => {},
    },
  });

  if (manual) session.sendRealtimeInput({ activityStart: {} });

  const CHUNK = 640;
  for (let o = 0; o < pcm.length; o += CHUNK) {
    const s = pcm.subarray(o, Math.min(o + CHUNK, pcm.length));
    session.sendRealtimeInput({
      audio: {
        data: Buffer.from(s.buffer, s.byteOffset, s.byteLength).toString("base64"),
        mimeType: "audio/pcm;rate=16000",
      },
    });
    await wait(40);
  }
  const silence = new Int16Array(CHUNK);
  for (let i = 0; i < 50; i++) {
    session.sendRealtimeInput({
      audio: {
        data: Buffer.from(silence.buffer, 0, silence.byteLength).toString("base64"),
        mimeType: "audio/pcm;rate=16000",
      },
    });
    await wait(40);
  }

  const duringSettled = settled.length;
  const duringInterim = interim.length;

  if (manual) {
    session.sendRealtimeInput({ activityEnd: {} });
    await wait(6000);
  }
  await wait(3000);
  session.close();

  console.log(`\n  ${label}`);
  console.log(`    during speech : inputTranscription=${duringSettled} fragments, interim=${duringInterim}`);
  console.log(`    total         : inputTranscription=${settled.length} fragments, interim=${interim.length}`);
  console.log(`    settled text  : "${settled.join("").trim().slice(0, 100)}"`);
  console.log(`    interim text  : "${interim.join("").trim().slice(0, 100)}"`);
}

async function main() {
  const pcm = await speak(
    "Je pense que le télétravail a transformé notre rapport au bureau, et je voudrais le défendre.",
  );
  console.log(`${(pcm.length / 16000).toFixed(1)}s of speech`);

  await probe("DEBAT (auto VAD)", debateConfig({ topic: TOPIC }), false, pcm);
  await probe("MONOLOGUE (manual VAD)", monologueConfig({ topic: TOPIC }), true, pcm);
  console.log("");
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
