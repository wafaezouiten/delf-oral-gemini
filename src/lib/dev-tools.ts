/**
 * Whether this build carries the exam's development tooling (#36).
 *
 * One switch for all of it: the transcription panel, `injectCandidateSpeech`,
 * `setDevTextMode`, and the finish route's duration override. They are one
 * feature and they have to agree — a build where the panel renders but the
 * duration claim is ignored gives every typed sitting the −3 penalty and no way
 * to see why, which is worse than not shipping the panel at all.
 *
 * **What this tooling actually is.** A way to write an exam transcript without
 * speaking, and to tell the server how long a phase lasted. On an environment
 * where marks are real, that is not a convenience, it is a way to award yourself
 * a grade. So this is opt-in and it fails closed:
 *
 *  - **Local development** — on. `NODE_ENV` is not "production" and the server
 *    is the developer's own machine.
 *  - **Staging and previews** — on. Vercel reports these as `VERCEL_ENV=preview`,
 *    and an environment that exists to try the product before it is real is
 *    exactly where trying it without speaking for twenty minutes belongs.
 *  - **Production** — off, and there is no way to turn it on: the check below is
 *    an equality against "production" with nothing that can override it.
 *
 * This began as an explicit `NEXT_PUBLIC_DEV_TOOLS=1` opt-in per environment,
 * which is the tighter rule and was the wrong one *here*. Two reasons it lost:
 * a `NEXT_PUBLIC_*` value is inlined when the app is built, so setting it in a
 * dashboard does nothing until the next build and reads as "the flag is broken";
 * and every preview of this repo is a preview of this product, so "which
 * previews should have it?" never had an interesting answer. The flag survives
 * only for hosts that report no `VERCEL_ENV` at all.
 *
 * What this widens, stated plainly: anyone who can open the staging URL can type
 * an exposé instead of speaking it, and claim a duration for it. Staging marks
 * are test data, so that is the point rather than a cost — but it is why the
 * production branch below is an equality and not a default.
 */

/** The environment as this module reads it. Passed in so the rule is testable. */
export interface DevToolsEnv {
  /** `NODE_ENV`: "production" in every built artefact, local `next dev` aside. */
  nodeEnv?: string;
  /**
   * Vercel's own environment name — "production", "preview" or "development".
   *
   * Server-side this is `VERCEL_ENV`. In the browser it is whatever
   * `next.config.ts` inlined under `NEXT_PUBLIC_VERCEL_ENV` — which is that same
   * value, copied at build time, so the two halves of this check cannot
   * disagree. Empty or absent means "not deployed on Vercel".
   */
  vercelEnv?: string;
  /**
   * `NEXT_PUBLIC_DEV_TOOLS`. Anything but "1" is off.
   *
   * Only consulted where there is no Vercel environment to read, which on this
   * project means a production build on some other host. It cannot reach past
   * the production check.
   */
  flag?: string;
}

export function devToolsEnabled(env: DevToolsEnv): boolean {
  // First and unconditional. Nothing below can reach past this, which is the
  // only property of this function that really matters.
  if (env.vercelEnv === "production") return false;
  // A deployment that Vercel calls anything else — preview, staging, its own
  // "development" — is not somewhere marks are real.
  if (env.vercelEnv) return true;
  // No Vercel at all: a developer's machine, or `node --test`.
  if (env.nodeEnv !== "production") return true;
  // A production build on some other host, which has to ask by name.
  return env.flag === "1";
}

/**
 * Read once, at module load.
 *
 * `process.env.NEXT_PUBLIC_*` is inlined at build time in the client bundle, so
 * these must stay literal property accesses: a computed key would leave the
 * browser reading `undefined` and quietly disable the panel everywhere.
 */
export const DEV_TOOLS_ENABLED = devToolsEnabled({
  nodeEnv: process.env.NODE_ENV,
  // `||`, not `??`: off Vercel the inlined value is the empty string, and an
  // empty string has to fall through to the server variable and then to
  // NODE_ENV rather than being read as an environment named "".
  vercelEnv: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.VERCEL_ENV,
  flag: process.env.NEXT_PUBLIC_DEV_TOOLS,
});
