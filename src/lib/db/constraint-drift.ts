/**
 * Comparing the live database's CHECK constraints against what `schema.ts`
 * declares (#77).
 *
 * The footgun this exists for is `drizzle-kit push`: it applies a new COLUMN
 * and silently leaves CHECK constraints at whatever the database already had.
 * That is not theoretical — after #71's push, `evaluations_score_25_check`
 * still read `raw − duration` while `absence_penalty` sat beside it, so every
 * correction without an absence penalty stored fine and the first walk-out was
 * refused, days later, on someone else's sitting. The guard against that was a
 * WARNING comment in `schema.ts`, which only works on people who read it.
 * `pnpm verify:db` runs before anyone trusts a database, so this is what it
 * checks there.
 *
 * **How the comparison stays honest.** Comparing the schema's expression text
 * against `pg_get_constraintdef` directly would drown in normalisation:
 * Postgres rewrites `x in (0, 1, 3, 5)` to `x = ANY (ARRAY[…])`, `between` to
 * a pair of comparisons, and sprinkles casts by column type. So nothing here
 * parses anything. Instead the script creates a short-lived MIRROR table per
 * checked table — the referenced columns at their exact declared types, plus
 * the declared constraints — and reads `pg_get_constraintdef` for mirror and
 * original alike. Both sides are then normalised by the same server, and the
 * comparison is string equality: any surviving difference is a real one.
 * (The types matter, not a nicety — the bands are `smallint`, and Postgres
 * prints different casts for a `smallint` than an `integer` comparison.)
 *
 * This module is the pure half: which checks the schema declares, the DDL the
 * mirrors need, and the diff. Creating the mirrors and reading the catalog is
 * the script's, because it needs the live connection this file must not have —
 * `node --test` covers everything on this side of that line.
 */

import { is } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig } from "drizzle-orm/pg-core";

import * as schema from "./schema";

/** One CHECK as `schema.ts` declares it, rendered to SQL text. */
export interface DeclaredCheck {
  table: string;
  constraint: string;
  /** The declared expression, with columns qualified as `"table"."column"`.
   *  Never compared against the live catalog directly — see the header. */
  expression: string;
}

/** One CHECK as a database reports it: `pg_get_constraintdef` output. */
export interface LiveConstraint {
  table: string;
  constraint: string;
  definition: string;
}

/** The mirror a checked table needs: a name no real table uses, and the DDL
 *  that attaches the schema's constraints to columns of the declared types. */
export interface ConstraintMirror {
  table: string;
  mirrorName: string;
  createSql: string;
}

export type ConstraintDrift =
  /** Declared in `schema.ts`, absent from the database. */
  | { kind: "missing"; table: string; constraint: string; expected: string }
  /** Present in the database, declared nowhere — drift from the other side. */
  | { kind: "undeclared"; table: string; constraint: string; actual: string }
  /** Same name, different rule. The #71 failure wore exactly this shape. */
  | { kind: "different"; table: string; constraint: string; expected: string; actual: string };

const dialect = new PgDialect();

/** Every table the schema module exports, in declaration order. Enumerated
 *  rather than listed so a new table's checks join the probe by existing. */
function tables(): PgTable[] {
  // Widened first: the exports are a union of concretely-typed tables (each
  // pinning its literal name), and a predicate cannot narrow that union to the
  // bare `PgTable` the probe wants without the compiler objecting.
  const exported: unknown[] = Object.values(schema);
  return exported.filter((value): value is PgTable => is(value, PgTable));
}

export function schemaTableNames(): string[] {
  return tables().map((table) => getTableConfig(table).name);
}

function renderedChecks(table: PgTable): DeclaredCheck[] {
  const config = getTableConfig(table);
  return config.checks.map((check) => {
    const query = dialect.sqlToQuery(check.value);
    if (query.params.length > 0) {
      // A bound parameter cannot be written into mirror DDL. No check in this
      // schema has one — literals live in the template text — and one arriving
      // must fail the probe loudly rather than mirror a hole where a rule was.
      throw new Error(
        `check "${check.name}" on "${config.name}" carries bound parameters and cannot be mirrored`,
      );
    }
    return { table: config.name, constraint: check.name, expression: query.sql };
  });
}

