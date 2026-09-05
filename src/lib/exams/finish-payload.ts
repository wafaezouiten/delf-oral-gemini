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
 * The most reconnections a sitting may claim.
 *
 * Generous on purpose, and sized against the worst sitting rather than a round
 * number: an épreuve is about 20 minutes and a Live session takes seconds to
 * reopen, so even one dropping every two seconds for its whole length lands
 * near 600. A test pins that relation, and it is what caught the first figure
 * here (500) being under it.
 *
 * What it bounds is the two ways an unbounded count goes wrong, and only one of
 * them was ever theoretical:
 *
 *  - **`oral_exams.reconnect_count` is an `integer`.** A claim past 2^31 passes
 *    `nonnegative()`, reaches the INSERT and fails it, and a failed write here
 *    costs a candidate their whole correction, shown to them as « correction
 *    perdue ». That is the same overflow the #92 clamp closed for
 *    `earlyClosingCount`, which this field had no equivalent of.
 *  - **It reaches the corrector's prompt since #189.** « la connexion a été
 *    interrompue 999999999 fois » is not a sentence to put in front of a model
 *    that is about to grade somebody (raised in review of #196).
 *
 * A `.max()` rather than a clamp, matching every other bounded field here:
 * no honest client sends more than this, so the value is refused rather than
 * quietly rewritten into something the browser never said.
 */
export const MAX_RECONNECTS = 1000;

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
  reconnectCount: z.number().int().nonnegative().max(MAX_RECONNECTS),
  /**
   * How many times the examiner tried to close the épreuve mid-débat (#92), as
   * `ExamController` counted it. The browser is the only witness — the goodbye
   * happened in a Live session the server never saw — so the shape is bounded
   * here like `reconnectCount`'s, and the VALUE is not taken alone: it is the
   * one number in this payload that can RAISE a grade rather than lower it —
   * positive, it waives the débat's penalties, reaching even the duration
   * penalty that is otherwise measured server-side from the uploaded bytes.
   * The route clamps it to the goodbyes the submitted transcript shows, which
   * bounds an incoherent or buggy claim but not a fabricated one, because the
   * transcript is this same payload; why that trust is accepted is
   * `resolveEarlyClosingCount`'s to say. The clamp is also why there is no
   * `.max()` here, where `reconnectCount` now has one: the clamp bounds the
   * stored value by the transcript's own turn
   * limit.
   *
   * Defaulted rather than required, unlike `reconnectCount`, because it is
   * being added to a payload that already exists in the wild: a candidate
   * mid-sitting across the deploy finishes from a page that has never heard of
   * the field, and a 400 there costs them a twenty-minute épreuve. Zero is the
   * truthful reading of that page — its controller predates the counter.
   */
  earlyClosingCount: z.number().int().nonnegative().default(0),
  /**
   * Seconds of VOICED audio the microphone measured, per part.
   *
   * The one field in this payload that can only ever protect the candidate, so
   * the trust question it raises is the opposite of every other one here: a
   * forged value cannot raise a mark, it can only cause the route to REFUSE to
   * produce one. Nothing downstream reads it as a duration — the duration
   * penalty is still measured server-side from the uploaded bytes — and it
   * reaches no column; it is consumed inside the request that carries it.
   *
   * What it is for: the monologue is transcribed in a single fragment emitted
   * at `activityEnd` (`docs/GEMINI_LIVE_FINDINGS.md` §6), so a session that
   * dies before that boundary loses the whole exposé at once. With only the
   * transcript to go on, the rubric read that as a candidate who never
   * presented, halved their mark, and said so on the correction page. The
   * microphone knows better, and this is how it gets to say so.
   *
   * Optional for the reason `earlyClosingCount` is defaulted: a candidate
   * mid-sitting across the deploy finishes from a page whose controller has
   * never heard of the field, and a 400 there costs them a twenty-minute
   * épreuve. Absent means "no evidence", which is what that page actually has.
   */
  voicedSeconds: z
    .object({
      monologue: z.number().nonnegative().max(MAX_PHASE_SECONDS),
      debate: z.number().nonnegative().max(MAX_PHASE_SECONDS),
    })
    .optional(),
  /**
   * DEVELOPMENT ONLY — the seconds a typed phase claims to have lasted (#36).
   *
   * The one number in this file that can reach a grade, which is why the bound
   * is not the only thing standing in front of it. The route ignores this
   * outright in a production build, and honours it only for a phase that
   * uploaded no audio: with a recording present the recording still wins, so
   * this cannot dress a short sitting up as a long one. It exists because a
   * typed phase has no audio — an ENFORCED fact since #51, not an assumption:
   * the controller drops a typed phase's artefact at the phase boundary, so
   * the stub of room tone that used to ride in front of a typed exposé (and
   * silently displace this claim) never leaves the tab. Without the claim, a
   * permanent −3 makes the rubric's only interesting threshold untestable
   * without a microphone.
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
