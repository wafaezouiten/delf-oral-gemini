/**
 * Verify that a live database's CHECK constraints are the schema's — and
 * nothing else (#125).
 *
 * The constraints slice of `verify:db`, cut out so CI can run it on every
 * schema-touching change: `pnpm verify:db` writes and deletes a synthetic
 * sitting, which is a fine bargain for a developer's own branch and no
 * business of a CI job probing a shared one. This script creates the mirror
 * tables, reads the catalog, diffs, drops the mirrors, and touches nothing
 * further — the mechanics and the reasoning live in
 * `src/lib/db/constraint-drift.ts`.
 *
 * Exit 1 on drift, on a database with nothing declared to hold (a vacuous
 * pass is the comment-shaped guard #77 retired), or on a missing
 * `DATABASE_URL`. CI treats all three as the same instruction: do not trust
 * this database's arithmetic until someone has looked.
 *
 *   pnpm verify:constraints
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { sql } from "drizzle-orm";

import { getDb, isDatabaseConfigured } from "../src/lib/db";
import { probeConstraintDrift } from "../src/lib/db/constraint-drift";

if (!isDatabaseConfigured()) {
  console.error(
    "DATABASE_URL is not set. Locally: add your Neon connection string to .env.local. " +
      "In CI: add a DATABASE_URL repository secret pointing at a development branch, never production.",
  );
  process.exit(1);
}

let failures = 0;
function check(what: string, ok: boolean, detail?: unknown): void {
  console.log(
    `${ok ? "  ok  " : "  FAIL"}  ${what}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
  );
  if (!ok) failures += 1;
}

async function main(): Promise<number> {
  const db = getDb();

  console.log("constraints");
  const { declared, drift } = await probeConstraintDrift(
    async (statement) => (await db.execute(sql.raw(statement))).rows,
    `${Date.now()}`,
  );

  check("the schema declares checks for the probe to hold", declared > 0, { declared });
  check(
    "every live CHECK matches the schema, word for word",
    drift.length === 0,
    drift.length > 0 ? drift : { constraints: declared },
  );

  return failures;
}

main()
  .then((count) => {
    console.log(count === 0 ? "\nAll checks passed.\n" : `\n${count} check(s) FAILED.\n`);
    process.exit(count === 0 ? 0 : 1);
  })
  .catch((error: unknown) => {
    console.error("\nverification threw:", error);
    process.exit(1);
  });
