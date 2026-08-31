import { expect, test } from "@playwright/test";

/**
 * Smoke test: the app starts and its one public page is reachable.
 *
 * `/` is that page. `src/proxy.ts` establishes the Clerk request context but
 * deliberately protects nothing by path — authorisation lives on each resource
 * under `/app` — so the landing page is the only route a signed-out visitor can
 * reach, and a fresh browser context is signed out by construction. That is why
 * this needs no fixture, no test user and no stored session state.
 *
 * The assertions avoid the copy that is derived from the exam's constants
 * (`PHASE_DURATIONS`, `COMPETENCY_MAX`): those numbers are meant to move, and a
 * smoke test that fails when a duration is retuned is a smoke test nobody
 * trusts. What is asserted is the shell — a 200, the document title, the single
 * h1 and the two ways in.
 */
test("the landing page is served to a signed-out visitor", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/DELF B2/);

  // Server-rendered, so its presence also proves the render did not throw.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await expect(page.getByRole("button", { name: "Créer un compte" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Se connecter" })).toBeVisible();
});
