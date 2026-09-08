import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests.
 *
 * Deliberately separate from `pnpm test:unit`, which runs the unit tests under
 * `src/` through the node test runner. The two globs do not overlap: unit tests are
 * `*.test.ts` under `src/`, end-to-end tests are `*.spec.ts` under `e2e/`, so
 * neither runner can pick up the other's files.
 *
 * The server is `next dev` rather than a production build: this suite only has
 * to prove the app boots and serves, and dev needs no build step and reads
 * `.env.local` the same way the developer's own `pnpm dev` does. Nothing here
 * signs in — see `e2e/smoke.spec.ts` for why that is enough.
 */
const PORT = 3000;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // A failing expect must not hold the suite open for Playwright's 5s default
  // while `next dev` is still compiling the route behind it.
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // A committed `test.only` is a mistake locally and a silently narrowed suite
  // in CI; refuse the build rather than report a green partial run.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    // Locally, attach to a `pnpm dev` that is already running instead of
    // failing on the busy port. CI always starts its own.
    reuseExistingServer: !process.env.CI,
    // Next's first compile of a cold `.next` is well past the 60s default.
    timeout: 120_000,
  },
});
