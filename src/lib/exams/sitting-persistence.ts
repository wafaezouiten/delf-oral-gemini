/**
 * Writing one sitting down, and reading it back — the policy half.
 *
 * Everything here is deliberately free of Drizzle, Neon, Clerk and Next, for the
 * same reason `auth/exam-access.ts` is: the interesting decisions in this phase
 * are *when* a write may happen and *what* happens when the same exam is
 * submitted twice, and neither is a question about SQL. The SQL lives in
 * `db/sittings.ts`, which implements {@link SittingStore} and nothing else.
 *
 * ## The three states a sitting can be in
 *
 * `oral_exams` alone cannot say whether an exam finished, because "finished" is
 * two facts: the candidate reached the end, *and* a correction exists for what
 * they produced. {@link sittingOutcome} is the one place that combines them, and
 * it is what makes an interrupted sitting distinguishable from a completed one
 * rather than something a reader has to reconstruct from two nullable columns.
 *
 * ## Why the correction is claimed rather than simply inserted
 *
 * `evaluations` has no unique index on `exam_id`, and must not grow one: this
 * project exists to score the SAME sitting twice, in `text` mode and in `audio`
 * mode, and compare (schema header, second bullet). So "one correction per
 * sitting" is not a database invariant available to us — it is a rule about one
 * code path, the finish route, and it is enforced here.
 *
 * The mechanism is a conditional UPDATE that no second caller can win
 * ({@link SittingStore.claimForCorrection}). The condition is *"this sitting has
 * no correction yet"*, not *"this sitting is not marked finished"*, and the
 * difference is the crash window: a claim that commits and a write that then
 * fails leaves a finished sitting with nothing attached, which reads as
 * `uncorrected` and — because the claim only ever asked about corrections — can
 * be repaired by simply finishing again. Keying on `finished_at` would have
 * stranded that sitting forever, marked done and never gradeable.
 *
 * What this does NOT close is two finishes racing at the same instant: under
 * READ COMMITTED both claims can see no correction, because neither has inserted
 * one yet. Closing that needs a unique index the schema deliberately does not
 * have, or a transaction the `neon-http` driver deliberately does not offer. The
 * realistic duplicate — a refreshed tab, a retried request, a candidate pressing
 * the button twice — costs a paid model call at worst and produces exactly one
 * correction, which is the case this phase is asked to handle.
 */

import type { OralCriterion } from "@/lib/delf/criteria";
import type { GrilleBand } from "@/lib/delf/grille";
import type { OralPhase } from "@/lib/delf/phases";
import type { TranscriptEntry } from "@/lib/delf/transcript";
import type { EvaluationFeedback, EvaluationMode, OralSpeakingPhase } from "@/lib/db/schema";

// =====================================================
// WHAT A SITTING IS MADE OF
// =====================================================

/**
 * A sitting, named the only way anything in this module is allowed to name one.
 *
 * The owner travels with the id on **every** call, including the reads. Not
 * because the caller has not already checked — `authorizeExam` runs first and
 * would have refused — but because a store method that accepts an id alone is a
 * method someone can call from a path where the check was forgotten. Making the
 * owner part of the address means the scoping cannot be left out by omission,
 * only by lying, and there is nothing in the request that can lie about it.
 */
export interface SittingRef {
  examId: number;
  userId: string;
}

/** One speaking phase's row, as this module hands it to the store. */
export interface PhaseRow {
  phase: OralSpeakingPhase;
  /** Measured from the audio, never from the browser's clock. See the header of
   *  the finish route for why those are two different numbers. */
  spokenSeconds: number;
  startedAt: Date | null;
  endedAt: Date | null;
}

/** One recording's row. The bytes are gone; this is the record that they were. */
export interface RecordingRow {
  phase: OralSpeakingPhase;
  uri: string | null;
  mimeType: string;
  byteSize: number;
  durationSeconds: number;
  deletedAt: Date | null;
}

/**
 * One correction, in the shape the `evaluations` row wants.
 *
 * Not `EvaluationResult`: that type carries the corrector's working — the
 * pre-snap bands, the model's own arithmetic — which is diagnostic output rather
 * than a stored fact. This is the subset the table has columns for.
 */
export interface CorrectionRow {
  mode: EvaluationMode;
  criteria: Record<OralCriterion, GrilleBand>;
  rawScore25: number;
  durationPenalty: number;
  score25: number;
  meetsFloor: boolean;
  feedback: EvaluationFeedback;
  model: string;
  promptVersion: string;
  latencySeconds: number | null;
}

/** A correction as it comes back out, with the one column the writer never sets. */
export interface StoredCorrection extends CorrectionRow {
  id: number;
  createdAt: Date;
}

/**
 * What the finish path asks the store to write, all of it or none of it.
 *
 * Three tables telling one story: which phases the candidate sat, what they
 * produced in each, and what it was worth. A `finished` sitting carrying only
 * the first two is the inconsistency this phase exists to make impossible.
 */
export interface CorrectionWrite {
  phases: PhaseRow[];
  recordings: RecordingRow[];
  correction: CorrectionRow;
}

