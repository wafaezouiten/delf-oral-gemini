/**
 * Smallest possible proof that the Gemini Live wiring is real: mint an
 * ephemeral token exactly as `/api/live-token` does, open a session with the
 * débat configuration, send one text turn, and confirm audio and a transcript
 * come back.
 *
 *   pnpm smoke
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { GoogleGenAI, type LiveServerMessage } from "@google/genai";

import { LIVE_MODEL, debateConfig } from "../src/lib/gemini/live-config";
import { ORAL_TOPICS } from "../src/lib/delf/topics";

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  console.log(`model: ${LIVE_MODEL}\n`);

  // 1. The server-side half of the security model.
  const server = new GoogleGenAI({ apiKey });
  const token = await server.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + 15 * 60_000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(),
      liveConnectConstraints: { model: LIVE_MODEL },
    },
  });
  if (!token.name) throw new Error("no token minted");
  console.log(`1. ephemeral token minted (${token.name.slice(0, 14)}…)`);

  // 2. The browser's half: connect with the token, never the key.
  const client = new GoogleGenAI({
    apiKey: token.name,
    httpOptions: { apiVersion: "v1alpha" },
  });

  let audioChunks = 0;
  let audioBytes = 0;
  let examinerText = "";
  let resumptionHandle: string | undefined;
  let done: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));

  const session = await client.live.connect({
    model: LIVE_MODEL,
    config: debateConfig({ topic: ORAL_TOPICS[0] }),
    callbacks: {
      onopen: () => console.log("2. session open"),
      onmessage: (message: LiveServerMessage) => {
        const update = message.sessionResumptionUpdate;
        if (update?.resumable && update.newHandle) resumptionHandle = update.newHandle;

        const content = message.serverContent;
        if (!content) return;
        for (const part of content.modelTurn?.parts ?? []) {
          if (part.inlineData?.data) {
            audioChunks += 1;
            audioBytes += part.inlineData.data.length;
          }
        }
        if (content.outputTranscription?.text) {
          examinerText += content.outputTranscription.text;
        }
        if (content.turnComplete) done();
      },
      onerror: (error) => {
        console.error("   error:", error);
        done();
      },
      onclose: () => done(),
    },
  });

  const directive =
    "Ouvre le débat en une seule phrase courte en contestant l'idée que le télétravail améliore la vie des salariés.";

  // On gemini-3.1-flash-live, `sendClientContent` seeds history but does not
  // prompt a turn; `sendRealtimeInput({text})` is what makes the model speak.
  // Selectable so the smoke test can demonstrate which one actually works.
  if (process.argv.includes("--client-content")) {
    console.log("   (using sendClientContent)");
    session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: directive }] }],
      turnComplete: true,
    });
  } else {
    console.log("   (using sendRealtimeInput text)");
    session.sendRealtimeInput({ text: directive });
  }

  const timeout = setTimeout(() => {
    console.error("   timed out after 30s with no turn");
    done();
  }, 30_000);

  await finished;
  console.log("   (turn settled, closing)");
  clearTimeout(timeout);
  session.close();

  console.log(`3. examiner audio: ${audioChunks} chunks, ~${Math.round(audioBytes / 1024)} KB base64`);
  console.log(`4. examiner transcript: "${examinerText.trim()}"`);
  console.log(`5. resumption handle: ${resumptionHandle ? "issued" : "NOT ISSUED"}`);

  const ok = audioChunks > 0 && examinerText.trim().length > 0 && Boolean(resumptionHandle);
  console.log(`\n${ok ? "PASS" : "FAIL"}: mic-less Live loop`);
  // `process.exit()` here would truncate the lines above: on Windows a piped
  // stdout is async, and exiting immediately discards whatever is still
  // buffered. Setting exitCode lets the process drain and then leave.
  process.exitCode = ok ? 0 : 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
