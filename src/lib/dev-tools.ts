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
 *  - **Staging and previews** — on ONLY where `NEXT_PUBLIC_DEV_TOOLS` is set to
 *    "1". Vercel scopes environment variables per environment, so setting it on
 *    Preview and leaving Production blank is what keeps the two apart. Nothing
 *    is inferred from the branch name or the URL.
 *  - **Production** — off. The flag is absent by default, and `VERCEL_ENV`
 *    vetoes it outright wherever that variable is readable, so setting the flag
 *    on Production by mistake still does not switch this on.
 *
 * Deliberately NOT keyed on "is this a preview deployment?" alone. That reads as
 * the same rule but is not: it turns the tooling on for every future preview
 * without anyone deciding to, including previews of branches nobody is testing
 * an exam on.
 */

/** The environment as this module reads it. Passed in so the rule is testable. */
export interface DevToolsEnv {
  /** `NODE_ENV`: "production" in every built artefact, local `next dev` aside. */
  nodeEnv?: string;
  /**
   * Vercel's own environment name — "production", "preview" or "development".
   *
   * Server-side this is `VERCEL_ENV`. On the client it is only readable if the
   * deployment explicitly exposes `NEXT_PUBLIC_VERCEL_ENV`, so it is treated as
   * a veto when present rather than as the rule: absent must not mean "allow
   * everything", and it does not, because the flag below is what grants.
   */
  vercelEnv?: string;
  /** `NEXT_PUBLIC_DEV_TOOLS`. Anything but "1" is off. */
  flag?: string;
}

export function devToolsEnabled(env: DevToolsEnv): boolean {
  // The veto comes first: a production deployment does not get this even if
  // somebody has set the flag there.
  if (env.vercelEnv === "production") return false;
  // A developer's own machine, where the server and the candidate are the same
  // person and no mark means anything.
  if (env.nodeEnv !== "production") return true;
  // Every other build — staging, previews — has to ask for it by name.
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
  vercelEnv: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.VERCEL_ENV,
  flag: process.env.NEXT_PUBLIC_DEV_TOOLS,
});
