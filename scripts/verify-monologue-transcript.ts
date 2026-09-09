/**
 * The monologue's transcript, off the recording, at the length that defeats the
 * Live session.
 *
 * `probe-monologue-close.ts` establishes the failure this replaces: past
 * somewhere under four minutes inside one manual-VAD activity, `activityEnd`
 * emits no `inputTranscription` at all and never does. This verifies the way
 * round it — and measures the one number the design turns on, which is how long
 * the débat may have to be held for it (`MONOLOGUE_TRANSCRIPTION_WAIT_MS`).
 *
 * The speech is the app's own spoken consignes, concatenated and looped, for
 * the reason `make-expose-wav.ts` gives: rendering fresh speech costs the TTS
 * model's ten-a-day free tier, and a check that cannot be re-run is not a check.
 *
 *   pnpm verify:transcript [seconds...]
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { pcm16ToWav } from "../src/lib/audio/pcm";
import { transcribeMonologue } from "../src/lib/gemini/transcribe-monologue";

const SOURCE = "public/announcements";
/** What the clips are written at. */
const SOURCE_RATE = 24000;
/**
 * And what this sends: `INPUT_SAMPLE_RATE`, the rate the candidate's microphone
 * is actually captured at. Also the rate that keeps a seven-minute fixture
 * inside the inline request limit as WAV — the real artefact is Opus and a
 * fraction of the size, but nothing in Node here can encode one.
 */
const RATE = 16000;

/** The samples of one canonical 44-byte-header WAV, at {@link RATE}. */
function samplesOf(path: string): Int16Array {
  const buf = readFileSync(path);
  const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length));
  const out = new Int16Array(Math.floor((pcm.length * RATE) / SOURCE_RATE));
  for (let i = 0; i < out.length; i++) {
    const at = (i * SOURCE_RATE) / RATE;
    const lo = Math.floor(at);
    const hi = Math.min(lo + 1, pcm.length - 1);
    out[i] = Math.round(pcm[lo] * (1 - (at - lo)) + pcm[hi] * (at - lo));
  }
  return out;
}

/**
 * An exposé of roughly `seconds` seconds, by looping the clips — each loop
 * resampled slightly, so no two are acoustically identical.
 *
 * The wobble is not decoration. Eighty-six seconds of these clips transcribes,
 * and the same clips repeated do not, so "the model will not transcribe long
 * audio" and "the model collapses audio it has already heard" are two different
 * findings and this fixture has to be able to tell them apart. A candidate
 * never says the same paragraph five times; a looped fixture does.
 */
function exposeOf(seconds: number, clips: Int16Array[]): Int16Array {
  /** ±6%, cycling: enough to shift pitch and length, far too little to slur. */
  const WOBBLE = [1, 0.94, 1.06, 0.97, 1.03];
  const target = seconds * RATE;
  const parts: Int16Array[] = [];
  let total = 0;
  for (let i = 0; total < target; i++) {
    const source = clips[i % clips.length];
    const factor = WOBBLE[Math.floor(i / clips.length) % WOBBLE.length];
    const clip = new Int16Array(Math.floor(source.length * factor));
    for (let j = 0; j < clip.length; j++) clip[j] = source[Math.floor(j / factor)];
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

async function main() {
  const clips = readdirSync(SOURCE)
    .filter((name) => name.endsWith(".wav"))
    .map((name) => samplesOf(join(SOURCE, name)));

  const targets = process.argv.slice(2).map(Number).filter(Boolean);
  for (const seconds of targets.length > 0 ? targets : [370]) {
    const pcm = exposeOf(seconds, clips);
    const wav = pcm16ToWav(pcm, RATE);
    const startedAt = Date.now();
    const text = await transcribeMonologue(await wav.arrayBuffer(), "audio/wav");
    const took = (Date.now() - startedAt) / 1000;
    const spoken = (pcm.length / RATE).toFixed(0);
    console.log(`\n  ${spoken}s of exposé, ${(wav.size / 1024 / 1024).toFixed(1)} MB of WAV:`);
    console.log(`    took       : ${took.toFixed(1)}s`);
    console.log(`    transcript : ${text.length} chars`);
    console.log(`    first 120  : "${text.slice(0, 120)}"`);
    console.log(`    last 120   : "${text.slice(-120)}"`);
  }
  console.log("");
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