/** What the claim writes onto the sitting itself when it wins. */
export interface SittingClaim {
  transcript: TranscriptEntry[];
  reconnectCount: number;
  finishedAt: Date;
}

/** A phase that has just finalised, reported mid-sitting rather than at the end. */
export interface FinalisedPhase {
  phase: OralSpeakingPhase;
  /** This phase's turns only. Appended to what is already stored. */
  entries: TranscriptEntry[];
  startedAt: Date;
  endedAt: Date | null;
}

// =====================================================
// THE READ MODEL
// =====================================================

/**
 * Where a sitting actually got to.
 *
 * Three values rather than a boolean, because the middle one is real and is the
 * whole reason this phase has a read model at all:
 *
 *  - `in-progress` — the finish route never claimed it. The candidate is either
 *    still sitting it or walked away, and the row honestly cannot say which; the
 *    phase column says how far they got before it stopped mattering.
 *  - `uncorrected` — claimed, but no correction is attached. Either the write
 *    that follows the claim failed, or the correction itself did. Recoverable:
 *    finishing again re-claims and re-writes.
 *  - `corrected` — the only state that may be shown as a completed exam.
 */
export type SittingOutcome = "in-progress" | "uncorrected" | "corrected";

export function sittingOutcome(sitting: {
  finishedAt: Date | null;
  correction: StoredCorrection | null;
}): SittingOutcome {
  if (sitting.correction) return "corrected";
  return sitting.finishedAt === null ? "in-progress" : "uncorrected";
}

/** A whole sitting, read back. The shape the results page renders from. */
export interface StoredSitting {
  examId: number;
  topicSlug: string;
  /** Where the state machine stopped, as far as anything told the server. */
  phase: OralPhase;
  outcome: SittingOutcome;
  transcript: TranscriptEntry[];
  reconnectCount: number;
  startedAt: Date;
  finishedAt: Date | null;
  phases: PhaseRow[];
  recordings: RecordingRow[];
  correction: StoredCorrection | null;
}

// =====================================================
// THE PORT
// =====================================================

/**
 * Everything this phase needs a database for, and nothing else.
 *
 * Four methods, each of which must be atomic **in itself** — that is the whole
 * contract, and it is what lets the orchestration below be a plain sequence of
 * awaits instead of a transaction it has no driver for.
 */
export interface SittingStore {
  /**
   * Record a phase the candidate has finished, mid-sitting, and append its turns
   * to the stored transcript.
   *
   * Returns `false` — writing nothing — unless the phase is the sitting's very
   * next step. That covers three refusals with one rule: a phase already
   * recorded (a retried request must not double the monologue), a phase that
   * would skip over one that was never reported, and any report at all once the
   * sitting has been finished.
   */
  appendFinalisedPhase(ref: SittingRef, phase: FinalisedPhase): Promise<boolean>;

  /**
   * Take exclusive ownership of the right to correct this sitting, marking it
   * finished in the same statement.
   *
   * Returns `false` when a correction already exists — see the module header for
   * why the condition is about corrections rather than about `finished_at`.
   */
  claimForCorrection(ref: SittingRef, claim: SittingClaim): Promise<boolean>;

  /** The phases, the recordings and the correction, atomically. Rejects, never partial. */
  writeCorrection(ref: SittingRef, write: CorrectionWrite): Promise<StoredCorrection>;

  /** This sitting's correction, if it has one. The cheap half of {@link readSitting}. */
  findCorrection(ref: SittingRef): Promise<StoredCorrection | null>;

  /** The whole sitting, or null when the owner has no such sitting. */
  readSitting(ref: SittingRef): Promise<StoredSitting | null>;
}

// =====================================================
// DERIVING THE ROWS
// =====================================================

/** A phase as the browser reported it: the wall clock, and nothing derived. */
export interface ReportedPhase {
  phase: OralSpeakingPhase;
  /** Epoch ms. Required — a phase is reported only because it was entered. */
  startedAt: number;
  /** Epoch ms, or null for a phase entered and never left. */
  endedAt: number | null;
}

/** One uploaded artefact, already measured out of its own bytes by the route. */
export interface MeasuredRecording {
  phase: OralSpeakingPhase;
  mimeType: string;
  byteSize: number;
  durationSeconds: number;
}

export interface CorrectionInput {
  phases: readonly ReportedPhase[];
  recordings: readonly MeasuredRecording[];
  correction: CorrectionRow;
  /** When the bytes were disposed of, which for a transient upload is now. */
  disposedAt: Date;
}

/**
 * Turn what arrived in the request into the three sets of rows to be written.
 *
 * Pure, and exported, because this is where the arithmetic that a stored row
 * either agrees or disagrees with the correction lives (#17): `spoken_seconds`
 * comes from the measured audio rather than from the clock the browser sent, and
 * the recording rows are stamped disposed because nothing durably keeps the
 * bytes.
 *
 * Rounding is `Math.round`, matching the integer columns and their `>= 0` check
 * constraints. A negative measurement cannot reach here — `measureUploadedRecording`
 * derives it from a byte count — but the floor at zero is written down anyway,
 * because the alternative failure is a rejected INSERT after a paid model call.
 */
