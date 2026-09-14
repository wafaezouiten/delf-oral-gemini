import "server-only";

import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

import type { DashboardSitting, SittingRecording } from "@/lib/ui/dashboard-view";
import {
  evaluations,
  getDb,
  isDatabaseConfigured,
  oralExamPhases,
  oralExams,
  oralRecordings,
  oralTopics,
} from "./index";
import { sittingFromRow } from "./history-row";

/**
 * The candidate's record — the one read the hub, the tableau de bord and the
 * historique share.
 *
 * Everything in this module is scoped by `user_id` in its own WHERE clause, not
 * by having been called from a page that checked. That is the same rule
 * `exam-guard.ts` states for the sitting routes, applied to the surfaces that
 * read *across* sittings rather than into one: there is no id to own here, so
 * the ownership has to be the query's.
 *
 * Two kinds of sitting reach the record, and the WHERE clause is where that is
 * decided:
 *
 *  - **Corrected** — an evaluation exists. Its score is the rubric's.
 *  - **Abandoned** — `abandoned_at` is stamped, meaning the candidate confirmed
 *    the exit dialog after being told it would count. Scored `0/25` in the view
 *    model, never in the database: no model read the performance, so there is no
 *    correction to write, and a zero evaluation row would claim otherwise.
 *
 * A sitting that is neither is still in progress and is deliberately absent. It
 * has no score to average and no decision to report — including one abandoned
 * by a flat battery rather than a choice, which is exactly the difference
 * `abandoned_at` exists to draw.
 *
 * The correction is therefore reached by a `leftJoin` and no longer an inner
 * one: an abandoned sitting has no correction and must still be counted. And it
 * is reached through `latestEvaluationByExam` rather than through `evaluations`
 * directly, because a sitting may carry more than one correction and this
 * function owes its callers one row per sitting — see that subquery.
 *
 * A third question sits on top of those two since #69: whether the sitting is
 * still on the **current** record, or was archived when the candidate started
 * over. That is `includeArchived`, and it defaults to off — every screen that
 * reports a standing wants the current record, and only the historique, which is
 * the one screen that must not forget, asks for the rest.
 */

/**
 * Measured speaking time per sitting, summed over the two phases.
 *
 * A subquery rather than a third join, because joining `oral_exam_phases`
 * alongside `evaluations` multiplies the evaluation row by the number of phases
 * and every average computed off it would silently double. Aggregating first is
 * the fix that does not depend on remembering the fan-out.
 *
 * `spoken_seconds` is measured from the audio, never the phase clock — so a
 * sitting whose microphone died reports the seconds that exist, which is the
 * same number the duration penalty was computed from.
 */
const spokenSecondsByExam = (userId: string) =>
  getDb()
    .select({
      examId: oralExamPhases.examId,
      spokenSeconds: sql<number>`coalesce(sum(${oralExamPhases.spokenSeconds}), 0)`.as(
        "spoken_seconds",
      ),
    })
    .from(oralExamPhases)
    .innerJoin(oralExams, eq(oralExamPhases.examId, oralExams.id))
    .where(eq(oralExams.userId, userId))
    .groupBy(oralExamPhases.examId)
    .as("phase_totals");

/**
 * The kept recordings per sitting, as one JSON array per exam (#185).
 *
 * A second aggregating subquery, for exactly the reason the one above is:
 * joining `oral_recordings` alongside `evaluations` multiplies the evaluation
 * row by however many halves were recorded, and every average computed off it
 * would double for the sittings that kept both. Aggregating first is the fix
 * that does not depend on remembering the fan-out.
 *
 * **Kept means playable**, and the filter says which: a `uri` to fetch and no
 * purge stamp. That is the same test the correction's `playable` applies, so a
 * row here offers a player exactly when the correction it links to does — the
 * alternative is a historique advertising audio the correction then refuses.
 *
 * `filter (where …)` rather than a WHERE on the subquery: a sitting whose only
 * recording was purged must still produce a row, carrying `[]`, so the left
 * join below distinguishes "no audio kept" from "no such exam". A bare WHERE
 * would drop the group and the two would be indistinguishable — which matters
 * on a landing page that must not throw.
 */
const recordingsByExam = (userId: string) =>
  getDb()
    .select({
      examId: oralRecordings.examId,
      recordings: sql<SittingRecording[] | null>`coalesce(
        json_agg(
          json_build_object(
            'phase', ${oralRecordings.phase},
            'mimeType', ${oralRecordings.mimeType},
            'durationSeconds', coalesce(${oralRecordings.durationSeconds}, 0)
          )
        ) filter (
          where ${oralRecordings.uri} is not null and ${oralRecordings.deletedAt} is null
        ),
        '[]'::json
      )`.as("recordings"),
    })
    .from(oralRecordings)
    .innerJoin(oralExams, eq(oralRecordings.examId, oralExams.id))
    .where(eq(oralExams.userId, userId))
    .groupBy(oralRecordings.examId)
    .as("recording_lists");

/**
 * The one correction that counts for each sitting: the newest.
 *
 * A third subquery, and the reason it exists is the same fan-out the two above
 * guard against — with one difference that makes it worse. `evaluations` has no
 * unique key on `exam_id`, deliberately: `schema.ts` says "one sitting must
 * carry many evaluations" so the comparison harness can grade one performance
 * several times. A plain join therefore emits **one row per correction**, and
 * this function's contract is one row per sitting. A twice-graded sitting was
 * printing twice in the historique, twice in the dashboard's list, and counting
 * twice in every average computed off it — each copy carrying a different mark,
 * while the correction it linked to showed a third answer.
 *
 * It showed a third answer because it was already right: `readSitting` and
 * `findCorrection` both take `order by created_at desc, id desc limit 1`. This
 * is that ordering, applied once per exam — so the record and the correction it
 * opens can no longer disagree about what a sitting scored.
 *
 * `distinct on` rather than a `max(created_at)` join: the tiebreak on `id`
 * matters (a re-grade written in the same millisecond as its predecessor is
 * exactly what a harness does), and reproducing "newest by two keys" as a
 * correlated subquery is how the two orderings would drift apart.
 */
