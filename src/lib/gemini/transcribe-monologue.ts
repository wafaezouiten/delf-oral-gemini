import "server-only";

/**
 * The monologue's transcript, read off its own recording.
 *
 * **Why this exists at all.** The exposé is supposed to be transcribed by the
 * Live session that heard it: manual voice-activity detection holds the
 * candidate's floor open for the whole part — which is what stops the examiner
 * interrupting them — and the single `activityEnd` that closes it is what makes
 * Gemini emit the transcription of everything said inside it. That mechanism
 * has a ceiling nobody had measured. Against the real service
 * (`scripts/probe-monologue-close.ts`):
 *
 *     224s of exposé, manual VAD : 3010 chars, 1.8s after activityEnd
 *     258s of exposé, manual VAD : nothing, ever
 *     310s of exposé, manual VAD : nothing, ever
 *     370s of exposé, manual VAD : nothing, ever
 *     370s of exposé, automatic VAD (the débat's config) : 3457 chars, live
 *
 * Somewhere under four minutes inside one open activity, `activityEnd` stops
 * producing an `inputTranscription` and never produces one — no error, no empty
 * fragment, and the examiner's closing sentence arrives exactly as it always
 * does, so nothing in the app notices. The automatic-VAD control on the same
 * audio rules out the length of the recording and the sliding window; what
 * fails is the long open activity. A DELF B2 exposé is five to seven minutes,
 * so EVERY spoken monologue fell in the failing range, reached the finish route
 * as zero candidate words, and was refused as a candidate who had said nothing.
 *
 * **Why not automatic VAD, then.** Because the monologue's silence is bought
 * with the missing turn boundary: give the model boundaries and it takes turns.
 * Releasing the floor periodically was measured too
 * (`scripts/probe-monologue-segments.ts`) and is worse than it looks — three
 * transcriptions from six boundaries, and at one of them the examiner announced
 * the end of an exposé that was still in progress.
 *
 * So the transcript comes from the artefact instead. The recording already
 * exists, is already compressed for upload, and is already what the corrector
 * hears; asking a model to read it back is the one route to the words that does
 * not go through a live socket at all.
 *
 * **What it costs, on a free key.** A seven-minute recording is about 9 900
 * audio tokens and the free tier allows 10 000 input tokens per minute for this
 * model, so one exposé very nearly is the minute's budget. A 429 here is
 * survivable — the transcript is missing, the épreuve is not — but two sittings
 * finishing their monologue in the same minute will collide on a free key.
 */

import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";

import { withTransientRetry, transientStatus } from "./transient";

/**
 * The transcriber: a model whose whole job this is.
 *
 * NOT the corrector's model, and that was not a preference. `gemini-3.6-flash`
 * transcribes a full-length exposé so unreliably that it is unusable here, and
 * it fails in the one shape this whole change exists to stop — silently. On the
 * SAME audio, at temperature 0, with a 32k output budget, two consecutive calls
 * returned 2703 characters and then nothing at all: `finishReason: STOP`, no
 * output tokens, no error. Across lengths from 52 s to 395 s the same call
 * returned 0, 4, 140, 507, 664, 1318 and 2703 characters. Turning thinking down
 * changed the failure's shape and not its rate.
 *
 * `gemini-3.5-transcribe` answers, every time, in a few seconds, and puts the
 * words in a part of its own — see {@link readTranscription}. On 395 s of the
 * fixture: 5356 characters in 8.5 s, and 2550 in 5.8 s. Both are transcripts
 * and neither is nothing, which is the bar the other model could not clear —
 * but the two are not the same length, so this is "reliably answers", not
 * "provably complete".
 *
 * That caveat is partly the fixture's: `verify-monologue-transcript.ts` has no
 * seven-minute recording of a person to hand and loops the app's own consignes
 * to reach the length, which is speech a transcriber has already heard four
 * times over. Whether a real exposé comes back whole is what
 * `e2e/monologue-transcription.spec.ts` is for, and it has not been run.
 *
 * The override stays for the day this id is renamed, which preview ids are.
 */
export const TRANSCRIBE_MODEL = process.env.GEMINI_TRANSCRIBE_MODEL ?? "gemini-3.5-transcribe";

/**
 * What the transcriber is asked for, in French because everything the models in
 * this app read is.
 *
 * Verbatim, hesitations included: this text is graded prose, and « euh » is
 * evidence on the phonologie and the aisance the grille asks about. Nothing but
 * the words — a model that helpfully writes « [silence] » or « L'étudiant dit :
 * » puts its own voice into a transcript the corrector reads as the
 * candidate's, which is exactly the failure #187 spent a release removing from
 * the examiner's side.
 */
