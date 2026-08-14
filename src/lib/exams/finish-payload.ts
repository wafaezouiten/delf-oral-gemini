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

import type { TranscriptEntry } from "@/lib/delf/transcript";

/**
 * How long one turn's text may be.
 *
 * Sized against what the transcript actually produces, not against a guess.
 * `appendFragment` coalesces consecutive fragments from the same speaker, and
 * the monologue is by construction ONE turn — Gemini emits nothing until
 * `activityEnd` and then the whole exposé at once. Seven minutes of fast French
 * is roughly 1 300 words, call it 9 000 characters, so a 4 000-character cap
 * would reject a perfectly ordinary sitting. 20 000 is comfortably clear of the
 * longest legitimate turn and still four orders of magnitude below what an
 * unbounded field allows.
 */
export const MAX_TURN_CHARS = 20_000;

/** Turns in a sitting. A talkative 13-minute débat is well under a hundred. */
export const MAX_TURNS = 500;

/**
 * And the whole transcript, bounded independently of how it is distributed
 * across turns — 500 turns of 20 000 characters each is 10 MB, which is not a
 * bound worth having. 200 000 characters is about 35 000 words against a
 * 20-minute exam's realistic ceiling of roughly 4 000.
 */
export const MAX_TRANSCRIPT_CHARS = 200_000;

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

const transcriptEntrySchema = z.object({
  phase: z.enum(["monologue", "debate"]),
  speaker: z.enum(["candidate", "examiner"]),
  timestamp: z.number(),
  text: z.string().max(MAX_TURN_CHARS),
}) satisfies z.ZodType<TranscriptEntry>;

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
  transcript: z
    .array(transcriptEntrySchema)
    .max(MAX_TURNS)
    .refine(
      (entries) => entries.reduce((n, entry) => n + entry.text.length, 0) <= MAX_TRANSCRIPT_CHARS,
      "the transcript is longer than any real épreuve produces",
    ),
  /** At most one entry per phase, and only for phases actually entered. */
  phases: z
    .array(phaseReportSchema)
    .max(2)
    .refine(
      (reports) => new Set(reports.map((report) => report.phase)).size === reports.length,
      "a phase cannot be reported twice",
    ),
  reconnectCount: z.number().int().nonnegative(),
});

export type FinishPayload = z.infer<typeof finishPayloadSchema>;
