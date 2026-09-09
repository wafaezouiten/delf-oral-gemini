/**
 * When does the monologue's transcription arrive, relative to the moment the
 * app closes the socket?
 *
 * The closing handshake sends the directive, sends `activityEnd`, and then
 * advances as soon as the examiner's sentence has been generated AND played out
 * (`finishClosingIfQuiet`). `advance()` then closes the session. The entire
 * exposé arrives in ONE `inputTranscription` fragment at that same boundary
 * (GEMINI_LIVE_FINDINGS §6) — so if that fragment is slower than the closing
 * sentence is to speak, the socket dies with the whole monologue on it, and the
 * finish route refuses the sitting for containing no candidate speech.
 *
 * This measures both, for exposés of several lengths. Everything is reported in
 * milliseconds after `activityEnd`.
 *
 *   pnpm tsx scripts/probe-monologue-close.ts [seconds...]
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { GoogleGenAI } from "@google/genai";

import { closingInstruction } from "../src/lib/delf/examiner-prompt";
import { ORAL_TOPICS } from "../src/lib/delf/topics";
import { CLIENT_CONNECT_CONFIG, LIVE_MODEL, OUTPUT_SAMPLE_RATE } from "../src/lib/gemini/constants";
import { debateConfig, monologueConfig } from "../src/lib/gemini/live-config";

const apiKey = process.env.GEMINI_API_KEY!;
const TOPIC = ORAL_TOPICS[0];
const INPUT_RATE = 16000;
/** How long to keep listening after `activityEnd`, whatever the app would do. */
const OBSERVE_MS = 60_000;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The candidate's voice, taken from the spoken consignes already in the tree.
 *
 * Rendering fresh speech needs the TTS model, whose free tier is ten requests a
 * day — so a probe that TTS'd its own input could be run about twice before it
 * started failing on quota instead of on the thing it measures. These four
 * clips are French, they are already 24 kHz mono PCM, and what is being
 * measured is transcription latency, not what the words mean.
 */
