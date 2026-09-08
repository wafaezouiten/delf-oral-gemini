/**
 * Capture a signed-in Clerk session for the E2E suite.
 *
 *     pnpm test:e2e:auth
 *
 * Opens a real browser, parks it on this app's own sign-in page and waits for
 * YOU to sign in with your own Clerk development account. When the browser
 * lands back inside `/app`, the resulting cookies are written to
 * `e2e/.auth/candidate.json` and `oral-journey.spec.ts` can use them.
 *
 * Deliberately not a Playwright test and deliberately not automated. There is no
 * test user, no password in this repository and no bypass around
 * `lib/auth/exam-guard` — the sign-in is a human doing it once, and the only
 * thing kept afterwards is the session it produced.
 *
 * Not a `*.spec.ts`, so `testDir: "./e2e"` never collects it as a test.
 *
 * The file it writes is a live credential for whoever ran it: it is gitignored
 * (`/e2e/.auth/`), and it expires on Clerk's own schedule — when the suite
 * starts bouncing to sign-in again, run this again.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { chromium } from "@playwright/test";

/** Where the suite looks. Keep in step with the command in the README of this file. */
const STATE_PATH = "e2e/.auth/candidate.json";
const BASE_URL = "http://localhost:3000";
/** How long you get to sign in — including a verification code arriving by mail. */
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  // Checked before a browser is launched, so a forgotten dev server costs a
  // sentence rather than a window that fails to load.
  if (!(await serverIsUp())) {
    console.error(
      `No app answering on ${BASE_URL}.\n` +
        `Start it in another terminal first:\n\n    pnpm dev\n\n` +
        `then run this again.`,
    );
    process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(STATE_PATH), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // `/app`, not `/sign-in`: the guard bounces it to sign-in carrying
    // `redirect_url`, so Clerk returns here by itself once you are in. That is
    // the app's own mechanism rather than a destination assumed by this script.
    await page.goto(`${BASE_URL}/app`);

    console.log(
      `\nA browser window is open.\n\n` +
        `  1. Sign in with your own Clerk development account.\n` +
        `  2. Wait until the épreuve hub (/app) has loaded.\n\n` +
        `The session saves itself and the window closes. Waiting up to ${
          SIGN_IN_TIMEOUT_MS / 60000
        } minutes…\n`,
    );

    // Signed in is "the guard let us through", which is the same condition the
    // suite itself depends on — not "a Clerk form disappeared".
    await page.waitForURL((url) => url.pathname.startsWith("/app"), {
      timeout: SIGN_IN_TIMEOUT_MS,
    });

    await context.storageState({ path: STATE_PATH });
    console.log(
      `Saved ${STATE_PATH}.\n\nRun the journey with:\n\n` +
        `    E2E_STORAGE_STATE=${STATE_PATH} pnpm test:e2e\n`,
    );
  } catch (cause) {
    console.error(
      `\nNo signed-in session was captured — the window closed, or the sign-in ` +
        `did not finish in time. Nothing was written.\n`,
    );
    console.error(cause);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

/** Whether `pnpm dev` is answering. A connection refused is the answer, not a throw. */
async function serverIsUp(): Promise<boolean> {
  try {
    await fetch(BASE_URL, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