export function deriveCorrectionWrite(input: CorrectionInput): CorrectionWrite {
  const measured = (phase: OralSpeakingPhase): number =>
    input.recordings.find((recording) => recording.phase === phase)?.durationSeconds ?? 0;

  return {
    // Only the phases the candidate actually entered get a row: a débat row
    // claiming zero seconds on a sitting abandoned during the monologue is a
    // record of a task that never happened.
    phases: input.phases.map((report) => ({
      phase: report.phase,
      spokenSeconds: Math.max(0, Math.round(measured(report.phase))),
      startedAt: new Date(report.startedAt),
      endedAt: report.endedAt === null ? null : new Date(report.endedAt),
    })),
    recordings: input.recordings.map((recording) => ({
      phase: recording.phase,
      // Null on purpose, and permanently: retention is forbidden (schema
      // header), so what survives is the honest record that a recording of this
      // length and this size existed and is gone.
      uri: null,
      mimeType: recording.mimeType,
      byteSize: recording.byteSize,
      durationSeconds: Math.max(0, Math.round(recording.durationSeconds)),
      deletedAt: input.disposedAt,
    })),
    correction: input.correction,
  };
}

// =====================================================
// THE FINISH PATH
// =====================================================

export type CorrectionOutcome =
  /** Graded and written. The ordinary path. */
  | { status: "stored"; correction: StoredCorrection }
  /**
   * This sitting already had a correction, so it was returned unchanged and
   * nothing was graded or written. What "finishing twice is a no-op" looks like.
   */
  | { status: "already-corrected"; correction: StoredCorrection }
  /**
   * Graded, but not stored: either the claim was lost and the winner's
   * correction could not be read back, or the write itself failed. The candidate
   * still gets their grade — it is in `correction` — and the sitting reads as
   * `uncorrected` until someone finishes it again.
   */
  | { status: "graded-not-stored"; correction: CorrectionRow; error: unknown };

export interface CorrectSittingInput {
  transcript: TranscriptEntry[];
  reconnectCount: number;
  phases: readonly ReportedPhase[];
  recordings: readonly MeasuredRecording[];
  /**
   * The correction itself, run lazily.
   *
   * A function rather than a value because the duplicate check is only worth
   * anything if it can happen *before* this runs: grading is a paid,
   * minutes-long model call, and a second submit of an already-corrected sitting
   * should cost nothing at all. The test for double-finish asserts exactly that
   * — not merely that one row exists afterwards, but that the corrector was
   * never asked.
   */
  evaluate: () => Promise<CorrectionRow>;
  /** Injected so a test can pin the timestamps it asserts on. */
  now: () => Date;
}

/**
 * Grade and persist one finished sitting, at most once.
 *
 * The order is the design: check, grade, claim, write. Grading before the claim
 * is what keeps a crash mid-correction from marking the sitting finished with
 * nothing to show — the claim is the last cheap thing that happens, and until it
 * commits the sitting is simply still in progress.
 */
export async function correctSitting(
  store: SittingStore,
  ref: SittingRef,
  input: CorrectSittingInput,
): Promise<CorrectionOutcome> {
  // A failure here is not an answer, so it is not treated as one. Grading
  // proceeds, and the claim below is what actually decides whether anything is
  // written — an outage must cost the candidate a stored row at worst, never
  // their grade. Same bargain the route has always made with a missing
  // `DATABASE_URL`.
  const existing = await store.findCorrection(ref).catch(() => null);
  if (existing) return { status: "already-corrected", correction: existing };

  const correction = await input.evaluate();

  const now = input.now();
  let claimed: boolean;
  try {
    claimed = await store.claimForCorrection(ref, {
      transcript: input.transcript,
      reconnectCount: input.reconnectCount,
      finishedAt: now,
    });
  } catch (error) {
    // Nothing was marked and nothing was written: the sitting is still in
    // progress, which is a truthful thing for it to be.
    return { status: "graded-not-stored", correction, error };
  }

  if (!claimed) {
    // Somebody else corrected this sitting between the check above and here.
    // Theirs is the one that exists, so theirs is the one that is returned;
    // this call's grade is discarded rather than shown beside a row it is not.
    const winner = await store.findCorrection(ref).catch(() => null);
    return winner
      ? { status: "already-corrected", correction: winner }
      : { status: "graded-not-stored", correction, error: new Error("claim lost") };
  }

  try {
    const stored = await store.writeCorrection(
      ref,
      deriveCorrectionWrite({
        phases: input.phases,
        recordings: input.recordings,
        correction,
        disposedAt: now,
      }),
    );
    return { status: "stored", correction: stored };
  } catch (error) {
    // The sitting is now marked finished with no correction attached, which is
    // `uncorrected` to every reader and repairable by finishing again. The
    // candidate has their grade in hand either way.
    return { status: "graded-not-stored", correction, error };
  }
}
