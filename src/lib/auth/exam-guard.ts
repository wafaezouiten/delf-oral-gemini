import "server-only";

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { getDb, isDatabaseConfigured, oralExams } from "@/lib/db";
import {
  EXAM_ACCESS_DENIALS,
  resolveExamAccess,
  type ExamAccess,
  type ExamOwnerRow,
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

/** Reads the owner of one sitting. The only query in the ownership path. */
async function findExamOwner(examId: number): Promise<ExamOwnerRow | undefined> {
  const [row] = await getDb()
    .select({ id: oralExams.id, userId: oralExams.userId })
    .from(oralExams)
    .where(eq(oralExams.id, examId))
    .limit(1);
  return row;
}

/**
 * Ownership of `examId` for the current request.
 *
 * Never throws and never redirects, so a Route Handler stays in charge of its
 * own response shape. Pages want {@link requireOwnedExam} instead.
 */
export async function authorizeExam(examId: string): Promise<ExamAccess> {
  const { userId } = await auth();
  return resolveExamAccess({
    userId,
    examId,
    databaseConfigured: isDatabaseConfigured(),
    lookup: findExamOwner,
  });
}

/** The JSON body and status a denial turns into. Routes build the response. */
export function examAccessDenial(access: Extract<ExamAccess, { status: "denied" }>) {
  return EXAM_ACCESS_DENIALS[access.reason];
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
 * The same, plus ownership of `examId`.
 *
 * A sitting the caller does not own is a 404, exactly as it is over the API. The
 * `no-sitting` outcomes render: they expose nothing owned by anyone — the exam
 * page renders a topic from the public catalogue, and the results page renders
 * whatever is in the visitor's own `sessionStorage` — and refusing them would
 * break the documented "runs before a database exists" path.
 */
export async function requireOwnedExam(examId: string): Promise<ExamAccess> {
  const access = await authorizeExam(examId);
  if (access.status === "denied") {
    if (access.reason === "unauthenticated") {
      const { redirectToSignIn } = await auth();
      return redirectToSignIn();
    }
    notFound();
  }
  return access;
}
