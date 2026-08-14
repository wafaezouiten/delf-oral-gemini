import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "./index";
import { oralExams, oralTopics } from "./schema";

/**
 * Reads about a sitting that are not ownership questions.
 *
 * Kept out of `exam-guard.ts` on purpose: that module answers exactly one
 * question and gets to stay small enough to audit. This one runs *after* it has
 * answered, on a row id the guard has already vouched for.
 */

/**
 * The subject recorded on a sitting.
 *
 * The authoritative answer to "which subject is this exam?", and the reason it
 * exists: before Phase 4 both the exam page (`?sujet=`) and the token route took
 * the browser's word for it, so a candidate could sit subject A on a row that
 * says subject B. Cross-user safe — the slug is validated against the catalogue
 * either way — but the grade would then be filed against a subject nobody
 * prepared.
 *
 * Returns `undefined` rather than throwing when the database cannot answer. A
 * token is minted on every reconnect, so an outage here must degrade to whatever
 * the candidate is visibly looking at rather than end a débat in progress. The
 * callers decide what to do with the absence; this only reports it.
 */
export async function findSittingTopicSlug(examId: number): Promise<string | undefined> {
  try {
    const [row] = await getDb()
      .select({ slug: oralTopics.slug })
      .from(oralExams)
      .innerJoin(oralTopics, eq(oralExams.topicId, oralTopics.id))
      .where(eq(oralExams.id, examId))
      .limit(1);
    return row?.slug;
  } catch (error) {
    console.error("[sittings] could not read the subject of exam", examId, error);
    return undefined;
  }
}