const latestEvaluationByExam = (userId: string) =>
  getDb()
    .selectDistinctOn([evaluations.examId], {
      id: evaluations.id,
      examId: evaluations.examId,
      score25: evaluations.score25,
      meetsFloor: evaluations.meetsFloor,
      mode: evaluations.mode,
      realisationTache: evaluations.realisationTache,
      interaction: evaluations.interaction,
      lexique: evaluations.lexique,
      morphosyntaxe: evaluations.morphosyntaxe,
      phonologie: evaluations.phonologie,
    })
    .from(evaluations)
    // The join is the scoping, as everywhere in this file: `evaluations` has no
    // `user_id` of its own, and a subquery that graded the whole table before
    // the outer WHERE filtered it would read every candidate's corrections.
    .innerJoin(oralExams, eq(evaluations.examId, oralExams.id))
    .where(eq(oralExams.userId, userId))
    // `distinct on` demands its expressions lead the ORDER BY; the rest is
    // `findCorrection`'s ordering verbatim.
    .orderBy(evaluations.examId, desc(evaluations.createdAt), desc(evaluations.id))
    .as("latest_evaluations");

/** What a caller can ask for beyond "this candidate's sittings". */
export interface CandidateHistoryOptions {
  /**
   * Include the sittings archived by a reset (#69).
   *
   * Off by default, and the default is the safe one: a screen that reports a
   * standing — an average, a streak, a « où j'en suis ? » on a sujet card —
   * should have to *ask* for a record the candidate has explicitly put behind
   * them. The historique asks; nothing else does.
   */
  includeArchived?: boolean;
}

/**
 * Every corrected sitting this candidate has, newest first.
 *
 * **Newest first is a contract, not an incidental.** The ORDER BY below is the
 * only thing that makes `latestScoreBySujet` correct, and that reducer lives in
 * another module (`@/lib/ui/epreuve-hub`) where the ordering cannot be seen. Any
 * change to the direction here changes which score the sujet cards print.
 *
 * The ordering spans the archive too, so a historique that asks for everything
 * gets one newest-first list and decides for itself where to draw the line —
 * rather than two queries whose orderings could disagree.
 *
 * Returns `[]` — never throws — when there is no database configured. Both
 * callers are landing pages: a hub that 500s because Neon is not wired up in a
 * developer's `.env.local` is a worse failure than a hub whose sujet cards all
 * read "Commencer", which is exactly what an empty history means anyway.
 */
export async function readCandidateHistory(
  userId: string,
  { includeArchived = false }: CandidateHistoryOptions = {},
): Promise<DashboardSitting[]> {
  if (!isDatabaseConfigured()) return [];

  const totals = spokenSecondsByExam(userId);
  const recordings = recordingsByExam(userId);
  const correction = latestEvaluationByExam(userId);

  try {
    const rows = await getDb()
      .select({
        examId: oralExams.id,
        topicSlug: oralTopics.slug,
        topicTitle: oralTopics.title,
        phase: oralExams.phase,
        finishedAt: oralExams.finishedAt,
        abandonedAt: oralExams.abandonedAt,
        archivedAt: oralExams.archivedAt,
        score25: correction.score25,
        meetsFloor: correction.meetsFloor,
        mode: correction.mode,
        spokenSeconds: totals.spokenSeconds,
        recordings: recordings.recordings,
        realisationTache: correction.realisationTache,
        interaction: correction.interaction,
        lexique: correction.lexique,
        morphosyntaxe: correction.morphosyntaxe,
        phonologie: correction.phonologie,
      })
      .from(oralExams)
      // The newest correction, one row per sitting — never `evaluations`
      // itself, which fans a twice-graded sitting out into two épreuves.
      .leftJoin(correction, eq(correction.examId, oralExams.id))
      .innerJoin(oralTopics, eq(oralExams.topicId, oralTopics.id))
      .leftJoin(totals, eq(totals.examId, oralExams.id))
      .leftJoin(recordings, eq(recordings.examId, oralExams.id))
      .where(
        and(
          eq(oralExams.userId, userId),
          // Graded, or walked out of. Anything else is still running.
          or(isNotNull(correction.id), isNotNull(oralExams.abandonedAt)),
          // The current record, unless the caller wants the archive with it.
          // `undefined` is how Drizzle's `and` is told to drop a condition, and
          // it is the whole difference between the two callers.
          includeArchived ? undefined : isNull(oralExams.archivedAt),
        ),
      )
      // Coalesced, because the two kinds are stamped in different columns and a
      // record ordered by only one of them would file every walk-out at the end
      // of time (nulls) or the beginning of it, depending on the direction.
      .orderBy(desc(sql`coalesce(${oralExams.abandonedAt}, ${oralExams.finishedAt})`));

    return rows.map(sittingFromRow);
  } catch (error) {
    // A landing page is not worth a 500. The candidate loses their standing for
    // this render and keeps every way of sitting a new épreuve.
    console.error("[history] could not read the candidate's sittings", error);
    return [];
  }
}
