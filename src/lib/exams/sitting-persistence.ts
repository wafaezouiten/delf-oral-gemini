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

/** One recording's row: where the bytes are kept, or the record that they were. */
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
  absencePenalty: number;
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

/** The artefact half of a sitting's rows: what it produced, without the grade. */
export interface ArtefactRows {
  phases: PhaseRow[];
  recordings: RecordingRow[];
}

/**
 * What the finish path asks the store to write, all of it or none of it.
 *
 * Three tables telling one story: which phases the candidate sat, what they
 * produced in each, and what it was worth. Since #86 the first two are written
 * at the accept, before the grading, so a `finished` sitting carrying only
 * phases and recordings is no longer an inconsistency — it is the honest state
 * of a correction still under way (or one that failed), and it reads as
 * `uncorrected` until the attach lands.
 */
export interface CorrectionWrite extends ArtefactRows {
  correction: CorrectionRow;
}

/** What the claim writes onto the sitting itself when it wins. */
export interface SittingClaim {
  transcript: TranscriptEntry[];
  reconnectCount: number;
  /** How many times the examiner tried to close the épreuve early (#92). */
  earlyClosingCount: number;
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
  /** How many times the examiner tried to close the épreuve early (#92). Zero
   *  on rows that predate the column, which is also what it means: their
   *  corrections were graded with no such fact on record. */
  earlyClosingCount: number;
  /** Which Live model played the examiner (#99). Null on rows that predate the
   *  column — genuinely unrecorded, not defaulted after the fact. */
  examinerModel: string | null;
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

  /**
   * The phases and the recordings, atomically, with no correction beside them
   * (#86). What the accept half writes so the sitting is complete — everything
   * except the grade — before the response goes out and the grading starts.
   * Upsert semantics, because the attach half's `writeCorrection` will touch
   * the same rows again and the two must agree rather than duplicate.
   */
  writeArtefacts(ref: SittingRef, artefacts: ArtefactRows): Promise<void>;

  /** The phases, the recordings and the correction, atomically. Rejects, never partial. */
  writeCorrection(ref: SittingRef, write: CorrectionWrite): Promise<StoredCorrection>;

  /**
   * Record that the candidate walked out, having been warned it would count.
   *
   * Returns `false` — writing nothing — when the sitting already carries a
   * correction, which is the same shape of guard `claimForCorrection` uses and
   * for the same reason: a sitting is graded or abandoned, never both. The race
   * it closes is real rather than theoretical — the finish request is in flight
   * while the candidate is looking at the exit dialog, so "I gave up on the
   * upload" and "the upload succeeded" can arrive in either order, and a
   * correction that exists must outrank a walk-out.
   */
  abandonSitting(ref: SittingRef, abandonedAt: Date): Promise<boolean>;

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
  /**
   * Which recordings were durably kept, by the uri they were kept at (#98).
   * Absent or missing a phase means that artefact was transient — no vault
   * configured, or an upload that failed — and its row is stamped disposed.
   */
  kept?: ReadonlyMap<OralSpeakingPhase, string>;
  /** When any transient bytes were disposed of, which is now. */
  disposedAt: Date;
}

/**
 * Turn what arrived in the request into the three sets of rows to be written.
 *
 * Pure, and exported, because this is where the arithmetic that a stored row
 * either agrees or disagrees with the correction lives (#17): `spoken_seconds`
 * comes from the measured audio rather than from the clock the browser sent, and
 * each recording row either points at the copy the vault kept or is stamped
 * disposed — never both, and never neither.
 *
 * Rounding is `Math.round`, matching the integer columns and their `>= 0` check
 * constraints. A negative measurement cannot reach here — `measureUploadedRecording`
 * derives it from a byte count — but the floor at zero is written down anyway,
 * because the alternative failure is a rejected INSERT after a paid model call.
 */
export function deriveCorrectionWrite(input: CorrectionInput): CorrectionWrite {
  return {
    ...deriveArtefactRows(input),
    correction: input.correction,
  };
}

/**
 * The artefact half of the derivation on its own (#86): what the accept writes
 * before any grading has run. Split out rather than duplicated so the attach's
 * re-upsert of the same rows cannot drift from the rows the accept wrote.
 */
