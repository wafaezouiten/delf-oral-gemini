/**
 * What the CONVERSATION half of a sitting costs — and how long the examiner
 * takes to answer — measured against the real Gemini Live service (#12, #100).
 *
 *   pnpm measure:live                  # a few débat turns
 *   pnpm measure:live -- --turns=6
 *
 * WHY THIS SCRIPT EXISTS. The corrector is the cheap half. A sitting is twenty
 * minutes of live audio in both directions, and on this side that is billed per
 * token while the incumbent's ElevenLabs agent is billed per minute — two units
 * that cannot be compared without measuring one of them. #12 asks for cost per
 * sitting measured rather than estimated, and a report that priced only the
 * correction would answer a cheaper question than the one asked.
 *
 * WHY IT DOES NOT JUST MULTIPLY 32 TOKENS/SECOND. The published tokenisation
 * rates (32 tok/s in, 25 tok/s out) describe the audio ALONE. A Live session
 * also re-bills its accumulated context on every turn, so the cost of turn ten
 * is not the cost of turn one, and no per-second rate predicts it. That growth
 * is the number worth having, and it can only be read off `usageMetadata`.
 *
 * WHAT IT IS NOT. Three turns of synthetic French is not a DELF sitting. The
 * script measures a RATE and the report extrapolates it, saying so; it does not
 * claim to have run an exam. The candidate audio is TTS, which is cleaner and
 * more fluent than a B2 learner and therefore produces shorter examiner replies
 * than a real one would — the extrapolation is a floor.
 *
 * WHY IT ALSO MEASURES LATENCY (#100). In the débat the examiner cannot start
 * its turn until the service declares end-of-speech, which with automatic VAD
 * happens `silenceDurationMs` after the candidate's last word. Everything after
 * that — model time-to-first-audio, network, our 20 ms playback lead — stacks on
 * top, and the three have completely different fixes. So each turn records the
 * moment the last chunk of candidate SPEECH goes on the socket (the trailing
 * silence is exactly what a human's last word is followed by) and the deltas to
 * the first server content, the first audio chunk and turn completion. The VAD
 * window is read off the config rather than restated, so the decomposition
 * cannot drift from the tuning it is meant to judge.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  GoogleGenAI,
  Modality,
  type LiveConnectConfig,
  type LiveServerMessage,
  type Session,
  type UsageMetadata,
} from "@google/genai";

import { ORAL_TOPICS } from "../src/lib/delf/topics";
import { CLIENT_CONNECT_CONFIG, LIVE_MODEL } from "../src/lib/gemini/constants";
import { debateConfig } from "../src/lib/gemini/live-config";
import { GEMINI_LIVE_AUDIO } from "./comparison/pricing";

const TOPIC = ORAL_TOPICS[0];
const TTS_MODEL = process.env.GEMINI_TTS_MODEL ?? "gemini-2.5-flash-preview-tts";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

/** A full B2 sitting, for the extrapolation: 7 min monologue + 13 min débat. */
const SITTING_SECONDS = (420 + 780);

/**
 * Candidate turns, written to be answerable and to keep the examiner arguing.
 * Short on purpose: each one is synthesised, streamed at real time and waited
 * on, so the script's wall-clock is roughly the conversation's.
 */
