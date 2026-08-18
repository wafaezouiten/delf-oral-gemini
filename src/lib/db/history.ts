import "server-only";

import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";

import { ORAL_CRITERIA, type OralCriterion } from "@/lib/delf/criteria";
import { zeroCriteria, type DashboardSitting } from "@/lib/ui/dashboard-view";
import {
  evaluations,
  getDb,
  isDatabaseConfigured,
  oralExamPhases,
  oralExams,
  oralTopics,
} from "./index";

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
 * The join on `evaluations` is therefore a `leftJoin` and no longer an inner
 * one: an abandoned sitting has no correction and must still be counted.
 */

/** The five band columns, read back into the shape the view model wants. */
function criteriaOf(row: Record<string, unknown>): Record<OralCriterion, number> {
  return Object.fromEntries(
    ORAL_CRITERIA.map((criterion) => [criterion, Number(row[criterion] ?? 0)]),
  ) as Record<OralCriterion, number>;
}

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
 * Every corrected sitting this candidate has, newest first.
 *
 * **Newest first is a contract, not an incidental.** The ORDER BY below is the
 * only thing that makes `latestScoreBySujet` correct, and that reducer lives in
 * another module (`@/lib/ui/epreuve-hub`) where the ordering cannot be seen. Any
 * change to the direction here changes which score the sujet cards print.
 *
 * Returns `[]` — never throws — when there is no database configured. Both
 * callers are landing pages: a hub that 500s because Neon is not wired up in a
 * developer's `.env.local` is a worse failure than a hub whose sujet cards all
 * read "Commencer", which is exactly what an empty history means anyway.
 */
export async function readCandidateHistory(userId: string): Promise<DashboardSitting[]> {
  if (!isDatabaseConfigured()) return [];

  const totals = spokenSecondsByExam(userId);

  try {
    const rows = await getDb()
      .select({
        examId: oralExams.id,
        topicSlug: oralTopics.slug,
        topicTitle: oralTopics.title,
        phase: oralExams.phase,
        finishedAt: oralExams.finishedAt,
        abandonedAt: oralExams.abandonedAt,
        score25: evaluations.score25,
        meetsFloor: evaluations.meetsFloor,
        mode: evaluations.mode,
        spokenSeconds: totals.spokenSeconds,
        realisationTache: evaluations.realisationTache,
        interaction: evaluations.interaction,
        lexique: evaluations.lexique,
        morphosyntaxe: evaluations.morphosyntaxe,
        phonologie: evaluations.phonologie,
      })
      .from(oralExams)
      .leftJoin(evaluations, eq(evaluations.examId, oralExams.id))
      .innerJoin(oralTopics, eq(oralExams.topicId, oralTopics.id))
      .leftJoin(totals, eq(totals.examId, oralExams.id))
      .where(
        and(
          eq(oralExams.userId, userId),
          // Graded, or walked out of. Anything else is still running.
          or(isNotNull(evaluations.id), isNotNull(oralExams.abandonedAt)),
        ),
      )
      // Coalesced, because the two kinds are stamped in different columns and a
      // record ordered by only one of them would file every walk-out at the end
      // of time (nulls) or the beginning of it, depending on the direction.
      .orderBy(desc(sql`coalesce(${oralExams.abandonedAt}, ${oralExams.finishedAt})`));

    return rows.map((row) => {
      const abandoned = row.abandonedAt !== null;
      return {
        examId: row.examId,
        topicSlug: row.topicSlug,
        topicTitle: row.topicTitle,
        outcome: abandoned ? ("abandoned" as const) : ("corrected" as const),
        // The zero is the consequence of walking out, not a grading of it. See
        // `DashboardSitting` for why it is not an evaluation row.
        score25: abandoned ? 0 : (row.score25 ?? 0),
        meetsFloor: abandoned ? false : (row.meetsFloor ?? false),
        mode: abandoned ? null : row.mode,
        criteria: abandoned ? zeroCriteria() : criteriaOf(row),
        spokenSeconds: Number(row.spokenSeconds ?? 0),
        phase: row.phase,
        // Non-null by the WHERE clause: a row is here because it carries one
        // stamp or the other. `startedAt` is the fallback rather than a cast, so
        // a row that somehow had neither sorts by when it began instead of
        // throwing on a page that is only reporting history.
        endedAt: row.abandonedAt ?? row.finishedAt ?? new Date(0),
      };
    });
  } catch (error) {
    // A landing page is not worth a 500. The candidate loses their standing for
    // this render and keeps every way of sitting a new épreuve.
    console.error("[history] could not read the candidate's sittings", error);
    return [];
  }
}