export function deriveArtefactRows(input: Omit<CorrectionInput, "correction">): ArtefactRows {
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
    recordings: input.recordings.map((recording) => {
      // Where the bytes ended up. Kept, `deleted_at` stays null and the row is
      // something the playback route can serve (#98); transient, what survives
      // is the honest record that a recording of this length and this size
      // existed and is gone — which is every row this function wrote before
      // the vault existed, and still every row on a deployment without one.
      const uri = input.kept?.get(recording.phase) ?? null;
      return {
        phase: recording.phase,
        uri,
        mimeType: recording.mimeType,
        byteSize: recording.byteSize,
        durationSeconds: Math.max(0, Math.round(recording.durationSeconds)),
        deletedAt: uri === null ? input.disposedAt : null,
      };
    }),
  };
}

// =====================================================
// THE FINISH PATH
// =====================================================

/**
 * What accepting a sitting — everything except the grade — came to (#86).
 */
export type AcceptOutcome =
  /**
   * Claimed, artefacts written, bytes kept: the sitting is safe, and the only
   * thing it lacks is a correction. The caller may answer the candidate and
   * grade behind the response.
   */
  | { status: "accepted" }
  /**
   * This sitting already has a correction, so nothing was claimed or written
   * and nothing needs grading. What "finishing twice is a no-op" looks like —
   * and, since the check comes first, a retry of a finish whose correction
   * landed late costs nothing at all.
   */
  | { status: "already-corrected"; correction: StoredCorrection }
  /**
   * The claim or the artefact write failed. Nothing about the sitting can be
   * called safe, so the caller must refuse the finish and let the candidate
   * retry from the tab — which still holds the only other copy.
   */
  | { status: "not-stored"; error: unknown };

export interface AcceptSittingInput {
  transcript: TranscriptEntry[];
  reconnectCount: number;
  /** How many times the examiner tried to close the épreuve early (#92). */
  earlyClosingCount: number;
  phases: readonly ReportedPhase[];
  recordings: readonly MeasuredRecording[];
  /**
   * Keep the recordings' bytes durably, returning each kept phase's uri (#98).
   *
   * Run lazily, and only by the caller that wins the claim — a duplicate
   * finish must not file a second copy of somebody's voice next to rows it
   * will never write. The contract is best-effort: a phase the store could not
   * keep is simply absent from the map, and its row goes down transient,
   * exactly as every row did before the vault existed. The implementation
   * should not throw; if it does anyway, the artefact rows are still written
   * and every recording reads as disposed — losing the copy must never cost
   * the candidate their correction.
   *
   * Optional because a deployment without a vault has nothing to keep.
   */
  preserve?: () => Promise<ReadonlyMap<OralSpeakingPhase, string>>;
  /** Injected so a test can pin the timestamps it asserts on. */
  now: () => Date;
}

/**
 * Accept one finished sitting: check, claim, keep, write the artefacts (#86).
 *
 * The order used to be check, GRADE, claim, keep, write — grading before the
 * claim, so a crash mid-correction could not mark the sitting finished with
 * nothing to show. That ordering is deliberately reversed, because it is also
 * what held the candidate at « Épreuve terminée » for the whole of a
 * thirty-to-sixty-second model call: the claim now comes first, the response
 * goes out the moment the artefacts are safe, and the grading runs behind it
 * ({@link attachCorrection}).
 *
 * What the reversal costs, precisely: a crash between the claim and the attach
 * leaves a sitting marked finished with no correction — the state the old
 * ordering existed to prevent. It is accepted because it is no longer a
 * stranding: `uncorrected` is a first-class outcome every reader understands,
 * the claim keys on corrections rather than `finished_at` so finishing again
 * repairs it, and the finished screen keeps the artefacts in the tab precisely
 * so its retry can do that.
 */