const CANDIDATE_TURNS = [
  "Je pense que le télétravail est un progrès, à condition qu'il soit encadré. Il rend du temps aux salariés et ouvre des postes à des personnes qui en étaient exclues.",
  "Votre objection est juste, mais ce que vous décrivez tient à la culture managériale, pas au télétravail lui-même. Les entreprises qui appliquent un vrai droit à la déconnexion ne constatent pas cet allongement.",
  "C'est l'argument qui me gêne le plus, je le reconnais. Une infirmière n'aura jamais cette souplesse. J'en tire pourtant une conclusion différente de la vôtre.",
  "Parce que ces entreprises mesurent ce qu'elles savent mesurer. Un bureau plein se voit, la productivité à distance ne se voit pas, et il y a aussi des baux à amortir.",
  "Je maintiens ma position, mais je la nuance : le modèle hybride n'est pas une fin en soi, c'est le seul qui préserve à la fois le collectif et la souplesse acquise.",
  "Vous avez raison sur ce point précis. Cela dit, refuser une avancée parce qu'elle ne profite pas immédiatement à tous me paraît un raisonnement dangereux.",
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------- session

/** One `usageMetadata` snapshot, as the server sent it, plus when it arrived. */
interface UsageSnapshot {
  turn: number;
  atSecond: number;
  promptTokens: number | null;
  responseTokens: number | null;
  totalTokens: number | null;
  promptByModality: Record<string, number>;
  responseByModality: Record<string, number>;
}

/**
 * Reply latency for one candidate turn (#100). All deltas are milliseconds from
 * the moment the last chunk of candidate speech was sent — the point at which a
 * human starts waiting for an answer. `firstServerContentMs` is the first
 * evidence the model is replying (a modelTurn part or output transcription);
 * `firstAudioChunkMs` is when sound could start: the browser's player adds only
 * a 20 ms scheduling lead (`src/lib/audio/player.ts`), so chunk arrival is
 * within a frame of the first audible sample.
 */
interface TurnLatency {
  turn: number;
  atSecond: number;
  firstServerContentMs: number | null;
  firstAudioChunkMs: number | null;
  turnCompleteMs: number | null;
}

function byModality(details: UsageMetadata["promptTokensDetails"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const detail of details ?? []) {
    if (detail.modality) out[detail.modality] = detail.tokenCount ?? 0;
  }
  return out;
}

/** Connect the way the browser does: server-minted token, modalities only. */
async function connect(cfg: LiveConnectConfig) {
  const server = new GoogleGenAI({ apiKey });
  const token = await server.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + 15 * 60_000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(),
      liveConnectConstraints: { model: LIVE_MODEL, config: cfg },
    },
  });
  if (!token.name) throw new Error("no ephemeral token minted");

  const ai = new GoogleGenAI({ apiKey: token.name, httpOptions: { apiVersion: "v1alpha" } });

  const snapshots: UsageSnapshot[] = [];
  const latencies: TurnLatency[] = [];
  let pending: TurnLatency | null = null;
  let speechEndedAtMs = 0;
  let turns = 0;
  let examinerAudioChunks = 0;
  let examinerText = "";
  let startedAt = Date.now();

  const session: Session = await ai.live.connect({
    model: LIVE_MODEL,
    config: CLIENT_CONNECT_CONFIG,
    callbacks: {
      onopen: () => {},
      onmessage: (message: LiveServerMessage) => {
        // Usage arrives on its own cadence, not only at turn boundaries. Every
        // snapshot is kept: the SHAPE of the growth is the finding, and keeping
        // only the last one would reduce it to a single number.
        if (message.usageMetadata) {
          snapshots.push({
            turn: turns,
            atSecond: (Date.now() - startedAt) / 1000,
            promptTokens: message.usageMetadata.promptTokenCount ?? null,
            responseTokens: message.usageMetadata.responseTokenCount ?? null,
            totalTokens: message.usageMetadata.totalTokenCount ?? null,
            promptByModality: byModality(message.usageMetadata.promptTokensDetails),
            responseByModality: byModality(message.usageMetadata.responseTokensDetails),
          });
        }
        const content = message.serverContent;
        if (!content) return;
        const sinceSpeechEnd = Date.now() - speechEndedAtMs;
        if (pending && pending.firstServerContentMs === null) {
          // Only the model's own turn counts as a reply — the echo of the
          // candidate's input transcription arriving back is not an answer.
          if (content.modelTurn || content.outputTranscription?.text) {
            pending.firstServerContentMs = sinceSpeechEnd;
          }
        }
        for (const part of content.modelTurn?.parts ?? []) {
          if (part.inlineData?.data) {
            examinerAudioChunks += 1;
            if (pending && pending.firstAudioChunkMs === null) {
              pending.firstAudioChunkMs = sinceSpeechEnd;
            }
          }
        }
        if (content.outputTranscription?.text) examinerText += content.outputTranscription.text;
        if (content.turnComplete) {
          turns += 1;
          if (pending) {
            pending.turnCompleteMs = sinceSpeechEnd;
            pending = null;
          }
        }
      },
      onerror: (error) => console.error("  ws error:", String(error).slice(0, 140)),
      onclose: () => {},
    },
  });

  return {
    session,
    snapshots: () => snapshots,
    latencies: () => latencies,
    /** The streamer calls this as the LAST chunk of speech goes out. */
    markSpeechEnd: () => {
      speechEndedAtMs = Date.now();
      pending = {
        turn: turns,
        atSecond: (speechEndedAtMs - startedAt) / 1000,
        firstServerContentMs: null,
        firstAudioChunkMs: null,
        turnCompleteMs: null,
      };
      latencies.push(pending);
    },
    turns: () => turns,
    examinerAudioChunks: () => examinerAudioChunks,
    examinerText: () => examinerText,
    markStart: () => {
      startedAt = Date.now();
    },
    elapsed: () => (Date.now() - startedAt) / 1000,
  };
}

// ---------------------------------------------------------------------- audio

