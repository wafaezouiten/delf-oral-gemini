import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    /**
     * Vercel's environment name, carried into the browser bundle.
     *
     * `VERCEL_ENV` is set automatically on every Vercel build but is readable
     * only on the server, and the check it feeds — `lib/dev-tools.ts`, which
     * decides whether this build carries the exam's development tooling — runs
     * in the browser as well. Inlined here rather than asked for in the
     * dashboard, so no deployment can end up with the two halves disagreeing
     * because somebody added a variable to one environment and not another.
     *
     * Empty off Vercel, which `devToolsEnabled` reads as "no Vercel" and falls
     * back to `NODE_ENV` for.
     */
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV ?? "",
  },
};

export default nextConfig;
