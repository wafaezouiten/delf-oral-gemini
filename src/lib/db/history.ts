import "server-only";

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { ORAL_CRITERIA, type OralCriterion } from "@/lib/delf/criteria";
import type { DashboardSitting } from "@/lib/ui/dashboard-view";
import {
  evaluations,
  getDb,
  isDatabaseConfigured,
  oralExamPhases,
  oralExams,
  oralTopics,
} from "./index";

/**
 * The candidate's own corrected sittings — the one read the hub and the tableau
 * de bord share.
 *
 * Everything in this module is scoped by `user_id` in its own WHERE clause, not
 * by having been called from a page that checked. That is the same rule
 * `exam-guard.ts` states for the sitting routes, applied to the two surfaces
 * that read *across* sittings rather than into one: there is no id to own here,
 * so the ownership has to be the query's.
 *
 * Only corrected sittings are returned, and the join is what enforces it — an
 * `innerJoin` on `evaluations`. An abandoned attempt has no score, no criteria
 * and no measured audio; counting it toward a "note moyenne" would move a
 * candidate's standing for a reason that has nothing to do with their French.
 * This is the looseness-vs-strictness call the exam guard describes, on the
 * other side of the line: no authorisation decision is being made from this
 * join, so it may be strict.
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
        score25: evaluations.score25,
        meetsFloor: evaluations.meetsFloor,
        mode: evaluations.mode,
        finishedAt: oralExams.finishedAt,
        spokenSeconds: totals.spokenSeconds,
        realisationTache: evaluations.realisationTache,
        interaction: evaluations.interaction,
        lexique: evaluations.lexique,
        morphosyntaxe: evaluations.morphosyntaxe,
        phonologie: evaluations.phonologie,
      })
      .from(oralExams)
      .innerJoin(evaluations, eq(evaluations.examId, oralExams.id))
      .innerJoin(oralTopics, eq(oralExams.topicId, oralTopics.id))
      .leftJoin(totals, eq(totals.examId, oralExams.id))
      .where(and(eq(oralExams.userId, userId), isNotNull(oralExams.finishedAt)))
      .orderBy(desc(oralExams.finishedAt));

    return rows.map((row) => ({
      examId: row.examId,
      topicSlug: row.topicSlug,
      topicTitle: row.topicTitle,
      score25: row.score25,
      meetsFloor: row.meetsFloor,
      mode: row.mode,
      criteria: criteriaOf(row),
      spokenSeconds: Number(row.spokenSeconds ?? 0),
      // Non-null by the WHERE clause above; the cast is the narrowing Drizzle
      // cannot do from `isNotNull`, not an assumption about the data.
      finishedAt: row.finishedAt as Date,
    }));
  } catch (error) {
    // A landing page is not worth a 500. The candidate loses their standing for
    // this render and keeps every way of sitting a new épreuve.
    console.error("[history] could not read the candidate's sittings", error);
    return [];
  }
}

/**
 * The candidate's best /25 per sujet, for the hub's cards.
 *
 * Best rather than latest, deliberately: the card's job is to say whether this
 * sujet has been beaten, and a candidate who scored 18 and then tried a risky
 * angle for 11 has not got worse at it. Derived from the same history read
 * rather than from a second query — six sujets is not worth a round trip.
 */
export function bestScoreBySujet(
  history: readonly DashboardSitting[],
): Map<string, number> {
  const best = new Map<string, number>();
  for (const sitting of history) {
    const previous = best.get(sitting.topicSlug);
    if (previous === undefined || sitting.score25 > previous) {
      best.set(sitting.topicSlug, sitting.score25);
    }
  }
  return best;
}
