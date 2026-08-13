import "server-only";

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { getDb, isDatabaseConfigured, oralExams } from "@/lib/db";
import { pageGate, resolveExamAccess, type ExamAccess, type ExamOwnerRow } from "./exam-access";

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

/** Reads the owner of one sitting. The only query in the ownership path. */
async function findExamOwner(examId: number): Promise<ExamOwnerRow | undefined> {
  const [row] = await getDb()
    .select({ id: oralExams.id, userId: oralExams.userId })
    .from(oralExams)
    .where(eq(oralExams.id, examId))
    .limit(1);
  return row;
}

/** The one wiring of policy to sources. Both entry points below go through it. */
async function accessFor(userId: string | null, examId: string): Promise<ExamAccess> {
  const access = await resolveExamAccess({
    userId,
    examId,
    databaseConfigured: isDatabaseConfigured(),
    lookup: findExamOwner,
  });
  // `exam-access.ts` does no I/O, so the log for an unanswered ownership
  // question is raised here, where there is a request to name it against.
  if (access.status === "no-sitting" && access.reason === "lookup-failed") {
    console.error("[exam-guard] could not verify ownership of exam", examId);
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
  return accessFor(userId, examId);
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
 * Gate a page on `examId`, and hand back the sitting's row id when there is one.
 *
 * The return type is the point: **this cannot return a number unless ownership
 * was established.** `null` means there is provably no sitting to own — no
 * database, or one of the degraded `local-…` ids — so a caller that reads
 * persisted data keys off the id and has no way to reach a row it did not earn.
 * Nothing needs the id today; it is here so the Phase 8 read path cannot be
 * written any other way.
 *
 * A sitting the caller does not own is a 404, exactly as it is over the API. An
 * ownership question the database could not answer is a 500 — see
 * {@link pageGate} for why that is not the same as "nothing to own".
 */
export async function requireExamAccess(examId: string): Promise<number | null> {
  const access = await authorizeExam(examId);

  switch (pageGate(access)) {
    case "sign-in": {
      const { redirectToSignIn } = await auth();
      return redirectToSignIn();
    }
    case "not-found":
      notFound();
    case "unverifiable":
      // Deliberately not `notFound()`: the sitting may well exist and be theirs.
      // What failed is our ability to say so, and that is a server error.
      throw new Error(`[exam-guard] ownership of exam ${examId} could not be verified`);
    case "render":
      return access.status === "owned" ? access.examId : null;
  }
}
