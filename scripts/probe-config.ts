/**
 * Bisect the Live config: add one field at a time and report which one stops
 * the session from completing setup. The Developer API tends to accept a
 * connection and then quietly never finish the handshake for an unsupported
 * field, so "it hangs" is the failure signature we are hunting.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { GoogleGenAI, Modality, type LiveConnectConfig } from "@google/genai";

import { LIVE_MODEL } from "../src/lib/gemini/live-config";

const CASES: Array<{ name: string; config: LiveConnectConfig }> = [
  { name: "bare (AUDIO only)", config: { responseModalities: [Modality.AUDIO] } },
  {
    name: "+ systemInstruction",
    config: { responseModalities: [Modality.AUDIO], systemInstruction: "Tu es un examinateur." },
  },
  {
    name: "+ transcription",
    config: {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  },
  {
    name: "+ speechConfig fr-FR/Charon",
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        languageCode: "fr-FR",
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } },
      },
    },
  },
  {
    name: "+ sessionResumption {}",
    config: { responseModalities: [Modality.AUDIO], sessionResumption: {} },
  },
  {
    name: "+ contextWindowCompression",
    config: {
      responseModalities: [Modality.AUDIO],
      contextWindowCompression: { slidingWindow: {} },
    },
  },
  {
    name: "+ manual VAD (monologue mechanism)",
    config: {
      responseModalities: [Modality.AUDIO],
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    },
  },
  {
    name: "+ tuned auto VAD (debate)",
    config: {
      responseModalities: [Modality.AUDIO],
      realtimeInputConfig: {
        automaticActivityDetection: { prefixPaddingMs: 300, silenceDurationMs: 1200 },
      },
    },
  },
  {
    name: "+ temperature",
    config: { responseModalities: [Modality.AUDIO], temperature: 0.9 },
  },
];

async function probe(name: string, cfg: LiveConnectConfig, apiKey: string): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });
  let closeInfo = "";

  try {
    const session = await Promise.race([
      ai.live.connect({
        model: LIVE_MODEL,
        config: cfg,
        callbacks: {
          onopen: () => {},
          onmessage: () => {},
          onerror: (error) => {
            closeInfo = `error: ${String(error)}`;
          },
          onclose: (event) => {
            closeInfo = `closed: code=${event?.code ?? "?"} reason=${event?.reason ?? ""}`;
          },
        },
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
    ]);

    if (session === null) return `HANG (setup never completed) ${closeInfo}`;
    session.close();
    return "OK";
  } catch (error) {
    return `THROW: ${String(error).slice(0, 160)}`;
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  console.log(`model: ${LIVE_MODEL}`);
  console.log("auth: direct API key (isolating config from the token path)\n");

  for (const testCase of CASES) {
    const result = await probe(testCase.name, testCase.config, apiKey);
    console.log(`  ${testCase.name.padEnd(38)} ${result}`);
  }
  console.log("");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
