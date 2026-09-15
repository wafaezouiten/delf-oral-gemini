import type { OralTopic } from "@/lib/delf/topics";
import { DEV_TOOLS_ENABLED } from "@/lib/dev-tools";
import type { ExamFinishedPayload } from "@/lib/live/exam-controller";
import {
  CORRECTION_TIMED_OUT,
  describeFinishFailure,
  type FinishFailure,
} from "@/lib/ui/finish-failure";
import type { StoredResult } from "@/lib/ui/stored-result";

import { fetchCorrectionStatus, waitForCorrection } from "./correction-wait";
import { postFinishRequest, type FinishAnswer, type UploadProgress } from "./finish-request";
import { selectDeliverable } from "./uploaded-recording";

/**
 * Handing the sitting in: the form, the answer, and what the screen does next.
 *
 * Out of `exam-client.tsx`'s finish handler so `node --test` can drive the
 * whole exchange with a fake route (#234): which recordings are attached and
 * which are dropped for not fitting, what a 4xx, a 202 and a 200 each mean,
 * and what is stashed for the results page when the correction comes back in
 * the response. The component keeps the state it draws and the navigation.
 */

export type SpeakingPhase = "monologue" | "debate";

/** The multipart body the finish route reads, and the phases it will not hear. */
export interface FinishForm {
  form: FormData;
  /** Recordings that did not fit in one request beside the rest of the sitting:
   *  graded from their transcript, measuring zero seconds. */
  dropped: SpeakingPhase[];
}

export function buildFinishForm(payload: ExamFinishedPayload, topicSlug: string): FinishForm {
  const form = new FormData();
  const json = JSON.stringify({
    topicSlug,
    transcript: payload.transcript,
    phases: payload.phases,
    reconnectCount: payload.reconnectCount,
    earlyClosingCount: payload.earlyClosingCount,
    soloVoicedSeconds: payload.soloVoicedSeconds,
    soloSeconds: payload.soloSeconds,
    devSeconds: payload.devSeconds,
    devSkippedSeconds: payload.devSkippedSeconds,
  });
  form.set("payload", json);

  // What fits in one request beside the payload — decided in
  // `uploaded-recording.ts`, where the ceiling is argued for.
  const deliverable = selectDeliverable(
    payload.recordings,
    (recording) => recording.blob.size,
    new TextEncoder().encode(json).length,
  );
  for (const recording of deliverable) {
    const extension = recording.mimeType === "audio/ogg" ? "ogg" : "wav";
    form.set(`audio-${recording.phase}`, recording.blob, `${recording.phase}.${extension}`);
  }

  const dropped: SpeakingPhase[] = [];
  for (const recording of payload.recordings) {
    if (deliverable.includes(recording)) continue;
    dropped.push(recording.phase);
    console.warn(
      `[finish] the ${recording.phase} recording (${recording.blob.size} bytes, ` +
        `${recording.mimeType}) was not attached: it does not fit in one request ` +
        "beside the rest of the sitting. That phase will be graded from its " +
        "transcript and will measure zero seconds.",
    );
  }
  return { form, dropped };
}

/**
 * What the results page reads back when the correction came with the answer.
 *
 * Durations are the recorder's own measurement per phase, which is the number
 * the duration penalty was computed from. No `playable`: the finish response
 * carries no uris, so playback belongs to the server-read path alone.
 */
export function finishStash(
  payload: ExamFinishedPayload,
  topic: OralTopic,
  evaluation: StoredResult["evaluation"],
  examinerModel: string,
): StoredResult {
  const recordedSeconds = (phase: SpeakingPhase) =>
    payload.phases.find((report) => report.phase === phase)?.recordedSeconds ?? 0;
  return {
    evaluation,
    topic,
    transcript: payload.transcript,
    monologueSeconds: recordedSeconds("monologue"),
    debateSeconds: recordedSeconds("debate"),
    reconnectCount: payload.reconnectCount,
    earlyClosingCount: payload.earlyClosingCount,
    examinerModel,
  };
}

export type FinishOutcome =
  /** Graded behind the response and now on the record: go and read it. */
  | { kind: "corrected" }
  /** Graded in the response: stash this for the results page, then go. */
  | { kind: "stashed"; stash: StoredResult }
  /** Refused, or the correction never came: the screen says so and offers a retry. */
  | { kind: "failed"; failure: FinishFailure }
  /** The screen went away mid-wait; nothing to draw. */
  | { kind: "cancelled" };

export interface FinishSubmission {
  examId: string;
  topic: OralTopic;
  payload: ExamFinishedPayload;
  form: FormData;
  /** Which examiner spoke, for the stash's provenance line. */
  examinerModel: string;
  onUploadProgress: UploadProgress;
  /** The route answered 202: the correction is being computed behind it. */
  onAwaitingCorrection: () => void;
  /** Whether the screen is still there to draw the outcome. */
  cancelled: () => boolean;
  /** Injectable for the tests; the browser's own by default. */
  post?: typeof postFinishRequest;
  isCorrected?: () => Promise<boolean>;
  waitOptions?: Parameters<typeof waitForCorrection>[1];
}

/**
 * Send the form and read the answer through to an outcome.
 *
 * Three answers are legal. A non-2xx is the route's refusal, worded by
 * `describeFinishFailure`. A 202 with `pending` means the sitting is safe and
 * the correction is being computed behind the response (#86): wait for it by
 * polling the status route, and give up with `CORRECTION_TIMED_OUT` rather
 * than for ever. A 200 with `evaluation` is the correction itself. Anything
 * else — a 2xx with no JSON, a 200 with neither word — is the route breaking
 * its contract, reported as a plain failure with the cause logged.
 */
export async function submitFinish(submission: FinishSubmission): Promise<FinishOutcome> {
  const post = submission.post ?? postFinishRequest;
  try {
    const startedAt = Date.now();
    const answer = await post(
      `/api/exams/${submission.examId}/finish`,
      submission.form,
      submission.onUploadProgress,
    );
    if (DEV_TOOLS_ENABLED) {
      console.info(
        `[finish] answered ${answer.status} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      );
    }
    return await readFinishAnswer(answer, submission);
  } catch (error) {
    console.error(error);
    return { kind: "failed", failure: describeFinishFailure(null, null) };
  }
}

async function readFinishAnswer(
  { status, body }: FinishAnswer,
  submission: FinishSubmission,
): Promise<FinishOutcome> {
  if (status < 200 || status >= 300) {
    return { kind: "failed", failure: describeFinishFailure(status, body?.error) };
  }
  if (body === null) throw new Error("the finish route answered 200 without JSON");

  if (body.pending === true) {
    submission.onAwaitingCorrection();
    const outcome = await waitForCorrection(
      submission.isCorrected ?? (() => fetchCorrectionStatus(submission.examId)),
      { ...submission.waitOptions, cancelled: submission.cancelled },
    );
    if (outcome === "cancelled") return { kind: "cancelled" };
    if (outcome === "corrected") return { kind: "corrected" };
    return { kind: "failed", failure: CORRECTION_TIMED_OUT };
  }

  if (body.evaluation === undefined) {
    throw new Error("the finish route answered without a result or a pending word");
  }
  return {
    kind: "stashed",
    stash: finishStash(
      submission.payload,
      submission.topic,
      body.evaluation as StoredResult["evaluation"],
      submission.examinerModel,
    ),
  };
}
