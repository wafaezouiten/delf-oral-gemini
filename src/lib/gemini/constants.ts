/**
 * The few Gemini Live facts the BROWSER is allowed to know.
 *
 * Split out from `live-config.ts` on purpose. The full session config — and with
 * it the examiner's system instruction — is built on the server and travels to
 * Gemini inside the ephemeral token's `liveConnectConstraints`, never through
 * the client. The browser only needs the model id (to name the connection), the
 * audio contract, and the response modality.
 */

import { Modality, type LiveConnectConfig } from "@google/genai";

/**
 * The Live model. Native-audio, so the examiner's French has real prosody
 * rather than TTS flatness. Overridable by env because preview model ids are
 * renamed without warning and a hard-coded string is a time bomb.
 */
export const LIVE_MODEL =
  process.env.NEXT_PUBLIC_GEMINI_LIVE_MODEL ?? "gemini-3.1-flash-live-preview";

/** Gemini Live audio contract: 16 kHz PCM16 in, 24 kHz PCM16 out. */
export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;
export const INPUT_MIME_TYPE = `audio/pcm;rate=${INPUT_SAMPLE_RATE}`;

/**
 * What the client passes to `live.connect()`.
 *
 * Deliberately minimal, and verified to be sufficient: with the real config
 * pinned in the token constraint, connecting with modalities only produces
 * audio, transcripts and resumption handles exactly as connecting with the full
 * config does. Connecting with a fully EMPTY config, by contrast, silently
 * yields no audio at all — so this is the floor, not an arbitrary choice.
 */
export const CLIENT_CONNECT_CONFIG: LiveConnectConfig = {
  responseModalities: [Modality.AUDIO],
};
