/**
 * Clerk request handling.
 *
 * Next.js 16 renamed the `middleware` file convention to `proxy` (see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
 *
 * Note what this deliberately does NOT do: match protected paths here.
 * `createRouteMatcher` is deprecated in Clerk v7, and the reason given is worth
 * heeding rather than silencing — middleware auth relies on path matching, which
 * can diverge from how Next.js actually routes a request and leave a protected
 * resource reachable. For a route that mints Gemini credentials, "probably
 * matched" is not good enough. A path matcher also cannot answer the question
 * this product actually has to ask, which is not "is this caller signed in?" but
 * "is this sitting theirs?" — that needs the row.
 *
 * So authorisation lives with each resource instead, through `lib/auth`:
 *   - `app/app/page.tsx`                   `requireUserId()`
 *   - `app/app/oral/[examId]/page.tsx`     `requireExamAccess()`
 *   - `app/app/results/[examId]/page.tsx`  `requireExamAccess()`
 *   - `app/app/layout.tsx`                 `requireUserId()`, for the shell only
 *   - `api/live-token/route.ts`            `auth()` before minting a token
 *   - `api/exams/route.ts`                 `auth()` before creating an exam
 *   - `api/exams/[examId]/finish/route.ts` `authorizeExam()` before grading
 *
 * This file only establishes the Clerk request context those checks read from.
 */

import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = {
  matcher: [
    // Everything except Next internals and static files, unless they carry a query string.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
