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

/** One examiner the candidate may choose (#99). */
export interface LiveModelOption {
  /** The raw model id — what is stored, minted and connected with. */
  id: string;
  /** The readable name the picker shows. The id stays visible beside it: a
   *  label alone would hide which model actually ran. */
  label: string;
  /** What choosing it changes, in one candidate-facing French clause. */
  detail: string;
}

/**
 * The examiners a candidate may choose between (#99) — and, server-side, the
 * allow-list a requested model id is checked against before it reaches Google.
 *
 * Membership here is a claim about the REAL service, not about the catalogue:
 * every id was verified by minting a constrained token and opening a session
 * (run of 2026-08-20). That check is what keeps trap 4 of #99 out of the
 * picker — a listed model can still be unrunnable, and both failure shapes are
 * silent at the point of choice: `gemini-2.5-flash-native-audio-preview-09-2025`
 * opens a socket and never speaks, and a retired id dies at the handshake with
 * 1011 and no diagnostic. Nothing goes in this list without a probe.
 *
 * **One probe is not a sitting** (#218). Membership was established by minting a
 * token and opening a session, which is exactly long enough to catch the two
 * failure shapes above and far too short to catch the third: a session that
 * works for three turns and then stops both speaking and listening, with the
 * socket still open and nothing on it to react to.
 * `gemini-2.5-flash-native-audio-preview-12-2025` does that after roughly 50
 * seconds of its own speech, and did it again with context compression removed;
 * the default examiner ran the same eight-turn script without a fault
 * (`docs/GEMINI_LIVE_FINDINGS.md` §7). It stays on the list because
 * `ExamController.checkSessionDeafness` now notices and reconnects — which was
 * probed and works — and because a candidate choosing it is told, in the
 * `detail` below, that their débat may be interrupted. What it must not be is
 * on this list silently.
 *
 * `gemini-2.5-flash-native-audio-latest` also ran, and is left out on purpose:
 * it is a moving alias, and a sitting that stores it cannot answer "which
 * examiner graded this?" once the alias moves — which is the whole reason the
 * choice is stored.
 */
export const LIVE_MODEL_OPTIONS: readonly LiveModelOption[] = [
  {
    id: "gemini-3.1-flash-live-preview",
    label: "Gemini 3.1 Flash Live",
    detail: "L'examinateur habituel : réactif et éprouvé sur l'épreuve entière.",
  },
  {
    id: "gemini-2.5-flash-native-audio-preview-12-2025",
    label: "Gemini 2.5 Native Audio",
    detail: "Voix plus naturelle, mais moins stable : le débat peut être interrompu brièvement.",
  },
];

/**
 * Whether an id may run an examiner session.
 *
 * The env-configured default passes even when it is not in the option list:
 * `NEXT_PUBLIC_GEMINI_LIVE_MODEL` exists so an operator can outrun a preview
 * rename without a code change, and an override that the allow-list then
 * refused would break every untouched sitting.
 */
export function isSelectableLiveModel(id: string): boolean {
  return id === LIVE_MODEL || LIVE_MODEL_OPTIONS.some((option) => option.id === id);
}

/**
 * What the picker renders: the verified options, with the configured default
 * first. When the env override names a model outside the list, it is prepended
 * under its raw id — unreadable, but honest, and the candidate who touches
 * nothing must be able to see what they are getting.
 */
export function liveModelChoices(): LiveModelOption[] {
  const options = [...LIVE_MODEL_OPTIONS];
  const defaultIndex = options.findIndex((option) => option.id === LIVE_MODEL);
  if (defaultIndex > 0) {
    const [fallback] = options.splice(defaultIndex, 1);
    options.unshift(fallback);
  } else if (defaultIndex === -1) {
    options.unshift({
      id: LIVE_MODEL,
      label: LIVE_MODEL,
      detail: "Modèle configuré par défaut.",
    });
  }
  return options;
}

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
