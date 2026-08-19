/**
 * Speak the examiner's consignes once, and commit the result (#37).
 *
 *   pnpm announcements
 *
 * The clips in `public/announcements/` are build artefacts of
 * `src/lib/delf/announcements.ts`, and this is the build. Running it is a
 * deliberate, occasional act rather than part of `next build`, for three reasons:
 *
 *  - **A deploy must not depend on a TTS preview model.** Preview model ids are
 *    renamed without warning; a generation step in the build would turn that into
 *    a failed deploy of an unrelated change.
 *  - **The words must not vary between candidates.** A model spoken at build time
 *    is a model spoken per deploy, and prosody differs between calls. The consigne
 *    a candidate hears should be the same one their classmate heard.
 *  - **It is reviewable.** The manifest this writes carries a digest of each
 *    script, and `announcements.test.ts` fails when a script is edited and the
 *    audio is not regenerated. That test is the reason it is safe for the audio to
 *    be a committed artefact at all.
 *
 * The voice is the examiner's own. `Charon` is what the Live session speaks with
 * (`lib/gemini/live-config.ts`), and hearing one voice read the consigne and a
 * different one argue the débat would be a stranger experience than having no
 * consigne at all.
 *
 * WAV, uncompressed, and no apology for it. There is no Opus encoder available
 * outside the browser in this repo — `lib/audio/opus-encoder.ts` is WebCodecs —
 * and the alternative was a dependency added to compress four files that total
 * around two megabytes and are fetched once per phase from the same origin as the
 * page. It also means the clips are at 24 kHz, the rate the examiner's streamed
 * voice already plays at, so nothing resamples anything.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GoogleGenAI } from "@google/genai";

import {
  ANNOUNCEMENTS,
  ANNOUNCEMENT_IDS,
  announcementDigest,
  type AnnouncementId,
  type AnnouncementManifest,
} from "../src/lib/delf/announcements";
import { pcm16ToWav } from "../src/lib/audio/pcm";

/** Overridable, because this is a preview id and they get renamed. */
const TTS_MODEL = process.env.GEMINI_TTS_MODEL ?? "gemini-3.1-flash-tts-preview";

/** The examiner's voice, and not a choice this script gets to make on its own.
 *  See the header. */
const VOICE = "Charon";

/** Gemini TTS returns L16 PCM at this rate. Asserted rather than assumed: a model
 *  that changed it would otherwise produce a WAV header describing the wrong
 *  speed, and the clip would play back at the wrong pitch with nothing failing. */
const TTS_SAMPLE_RATE = 24000;

const OUT_DIR = join(process.cwd(), "public", "announcements");

/**
 * How the script is read.
 *
 * The instruction matters more than it looks. Left to itself the model performs
 * the text, and a warm, encouraging reading is wrong twice over: an examiner
 * reading a consigne is neutral, and a candidate about to be graded should not be
 * told by the tone of voice that things are going well.
 */
function prompt(text: string): string {
  return (
    "Lis ce texte à voix haute, en français, exactement tel qu'il est écrit, " +
    "sans rien ajouter, sans rien commenter et sans rien omettre. " +
    "Adopte le ton d'un examinateur officiel qui lit une consigne dans un centre " +
    "d'examen : posé, neutre, bienveillant mais sans chaleur excessive, " +
    "à un débit régulier et pas trop rapide, en articulant clairement.\n\n" +
    text
  );
}

/** One clip's samples, from the model. */
async function speak(client: GoogleGenAI, text: string): Promise<Int16Array> {
  const response = await client.models.generateContent({
    model: TTS_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt(text) }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
    },
  });

  const part = response.candidates?.[0]?.content?.parts?.find((candidate) => candidate.inlineData);
  const inline = part?.inlineData;
  if (!inline?.data) {
    throw new Error(
      `${TTS_MODEL} returned no audio. Response: ${JSON.stringify(response).slice(0, 400)}`,
    );
  }

  // "audio/L16;codec=pcm;rate=24000". The rate is the one thing here that would
  // fail silently, so it is checked rather than trusted.
  const declared = /rate=(\d+)/.exec(inline.mimeType ?? "")?.[1];
  if (declared && Number(declared) !== TTS_SAMPLE_RATE) {
    throw new Error(
      `expected ${TTS_SAMPLE_RATE} Hz from the TTS model, got ${declared} Hz ` +
        `(${inline.mimeType}). Update TTS_SAMPLE_RATE and regenerate every clip, ` +
        "or the committed WAV headers will describe the wrong speed.",
    );
  }

  const bytes = Buffer.from(inline.data, "base64");
  // A trailing odd byte would shift every sample after it. It has never happened;
  // it would be inaudible in a diff if it did.
  if (bytes.byteLength % 2 !== 0) {
    throw new Error(`odd PCM16 byte length (${bytes.byteLength}) from ${TTS_MODEL}`);
  }
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  await mkdir(OUT_DIR, { recursive: true });
  console.log(`model: ${TTS_MODEL}\nvoice: ${VOICE}\nout:   ${OUT_DIR}\n`);

  const clips = {} as AnnouncementManifest["clips"];

  for (const id of ANNOUNCEMENT_IDS) {
    const announcement = ANNOUNCEMENTS[id];
    const file = announcement.src.replace("/announcements/", "");
    process.stdout.write(`${id.padEnd(12)} `);

    const samples = await speak(client, announcement.text);
    const wav = Buffer.from(await pcm16ToWav(samples, TTS_SAMPLE_RATE).arrayBuffer());
    await writeFile(join(OUT_DIR, file), wav);

    const seconds = Number((samples.length / TTS_SAMPLE_RATE).toFixed(2));
    clips[id satisfies AnnouncementId] = {
      file,
      digest: announcementDigest(announcement.text),
      bytes: wav.byteLength,
      seconds,
    };
    console.log(`${seconds.toFixed(2).padStart(6)}s  ${(wav.byteLength / 1024).toFixed(0)} kB`);
  }

  const manifest: AnnouncementManifest = { model: TTS_MODEL, voice: VOICE, clips };
  await writeFile(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const total = Object.values(clips).reduce((sum, clip) => sum + clip.bytes, 0);
  console.log(`\n${ANNOUNCEMENT_IDS.length} clips, ${(total / 1024 / 1024).toFixed(2)} MB total.`);
  console.log("Commit public/announcements/ with the script change that prompted it.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
