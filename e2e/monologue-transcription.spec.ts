import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

/**
 * A SPOKEN monologue of a realistic length, and what the finish makes of it.
 *
 * `oral-journey.spec.ts` types the exposé (« Dev · transcription »), so nothing
 * in the repository has ever driven the one path a real candidate takes: audio,
 * for minutes, under manual VAD, transcribed in a single fragment when the
 * closing handshake releases the floor.
 *
 * The microphone is a WAV file rather than the fake device's beep — Chrome loops
 * `--use-file-for-fake-audio-capture`, so a couple of minutes of French speech
 * fills a monologue of any length. Render one with
 * `pnpm test:e2e:wav` and point `E2E_EXPOSE_WAV` at it.
 *
 * `E2E_EXPOSE_SECONDS` is how long to speak for; the failure this exists to
 * catch does not appear at short lengths.
 *
 * Like every journey here it needs `E2E_STORAGE_STATE` (`pnpm test:e2e:auth`),
 * and it talks to the real Gemini Live service.
 */

const STORAGE_STATE = process.env.E2E_STORAGE_STATE;
const WAV = process.env.E2E_EXPOSE_WAV ? resolve(process.env.E2E_EXPOSE_WAV) : undefined;
const SIGNED_IN = !!STORAGE_STATE && existsSync(STORAGE_STATE);
const HAS_AUDIO = !!WAV && existsSync(WAV);
const SPEAK_SECONDS = Number(process.env.E2E_EXPOSE_SECONDS ?? 360);

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      ...(HAS_AUDIO ? [`--use-file-for-fake-audio-capture=${WAV}`] : []),
    ],
  },
});

test.describe("a spoken exposé reaches the correction", () => {
  test.skip(
    !SIGNED_IN || !HAS_AUDIO,
    "Needs E2E_STORAGE_STATE (pnpm test:e2e:auth) and E2E_EXPOSE_WAV (pnpm test:e2e:wav).",
  );
  if (SIGNED_IN) test.use({ storageState: STORAGE_STATE });

  test("the candidate speaks, and the transcript carries it", async ({ page }) => {
    test.setTimeout((SPEAK_SECONDS + 15 * 60) * 1000);

    /** The controller's own event log, which it prints in every dev build. */
    const events: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("[exam ")) events.push(text);
    });

    /**
     * What the finish route answered, which is the thing under test. Held on an
     * object rather than in a `let`, so the assignment inside the listener is
     * visible to the assertions at the bottom.
     */
    const seen: { finish: { status: number; body: string } | null } = { finish: null };
    page.on("response", async (response) => {
      if (!/\/api\/exams\/\d+\/finish$/.test(new URL(response.url()).pathname)) return;
      seen.finish = { status: response.status(), body: (await response.text()).slice(0, 600) };
    });

    await page.goto("/app/sujets");
    await page
      .getByRole("button", { name: /^Lire le sujet/ })
      .first()
      .click();
    await page.getByRole("button", { name: /^Passer l'épreuve sur le sujet/ }).click();
    await expect(page).toHaveURL(/\/app\/oral\/\d+/);

    await page.getByRole("button", { name: "Commencer la passation" }).click();

    const startExpose = page.getByRole("button", { name: "Commencer votre exposé" });
    await expect(startExpose).toBeEnabled({ timeout: 120_000 });
    await startExpose.click();

    const endExpose = page.getByRole("button", { name: "Terminer votre exposé" });
    await expect(endExpose).toBeVisible();
    console.log(`speaking for ${SPEAK_SECONDS}s…`);
    await page.waitForTimeout(SPEAK_SECONDS * 1000);
    await endExpose.click();

    // The whole point of the reproduction: start the débat and leave at once.
    const startDebate = page.getByRole("button", { name: "Commencer le débat" });
    await expect(startDebate).toBeEnabled({ timeout: 120_000 });
    await startDebate.click();
    const finishExam = page.getByRole("button", { name: "Terminer l'épreuve" });
    await expect(finishExam).toBeEnabled();
    await finishExam.click();

    await expect(page.getByRole("heading", { name: "Épreuve terminée" })).toBeVisible({
      timeout: 120_000,
    });
    // Long enough for the correction to come back, or for the refusal to show.
    await page
      .waitForURL(/\/app\/results\/\d+/, { timeout: 300_000 })
      .catch(() => console.log("no results page"));

    console.log("\n--- exam events ---");
    for (const line of events) console.log(line);
    console.log("\n--- finish ---");
    const finish = seen.finish;
    console.log(finish ? `${finish.status} ${finish.body}` : "no finish response observed");

    expect(finish, "the finish was never answered").not.toBeNull();
    expect(finish!.status, `the finish refused the sitting: ${finish!.body}`).toBeLessThan(400);
  });
});