/**
 * Synthesise a candidate turn as 16 kHz PCM16.
 *
 * The byte-offset copy is not defensive style: `Buffer.from(...).buffer` is
 * Node's shared 8 KB allocation pool, and reading it directly yields unrelated
 * memory that looks like audio and is noise. Learned in `verify-live.ts`, which
 * documents the symptom in full.
 */
async function speak(text: string): Promise<Int16Array | null> {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: [{ role: "user", parts: [{ text }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
    },
  });
  const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!data) return null;
  const buf = Buffer.from(data, "base64");
  const pcm24 = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  const pcm16 = new Int16Array(Math.floor((pcm24.length * 2) / 3));
  for (let i = 0; i < pcm16.length; i++) {
    const position = (i * 3) / 2;
    const low = Math.floor(position);
    const high = Math.min(low + 1, pcm24.length - 1);
    const fraction = position - low;
    pcm16[i] = Math.round(pcm24[low] * (1 - fraction) + pcm24[high] * fraction);
  }
  return pcm16;
}

/**
 * Stream PCM at real time, then keep sending SILENCE. Ceasing to send packets is
 * not silence to a voice-activity detector — it is an open microphone with
 * nobody talking into it, and the examiner would never take its turn.
 */
async function stream(
  session: Session,
  pcm: Int16Array,
  onSpeechEnd?: () => void,
  trailingSilenceMs = 1600,
) {
  const CHUNK = 640; // 40 ms at 16 kHz
  const send = (slice: Int16Array) =>
    session.sendRealtimeInput({
      audio: {
        data: Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString("base64"),
        mimeType: "audio/pcm;rate=16000",
      },
    });

  for (let offset = 0; offset < pcm.length; offset += CHUNK) {
    send(pcm.subarray(offset, Math.min(offset + CHUNK, pcm.length)));
    await wait(40);
  }
  // The latency clock starts HERE, not after the silence: to the candidate the
  // wait begins with their last word, and the VAD window is part of the wait.
  onSpeechEnd?.();
  const silence = new Int16Array(CHUNK);
  for (let i = 0; i < Math.round(trailingSilenceMs / 40); i++) {
    send(silence);
    await wait(40);
  }
}

// ----------------------------------------------------------------------- main