export async function acceptSitting(
  store: SittingStore,
  ref: SittingRef,
  input: AcceptSittingInput,
): Promise<AcceptOutcome> {
  // A failure here is not an answer, so it is not treated as one: the claim
  // below is what actually decides, and an outage on the cheap read must not
  // refuse a finish the claim would have accepted.
  const existing = await store.findCorrection(ref).catch(() => null);
  if (existing) return { status: "already-corrected", correction: existing };

  const now = input.now();
  let claimed: boolean;
  try {
    claimed = await store.claimForCorrection(ref, {
      transcript: input.transcript,
      reconnectCount: input.reconnectCount,
      earlyClosingCount: input.earlyClosingCount,
      finishedAt: now,
    });
  } catch (error) {
    // Nothing was marked and nothing was written: the sitting is still in
    // progress, which is a truthful thing for it to be.
    return { status: "not-stored", error };
  }

  if (!claimed) {
    // Somebody corrected this sitting between the check above and here. Theirs
    // is the one that exists, so theirs is the one that is returned.
    const winner = await store.findCorrection(ref).catch(() => null);
    return winner
      ? { status: "already-corrected", correction: winner }
      : { status: "not-stored", error: new Error("claim lost") };
  }

  // The claim is won, so this call is the one that writes the rows — and
  // therefore the one allowed to store the bytes they will point at. The
  // second net around a `preserve` that breaks its own no-throw contract is
  // deliberate: an upload failure must cost the candidate a replay button,
  // never their finish.
  let kept: ReadonlyMap<OralSpeakingPhase, string> | undefined;
  if (input.preserve) {
    kept = await input.preserve().catch(() => undefined);
  }

  try {
    await store.writeArtefacts(
      ref,
      deriveArtefactRows({
        phases: input.phases,
        recordings: input.recordings,
        kept,
        disposedAt: now,
      }),
    );
  } catch (error) {
    // Claimed, but the rows did not land. The sitting reads `uncorrected` and
    // the retry re-claims — the claim keys on corrections, not `finished_at` —
    // so refusing the finish here strands nothing.
    return { status: "not-stored", error };
  }

  return { status: "accepted" };
}

export type CorrectionOutcome =
  /** Graded and written. The ordinary path. */
  | { status: "stored"; correction: StoredCorrection }
  /**
   * A correction already existed — a concurrent finish won, or this is a retry
   * whose first grading landed. Nothing was graded or written.
   */
  | { status: "already-corrected"; correction: StoredCorrection }
  /**
   * Graded, but not stored: the write itself failed. The sitting reads as
   * `uncorrected` until someone finishes it again; the grade is in
   * `correction` for whoever can still show it — which, behind an
   * already-answered response, is only the log.
   */
  | { status: "graded-not-stored"; correction: CorrectionRow; error: unknown };

export interface AttachCorrectionInput {
  phases: readonly ReportedPhase[];
  recordings: readonly MeasuredRecording[];
  /**
   * The correction itself, run lazily.
   *
   * A function rather than a value because the duplicate check is only worth
   * anything if it can happen *before* this runs: grading is a paid,
   * minutes-long model call, and a second submit of an already-corrected
   * sitting should cost nothing at all. The test for double-finish asserts
   * exactly that — not merely that one row exists afterwards, but that the
   * corrector was never asked. A throw from here propagates to the caller,
   * which owns saying why (#73).
   */
  evaluate: () => Promise<CorrectionRow>;
  /** Injected so a test can pin the timestamps it asserts on. */
  now: () => Date;
}

/**
 * Grade an accepted sitting and attach the correction (#86).
 *
 * Runs behind the response on the ordinary path, which is the entire point:
 * the candidate stopped waiting when {@link acceptSitting} answered. The
 * artefact rows travel again because `writeCorrection` writes all three tables
 * — its phase and recording statements are upserts, so the rows the accept
 * already wrote win and these are no-ops beside the one INSERT that matters.
 * One write path for both halves is what keeps them from drifting; the kept
 * uris are absent here on purpose, because `on conflict` preserves the
 * accept's rows, which are the ones that carry them.
 */
export async function attachCorrection(
  store: SittingStore,
  ref: SittingRef,
  input: AttachCorrectionInput,
): Promise<CorrectionOutcome> {
  const existing = await store.findCorrection(ref).catch(() => null);
  if (existing) return { status: "already-corrected", correction: existing };

  const correction = await input.evaluate();

  try {
    const stored = await store.writeCorrection(
      ref,
      deriveCorrectionWrite({
        phases: input.phases,
        recordings: input.recordings,
        correction,
        disposedAt: input.now(),
      }),
    );
    return { status: "stored", correction: stored };
  } catch (error) {
    // The sitting stays `uncorrected`, which is repairable by finishing again.
    return { status: "graded-not-stored", correction, error };
  }
}
