/**
 * Can the examiner prompt stay entirely on the server?
 *
 * If a token's `liveConnectConstraints` carries the full config, and the client
 * may then connect with an EMPTY config, the system instruction never reaches
 * the browser at all — not in the bundle, not over the wire. That is a strictly
 * better posture than shipping the prompt to the client, so it is worth knowing
 * which shapes the server actually accepts.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { GoogleGenAI, Modality, type LiveConnectConfig } from "@google/genai";

import { LIVE_MODEL } from "../src/lib/gemini/live-config";

const FULL: LiveConnectConfig = {
  responseModalities: [Modality.AUDIO],
  systemInstruction: "Tu es un examinateur du DELF B2. Réponds en une phrase.",
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  sessionResumption: {},
  contextWindowCompression: { slidingWindow: {} },
  speechConfig: {
    languageCode: "fr-FR",
    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } },
  },
  temperature: 0.9,
};

async function run(label: string, connectConfig: LiveConnectConfig, apiKey: string): Promise<void> {
  const server = new GoogleGenAI({ apiKey });
  const token = await server.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + 15 * 60_000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(),
      liveConnectConstraints: { model: LIVE_MODEL, config: FULL },
    },
  });

  const ai = new GoogleGenAI({
    apiKey: token.name!,
    httpOptions: { apiVersion: "v1alpha" },
  });

  let transcript = "";
  let audioChunks = 0;
  let gotHandle = false;
  let info = "";
  let settle: () => void;
  const done = new Promise<void>((resolve) => (settle = resolve));

  try {
    const session = await Promise.race([
      ai.live.connect({
        model: LIVE_MODEL,
        config: connectConfig,
        callbacks: {
          onopen: () => {},
          onmessage: (message) => {
            if (message.sessionResumptionUpdate?.newHandle) gotHandle = true;
            const content = message.serverContent;
            if (!content) return;
            for (const part of content.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) audioChunks += 1;
            }
            if (content.outputTranscription?.text) transcript += content.outputTranscription.text;
            if (content.turnComplete) settle();
          },
          onerror: (error) => {
            info = ` error=${String(error).slice(0, 80)}`;
            settle();
          },
          onclose: (event) => {
            info = ` closed(${event?.code ?? "?"}: ${event?.reason ?? ""})`;
            settle();
          },
        },
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
    ]);

    if (session === null) {
      console.log(`  ${label.padEnd(34)} HANG${info}`);
      return;
    }

    session.sendRealtimeInput({ text: "Bonjour, présentez l'épreuve en une phrase." });
    await Promise.race([done, new Promise((r) => setTimeout(r, 25_000))]);
    session.close();

    const spoke = audioChunks > 0;
    console.log(
      `  ${label.padEnd(34)} ${spoke ? "OK" : "NO AUDIO"} ` +
        `audio=${audioChunks} handle=${gotHandle ? "yes" : "no"} ` +
        `transcript="${transcript.trim().slice(0, 60)}"${info}`,
    );
  } catch (error) {
    console.log(`  ${label.padEnd(34)} THROW: ${String(error).slice(0, 120)}`);
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  console.log(`model: ${LIVE_MODEL}\ntoken constraint carries the FULL config in every case\n`);

  await run("connect with {} (empty)", {}, apiKey);
  await run("connect with the same full config", FULL, apiKey);
  await run("connect with modalities only", { responseModalities: [Modality.AUDIO] }, apiKey);
  console.log("");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
