/**
 * Telling speech from an open microphone.
 *
 * The épreuve needs to know whether the candidate *spoke*, and until now nothing
 * could answer that (#39). The two numbers that existed both answer something
 * else:
 *
 *  - the transcript is empty during the monologue **by design** — Gemini
 *    transcribes nothing until the floor is released, so the whole exposé
 *    arrives at once at the end;
 *  - `measuredSeconds` counts samples, and sixty seconds of silence into a
 *    working microphone measures sixty seconds.
 *
 * So this measures the frames themselves. It is deliberately the crudest thing
 * that works — root-mean-square amplitude against a fixed threshold — and not a
 * voice activity detector: it cannot tell a candidate from a passing lorry, and
 * it is not asked to. The question it answers is "was this microphone carrying
 * anything at all, or a room tone?", which is the difference between a candidate
 * who attempted the task and one who sat in silence.
 *
 * That crudeness is affordable because of what the answer is used for. Nothing
 * here blocks anybody: a monologue judged silent produces a *confirmation*, not
 * a refusal (see `monologueWasSilent` in `lib/delf/phases.ts`). A quiet speaker
 * on a low-gain microphone therefore meets one extra dialog, which is a cost
 * worth paying to stop a silent sitting reaching the débat by accident. A
 * detector that could be wrong in the other direction — refusing to let someone
 * continue — would need to be far better than this one.
 *
 * Free of the browser and of the transport, like everything else in this folder,
 * so the arithmetic is testable without a microphone.
 */

/** The full-scale value of a PCM16 sample, for normalising RMS to 0..1. */
const PCM16_FULL_SCALE = 32_768;

/**
 * Normalised RMS above which a frame counts as carrying speech.
 *
 * 0.02 is about −34 dBFS. Digital silence is 0; a quiet room through a typical
 * laptop microphone sits well under 0.01; conversational speech runs an order of
 * magnitude above it. The gap between room tone and a voice is wide, which is
 * the only reason a single fixed number is defensible here.
 *
 * Tuning it moves how readily the confirmation appears, and nothing else — see
 * the header for why that is a safe direction to be wrong in.
 */
export const VOICE_RMS_THRESHOLD = 0.02;

/**
 * Root-mean-square amplitude of a PCM16 frame, normalised to 0..1.
 *
 * RMS rather than peak, but be clear about how little that buys: one full-scale
 * sample in a 640-sample frame still yields √(1/640) ≈ 0.0395, which is over the
 * threshold below. A single click therefore *does* mark its frame voiced, and
 * raising the threshold past it would also reject quiet speech — a 0.05
 * amplitude sine measures 0.035. Per-frame, a click and a soft voice are not
 * reliably separable at all.
 *
 * **The aggregate is what does the work.** A frame is 40 ms, so one click buys
 * 0.04 voiced seconds and the rule downstream asks for several whole seconds
 * (`MIN_VOICED_SECONDS`). Room noise has to be sustained and speech-loud for
 * seconds on end before it reads as an attempt at the task, which is a much
 * harder accident than a door slamming once.
 *
 * Returns 0 for an empty frame rather than `NaN`, because this feeds a
 * comparison and a `NaN` there would silently answer "not voiced" for reasons
 * nobody could see.
 */
export function frameRms(frame: Int16Array): number {
  if (frame.length === 0) return 0;

  let sumOfSquares = 0;
  for (const sample of frame) {
    const normalised = sample / PCM16_FULL_SCALE;
    sumOfSquares += normalised * normalised;
  }
  return Math.sqrt(sumOfSquares / frame.length);
}

/** Whether a frame carries speech rather than room tone. */
export function isVoiced(frame: Int16Array, threshold = VOICE_RMS_THRESHOLD): boolean {
  return frameRms(frame) > threshold;
}
