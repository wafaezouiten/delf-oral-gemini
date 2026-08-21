import "server-only";

import type { BatchItem } from "drizzle-orm/batch";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { getDb } from "./index";
import {
  evaluations,
  oralExamPhases,
  oralExams,
  oralPhase,
  oralRecordings,
  oralTopics,
} from "./schema";
import { ORAL_CRITERIA } from "@/lib/delf/criteria";
import { ORAL_PHASES, nextPhase } from "@/lib/delf/phases";
import type {
  CorrectionWrite,
  FinalisedPhase,
  SittingClaim,
  SittingRef,
  SittingStore,
  StoredCorrection,
  StoredSitting,
} from "@/lib/exams/sitting-persistence";
import { sittingOutcome } from "@/lib/exams/sitting-persistence";

/**
 * The SQL half of Phase 8 — the only module that knows how a sitting is stored.
 *
 * The policy it serves is in `lib/exams/sitting-persistence.ts`: what may be
 * written when, and what a second finish does. Nothing here decides any of that.
 * What this file owes that module is a short list of promises, and every one of
 * them is a statement-level guarantee rather than something the caller arranges:
 *
 *  - **Each method is atomic in itself.** Where a method needs more than one
 *    statement it uses `db.batch()`, which `neon-http` implements as a real
 *    transaction (`session.js`: `client.transaction(builtQueries)`).
 *    `db.transaction()` is NOT available on this driver — it throws — which is
 *    why the writes are shaped as batches rather than as a transaction block
 *    (#16).
 *  - **Every statement carries the owner.** Not because the caller has not
 *    already checked — `authorizeExam` refuses first — but because a statement
 *    that is safe only in the company of an earlier one is a statement that
 *    stops being safe when someone reorders the file. The one exception is
 *    called out where it appears.
 *  - **Idempotence is in the WHERE clause**, never in a read-then-write. Two
 *    identical requests are two statements racing, and only the database can
 *    settle which of them did anything.
 */

/**
 * `findSittingTopicSlug` used to live here — the authoritative answer to "which
 * subject is this exam?", which is why the exam page and the token route stopped
 * taking the browser's word for it in Phase 4. It is gone rather than moved: it
 * was only ever called right after the ownership lookup had read the same row,
 * so it is now a `leftJoin` inside that one query and the answer arrives on
 * `ExamAccess` (#22). Both promises it made are kept there — a database that
 * cannot answer degrades rather than ending a débat, and a sitting with no
 * readable subject is still owned.
 */

/**
 * The sitting is this caller's, and it has not been finished.
 *
 * Repeated into every mid-sitting write rather than factored into a prior
 * lookup, which would be a check the statement itself does not make.
 */
function liveSittingOwnedBy({ examId, userId }: SittingRef) {
  return and(eq(oralExams.id, examId), eq(oralExams.userId, userId), isNull(oralExams.finishedAt));
}

/**
 * The phase being reported is the sitting's very next step — not merely one it
 * has not already passed.
 *
 * The enum is declared in exam order (`preparation`, `monologue`, `debate`,
 * `finished`) and Postgres orders enum values by declaration, so the whole
 * invariant is one `between` against two constants derived from the report:
 *
 *   phase_before(reported) ≤ oral_exams.phase ≤ reported
 *
 * Both bounds earn their place. The **upper** one is what makes a replay a
 * no-op: a second report for a phase already recorded finds the sitting past it
 * and matches nothing, which is what stops the monologue being appended twice.
 * The **lower** one is what stops a report skipping a phase — without it a
 * hand-crafted request could report the débat of a sitting still in
 * `preparation`, and the column documented as the record of how far a candidate
 * got would be recording somewhere they had never been. Nothing that grades or
 * authorises reads `phase`, so that was a lie the sitting told only about
 * itself; it is still a lie, and one constant removes it.
 *
 * The cost is deliberate and small: if a phase's report is lost in flight, the
 * next one is refused too, and the sitting keeps only what it had. The finish
 * request re-sends the complete transcript regardless, so what is given up is
 * the insurance on a sitting that also never finishes — and recording a
 * débat-only transcript under a sitting that claims to have reached the end
 * would be worse evidence than recording none.
 *
 * The type name comes off the enum object rather than being spelled out, so
 * renaming it in `schema.ts` cannot leave a stale cast here.
 */
