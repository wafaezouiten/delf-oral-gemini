import { expect, type Page } from "@playwright/test";

/**
 * From the catalogue to an épreuve, in the two clicks it actually takes.
 *
 * TWO, not one. The catalogue is a grid of sujet CARDS, and the launch CTA
 * lives on the sheet a card opens: #131 removed the dialog between the sheet
 * and the épreuve, not the sheet itself. Getting that wrong is what step 1 of
 * `oral-journey.spec.ts` was wrong about — the journey was written from the
 * components rather than from a passing run (#179) — and it is the first thing
 * every journey through the app has to do, so it is written here once.
 *
 * Both accessible names carry the sujet, which is what keeps the six of them
 * distinguishable (`SujetCard`, `StartExamButton`).
 *
 * Not a spec file, and Playwright will not collect it as one: `testMatch` takes
 * `*.spec.ts`, which is also why `capture-session.ts` can live in this
 * directory.
 *
 * Leaves the page on `/app/oral/<id>`, at the préparation, having asserted it
 * arrived — a caller that goes looking for « Commencer la passation » on the
 * catalogue should fail here, where the reason is legible, and not four
 * locators later.
 */
export async function reachEpreuve(page: Page) {
  await page.goto("/app/sujets");
  await page
    .getByRole("button", { name: /^Lire le sujet/ })
    .first()
    .click();
  // No `.first()`: one sheet is mounted at a time, and saying so here is what
  // makes a second one a failure rather than a silent pick.
  await page.getByRole("button", { name: /^Passer l'épreuve sur le sujet/ }).click();
  await expect(page).toHaveURL(/\/app\/oral\/\d+/);
}
