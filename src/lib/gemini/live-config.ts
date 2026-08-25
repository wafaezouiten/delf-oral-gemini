/**
 * Per-phase Gemini Live configuration — where the DELF exam structure becomes
 * transport behaviour.
 *
 * The brief's central requirement is that Gemini must behave differently in the
 * monologue and in the débat. The naive way to do that is to ask it nicely in
 * the prompt. That is not reliable: a conversational model asked to "please stay
 * silent" will still emit an encouraging "d'accord" the moment the candidate
 * pauses for breath, which is exactly what ruins a monologue suivi.
 *
 * So the difference is enforced at the protocol level instead:
 *
 *   MONOLOGUE — `automaticActivityDetection.disabled: true`. With manual
 *     activity signalling, the model only takes a turn when the CLIENT sends
 *     `activityEnd`. The exam controller sends `activityStart` once when the
 *     monologue begins and withholds `activityEnd` for the whole phase, so the
 *     model is structurally unable to interrupt. Meanwhile
 *     `inputAudioTranscription` keeps streaming the candidate's words, so we
 *     still capture everything they say. Silence is a guarantee, not a request.
 *
 *   DÉBAT — automatic VAD, tuned for a language learner: a long
 *     `silenceDurationMs`, because a B2 candidate searching for a word pauses
 *     far longer than a native speaker and must not be cut off mid-thought.
 *
 * Both phases enable session resumption and context-window compression, because
 * a Gemini Live connection lives roughly 10 minutes and the débat targets 13.
 * Those two fields are the difference between an exam that survives its own
 * length and one that dies in the middle.
 *
 * All field names below were verified against the installed @google/genai
 * typings, not copied from a blog post.
 */

import { Modality, type LiveConnectConfig } from "@google/genai";

import { buildExaminerInstruction } from "@/lib/delf/examiner-prompt";
import type { OralTopic } from "@/lib/delf/topics";
import { LIVE_MODEL } from "./constants";

export { LIVE_MODEL };

/**
 * A measured, adult French voice. `Charon` is one of the prebuilt Live voices
 * and reads as a plausible examiner; the languageCode pins the output to French
 * so the model does not drift into English on an ambiguous turn.
 */
const EXAMINER_SPEECH = {
  languageCode: "fr-FR",
  voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } },
} as const;

/**
 * Enabled on every phase so the server keeps issuing resumption handles. Without
 * this field the server sends no `sessionResumptionUpdate` at all, and a
 * reconnect has nothing to resume from — the exam would restart.
 *
 * Deliberately EMPTY. The obvious thing to add is `transparent: true`, which
 * asks the server to report the last consumed client message index; the SDK
 * accepts it and the docs describe it. The Developer API then rejects the
 * connection outright at runtime:
 *
 *   "transparent parameter is only supported in Gemini Enterprise Agent
 *    Platform mode, not in Gemini Developer API mode."
 *
 * Found by connecting, not by reading. Resumption itself works fine without it.
 */
const RESUMPTION = {} as const;

/**
 * Sliding-window compression. Without it an audio-only session is capped at 15
 * minutes; a full B2 exam (7 min monologue + 13 min débat) exceeds that. With
 * it the session can run indefinitely, at the cost of dropping the oldest turns
 * — acceptable here because the evaluation reads our own transcript, not
 * Gemini's context.
 */
const COMPRESSION = { slidingWindow: {} } as const;

export interface LiveConfigOptions {
  topic: OralTopic;
  /** Resumption handle from a previous session, when reconnecting. */
  resumptionHandle?: string;
  /**
   * DEVELOPMENT ONLY — a system instruction to use instead of the built one
   * (#148).
   *
   * The whole of the examiner's behaviour, replaced. It reaches this file only
   * from the token route, which accepts it only where the development tooling
   * is enabled and drops it everywhere else, so a production mint cannot carry
   * one. Absent on every real sitting, and absent is the only state the shipped
   * product has.
   *
   * Applied to the instruction and to nothing else: the VAD mode, the
   * resumption, the compression and the temperature are what make the monologue
   * a monologue, and a prompt experiment must not be able to reach them.
   */
  instructionOverride?: string;
}

/**
 * The monologue configuration: the examiner listens and cannot interrupt.
 *
 * `responseModalities: [AUDIO]` is kept (rather than dropping to TEXT) because
 * the examiner still speaks two lines in this phase — the opening handover and
 * the closing sentence — and a session cannot change modality later.
 */
export function monologueConfig({
  topic,
  resumptionHandle,
  instructionOverride,
}: LiveConfigOptions): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    speechConfig: EXAMINER_SPEECH,
    systemInstruction: instructionOverride ?? buildExaminerInstruction("monologue", topic),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: resumptionHandle ? { handle: resumptionHandle, ...RESUMPTION } : RESUMPTION,
    contextWindowCompression: COMPRESSION,
    realtimeInputConfig: {
      // The whole mechanism. See the module comment.
      automaticActivityDetection: { disabled: true },
    },
    // A lower temperature keeps the two scripted lines close to the wording the
    // prompt specifies instead of improvising a conversation.
    temperature: 0.4,
  };
}

/**
 * The débat configuration: a genuinely interactive, adversarial examiner.
 *
 * `silenceDurationMs` is the single most consequential number in this file. The
 * documented floor is 500 ms; that is tuned for native speakers and would have
 * the examiner talking over a candidate who pauses to conjugate.
 *
 * It is also, measured, most of the reply latency (#100). `pnpm measure:live`
 * against the real service (run of 2026-08-20, in `docs/comparison/runs`) put
 * the median last-word-to-first-audio gap at 1.63 s with this window at 1200 ms
 * — the model's own time to first audio was 0.43 s and flat across six turns,
 * so roughly three quarters of what the candidate waits through is this number.
 * 1000 ms is the shortest window the learner-protection floor in
 * `live-config.test.ts` allows: every millisecond cut here comes straight off
 * the reply gap, but is also a millisecond less a B2 candidate may pause
 * mid-sentence before the examiner takes their unfinished turn. Cutting below
 * one second would need evidence about learner pause lengths, not more latency
 * measurements — the failure it risks is the exam's, not the transport's.
 */
export function debateConfig({
  topic,
  resumptionHandle,
  instructionOverride,
}: LiveConfigOptions): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    speechConfig: EXAMINER_SPEECH,
    systemInstruction: instructionOverride ?? buildExaminerInstruction("debate", topic),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: resumptionHandle ? { handle: resumptionHandle, ...RESUMPTION } : RESUMPTION,
    contextWindowCompression: COMPRESSION,
    realtimeInputConfig: {
      automaticActivityDetection: {
        prefixPaddingMs: 300,
        silenceDurationMs: 1000,
      },
    },
    // Higher than the monologue: the examiner has to invent counter-arguments,
    // not recite a line.
    temperature: 0.9,
  };
}

/** The config for a phase. */
export function liveConfigForPhase(
  phase: "monologue" | "debate",
  options: LiveConfigOptions,
): LiveConnectConfig {
  return phase === "monologue" ? monologueConfig(options) : debateConfig(options);
}
