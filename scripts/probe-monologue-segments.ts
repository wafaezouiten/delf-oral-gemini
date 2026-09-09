/**
 * Does releasing and reopening the candidate's floor mid-exposé get the
 * monologue transcribed?
 *
 * `probe-monologue-close.ts` establishes the failure: past somewhere between
 * three and four minutes inside ONE manual-VAD activity, the boundary produces
 * no `inputTranscription` at all — not late, never — so a real seven-minute
 * exposé reaches the finish route as zero candidate words. Neither the sliding
 * window nor the closing race explains it; both were ruled out by measurement.
 *
 * The obvious remedy is to stop asking for one seven-minute turn: send
 * `activityEnd` every N seconds and open the next activity immediately. Each
 * segment is then a boundary of its own and should be transcribed at it.
 *
 * What this has to measure is not only whether that works but what it costs:
 * every `activityEnd` is a turn boundary, so the examiner takes the floor at
 * each one — audio the app would have to swallow rather than play, and turns
 * the model would carry in its own context through the exposé it is supposed to
 * be listening to in silence.
 *
 *   pnpm tsx scripts/probe-monologue-segments.ts [totalSeconds] [everySeconds]
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { GoogleGenAI } from "@google/genai";

import { closingInstruction } from "../src/lib/delf/examiner-prompt";
import { ORAL_TOPICS } from "../src/lib/delf/topics";
import { CLIENT_CONNECT_CONFIG, LIVE_MODEL, OUTPUT_SAMPLE_RATE } from "../src/lib/gemini/constants";
import { monologueConfig } from "../src/lib/gemini/live-config";

const apiKey = process.env.GEMINI_API_KEY!;
const TOPIC = ORAL_TOPICS[0];
const INPUT_RATE = 16000;
const OBSERVE_MS = 20_000;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** French speech from the spoken consignes — see `probe-monologue-close.ts`. */
function loadClips(): Int16Array[] {
  const dir = "public/announcements";
  return readdirSync(dir)
    .filter((name) => name.endsWith(".wav"))
    .map((name) => {
      const buf = readFileSync(join(dir, name));
      const pcm24 = new Int16Array(
        buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length),
      );
      const out = new Int16Array(Math.floor((pcm24.length * 2) / 3));
      for (let i = 0; i < out.length; i++) {
        const p = (i * 3) / 2;
        const lo = Math.floor(p);
        const hi = Math.min(lo + 1, pcm24.length - 1);
        out[i] = Math.round(pcm24[lo] * (1 - (p - lo)) + pcm24[hi] * (p - lo));
      }
      return out;
    });
}

function exposeOf(seconds: number, clips: Int16Array[]): Int16Array {
  const target = seconds * INPUT_RATE;
  const parts: Int16Array[] = [];
  let total = 0;
  for (let i = 0; total < target; i++) {
    parts.push(clips[i % clips.length]);
    total += clips[i % clips.length].length;
  }
  const out = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function main() {
  const clips = loadClips();
  const totalSeconds = Number(process.argv[2] ?? 370);
  const everySeconds = Number(process.argv[3] ?? 90);
  const pcm = exposeOf(totalSeconds, clips);

  const server = new GoogleGenAI({ apiKey });
  const token = await server.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 5 * 60_000).toISOString(),
      liveConnectConstraints: { model: LIVE_MODEL, config: monologueConfig({ topic: TOPIC }) },
    },
  });
  const ai = new GoogleGenAI({ apiKey: token.name!, httpOptions: { apiVersion: "v1alpha" } });

  const startedAt = Date.now();
  const at = () => ((Date.now() - startedAt) / 1000).toFixed(1);
  const fragments: Array<{ at: string; chars: number }> = [];
  let transcript = "";
  let examinerChunks = 0;
  let examinerSeconds = 0;
  let examinerText = "";

  const session = await ai.live.connect({
    model: LIVE_MODEL,
    config: CLIENT_CONNECT_CONFIG,
    callbacks: {
      onopen: () => {},
      onmessage: (m) => {
        const c = m.serverContent;
        if (!c) return;
        const text = c.inputTranscription?.text;
        if (text) {
          fragments.push({ at: at(), chars: text.length });
          transcript += text;
        }
        if (c.outputTranscription?.text) examinerText += c.outputTranscription.text;
        for (const part of c.modelTurn?.parts ?? []) {
          const data = part.inlineData?.data;
          if (!data) continue;
          examinerChunks += 1;
          examinerSeconds += Buffer.from(data, "base64").length / 2 / OUTPUT_SAMPLE_RATE;
        }
      },
      onerror: (e) => console.error("  socket error", e),
      onclose: () => {},
    },
  });

  session.sendRealtimeInput({ activityStart: {} });

  const CHUNK = 640;
  const every = everySeconds * INPUT_RATE;
  let nextBoundary = every;
  const sendAt = Date.now();
  for (let o = 0; o < pcm.length; o += CHUNK) {
    if (o >= nextBoundary && o + CHUNK < pcm.length) {
      // The candidate is mid-sentence; this is the cost being measured.
      session.sendRealtimeInput({ activityEnd: {} });
      session.sendRealtimeInput({ activityStart: {} });
      console.log(`  ${at()}s  segment boundary`);
      nextBoundary += every;
    }
    const s = pcm.subarray(o, Math.min(o + CHUNK, pcm.length));
    session.sendRealtimeInput({
      audio: {
        data: Buffer.from(s.buffer, s.byteOffset, s.byteLength).toString("base64"),
        mimeType: `audio/pcm;rate=${INPUT_RATE}`,
      },
    });
    const due = sendAt + ((o + CHUNK) / INPUT_RATE) * 1000;
    const drift = due - Date.now();
    if (drift > 0) await wait(drift);
  }

  session.sendRealtimeInput({ text: closingInstruction("monologue") });
  session.sendRealtimeInput({ activityEnd: {} });
  console.log(`  ${at()}s  closing handshake`);
  await wait(OBSERVE_MS);
  session.close();

  const spoken = (pcm.length / INPUT_RATE).toFixed(0);
  console.log(`\n  ${spoken}s of exposé, floor released every ${everySeconds}s:`);
  console.log(`    fragments      : ${fragments.length}`);
  console.log(`    transcript     : ${transcript.trim().length} chars`);
  console.log(`    first 90       : "${transcript.trim().slice(0, 90)}"`);
  console.log(`    last 90        : "${transcript.trim().slice(-90)}"`);
  console.log(
    `    examiner spoke : ${examinerChunks} chunks, ${examinerSeconds.toFixed(1)}s ` +
      `<- audio the app would have to swallow`,
  );
  console.log(`    examiner said  : "${examinerText.trim().slice(0, 150)}"`);
  console.log("");
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
