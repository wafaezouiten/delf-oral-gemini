import { existsSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

/**
 * The candidate's journey through one production orale, end to end.
 *
 * ── READ THIS BEFORE RUNNING ────────────────────────────────────────────────
 * This suite is SKIPPED unless `E2E_STORAGE_STATE` points at a Playwright
 * storage state holding a signed-in Clerk session. It was written from the
 * components it drives rather than from a passing run, and that is what step 1
 * was wrong about (#179): the catalogue is a grid of CARDS, and the launch CTA
 * lives on the sheet a card opens, not on the catalogue itself.
 *
 * WHICH SERVER THIS PASSES AGAINST. Both of them, against a live examiner and a
 * real correction. All twelve steps run green on `pnpm dev` — the server
 * `playwright.config.ts` starts, so `pnpm test:e2e` needs nothing added to it —
 * and on a PRODUCTION build:
 *
 *     NEXT_PUBLIC_DEV_TOOLS=1 pnpm build
 *     NEXT_PUBLIC_DEV_TOOLS=1 pnpm start
 *
 * The flag is there because a production build otherwise switches the typed
 * exposé off (`lib/dev-tools.ts`), and step 5 is that panel. `next dev` needs no
 * flag: the tooling is on for every non-production build.
 *
 * Only the production build could pass until #160 was fixed. Under `next dev`,
 * React StrictMode's double-mount destroyed the memoized exam controller: the
 * clock sat at 30:00, « Commencer la passation » did nothing at all, and this
 * journey died at step 4 on the app rather than on anything in this file. The
 * cure is in `use-exam-controller.ts`, and this journey run on `pnpm dev` is what
 * holds it — nothing else in the repository exercises a StrictMode remount of
 * the exam room.
 *
 * Why it cannot sign itself in: every screen below `/app` is gated by
 * `lib/auth/exam-guard`, which calls Clerk's `auth()` on the SERVER. There is no
 * query flag, no header and no dev bypass — `e2e/auth-gate.spec.ts` proves the
 * gate holds — so the session is captured by a human signing in once, with
 * `pnpm test:e2e:auth` (see `e2e/capture-session.ts`). There is no test account
 * and no password in this repository.
 *
 * What still reaches the real world when it does run:
 *   - The EXAMINER is a Gemini Live WebSocket opened from the browser with a
 *     token minted by `/api/live-token`. It could be stubbed with
 *     `page.routeWebSocket()`; that stub is not written, so today this journey
 *     talks to Gemini and steps 7-8 are only as deterministic as the examiner is.
 *   - The /25 is produced by `lib/gemini/evaluate.ts` inside
 *     `POST /api/exams/[examId]/finish`, which runs on the server. Playwright
 *     cannot intercept that from the page, so step 11 asserts that a score is
 *     RENDERED, never which score — the number is the model's and moves.
 *
 * What keeps it off the microphone: the exam's own development tooling (#36),
 * which `lib/dev-tools.ts` switches on for every non-production build and
 * therefore for `next dev`. « Dev · transcription » types the exposé instead of
 * speaking it. No application code is touched to make any of this testable.
 */

const STORAGE_STATE = process.env.E2E_STORAGE_STATE;
const SIGNED_IN = !!STORAGE_STATE && existsSync(STORAGE_STATE);

/**
 * A microphone, because the épreuve does not start without one.
 *
 * « Commencer votre exposé » runs `prepareAudio()`, which is
 * `browserMicrophone` and therefore `getUserMedia`. An automated Chromium
 * refuses that by default and the room says so — « Le microphone n'est pas
 * accessible » — and stays on the préparation, which is not a stale locator but
 * a browser with no input device.
 *
 * The fake device rather than the real one: a laptop's own microphone makes the
 * run depend on the room it is run in, and there is no assertion here about what
 * the candidate says. The exposé is typed (« Dev · transcription ») and the
 * débat only has to prove the examiner took a turn.
 *
 * At the top of the file rather than in the describe below, because
 * `launchOptions` forces its own worker and Playwright refuses it in a group.
 */
test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

test.describe("one production orale, start to finish", () => {
  test.skip(
    !SIGNED_IN,
    "No signed-in Clerk session. Capture one with `pnpm test:e2e:auth`, then run with E2E_STORAGE_STATE=e2e/.auth/candidate.json.",
  );
  // Guarded, because Playwright reads the path when it builds the context and a
  // missing file is an error rather than a skip.
  if (SIGNED_IN) test.use({ storageState: STORAGE_STATE });

  // One journey, so one test: each step depends on the phase the last one left
  // the sitting in, and the épreuve's transitions are one-way by construction
  // (`ORAL_PHASES` — there is no path back into an earlier phase to re-enter).
  test("a candidate sits an épreuve and reads the correction", async ({ page }) => {
    // The examiner speaks a consigne at each boundary and the controls stay shut
    // until it has, so the waits below are longer than a click normally
    // deserves — and the twelve of them together outlast anything
    // `test.slow()` can buy. That is Playwright's 30 s default tripled, 90 s,
    // and the measured journey is about 1.6 min: it used to die between the
    // débat and the correction, one step from the end.
    //
    // A ceiling, not a target. Every step carries its own timeout, so this only
    // decides how long a genuinely stuck run hangs before it is called stuck,
    // and step 10 alone may wait 5 min for the /25 to come back.
    test.setTimeout(15 * 60_000);

    await test.step("1. the candidate reaches an épreuve", async () => {
      await page.goto("/app/sujets");
      // Two clicks, not one. The catalogue is a grid of sujet CARDS, and the
      // launch CTA lives on the sheet a card opens: #131 removed the dialog
      // between the sheet and the épreuve, not the sheet itself. Both accessible
      // names carry the sujet, so the six of them stay distinguishable
      // (`SujetCard`, `StartExamButton`).
      await page
        .getByRole("button", { name: /^Lire le sujet/ })
        .first()
        .click();
      // No `.first()`: one sheet is mounted at a time, and saying so here is
      // what would make a second one a failure rather than a silent pick.
      await page.getByRole("button", { name: /^Passer l'épreuve sur le sujet/ }).click();
      await expect(page).toHaveURL(/\/app\/oral\/\d+/);
    });

    await test.step("2. the préparation is on screen", async () => {
      // The sujet sheet the thirty minutes are spent on.
      await expect(page.getByRole("heading", { name: "Document déclencheur" })).toBeVisible();
      // The notes survive into the passation's drawer, so they are worth writing.
      await page
        .getByLabel("Mes notes de préparation")
        .fill("Problématique, plan en deux parties, exemples.");
    });

    await test.step("3. the candidate starts the passation", async () => {
      await page.getByRole("button", { name: "Commencer la passation" }).click();
    });

    await test.step("4. the monologue is armed and then running", async () => {
      // Armed: the one state where the control starts a part rather than ending
      // it (`micCopy`). Disabled while the examiner is still giving the consigne.
      const start = page.getByRole("button", { name: "Commencer votre exposé" });
      await expect(start).toBeEnabled({ timeout: 60_000 });
      await start.click();
      await expect(page.getByRole("button", { name: "Terminer votre exposé" })).toBeVisible();
    });

    await test.step("5. the monologue ends on a typed exposé", async () => {
      // Instead of speaking for seven minutes. Opening the panel cuts the
      // microphone, which is the controller's doing, not the test's.
      await page.getByRole("button", { name: "Dev · transcription" }).click();
      await page.getByRole("button", { name: "Exemple" }).click();
      // Refused while the examiner is still on the consigne (`devSubmitState`),
      // so this waits rather than pressing into a disabled control.
      const send = page.getByRole("button", { name: "Envoyer l'exposé" });
      await expect(send).toBeEnabled({ timeout: 60_000 });
      await send.click();
    });

    await test.step("6. the débat is armed and then running", async () => {
      const start = page.getByRole("button", { name: "Commencer le débat" });
      await expect(start).toBeEnabled({ timeout: 60_000 });
      await start.click();
      await expect(page.getByRole("button", { name: "Terminer le débat" })).toBeVisible();
    });

    await test.step("7. the examiner takes a turn", async () => {
      // The débat prints what is said, attributed — « Vous » / « Examinateur »
      // (`speakerLabel`). The examiner opens the part, so its name appearing is
      // the exchange having happened; the words themselves are the model's.
      await expect(page.getByText("Examinateur").first()).toBeVisible({ timeout: 120_000 });
    });

    await test.step("8. the débat ends", async () => {
      // « Terminer l'épreuve » is enabled only in the débat: the DELF has no
      // path from an exposé straight to a correction.
      const finish = page.getByRole("button", { name: "Terminer l'épreuve" });
      await expect(finish).toBeEnabled();
      await finish.click();
    });

    await test.step("9. the épreuve is sent for correction", async () => {
      await expect(page.getByRole("heading", { name: "Épreuve terminée" })).toBeVisible({
        timeout: 60_000,
      });
    });

    await test.step("10. the correction is displayed", async () => {
      // The finished screen navigates itself once the correction lands.
      await expect(page).toHaveURL(/\/app\/results\/\d+/, { timeout: 300_000 });
      await expect(page.getByText("Production orale · Correction")).toBeVisible();
    });

    await test.step("11. the correction carries a score out of 25", async () => {
      // `/25` — `COMPETENCY_MAX`, printed beside the mark. The mark itself is
      // the model's and is deliberately not asserted.
      await expect(page.getByText("/25").first()).toBeVisible();
    });

    await test.step("12. « Recommencer » opens a fresh épreuve on the same sujet", async () => {
      const before = examIdFrom(page);
      await page.getByRole("button", { name: /^Recommencer/ }).click();

      await expect(page).toHaveURL(/\/app\/oral\/\d+/);
      // A NEW sitting, not the old one reopened — the whole point of #165.
      expect(examIdFrom(page)).not.toBe(before);
      // And it opens where an épreuve opens: on the préparation.
      await expect(page.getByRole("heading", { name: "Document déclencheur" })).toBeVisible();
    });
  });
});

/** The trailing id of `/app/oral/123` or `/app/results/123`. */
function examIdFrom(page: Page): string {
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}