async function main() {
  const turnsWanted = Number(
    process.argv.find((a) => a.startsWith("--turns="))?.split("=")[1] ?? 4,
  );
  const script = CANDIDATE_TURNS.slice(0, Math.min(turnsWanted, CANDIDATE_TURNS.length));

  console.log(`\nMeasuring a Gemini Live débat: ${script.length} candidate turns on "${TOPIC.slug}"\n`);

  const liveConfig = debateConfig({ topic: TOPIC });
  const live = await connect(liveConfig);
  let audioSecondsSent = 0;
  live.markStart();

  try {
    for (const [index, text] of script.entries()) {
      process.stdout.write(`  turn ${index + 1}: synthesising… `);
      const pcm = await speak(text);
      if (!pcm) {
        process.stdout.write("TTS unavailable, stopping\n");
        break;
      }
      const seconds = pcm.length / 16000;
      audioSecondsSent += seconds;
      process.stdout.write(`${seconds.toFixed(1)}s of speech, streaming… `);

      const before = live.turns();
      await stream(live.session, pcm, live.markSpeechEnd);

      // Wait for the examiner to finish replying, then let usage settle.
      const deadline = Date.now() + 25_000;
      while (live.turns() === before && Date.now() < deadline) await wait(250);
      await wait(750);

      const latest = live.snapshots().at(-1);
      const lag = live.latencies().at(-1);
      process.stdout.write(
        live.turns() > before
          ? `examiner replied, first audio ${
              lag?.firstAudioChunkMs === null || lag?.firstAudioChunkMs === undefined
                ? "?"
                : `${(lag.firstAudioChunkMs / 1000).toFixed(2)}s`
            } after last word (cumulative ${latest?.totalTokens ?? "?"} tok)\n`
          : "no reply within 25s\n",
      );
    }
  } finally {
    live.session.close();
  }

  const snapshots = live.snapshots();
  const conversationSeconds = live.elapsed();

  if (snapshots.length === 0) {
    throw new Error(
      "the session reported no usageMetadata at all — nothing can be said about cost from this run",
    );
  }

  // Cumulative or per-turn? Read it off the data rather than assuming: if prompt
  // token counts only ever rise, the server is reporting a running total for the
  // session, and summing the snapshots would count the same tokens many times.
  const promptSeries = snapshots.map((s) => s.promptTokens ?? 0);
  const cumulative = promptSeries.every((v, i) => i === 0 || v >= promptSeries[i - 1]);
  const last = snapshots.at(-1)!;

  const totalPrompt = cumulative
    ? (last.promptTokens ?? 0)
    : snapshots.reduce((a, s) => a + (s.promptTokens ?? 0), 0);
  const totalResponse = cumulative
    ? (last.responseTokens ?? 0)
    : snapshots.reduce((a, s) => a + (s.responseTokens ?? 0), 0);

  const perMinuteIn = (totalPrompt / conversationSeconds) * 60;
  const perMinuteOut = (totalResponse / conversationSeconds) * 60;

  // EVERY prompt token is priced at the AUDIO rate, including the text ones (the
  // system instruction and the running transcriptions, about a third of them
  // here). Text on a Live session is billed lower, so this figure is an UPPER
  // BOUND rather than an estimate — which is the direction an unverified rate
  // should err in when the conclusion it feeds is "this side is cheaper".
  const costPerMinute =
    (perMinuteIn * GEMINI_LIVE_AUDIO.input + perMinuteOut * GEMINI_LIVE_AUDIO.output) / 1_000_000;

  // The reply-latency decomposition (#100). The VAD window is read off the same
  // config object the session was opened with, so if the tuning moves this
  // report moves with it. Everything above that floor is the model's time to
  // first audio plus the network — the part no VAD tuning can touch.
  const vadSilenceMs =
    liveConfig.realtimeInputConfig?.automaticActivityDetection?.silenceDurationMs ?? null;
  const latencies = live.latencies();
  const firstAudioSamples = latencies
    .map((l) => l.firstAudioChunkMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const medianFirstAudioMs =
    firstAudioSamples.length === 0
      ? null
      : firstAudioSamples[Math.floor((firstAudioSamples.length - 1) / 2)];

  const record = {
    measuredAt: new Date().toISOString(),
    model: LIVE_MODEL,
    topicSlug: TOPIC.slug,
    turnsAttempted: script.length,
    turnsCompleted: live.turns(),
    conversationSeconds,
    candidateAudioSecondsSent: audioSecondsSent,
    examinerAudioChunks: live.examinerAudioChunks(),
    examinerTranscript: live.examinerText(),
    turnLatencies: latencies,
    vadSilenceDurationMs: vadSilenceMs,
    usageIsCumulative: cumulative,
    totalPromptTokens: totalPrompt,
    totalResponseTokens: totalResponse,
    promptByModality: last.promptByModality,
    responseByModality: last.responseByModality,
    snapshots,
    derived: {
      medianFirstAudioChunkMs: medianFirstAudioMs,
      medianModelAndNetworkMs:
        medianFirstAudioMs !== null && vadSilenceMs !== null
          ? medianFirstAudioMs - vadSilenceMs
          : null,
      promptTokensPerMinute: perMinuteIn,
      responseTokensPerMinute: perMinuteOut,
      costPerMinuteUsd: costPerMinute,
      // Labelled `extrapolated` in the field name so no reader can mistake it
      // for a measurement of a sitting that never happened.
      extrapolatedSittingSeconds: SITTING_SECONDS,
      extrapolatedSittingCostUsd: (costPerMinute * SITTING_SECONDS) / 60,
    },
    rates: GEMINI_LIVE_AUDIO,
  };

  const outDir = resolve(import.meta.dirname, "../docs/comparison/runs");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `live-${record.measuredAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const latencyLines =
    medianFirstAudioMs === null
      ? "  reply latency            no examiner audio observed"
      : `  reply latency            ${(medianFirstAudioMs / 1000).toFixed(2)}s median from last word to first audio chunk
                           (${firstAudioSamples.map((v) => (v / 1000).toFixed(2)).join("s, ")}s across turns)${
                             vadSilenceMs === null
                               ? ""
                               : `
                           of which ${(vadSilenceMs / 1000).toFixed(2)}s is the VAD end-of-speech window, ${((medianFirstAudioMs - vadSilenceMs) / 1000).toFixed(2)}s model+network`
                           }`;

  console.log(`
  conversation             ${conversationSeconds.toFixed(1)}s, ${live.turns()} examiner turns
${latencyLines}
  usage reporting          ${cumulative ? "cumulative (running session total)" : "per-message"}
  prompt tokens            ${totalPrompt} (${perMinuteIn.toFixed(0)}/min)  ${JSON.stringify(last.promptByModality)}
  response tokens          ${totalResponse} (${perMinuteOut.toFixed(0)}/min) ${JSON.stringify(last.responseByModality)}
  measured cost            $${costPerMinute.toFixed(4)}/min
  EXTRAPOLATED per sitting $${((costPerMinute * SITTING_SECONDS) / 60).toFixed(2)} for ${SITTING_SECONDS / 60} min

  Recorded ${outPath}
`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