function phaseIsTheNextStep(phase: FinalisedPhase["phase"]) {
  // Derived from the one ordered list rather than a second hand-written map:
  // both speaking phases have a predecessor by construction.
  const previous = ORAL_PHASES[ORAL_PHASES.indexOf(phase) - 1];
  const type = sql.identifier(oralPhase.enumName);
  return sql`${oralExams.phase} between ${previous}::${type} and ${phase}::${type}`;
}

/** The five band columns, read back into the shape the rubric uses. */
function criteriaOf(row: Record<string, unknown>) {
  return Object.fromEntries(
    ORAL_CRITERIA.map((criterion) => [criterion, row[criterion]]),
  ) as StoredCorrection["criteria"];
}

type EvaluationRow = typeof evaluations.$inferSelect;

function toStoredCorrection(row: EvaluationRow): StoredCorrection {
  return {
    id: row.id,
    createdAt: row.createdAt,
    mode: row.mode,
    criteria: criteriaOf(row),
    rawScore25: row.rawScore25,
    absencePenalty: row.absencePenalty,
    durationPenalty: row.durationPenalty,
    score25: row.score25,
    meetsFloor: row.meetsFloor,
    feedback: row.feedback,
    model: row.model,
    promptVersion: row.promptVersion,
    latencySeconds: row.latencySeconds,
  };
}

/** `db.batch` wants a non-empty tuple; the callers below build arrays. */
type Writes = [BatchItem<"pg">, ...BatchItem<"pg">[]];

/**
 * Record which Live model will play this sitting's examiner (#99).
 *
 * A standalone export rather than a `SittingStore` method: that interface is
 * the finish path's seam — claim, correct, write — and this is a préparation
 * write with none of that policy behind it.
 *
 * One statement, idempotence in the WHERE as everywhere in this file, and the
 * `phase = 'preparation'` clause is the one that carries meaning: the choice
 * exists so a sitting can answer "which examiner spoke?", so it must become
 * immutable the moment anyone has spoken. Once the monologue starts — or the
 * sitting is finished, which the phase also implies — a write matches nothing,
 * and a stale tab cannot rename the examiner out from under a débat that
 * reconnects through the token route.
 *
 * `false` means "written nothing", which the route reports without alarm: the
 * ordinary causes are a replayed request after the passation started, and a
 * sitting that was never persisted.
 */
export async function chooseExaminerModel(ref: SittingRef, model: string): Promise<boolean> {
  const chosen = await getDb()
    .update(oralExams)
    .set({ examinerModel: model })
    .where(
      and(
        eq(oralExams.id, ref.examId),
        eq(oralExams.userId, ref.userId),
        eq(oralExams.phase, "preparation"),
      ),
    )
    .returning({ id: oralExams.id });

  return chosen.length > 0;
}

/**
 * The candidate left during the préparation (#113) — the sitting is archived,
 * never abandoned.
 *
 * A standalone export for `chooseExaminerModel`'s reason: the `SittingStore`
 * interface is the finish path's seam — claim, correct, write — and this is a
 * préparation write with none of that policy behind it.
 *
 * `archived_at` is the reset's stamp (#69), reused deliberately: both mean "off
 * the record by the candidate's own decision", and a sitting nobody has spoken
 * in has no other record to be off. The row stays exactly as unfinished as a
 * closed tab would leave it — no terminal stamp, no zero — but the stamp tells
 * a deliberate exit apart from a crashed one, which is the distinction
 * `abandoned_at` exists to draw for the phases where leaving costs something.
 *
 * One statement, idempotence in the WHERE as everywhere in this file:
 *
 *  - the owner, because exam ids are sequential serials;
 *  - `phase = 'preparation'`, the boundary. Note what the column can and cannot
 *    say: `phase` advances when a speaking phase *finalises* (see
 *    `appendFinalisedPhase`), so `'preparation'` strictly means "no speaking
 *    phase has been reported", which spans the live monologue. For the honest
 *    client — the only one that renders the préparation's exit — the two are
 *    the same thing; a forged request sent mid-monologue archives a sitting
 *    whose épreuve is in flight, which strands only the sender's own sitting.
 *    The clause also subsumes the `not exists (…evaluations…)` guard the
 *    terminal writes carry: a correction requires a claim, and the claim sets
 *    `phase = 'finished'` in the same statement;
 *  - `archived_at is null`, so a double-clicked « Quitter » keeps the moment
 *    the candidate first left;
 *  - `abandoned_at is null`, because a walk-out is ON the record and files
 *    under whichever archive a reset later draws — rows stamped from the
 *    préparation before #113 drew this boundary keep that filing.
 */
