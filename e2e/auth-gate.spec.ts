import { expect, test } from "@playwright/test";

/**
 * The gate in front of the oral journey.
 *
 * Every screen of the épreuve lives under `/app`, and `src/proxy.ts`
 * deliberately protects none of them by path — `lib/auth/exam-guard` asks for
 * the caller and, where there is an `examId`, for the row, on each page and each
 * route. These tests are that policy seen from outside: what a signed-out
 * visitor actually gets when they aim at the journey's routes.
 *
 * They are the part of the journey that can be exercised with no account at
 * all. Everything after the redirect needs a real Clerk session — see
 * `oral-journey.spec.ts` for what that requires and why it is not invented here.
 *
 * `redirect_url` is asserted rather than merely the destination: it is what
 * `redirectToSignIn()` carries so a candidate bounced out of an épreuve in
 * progress returns to it instead of to the dashboard, which is the difference
 * between resuming and starting over.
 */

/** The journey's routes, in the order a candidate meets them. */
const GUARDED_ROUTES = [
  { path: "/app", what: "the hub the journey starts from" },
  { path: "/app/sujets", what: "the catalogue that opens an épreuve" },
  { path: "/app/oral/1", what: "the épreuve itself" },
  { path: "/app/results/1", what: "the correction" },
  { path: "/app/historique", what: "the past sittings" },
] as const;

for (const route of GUARDED_ROUTES) {
  test(`${route.path} sends a signed-out visitor to sign-in (${route.what})`, async ({ page }) => {
    await page.goto(route.path);

    await expect(page).toHaveURL(/\/sign-in/);
    // The route asked for survives the bounce, so signing in resumes it.
    expect(new URL(page.url()).searchParams.get("redirect_url")).toContain(route.path);
  });
}

test("an épreuve cannot be opened without a session", async ({ request }) => {
  // The journey's first write. `useStartExam` POSTs this before navigating, so
  // a gate that only covered pages would leave the row-creating route open.
  const response = await request.post("/api/exams", {
    data: { topicSlug: "teletravail" },
  });

  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: "Non authentifié" });
});