const INSTRUCTION = [
  "Tu transcris l'enregistrement d'un candidat qui présente un exposé oral en français.",
  "",
  "Rends UNIQUEMENT la transcription littérale de ce que dit le candidat :",
  "- mot pour mot, y compris les hésitations (« euh »), les répétitions et les reprises ;",
  "- aucune correction de la grammaire, du vocabulaire ou de la syntaxe ;",
  "- aucun commentaire, aucune analyse, aucun horodatage, aucun nom de locuteur ;",
  "- aucune balise, aucun crochet, aucune indication de type « [silence] ».",
  "",
  "Si l'enregistrement ne contient aucune parole, réponds par une chaîne vide.",
].join("\n");

/**
 * Transcribe one recording. Returns the empty string for a recording with no
 * speech in it, which is a real answer and not a failure.
 *
 * Throws on anything else, and the caller decides what that is worth: on the
 * client this runs during the handover to the débat, where a failure costs the
 * exposé's transcript and must not cost the épreuve.
 *
 * **Inline rather than the Files API, unlike `evaluate.ts`.** One part's Opus is
 * on the order of a megabyte at `RECORDING_BITRATE` — seven minutes is about
 * 840 kB — comfortably inside the inline request limit even after base64. What
 * inlining skips is the upload-then-wait-for-ACTIVE dance whose race was the
 * best fit for #73's intermittence, on a call the candidate is waiting through
 * a consigne for.
 *
 * **The size cap is the route's, not this function's.** `MAX_RECORDING_BYTES`
 * is already the number one phase's artefact is held to when the same blob
 * reaches the finish, and the route is where untrusted bytes arrive. Re-checking
 * here would be a second number to keep in step, for no protection the first
 * does not already give.
 *
 * @param audio The recording's bytes. An `ArrayBuffer` rather than the `Blob`
 *   the route received, because the route has already read it once to decide
 *   what it is — reading it twice would double a multi-megabyte copy.
 * @param mimeType What the bytes turned out to BE, from
 *   `measureUploadedRecording` — never the label the client attached. A file
 *   offered under the wrong type transcribes silence.
 */
export async function transcribeMonologue(audio: ArrayBuffer, mimeType: string): Promise<string> {
  return readTranscription(await transcribeMonologueRaw(audio, mimeType));
}

/**
 * The words, out of wherever this model put them.
 *
 * `gemini-3.5-transcribe` does not answer in text parts. It answers in
 * `audioTranscription` parts, and `response.text` is therefore EMPTY — the SDK
 * says so out loud, on stderr, and returns "" anyway:
 *
 *     there are non-text parts audioTranscription in the response, returning
 *     concatenation of all text parts.
 *
 * Read through `.text` alone, a perfect transcription is indistinguishable from
 * a recording with nobody in it. The fallback keeps a general model — the
 * override exists — working through the same function.
 */
function readTranscription(response: GenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const spoken = parts
    .map((part) => (part as { audioTranscription?: { text?: string } }).audioTranscription?.text)
    .filter((text): text is string => typeof text === "string")
    .join(" ")
    .trim();
  return spoken || (response.text ?? "").trim();
}

async function transcribeMonologueRaw(
  audio: ArrayBuffer,
  mimeType: string,
): Promise<GenerateContentResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const ai = new GoogleGenAI({ apiKey });
  const data = Buffer.from(audio).toString("base64");

  // The same policy the corrector rides on: a busy model answers 503 and the
  // identical request goes through moments later, and here there is a candidate
  // waiting on a consigne for it.
  const response = await withTransientRetry(
    () =>
      ai.models.generateContent({
        model: TRANSCRIBE_MODEL,
        contents: [
          { role: "user", parts: [{ inlineData: { data, mimeType } }, { text: INSTRUCTION }] },
        ],
        config: {
          // A transcription is not a place for sampling: the same audio should
          // come back the same way, and a creative transcriber is a liar.
          //
          // Nothing else is set, and one absence is load-bearing: this model
          // refuses `thinkingConfig` outright — « Thinking level is not
          // supported for this model », 400 — which is the shape of a model
          // that does one job.
          temperature: 0,
        },
      }),
    {
      onRetry: (error, attempt, delayMs) =>
        console.warn(
          `[transcribe] monologue attempt ${attempt} failed ` +
            `(${transientStatus(error)}), retrying in ${delayMs}ms`,
        ),
    },
  );

  return response;
}