function loadClips(): Int16Array[] {
  const dir = "public/announcements";
  return readdirSync(dir)
    .filter((name) => name.endsWith(".wav"))
    .map((name) => {
      const buf = readFileSync(join(dir, name));
      // Past the 44-byte canonical header these files are written with.
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

/** A candidate exposé of roughly `seconds` seconds, built from the clips above. */
function exposeOf(seconds: number, clips: Int16Array[]): Int16Array {
  const target = seconds * INPUT_RATE;
  const parts: Int16Array[] = [];
  let total = 0;
  for (let i = 0; total < target; i++) {
    const clip = clips[i % clips.length];
    parts.push(clip);
    total += clip.length;
  }
  const out = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

interface Marks {
  firstAudio: number | null;
  audioSeconds: number;
  turnComplete: number | null;
  inputTranscription: number | null;
  inputChars: number;
  outputText: string;
}

async function probe(
  label: string,
  pcm: Int16Array,
  compression: boolean,
  manual = true,
): Promise<void> {
  const server = new GoogleGenAI({ apiKey });
  // `manual: false` runs the DEBAT's automatic-VAD config over the same audio,
  // which is the control: it says whether the length that defeats the monologue
  // defeats transcription at all, or only defeats one long open activity.
  const base = manual ? monologueConfig({ topic: TOPIC }) : debateConfig({ topic: TOPIC });
  // The suspect: `slidingWindow` drops the oldest turns, and the monologue's
  // oldest turn is the exposé itself — still open, still waiting for the
  // `activityEnd` that would transcribe it.
  const cfg = compression ? base : { ...base, contextWindowCompression: undefined };
  const token = await server.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 5 * 60_000).toISOString(),
      liveConnectConstraints: { model: LIVE_MODEL, config: cfg },
    },
  });
  const ai = new GoogleGenAI({ apiKey: token.name!, httpOptions: { apiVersion: "v1alpha" } });

  let activityEndAt = Number.POSITIVE_INFINITY;
  const since = () => Math.round(Date.now() - activityEndAt);
  const marks: Marks = {
    firstAudio: null,
    audioSeconds: 0,
    turnComplete: null,
    inputTranscription: null,
    inputChars: 0,
    outputText: "",
  };

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
          marks.inputTranscription ??= since();
          marks.inputChars += text.length;
        }
        if (c.outputTranscription?.text) marks.outputText += c.outputTranscription.text;
        for (const part of c.modelTurn?.parts ?? []) {
          const data = part.inlineData?.data;
          if (!data) continue;
          marks.firstAudio ??= since();
          marks.audioSeconds += Buffer.from(data, "base64").length / 2 / OUTPUT_SAMPLE_RATE;
        }
        if (c.turnComplete) marks.turnComplete ??= since();
      },
      onerror: (e) => console.error("  socket error", e),
      onclose: () => {},
    },
  });

  if (manual) session.sendRealtimeInput({ activityStart: {} });

  // Realtime, as a microphone delivers it: 640 samples is 40 ms at 16 kHz.
  const CHUNK = 640;
  const startedAt = Date.now();
  for (let o = 0; o < pcm.length; o += CHUNK) {
    const s = pcm.subarray(o, Math.min(o + CHUNK, pcm.length));
    session.sendRealtimeInput({
      audio: {
        data: Buffer.from(s.buffer, s.byteOffset, s.byteLength).toString("base64"),
        mimeType: `audio/pcm;rate=${INPUT_RATE}`,
      },
    });
    const due = startedAt + ((o + CHUNK) / INPUT_RATE) * 1000;
    const drift = due - Date.now();
    if (drift > 0) await wait(drift);
  }

  // Exactly what `beginClosingHandshake` does, in its order.
  session.sendRealtimeInput({ text: closingInstruction("monologue") });
  activityEndAt = Date.now();
  if (manual) session.sendRealtimeInput({ activityEnd: {} });

  await wait(OBSERVE_MS);
  session.close();

  const spoken = (pcm.length / INPUT_RATE).toFixed(0);
  const window = `${manual ? "manual" : "automatic"} VAD, compression ${compression ? "ON" : "OFF"}`;
  // What `finishClosingIfQuiet` waits for: the turn complete AND the speaker
  // dry. The player starts on the first chunk and plays every second of it.
  const drained =
    marks.firstAudio === null
      ? null
      : Math.max(marks.turnComplete ?? 0, Math.round(marks.firstAudio + marks.audioSeconds * 1000));
  console.log(`\n  ${label} — ${spoken}s of exposé, ${window}, ms after activityEnd:`);
  console.log(`    examiner audio starts   : ${marks.firstAudio}`);
  console.log(`    turnComplete            : ${marks.turnComplete}`);
  console.log(`    examiner speaker dry    : ${drained}   <- the app closes the socket here`);
  console.log(
    `    inputTranscription      : ${marks.inputTranscription} (${marks.inputChars} chars)`,
  );
  if (drained !== null) {
    const margin = marks.inputTranscription === null ? null : marks.inputTranscription - drained;
    console.log(
      `    VERDICT                 : ` +
        (margin === null
          ? `LOST — no transcription in ${OBSERVE_MS} ms`
          : margin > 0
            ? `LOST by ${margin} ms`
            : `kept, ${-margin} ms to spare`),
    );
  }
  console.log(`    examiner said           : "${marks.outputText.trim().slice(0, 90)}"`);
}

async function main() {
  const clips = loadClips();
  const lengths = clips.map((c) => (c.length / INPUT_RATE).toFixed(1));
  console.log(`  ${clips.length} clips: ${lengths.join("s, ")}s`);

  // Each argument is `<seconds>`, `<seconds>:nc` for no compression, or
  // `<seconds>:auto` for the débat's automatic VAD.
  const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["30", "120", "300"];
  for (const target of targets) {
    const [seconds, flag] = target.split(":");
    await probe("EXPOSE", exposeOf(Number(seconds), clips), flag !== "nc", flag !== "auto");
  }
  console.log("");
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
