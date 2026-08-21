/**
 * What `POST /api/exams/:examId/finish` will accept as its JSON half.
 *
 * Extracted from the route so it can be tested at all. `route.ts` transitively
 * imports `server-only`, Clerk and the database client, so nothing in it can be
 * loaded by `node --test` — which left the request validation, the one thing on
 * that route standing between an authenticated stranger and the server's
 * memory, as the only security-shaped code in the repo with no coverage.
 *
 * Everything here is a bound on something the server cannot check any other way.
 * The numbers that decide a grade are not in this file: the recording's duration
 * is measured from the uploaded bytes in the route, and the evaluation mode is
 * derived there rather than accepted here. What is left is the wall clock and
 * the transcript, which the browser is the only witness to — so they are taken
 * on trust, and the trust is bounded.
 */

import { z } from "zod";

// The transcript half of this payload, shared with the progress route since
// Phase 8 — both write turns into the same column, so both are bounded by the
// same numbers rather than by two copies of them.
import { transcriptSchema } from "./transcript-payload";

export { MAX_TRANSCRIPT_CHARS, MAX_TURNS, MAX_TURN_CHARS } from "./transcript-payload";

/**
 * The longest a phase's clock may claim to have run.
 *
 * It decides nothing — the duration penalty is computed from the measured
 * recording — but it is written to an audit column, and an audit trail that
 * accepts a four-figure hour count is decoration rather than evidence. Four
 * hours is absurd for a 13-minute task and still far outside anything a stalled
 * tab's clock could plausibly produce.
 */
export const MAX_PHASE_SECONDS = 4 * 60 * 60;

/**
 * One phase, as the browser saw it. Deliberately carries no recorded duration:
 * the recording's length is measured from the recording itself, and a second
 * copy of it here would be a number that can disagree with the file it
 * describes.
 */
const phaseReportSchema = z
  .object({
    phase: z.enum(["monologue", "debate"]),
    /** Wall clock. What the candidate watched count down. */
    elapsedSeconds: z.number().nonnegative().max(MAX_PHASE_SECONDS),
    /**
     * Epoch ms. Required, not nullable: a phase is only reported at all because
     * it was entered, and entering it is exactly what stamps this
     * (`ExamController.beginRecording`). Accepting null let a hand-crafted
     * payload write a phase that ended without ever starting.
     */
    startedAt: z.number().int().nonnegative(),
    /** Null for a phase entered but never left. */
    endedAt: z.number().int().nonnegative().nullable(),
  })
  .refine(
    (report) => report.endedAt === null || report.endedAt >= report.startedAt,
    "a phase cannot end before it started",
  );

/**
 * The client's payload, validated rather than asserted.
 *
 * These numbers end up in NOT NULL integer columns with `>= 0` constraints, so a
 * missing field used to travel as far as `Math.round(undefined)` → NaN and fail
 * at the INSERT — after a paid model call had already run, and inside a catch
 * that only logs. Failing here costs nothing and says what was wrong.
 *
 * `z.number()` rejects NaN and Infinity on its own in Zod 4; the explicit checks
 * are the domain's, not the format's.
 */
export const finishPayloadSchema = z.object({
  /** Bounded to the column it is looked up against (`oral_topics.slug`). */
  topicSlug: z.string().min(1).max(128),
  transcript: transcriptSchema,
  /** At most one entry per phase, and only for phases actually entered. */
  phases: z
    .array(phaseReportSchema)
    .max(2)
    .refine(
      (reports) => new Set(reports.map((report) => report.phase)).size === reports.length,
      "a phase cannot be reported twice",
    ),
  reconnectCount: z.number().int().nonnegative(),
  /**
   * DEVELOPMENT ONLY — the seconds a typed phase claims to have lasted (#36).
   *
   * The one number in this file that can reach a grade, which is why the bound
   * is not the only thing standing in front of it. The route ignores this
   * outright in a production build, and honours it only for a phase that
   * uploaded no audio: with a recording present the recording still wins, so
   * this cannot dress a short sitting up as a long one. It exists because a
   * typed sitting has no audio at all, and a permanent −3 makes the rubric's
   * only interesting threshold untestable without a microphone.
   *
   * Validated here regardless of environment. A schema that changes shape with
   * `NODE_ENV` is a schema whose tests prove nothing about production.
   */
  devSeconds: z
    .object({
      monologue: z.number().nonnegative().max(MAX_PHASE_SECONDS),
      debate: z.number().nonnegative().max(MAX_PHASE_SECONDS),
    })
    .optional(),
});

export type FinishPayload = z.infer<typeof finishPayloadSchema>;
