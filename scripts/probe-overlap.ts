/**
 * What happens to the candidate's speech during an examiner turn under
 * `activityHandling: NO_INTERRUPTION` (#220)?
 *
 * Two modes, same audio, same config as shipped by `debateConfig`:
 *
 *   live  — the candidate's chunks are streamed the moment they exist, as the
 *           app does today. This is the reproduction.
 *   hold  — chunks produced while an examiner turn is in flight (first examiner
 *           chunk → `turnComplete`) are held and flushed as one burst at
 *           `turnComplete`; everything after that streams live. This is the fix
 *           under test.
 *
 * Both are run with a short sentence that fits entirely inside the examiner's
 * turn and a long one that starts inside it and runs past it. What is printed
 * is the candidate transcription the service emitted, how many examiner turns
 * completed, and the timeline.
 *
 *   pnpm exec tsx scripts/probe-overlap.ts [live|hold|both] [model]
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { GoogleGenAI, Modality, type LiveConnectConfig } from "@google/genai";

import { CLIENT_CONNECT_CONFIG, LIVE_MODEL } from "../src/lib/gemini/constants";
import { debateConfig } from "../src/lib/gemini/live-config";
import { examinerOpeningLine } from "../src/lib/delf/examiner-prompt";
import { ORAL_TOPICS } from "../src/lib/delf/topics";

const apiKey = process.env.GEMINI_API_KEY!;
const TOPIC = ORAL_TOPICS[0];
const CHUNK = 640; // 40 ms at 16 kHz
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SHORT = "Je pense que le télétravail est un progrès, à condition qu'il soit encadré.";
const LONG =
  "Je pense que le télétravail est un progrès, à condition qu'il soit encadré. " +
  "Il rend du temps aux salariés, il réduit les trajets, et il permet à des personnes " +
  "éloignées des grandes villes de garder leur emploi. Mais il faut des règles claires " +
  "sur les horaires, sinon la frontière entre la vie privée et le travail disparaît.";

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

function chunksOf(pcm: Int16Array): string[] {
  const chunks: string[] = [];
  for (let o = 0; o < pcm.length; o += CHUNK) {
    const s = pcm.subarray(o, Math.min(o + CHUNK, pcm.length));
    chunks.push(Buffer.from(s.buffer, s.byteOffset, s.byteLength).toString("base64"));
  }
  return chunks;
}

const SILENCE = Buffer.from(new Int16Array(CHUNK).buffer).toString("base64");

async function probe(
  label: string,
  mode: "live" | "hold",
  model: string,
  cfg: LiveConnectConfig,
  pcm: Int16Array,
) {
  const server = new GoogleGenAI({ apiKey });
  const token = await server.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + 15 * 60_000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(),
      liveConnectConstraints: { model, config: cfg },
    },
  });
  const ai = new GoogleGenAI({ apiKey: token.name!, httpOptions: { apiVersion: "v1alpha" } });

  const t0 = Date.now();
  const at = () => ((Date.now() - t0) / 1000).toFixed(1);
  const timeline: string[] = [];
  const candidate: string[] = [];
  let turns = 0;
  let inFlight = false;
  let firstExaminerChunkAt: number | null = null;
  const held: string[] = [];
  let heldFlushes = 0;

  const send = (data: string) =>
    session.sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=16000" } });

  const session = await ai.live.connect({
    model,
    config: CLIENT_CONNECT_CONFIG,
    callbacks: {
      onopen: () => {},
      onmessage: (m) => {
        const c = m.serverContent;
        if (!c) return;
        if (c.inputTranscription?.text) candidate.push(c.inputTranscription.text);
        const hasAudio = c.modelTurn?.parts?.some((p) => p.inlineData?.data);
        if ((hasAudio || c.outputTranscription?.text) && !inFlight) {
          inFlight = true;
          if (firstExaminerChunkAt === null) firstExaminerChunkAt = Date.now();
          timeline.push(`turn-open@${at()}`);
        }
        if (c.interrupted) timeline.push(`interrupted@${at()}`);
        if (c.turnComplete) {
          turns += 1;
          inFlight = false;
          timeline.push(`turnComplete#${turns}@${at()}`);
          if (held.length > 0) {
            heldFlushes += 1;
            timeline.push(`flush(${held.length} chunks)@${at()}`);
            for (const chunk of held.splice(0)) send(chunk);
          }
        }
      },
      onerror: (e) => timeline.push(`error(${String(e)})@${at()}`),
      onclose: () => timeline.push(`closed@${at()}`),
    },
  });

  session.sendRealtimeInput({ text: examinerOpeningLine("debate")! });

  // Room tone until the examiner starts, then 2 s more.
  while (firstExaminerChunkAt === null) {
    send(SILENCE);
    await wait(40);
    if (Date.now() - t0 > 30_000) throw new Error("the examiner never spoke");
  }
  while (Date.now() - firstExaminerChunkAt < 2000) {
    send(SILENCE);
    await wait(40);
  }

  timeline.push(`candidate-starts@${at()}`);
  for (const chunk of chunksOf(pcm)) {
    if (mode === "hold" && inFlight) held.push(chunk);
    else send(chunk);
    await wait(40);
  }
  timeline.push(`candidate-ends@${at()}`);

  // Room tone long enough for the silence window, the transcription and a reply.
  const quietUntil = Date.now() + 25_000;
  while (Date.now() < quietUntil) {
    if (mode === "hold" && inFlight) held.push(SILENCE);
    else send(SILENCE);
    await wait(40);
  }
  session.close();
  await wait(500);

  const text = candidate.join("").trim();
  console.log(`\n--- ${label} [${mode}] ${model}`);
  console.log(`  candidate transcription: ${text ? `"${text}"` : "*** NONE ***"}`);
  console.log(`  turns=${turns} heldFlushes=${heldFlushes}`);
  console.log(`  timeline: ${timeline.join(" | ")}`);
}

async function main() {
  const modeArg = process.argv[2] ?? "both";
  const model = process.argv[3] ?? LIVE_MODEL;
  const modes: ("live" | "hold")[] = modeArg === "both" ? ["live", "hold"] : [modeArg as never];

  const short = await speak(SHORT);
  const long = await speak(LONG);
  console.log(
    `short: ${(short.length / 16000).toFixed(1)}s   long: ${(long.length / 16000).toFixed(1)}s`,
  );

  const cfg = debateConfig({ topic: TOPIC });
  for (const mode of modes) {
    await probe("short utterance, inside the turn", mode, model, cfg, short);
    await probe("long utterance, across the turn edge", mode, model, cfg, long);
  }
  console.log("");
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