export async function archivePreparationExit(ref: SittingRef, leftAt: Date): Promise<boolean> {
  const archived = await getDb()
    .update(oralExams)
    .set({ archivedAt: leftAt })
    .where(
      and(
        eq(oralExams.id, ref.examId),
        eq(oralExams.userId, ref.userId),
        eq(oralExams.phase, "preparation"),
        isNull(oralExams.archivedAt),
        isNull(oralExams.abandonedAt),
      ),
    )
    .returning({ id: oralExams.id });

  return archived.length > 0;
}

/**
 * One phase's recording row, read for playback (#98).
 *
 * A standalone export for `chooseExaminerModel`'s reason: the `SittingStore`
 * interface is the finish path's seam — claim, correct, write — and this is a
 * read the playback route makes with none of that policy behind it.
 * `readSitting` already returns these columns, but it hauls the whole
 * transcript along, and a request whose response is megabytes of audio should
 * not start by reading two hundred thousand characters of text it will not
 * use.
 *
 * The join is the scoping, as everywhere in this file: `oral_recordings` rows
 * are addressed through the sitting and its owner, never by the recording id a
 * request could have supplied.
 */
export async function findRecording(
  ref: SittingRef,
  phase: "monologue" | "debate",
): Promise<{
  uri: string | null;
  mimeType: string;
  byteSize: number | null;
  deletedAt: Date | null;
} | null> {
  const [row] = await getDb()
    .select({
      uri: oralRecordings.uri,
      mimeType: oralRecordings.mimeType,
      byteSize: oralRecordings.byteSize,
      deletedAt: oralRecordings.deletedAt,
    })
    .from(oralRecordings)
    .innerJoin(oralExams, eq(oralRecordings.examId, oralExams.id))
    .where(
      and(
        eq(oralExams.id, ref.examId),
        eq(oralExams.userId, ref.userId),
        eq(oralRecordings.phase, phase),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * The candidate deletes one of their own recordings (#98) — the row is
 * stamped, and the caller is handed the uri so it can clear the store.
 *
 * The stamp comes FIRST, in this statement, and the store second, in the
 * route: `decidePlayback` trusts `deleted_at` over a uri precisely because a
 * purge is allowed to crash between the two, and the failure that leaves an
 * unreachable orphan is strictly better than the one that leaves a playable
 * row pointing at bytes the candidate was told were gone.
 *
 * One statement, idempotence in the WHERE as everywhere in this file: only a
 * row that still has kept bytes matches, so a double-clicked « Supprimer »
 * stamps once and the second press deletes nothing. The uri is deliberately
 * NOT nulled — the row keeps saying where the bytes were, `deleted_at` says
 * they are not there any more, and `returning` can only hand back the new
 * row, which would be a null uri and nothing for the caller to clear.
 *
 * The owner is in the WHERE via the sitting, as everywhere: a recording is
 * addressed through the exam and its owner, never by an id a request chose.
 */
export async function disposeRecording(
  ref: SittingRef,
  phase: "monologue" | "debate",
  disposedAt: Date,
): Promise<{ uri: string } | null> {
  const db = getDb();
  const [row] = await db
    .update(oralRecordings)
    .set({ deletedAt: disposedAt })
    .where(
      and(
        eq(oralRecordings.phase, phase),
        isNotNull(oralRecordings.uri),
        isNull(oralRecordings.deletedAt),
        sql`${oralRecordings.examId} in (
          select ${oralExams.id} from ${oralExams}
          where ${oralExams.id} = ${ref.examId} and ${oralExams.userId} = ${ref.userId}
        )`,
      ),
    )
    .returning({ uri: oralRecordings.uri });

  // `returning` reads the updated row, whose uri survived on purpose (see
  // above) — non-null by the WHERE clause, narrowed for the caller.
  return row?.uri ? { uri: row.uri } : null;
}

export function neonSittingStore(): SittingStore {
  const db = getDb();

  return {
    async appendFinalisedPhase(ref, phase) {
      /**
       * The append is one statement, and that is the whole design.
       *
       * `transcript = coalesce(transcript, '[]') || $entries` happens inside the
       * database, so nothing reads the column in order to write it — a
       * read-modify-write here would lose a phase whenever two requests
       * overlapped, and overlapping is exactly what a retry is. The guard on
       * `phase` (see {@link phaseIsTheNextStep}) is what makes a replayed
       * request append nothing rather than the monologue twice.
       *
       * `nextPhase` can therefore write `finished` here, on a report of the
       * débat — and that is the intended reading of the column rather than a
       * leak of the finish route's word. `phase` says where the state machine
       * stopped; whether anything was graded is `finished_at`'s and the
       * correction's to say, and `sittingOutcome` asks only those two. A sitting
       * whose machine ran to the end and was never submitted is exactly a
       * `finished` phase with a null stamp.
       */
      const advanced = await db
        .update(oralExams)
        .set({
          phase: nextPhase(phase.phase),
          transcript: sql`coalesce(${oralExams.transcript}, '[]'::jsonb) || ${JSON.stringify(phase.entries)}::jsonb`,
        })
        .where(and(liveSittingOwnedBy(ref), phaseIsTheNextStep(phase.phase)))
        .returning({ id: oralExams.id });

      if (advanced.length === 0) return false;

      /**
       * The audit stamps for the phase that just ended.
       *
       * This is the one statement in the file without the owner in its own
       * WHERE clause, because an INSERT ... VALUES has nowhere to put it. It is
       * gated instead: it runs only when the UPDATE above matched, and that
       * UPDATE matches only for the owner. Deliberately outside the batch that
       * would make the two atomic — the transcript is the thing worth
       * protecting, and losing these two timestamps to a failure here costs an
       * audit trail rather than the candidate's words. `spoken_seconds` is left
       * at its default: it is measured from the audio, and the audio does not
       * exist until the sitting is submitted.
       */
      await db
        .insert(oralExamPhases)
        .values({
          examId: ref.examId,
          phase: phase.phase,
          startedAt: phase.startedAt,
          endedAt: phase.endedAt,
        })
        .onConflictDoNothing();

      return true;
    },

    async claimForCorrection(ref: SittingRef, claim: SittingClaim) {
      const claimed = await db
        .update(oralExams)
        .set({
          phase: "finished",
          // Replaces whatever the progress route appended, with the same turns:
          // the browser's copy is the complete one, coalesced across reconnects,
          // and it is the copy the correction was actually computed from.
          transcript: claim.transcript,
          reconnectCount: claim.reconnectCount,
          earlyClosingCount: claim.earlyClosingCount,
          finishedAt: claim.finishedAt,
        })
        .where(
          and(
            eq(oralExams.id, ref.examId),
            eq(oralExams.userId, ref.userId),
            // Not `finished_at is null`. See the header of
            // `sitting-persistence.ts`: keying on the correction is what lets a
            // sitting whose write failed be finished again instead of being
            // stranded marked-done and ungradeable.
            sql`not exists (select 1 from ${evaluations} where ${evaluations.examId} = ${oralExams.id})`,
          ),
        )
        .returning({ id: oralExams.id });

      return claimed.length > 0;
    },

    async writeCorrection(ref: SittingRef, write: CorrectionWrite) {
      const writes: BatchItem<"pg">[] = [];

      // Only the phases the candidate actually entered. `doNothing` because the
      // progress route may already have stamped this phase's clock, and those
      // are the timestamps of the transition as it happened rather than as it
      // was reported afterwards — but `spoken_seconds` is this statement's to
      // give, so it is set on conflict. There is no repeated-finish hazard in
      // that: a second finish never reaches here, the claim refuses it first.
      if (write.phases.length > 0) {
        writes.push(
          db
            .insert(oralExamPhases)
            .values(write.phases.map((row) => ({ ...row, examId: ref.examId })))
            .onConflictDoUpdate({
              target: [oralExamPhases.examId, oralExamPhases.phase],
              set: {
                spokenSeconds: sql`excluded.spoken_seconds`,
                // Keep a real timestamp over a missing one: a phase entered and
                // never left reports `null` here, and overwriting the moment the
                // progress route watched it end with that would be a downgrade.
                endedAt: sql`coalesce(excluded.ended_at, ${oralExamPhases.endedAt})`,
              },
            }),
        );
      }

      if (write.recordings.length > 0) {
        writes.push(
          db
            .insert(oralRecordings)
            .values(write.recordings.map((row) => ({ ...row, examId: ref.examId })))
            .onConflictDoNothing(),
        );
      }

      writes.push(
        db
          .insert(evaluations)
          .values({
            examId: ref.examId,
            // Deliberately no `recordingId`. The correction listened to BOTH
            // artefacts, and a single FK can name only one of them; naming
            // either would be a smaller lie than null but still a lie. The
            // recordings are attributable through `exam_id`.
            recordingId: null,
            mode: write.correction.mode,
            // The five bands are columns; `criteria` is keyed by the same five
            // criterion names, so it spreads straight in.
            ...write.correction.criteria,
            rawScore25: write.correction.rawScore25,
            absencePenalty: write.correction.absencePenalty,
            durationPenalty: write.correction.durationPenalty,
            score25: write.correction.score25,
            meetsFloor: write.correction.meetsFloor,
            feedback: write.correction.feedback,
            model: write.correction.model,
            promptVersion: write.correction.promptVersion,
            latencySeconds: write.correction.latencySeconds,
          })
          .returning(),
      );

      const results = await db.batch(writes as Writes);
      // The correction is always the last statement, so its row is the last
      // result. Positional, because that is the only thing `batch` returns.
      const [inserted] = results[results.length - 1] as EvaluationRow[];
      return toStoredCorrection(inserted);
    },

    async abandonSitting(ref: SittingRef, abandonedAt: Date) {
      /**
       * One statement, and every clause in the WHERE is load-bearing:
       *
       *  - the owner, because this writes a zero onto somebody's record and an
       *    exam id is a sequential serial;
       *  - `abandoned_at is null`, so a double-clicked exit button stamps the
       *    moment the candidate first left rather than the moment they clicked
       *    again;
       *  - `not exists (…evaluations…)`, the same guard `claimForCorrection`
       *    uses, so a correction that landed while the dialog was open outranks
       *    the walk-out. A sitting is graded or abandoned, never both;
       *  - `archived_at is null`, the mirror of the guard `archivePreparationExit`
       *    carries against this column. Redundant for a reset's archive — those
       *    rows were graded or abandoned first, and the clauses above already
       *    refuse them — but a préparation exit (#113) is the first archive to
       *    land on a live row, and a walk-out racing it would otherwise stamp a
       *    zero onto a sitting the candidate was just told would never appear.
       *    Left alone, that row surfaces in the historique's archive as an
       *    abandoned 0/25 — the exact record both dialogs promised against.
       *
       * `phase` is deliberately NOT advanced to `finished`, and `finished_at`
       * is deliberately NOT stamped. Both mean "this épreuve ran its course",
       * and the entire point of this row is that it did not — `phase` keeps
       * saying where the candidate stopped, which is the only honest record of
       * an abandonment and the thing the history page prints.
       *
       * There is also deliberately NO phase clause, although #113 draws a
       * boundary in phase terms: quitting before the exposé must not record a
       * walk-out. The column cannot enforce that boundary, because it advances
       * when a speaking phase *finalises* — the row reads `'preparation'`
       * through the whole live monologue, and a `phase != 'preparation'` guard
       * here would refuse the most ordinary walk-out there is, a candidate
       * abandoning mid-exposé. So the before-exposé rule is the client's: the
       * préparation screen never offers this write (it archives instead — see
       * `archivePreparationExit`), and a hand-crafted abandon sent during the
       * préparation writes a zero only onto its sender's own record.
       */
      const abandoned = await db
        .update(oralExams)
        .set({ abandonedAt })
        .where(
          and(
            eq(oralExams.id, ref.examId),
            eq(oralExams.userId, ref.userId),
            isNull(oralExams.abandonedAt),
            isNull(oralExams.archivedAt),
            sql`not exists (select 1 from ${evaluations} where ${evaluations.examId} = ${oralExams.id})`,
          ),
        )
        .returning({ id: oralExams.id });

      return abandoned.length > 0;
    },

    async findCorrection(ref: SittingRef) {
      const [row] = await db
        .select({ evaluation: evaluations })
        .from(evaluations)
        // The join is the scoping. `evaluations.exam_id` alone is an id the
        // caller supplied, and a correction is the one thing on a sitting worth
        // reading without owning it.
        .innerJoin(oralExams, eq(evaluations.examId, oralExams.id))
        .where(and(eq(oralExams.id, ref.examId), eq(oralExams.userId, ref.userId)))
        // Newest first: nothing on this path writes a second correction, but
        // the experiment harness is allowed to, and "the latest" is the only
        // answer that stays right if it ever does.
        .orderBy(desc(evaluations.createdAt), desc(evaluations.id))
        .limit(1);

      return row ? toStoredCorrection(row.evaluation) : null;
    },

    async readSitting(ref: SittingRef): Promise<StoredSitting | null> {
      const owned = and(eq(oralExams.id, ref.examId), eq(oralExams.userId, ref.userId));

      // One round trip, and every one of the four carries the owner rather than
      // inheriting it from the first.
      const [sittings, phases, recordings, corrections] = await db.batch([
        db
          .select({
            id: oralExams.id,
            slug: oralTopics.slug,
            phase: oralExams.phase,
            transcript: oralExams.transcript,
            reconnectCount: oralExams.reconnectCount,
            earlyClosingCount: oralExams.earlyClosingCount,
            examinerModel: oralExams.examinerModel,
            startedAt: oralExams.startedAt,
            finishedAt: oralExams.finishedAt,
          })
          .from(oralExams)
          // Inner, where the ownership lookup's is left, and the difference is
          // what each one costs when the join finds nothing. Ownership was
          // settled before this ran, so an empty result here means the results
          // page renders from the browser's copy; there it would mean a 404 on
          // a sitting somebody owns. See `findExamOwner` in `exam-guard.ts`.
          .innerJoin(oralTopics, eq(oralExams.topicId, oralTopics.id))
          .where(owned)
          .limit(1),
        db
          .select({
            phase: oralExamPhases.phase,
            spokenSeconds: oralExamPhases.spokenSeconds,
            startedAt: oralExamPhases.startedAt,
            endedAt: oralExamPhases.endedAt,
          })
          .from(oralExamPhases)
          .innerJoin(oralExams, eq(oralExamPhases.examId, oralExams.id))
          .where(owned)
          .orderBy(oralExamPhases.phase),
        db
          .select({
            phase: oralRecordings.phase,
            uri: oralRecordings.uri,
            mimeType: oralRecordings.mimeType,
            byteSize: oralRecordings.byteSize,
            durationSeconds: oralRecordings.durationSeconds,
            deletedAt: oralRecordings.deletedAt,
          })
          .from(oralRecordings)
          .innerJoin(oralExams, eq(oralRecordings.examId, oralExams.id))
          .where(owned)
          .orderBy(oralRecordings.phase),
        db
          .select({ evaluation: evaluations })
          .from(evaluations)
          .innerJoin(oralExams, eq(evaluations.examId, oralExams.id))
          .where(owned)
          .orderBy(desc(evaluations.createdAt), desc(evaluations.id))
          .limit(1),
      ]);

      const sitting = sittings[0];
      if (!sitting) return null;

      const correction = corrections[0] ? toStoredCorrection(corrections[0].evaluation) : null;

      return {
        examId: sitting.id,
        topicSlug: sitting.slug,
        phase: sitting.phase,
        outcome: sittingOutcome({ finishedAt: sitting.finishedAt, correction }),
        transcript: sitting.transcript ?? [],
        reconnectCount: sitting.reconnectCount,
        earlyClosingCount: sitting.earlyClosingCount,
        examinerModel: sitting.examinerModel,
        startedAt: sitting.startedAt,
        finishedAt: sitting.finishedAt,
        phases: phases.map((row) => ({
          phase: row.phase,
          spokenSeconds: row.spokenSeconds,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
        })),
        // The byte columns are nullable in the schema — a row may outlive
        // everything but the fact that it existed — and the read model is not,
        // because a missing size reads the same as an unknown one everywhere it
        // is shown.
        recordings: recordings.map((row) => ({
          phase: row.phase,
          uri: row.uri,
          mimeType: row.mimeType,
          byteSize: row.byteSize ?? 0,
          durationSeconds: row.durationSeconds ?? 0,
          deletedAt: row.deletedAt,
        })),
        correction,
      };
    },
  };
}
