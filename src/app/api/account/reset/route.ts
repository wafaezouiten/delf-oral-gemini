/**
 * POST /api/account/reset — the candidate is starting over (#69).
 *
 * Sent from « Repartir de zéro », the page this product adds to Clerk's account
 * screens at /app/compte, after an explicit confirmation. It archives everything
 * currently on the record: the tableau de bord goes back to its empty state, the
 * sujet cards go back to « Commencer », and the historique keeps every sitting
 * under its archive.
 *
 * **It deletes nothing**, which is what makes it safe to expose as a button. No
 * sitting, correction or recording is removed, `/app/results/:id` on an archived
 * épreuve keeps working, and the guard in front of it is untouched.
 *
 * That promise now covers bytes as well as rows (#98): the recordings a sitting
 * kept in the vault stay kept, and playback on an archived correction keeps
 * working, because the archive hides a record rather than shortening it. The
 * candidate whose reset should also silence their old voice is asking for a
 * deletion this product does not yet offer — that is a per-recording delete
 * speaking through `oral_recordings.deleted_at`, not a different reset.
 *
 * Two ways this differs from the sitting routes next door:
 *
 *  - **There is no id to own.** `authorizeExam` answers "is this sitting this
 *    caller's?", and there is no sitting here. Authorisation is the signed-in
 *    id plus the `user_id` clause inside `archiveCandidateRecord` — the rule
 *    `history.ts` already states for everything that works across sittings
 *    rather than into one.
 *  - **The candidate is still here.** `abandon` is written for a browser on its
 *    way out and swallows its own failures; this one is awaited by someone
 *    watching a button, so a failure must come back as a failure. Reporting
 *    success on a write that did not happen would send them to a tableau de bord
 *    that had not changed.
 *
 * A route handler and not a Server Action, because every other write in this
 * product is one and a lone action would be the only place a reviewer has to
 * check a different set of rules.
 */

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { archiveCandidateRecord } from "@/lib/db/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  try {
    const archived = await archiveCandidateRecord(userId, new Date());
    // Idempotent, and `archived: 0` is a success rather than a refusal: a second
    // press with nothing left to archive has already got the candidate what they
    // asked for. The count is reported so the page can say what happened
    // instead of guessing.
    return NextResponse.json({ archived });
  } catch (error) {
    // The user id is not logged: it identifies a person, and "a reset failed"
    // is the whole of what an incident needs from here.
    console.error("[account] could not archive the candidate's record", error);
    return NextResponse.json({ error: "Réinitialisation impossible" }, { status: 503 });
  }
}
