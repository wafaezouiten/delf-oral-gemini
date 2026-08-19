import "server-only";

import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

import { evaluations, getDb, oralExams } from "./index";

/**
 * The candidate's record as a whole, rather than one sitting in it.
 *
 * `sittings.ts` writes to one épreuve and takes an id to do it. This module has
 * no id: the thing being changed is "everything this candidate has done", so the
 * `user_id` clause is not a guard on top of an ownership check — it *is* the
 * ownership check, the same rule `history.ts` states for the surfaces that read
 * across sittings.
 */

/**
 * Start the record over: archive everything currently on it (#69).
 *
 * **Nothing is deleted.** Every row, correction, phase and recording stays
 * exactly where it was; the stamp takes them out of the figures and out of the
 * sujet cards, and the historique goes on listing them under their archive.
 * That is the whole feature, and it is why the button in front of it is one
 * confirmed click rather than a ceremony.
 *
 * Three clauses, each load-bearing:
 *
 *  - **the owner**, for the reason above — there is nothing else scoping this;
 *  - **`archived_at is null`**, so a double-clicked button keeps the instant the
 *    candidate first drew the line, and so a second reset with nothing new to
 *    archive is a genuine no-op rather than a re-stamp that would move older
 *    sittings into a later archive than the one they were filed in;
 *  - **graded or walked out of**, which is the same predicate
 *    `readCandidateHistory` uses to decide what is on the record at all.
 *
 * That last one is the interesting one, and stating it as "every row of this
 * candidate's" instead would be the bug this function exists to avoid: a sitting
 * still in progress in another tab is not on the record yet, so archiving it
 * looks like nothing at all until it finishes — and then the correction lands
 * *already archived*, and an épreuve the candidate sat **after** pressing the
 * button never appears anywhere. A sitting still running belongs to the new
 * record, which is also the honest reading of the button.
 *
 * `exists (…)` rather than a join, for the reason `abandonSitting` uses `not
 * exists`: an UPDATE that joins `evaluations` would touch a row once per
 * correction, and a sitting is allowed to carry several (the text/audio
 * comparison writes two).
 *
 * Returns how many sittings moved, which is what the route reports and what
 * makes a repeat press provably free.
 *
 * Never degrades to a silent success: with no database configured, `getDb()`
 * throws and the caller answers 503. A write that reported "done" without
 * writing would be worse here than an error — the candidate would go looking at
 * a tableau de bord that had not changed.
 */
export async function archiveCandidateRecord(userId: string, at: Date): Promise<number> {
  const archived = await getDb()
    .update(oralExams)
    .set({ archivedAt: at })
    .where(
      and(
        eq(oralExams.userId, userId),
        isNull(oralExams.archivedAt),
        or(
          isNotNull(oralExams.abandonedAt),
          sql`exists (select 1 from ${evaluations} where ${evaluations.examId} = ${oralExams.id})`,
        ),
      ),
    )
    .returning({ id: oralExams.id });

  return archived.length;
}
