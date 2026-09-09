/**
 * How long a part lasted, as everything downstream of the finish route sees it.
 *
 * ONE number per part, resolved once: it is what the rubric's duration tiers and
 * penalty are computed from, what the corrector is told, what
 * `oral_exam_phases.spoken_seconds` stores, and therefore what the results page
 * prints beside the mark. A second copy of this rule anywhere is a way for a
 * stored row to disagree with the correction that cites it (#17).
 *
 * Lives outside `route.ts` for the reason `finish-payload.ts` and
 * `uploaded-recording.ts` do: that file imports `server-only`, Clerk and the
 * database client, so nothing in it can be loaded by `node --test` — and this is
 * the arithmetic that decides a mark.
 *
 * **The rule it exists to hold.** A real sitting's duration is measured out of
 * the uploaded bytes, precisely so that no client can announce one. Both
 * exceptions here are development claims, gated on the same flag as the panels
 * that produce them (`lib/dev-tools.ts`), and each is shaped so it cannot be
 * used to dress a short sitting up as a long one on a deployment where marks are
 * real.
 */

/** What is known about one part when its duration has to be settled. */
export interface PhaseDurationInput {
  /**
   * The length measured out of this part's uploaded audio, in seconds. Zero
   * when no recording arrived — which is the intended answer rather than a gap:
   * a part nobody has a recording of has not been shown to have been produced.
   */
  measuredSeconds: number;
  /** Whether a recording arrived for this part at all. */
  hasRecording: boolean;
  /**
   * DEVELOPMENT ONLY — the seconds a typed part claims to have lasted (#36).
   *
   * SUBSTITUTED for the measurement, and only where there is none: with a
   * recording present the recording wins, so this can only ever describe a part
   * that produced no audio. Without it a typed part measures zero and takes the
   * short-duration penalty every single time, which makes the rubric's one
   * interesting threshold untestable without twenty minutes of spoken French.
   */
  devClaimedSeconds?: number;
  /**
   * DEVELOPMENT ONLY — the seconds the dev time-skip fast-forwarded past (#203).
   *
   * ADDED to whichever duration stands above, which is the whole difference
   * between this claim and the one before it: the skip does not describe a part
   * that produced no audio, it describes time a tester drove PAST while the
   * microphone went on recording everything else. So a real measurement stays
   * underneath it, and a sitting nobody skipped is graded on exactly the number
   * it is graded on today.
   *
   * It has to be said out loud because the skip is a rewind of the phase's start
   * stamp: the clock the épreuve is actually run off — the cue grid, the last
   * question, the closing lead, the time-up — already counts it, and the audio
   * cannot. Without this the tester watches the examiner call time at 13:00 and
   * then reads a correction of the eight minutes that were spoken.
   */
  devSkippedSeconds?: number;
  /**
   * Whether this build honours the two claims above at all. False in every
   * production build, where both are dropped unread — see `lib/dev-tools.ts`
   * for which environments that leaves.
   */
  devToolsEnabled: boolean;
}

/**
 * Settle one part's duration.
 *
 * Never negative and never NaN, though neither can arrive here: the measurement
 * is derived from a byte count and both claims are bounded by
 * `finishPayloadSchema`. The floor is written down anyway because the failure it
 * prevents is a rejected INSERT after a paid model call.
 */
export function gradedPhaseSeconds(input: PhaseDurationInput): number {
  const base =
    input.devToolsEnabled && !input.hasRecording && input.devClaimedSeconds !== undefined
      ? input.devClaimedSeconds
      : input.measuredSeconds;
  const skipped = input.devToolsEnabled ? (input.devSkippedSeconds ?? 0) : 0;
  const seconds = base + skipped;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}
