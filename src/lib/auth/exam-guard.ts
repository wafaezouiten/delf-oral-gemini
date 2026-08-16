import "server-only";

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { getDb, isDatabaseConfigured, oralExams, oralTopics } from "@/lib/db";
import {
  pageGate,
  resolveExamAccess,
  type ExamAccess,
  type ExamOwnerRow,
  type OwnedSitting,
} from "./exam-access";

/**
 * The server binding for `exam-access.ts` — Clerk on one side, Drizzle on the
 * other, and no policy of its own.
 *
 * This is the data access layer the Next.js docs ask for: the check sits next to
 * the query rather than in a layout or a path matcher, so a route cannot read a
 * sitting without having asked who owns it. The two reasons it is not middleware:
 *
 *  - `createRouteMatcher` is deprecated in Clerk v7 (`server/routeMatcher.d.ts`),
 *    because middleware auth matches paths rather than the routes Next actually
 *    resolves, and the two can diverge.
 *  - A path matcher can only ever answer "is this caller signed in?". Ownership
 *    needs the row, and the row is here.
 */

/**
 * Reads the owner of one sitting, and the subject it was set. The only query in
 * the ownership path, and now the only one on the paths that follow it.
 *
 * It used to read the id and the owner and nothing else, and every caller that
 * got `owned` back went and read the same row again for its subject — two
 * sequential round trips per mint, and a token is minted on every connect
 * INCLUDING every reconnect. Exhausting the client's backoff was five mints and
 * ten round trips, precisely when the network was already unwell (#22).
 *
 * `leftJoin`, not `innerJoin`, and the difference is the whole reason this is
 * safe to fold together: an inner join makes a sitting whose subject cannot be
 * resolved indistinguishable from a sitting that does not exist, which is a 404
 * served to the owner of a real épreuve. `topic_id` is `not null` with a
 * restricted FK so the join should always match — "should" being exactly the
 * word that has no place in the query the ownership decision is made from. The
 * row answers who owns it; the join answers what it is about; neither gets a
 * vote on the other.
 *
 * That argument is about this query and not about the same join elsewhere:
 * `readSitting` joins `oral_topics` inner, and is right to. It runs only after
 * this function has already established ownership, so an empty result there
 * costs a render — the results page falls back to the copy the browser is
 * holding — rather than telling a candidate their own épreuve does not exist.
 * The looseness is bought where an authorisation decision is being made.
 */
async function findExamOwner(examId: number): Promise<ExamOwnerRow | undefined> {
  const [row] = await getDb()
    .select({ id: oralExams.id, userId: oralExams.userId, topicSlug: oralTopics.slug })
    .from(oralExams)
    .leftJoin(oralTopics, eq(oralExams.topicId, oralTopics.id))
    .where(eq(oralExams.id, examId))
    .limit(1);
  return row;
}

/** The one wiring of policy to sources. Both entry points below go through it. */
async function accessFor(
  userId: string | null,
  examId: string,
  /** Which entry point asked. Only the log reads it — see below. */
  via: "page" | "api",
): Promise<ExamAccess> {
  const access = await resolveExamAccess({
    userId,
    examId,
    databaseConfigured: isDatabaseConfigured(),
    lookup: findExamOwner,
  });
  // `exam-access.ts` does no I/O, so the log for an unanswered ownership
  // question is raised here, where there is a request to name it against.
  //
  // It carries the entry point because the two react oppositely: a page turns
  // this into a 500 the candidate sees, the API grades and silently persists
  // nothing. During an incident, "which one was it?" is the first question.
  if (access.status === "no-sitting" && access.reason === "lookup-failed") {
    console.error(`[exam-guard] (${via}) could not verify ownership of exam`, examId);
  }
  return access;
}

/**
 * Ownership of `examId` for the current request.
 *
 * Never throws and never redirects, so a Route Handler stays in charge of its
 * own response shape. Pages want {@link requireExamAccess} instead.
 */
export async function authorizeExam(examId: string): Promise<ExamAccess> {
  const { userId } = await auth();
  return accessFor(userId, examId, "api");
}

/**
 * The signed-in caller, or a redirect to the sign-in page.
 *
 * `redirectToSignIn()` rather than `redirect("/sign-in")`: it carries the
 * `redirect_url` Clerk needs to send the candidate back to the page they asked
 * for, which for an exam in progress is the difference between resuming and
 * starting over.
 *
 * Called per page, not once in the layout. Layouts do not re-render on client
 * transitions and do not control whether the segment below them renders at all
 * — see "Layouts and auth checks" in
 * `node_modules/next/dist/docs/01-app/02-guides/authentication.md`.
 */
export async function requireUserId(): Promise<string> {
  const { userId, redirectToSignIn } = await auth();
  if (!userId) return redirectToSignIn();
  return userId;
}

/**
 * Gate a page on `examId`, and hand back the sitting when there is one.
 *
 * The return type is the point: **this cannot return a sitting unless ownership
 * was established.** `null` means there is provably no sitting to own — no
 * database, or one of the degraded `local-…` ids — so a caller that reads
 * persisted data keys off the id and has no way to reach a row it did not earn.
 *
 * The subject comes back with it rather than being fetched afterwards, for the
 * reason given on {@link findExamOwner}. One consequence is worth stating
 * plainly, because it is a change rather than a saving: the exam page used to
 * survive a subject lookup that failed on its own by falling back to `?sujet=`,
 * and there is no longer a lookup that can fail on its own. A database that
 * cannot answer is now one outcome, `lookup-failed`, and a page refuses to
 * render on it — which is the call {@link pageGate} already documents, applied
 * to one more case rather than a new policy.
 *
 * A sitting the caller does not own is a 404, exactly as it is over the API. An
 * ownership question the database could not answer is a 500 — see
 * {@link pageGate} for why that is not the same as "nothing to own".
 */
export async function requireExamAccess(examId: string): Promise<OwnedSitting | null> {
  // One `auth()` for both answers: whether there is a caller, and where to send
  // them if there is not. Clerk memoises per request, but re-deriving
  // `redirectToSignIn` from a second call would only hide that it was here.
  const { userId, redirectToSignIn } = await auth();
  const access = await accessFor(userId, examId, "page");

  switch (pageGate(access)) {
    case "sign-in":
      return redirectToSignIn();
    case "not-found":
      // `return` rather than a bare call: `notFound()` is typed `never` and
      // throws, so falling through is impossible — but a `case` with no exit
      // reads as a forgotten `break`, and the next person should not have to
      // know Next's type signature to see why this is safe.
      return notFound();
    case "unverifiable":
      // Deliberately not `notFound()`: the sitting may well exist and be theirs.
      // What failed is our ability to say so, and that is a server error.
      throw new Error(`[exam-guard] ownership of exam ${examId} could not be verified`);
    case "render":
      return access.status === "owned"
        ? { examId: access.examId, topicSlug: access.topicSlug }
        : null;
  }
}
