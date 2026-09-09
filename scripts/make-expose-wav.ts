/**
 * A candidate's voice for Chrome's fake microphone.
 *
 * `e2e/monologue-transcription.spec.ts` drives a SPOKEN exposé, which needs
 * audio Chrome can be pointed at: `--use-file-for-fake-audio-capture` takes a
 * 16-bit PCM WAV and loops it, so a minute and a half of French fills a
 * monologue of any length.
 *
 * The speech is the app's own spoken consignes, concatenated. Rendering fresh
 * speech would mean the TTS model, whose free tier is ten requests a day — a
 * fixture that cannot be rebuilt on a Tuesday afternoon is not a fixture. What
 * the test needs from this file is French, continuous and long enough to loop
 * without an obvious seam; it does not need the words to be an argument.
 *
 *   pnpm tsx scripts/make-expose-wav.ts [out.wav]
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "public/announcements";
const OUT = process.argv[2] ?? "expose.wav";
/** What the clips are written at, and what Chrome is handed. */
const SOURCE_RATE = 24000;
const OUT_RATE = 48000;

/** The samples of one canonical 44-byte-header WAV. */
function samplesOf(path: string): Int16Array {
  const buf = readFileSync(path);
  return new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length));
}

function wav(samples: Int16Array, rate: number): Buffer {
  const header = Buffer.alloc(44);
  const bytes = samples.length * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, bytes)]);
}

const clips = readdirSync(SOURCE)
  .filter((name) => name.endsWith(".wav"))
  .map((name) => samplesOf(join(SOURCE, name)));

const total = clips.reduce((n, c) => n + c.length, 0);
const pcm = new Int16Array(total);
let offset = 0;
for (const clip of clips) {
  pcm.set(clip, offset);
  offset += clip.length;
}

// 24 kHz -> 48 kHz, linear, because that is the rate Chrome's capture expects.
const out = new Int16Array(pcm.length * 2);
for (let i = 0; i < pcm.length; i++) {
  const next = pcm[Math.min(i + 1, pcm.length - 1)];
  out[i * 2] = pcm[i];
  out[i * 2 + 1] = Math.round((pcm[i] + next) / 2);
}

writeFileSync(OUT, wav(out, OUT_RATE));
console.log(
  `${OUT}: ${(total / SOURCE_RATE).toFixed(1)}s of French speech from ${clips.length} clips, ` +
    `${OUT_RATE} Hz mono 16-bit`,
);
