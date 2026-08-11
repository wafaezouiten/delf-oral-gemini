/**
 * Route protection.
 *
 * Next.js 16 renamed the `middleware` file convention to `proxy` (see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md);
 * Clerk's own Next 16 guidance says the same. The export is otherwise an
 * ordinary `clerkMiddleware`.
 *
 * Everything under /app and every exam API route requires a signed-in user. The
 * brief is explicit that unauthenticated users must not reach the oral
 * examination, and the token route matters most of all: it mints Gemini
 * credentials, so leaving it open would let anyone spend the project's quota.
 */

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher([
  "/app(.*)",
  "/api/live-token(.*)",
  "/api/exams(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  if (isProtectedRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Everything except Next internals and static files, unless they carry a query string.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