/** Every CHECK the schema declares, across every table. */
export function declaredChecks(): DeclaredCheck[] {
  return tables().flatMap((table) => renderedChecks(table));
}

/**
 * The mirror tables the probe needs, one per table that declares any check.
 *
 * Each mirror carries ONLY the columns its checks reference — at their exact
 * declared SQL types, since the type decides which casts Postgres prints into
 * the definition — and none of the rest: no enum columns, no jsonb, no
 * defaults, no keys, so the mirror depends on nothing but the checks it holds.
 *
 * @param suffix Appended to every mirror's name so a crashed run's leftovers
 *   cannot collide with the next one. Restricted to identifier characters
 *   because it is written into DDL.
 */
export function constraintMirrors(suffix: string): ConstraintMirror[] {
  if (!/^[a-z0-9_]+$/i.test(suffix)) {
    throw new Error(`mirror suffix ${JSON.stringify(suffix)} is not a bare identifier`);
  }

  const mirrors: ConstraintMirror[] = [];
  for (const table of tables()) {
    const config = getTableConfig(table);
    const checks = renderedChecks(table);
    if (checks.length === 0) continue;

    const referenced = config.columns.filter((column) =>
      checks.some((check) => check.expression.includes(`"${config.name}"."${column.name}"`)),
    );
    const columnsDdl = referenced.map(
      // `serial` is a column default wearing a type name; the mirror wants the
      // comparisons' arithmetic type, not a sequence. Unreachable today — no
      // check touches an id — and cheap to keep true.
      (column) =>
        `"${column.name}" ${column.getSQLType() === "serial" ? "integer" : column.getSQLType()}`,
    );
    // The declared expression qualifies its columns with the real table's
    // name; inside the mirror those must be bare, or the DDL names a table
    // it is not.
    const constraintsDdl = checks.map(
      (check) =>
        `constraint "${check.constraint}" check (${check.expression.split(`"${config.name}".`).join("")})`,
    );

    mirrors.push({
      table: config.name,
      mirrorName: `verify_constraints_${config.name}_${suffix}`,
      createSql: `create table "verify_constraints_${config.name}_${suffix}" (\n  ${[
        ...columnsDdl,
        ...constraintsDdl,
      ].join(",\n  ")}\n)`,
    });
  }
  return mirrors;
}

/**
 * What differs, with both sides quoted so the failure names the rule rather
 * than the fact of a mismatch.
 *
 * `expected` is the mirrors' catalog output mapped back to the real tables —
 * already server-normalised, which is what makes bare string equality the
 * whole comparison.
 */
export function diffConstraintDefinitions(
  expected: readonly LiveConstraint[],
  live: readonly LiveConstraint[],
): ConstraintDrift[] {
  const key = (constraint: { table: string; constraint: string }) =>
    `${constraint.table}.${constraint.constraint}`;
  const liveByKey = new Map(live.map((constraint) => [key(constraint), constraint]));
  const expectedKeys = new Set(expected.map(key));

  const drift: ConstraintDrift[] = [];
  for (const want of expected) {
    const got = liveByKey.get(key(want));
    if (!got) {
      drift.push({
        kind: "missing",
        table: want.table,
        constraint: want.constraint,
        expected: want.definition,
      });
    } else if (got.definition !== want.definition) {
      drift.push({
        kind: "different",
        table: want.table,
        constraint: want.constraint,
        expected: want.definition,
        actual: got.definition,
      });
    }
  }
  for (const got of live) {
    if (!expectedKeys.has(key(got))) {
      drift.push({
        kind: "undeclared",
        table: got.table,
        constraint: got.constraint,
        actual: got.definition,
      });
    }
  }
  return drift;
}
