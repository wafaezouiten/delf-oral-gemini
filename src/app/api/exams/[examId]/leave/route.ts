/**
 * POST /api/exams/:examId/leave — the candidate left during the préparation (#113).
 *
 * The abandon route's quiet sibling. Confirming the exit dialog from the exposé
 * onwards is a walk-out: the candidate was warned of a zero and `abandoned_at`
 * records the decision. Leaving during the préparation is not — nothing has been
 * said, there is no performance to score zero — so this route stamps
 * `archived_at` instead: the sitting is off the record by the candidate's own
 * decision, the way a reset files sittings (#69), rather than stranded looking
 * like a crashed tab.
 *
 * Three things this deliberately is not:
 *
 *  - **Not an abandon.** It never writes `abandoned_at`, so the sitting reaches
 *    no historique and no sujet card — not as a zero, not at all. That is the
 *    entire point of the boundary.
 *  - **Not a promise.** The abandon flow blocks on its write because the dialog
 *    promised a zero and a promise must be kept. This dialog promises the
 *    *absence* of a record, which is what an unrecorded exit produces anyway —
 *    so the client waits for the answer but leaves on any outcome, and a failure
 *    here costs a bookkeeping stamp, never the candidate anything.
 *  - **Not a rule the row can enforce alone.** `archivePreparationExit` requires
 *    `phase = 'preparation'`, but that column advances when a speaking phase
 *    finalises, so it still reads `'preparation'` through the live monologue. A
 *    forged request sent mid-exposé archives a sitting whose épreuve is in
 *    flight — stranding only the sender's own sitting, which is the acceptable
 *    half of the trade the issue named.
 *
 * It answers 200 for every legal request, including the ones that wrote nothing
 * — a sitting already left, already abandoned, or past the préparation. None of
 * those is an error the departing candidate could act on.
 */

import { archivePreparationExit } from "@/lib/db/sittings";
import { exitStampRoute } from "@/lib/exams/exit-stamp-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = exitStampRoute({
  flag: "archived",
  // `false` is not an error: the sitting was already left, already walked out
  // of, or had moved past the préparation while the dialog was open — and
  // writing nothing is the point of the guard. 200 either way, so a client
  // cannot be taught to retry on it.
  stamp: archivePreparationExit,
  failure: (examId) => `[leave] could not archive exam ${examId} on préparation exit`,
  failureBody: "Sortie non enregistrée",
});
