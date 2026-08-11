import "server-only";

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema";

/**
 * The Drizzle client.
 *
 * Lazily constructed so that importing anything from this module does not throw
 * at build time when `DATABASE_URL` is absent. That matters during development:
 * the Gemini exam loop is worth running before a Neon database exists, and a
 * top-level throw here would take the whole app down for want of a database the
 * exam does not need until it ends.
 */
let cached: ReturnType<typeof createClient> | null = null;

function createClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Add your Neon connection string to .env.local (see .env.example).",
    );
  }
  return drizzle(neon(url), { schema });
}

export function getDb() {
  cached ??= createClient();
  return cached;
}

/** Whether persistence is available. Callers degrade gracefully when it isn't. */
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export * from "./schema";
