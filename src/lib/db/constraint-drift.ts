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
 * This module owns everything except the connection: which checks the schema
 * declares, the DDL the mirrors need, the diff — and, since #125, the probe
 * that runs them in order ({@link probeConstraintDrift}), against an INJECTED
 * executor rather than an imported client. Two callers hand it one:
 * `scripts/verify-persistence.ts` inside the full round trip, and
 * `scripts/verify-constraints.ts`, the entry point CI runs on schema changes,
 * which probes and writes nothing else. `node --test` covers everything on
 * this side of the injection, fake executor included.
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

/**
 * One SQL statement, executed for its rows. The probe's whole connection
 * surface — injected so `node --test` can stand a database in with a map.
 *
 * Statements are TEXT, so nothing at this boundary can bind a parameter. That
 * makes the bare-identifier regexes in this file LOAD-BEARING against SQL
 * injection, not decoration: every name that reaches a statement — mirror
 * names via {@link constraintMirrors}'s suffix guard, table names via the
 * check inside {@link probeConstraintDrift}, reaped names via the pattern in
 * {@link reapStaleMirrors} — is proven identifier-shaped first. Anyone
 * reusing this executor shape for less trusted input must keep that chain,
 * or restore the parameterised query this replaced.
 */
export type SqlExecutor = (statement: string) => Promise<Array<Record<string, unknown>>>;

export interface ConstraintProbeOptions {
  /**
   * Where a failed cleanup goes instead of nowhere. A drop that fails must
   * neither mask the probe's own error nor fail a clean run — but swallowing
   * it silently would let a database that refuses drops leak one inert mirror
   * per run with no signal at all. Defaults to `console.warn`.
   */
  onCleanupFailure?: (mirrorName: string, error: unknown) => void;
  /** Injectable clock for the reaper's staleness arithmetic. */
  now?: () => number;
}

/**
 * How old a leftover mirror must be before the next run reaps it.
 *
 * Leftovers are real: a cancelled CI job is killed, not thrown at, so the
 * probe's `finally` never runs and its mirrors stay behind — and two quick
 * pushes to one ref is exactly what the workflow's `cancel-in-progress`
 * produces. One hour is far past any probe's lifetime, so a concurrent run's
 * fresh mirrors are never touched, while a cancelled run's debris survives
 * only until the next probe of the same database.
 */
export const MIRROR_REAP_AGE_MS = 60 * 60 * 1000;

const warnCleanupFailure = (mirrorName: string, error: unknown) =>
  console.warn(`[constraint-drift] could not drop mirror "${mirrorName}":`, error);

/**
 * Drop mirrors stranded by runs that never got to their own cleanup.
 *
 * Only names wearing this module's exact shape with a TIMESTAMP suffix are
 * candidates — both scripts suffix with `Date.now()` — and only when that
 * timestamp is at least {@link MIRROR_REAP_AGE_MS} old. A name whose suffix
 * does not parse is left alone rather than guessed about.
 */
async function reapStaleMirrors(
  execute: SqlExecutor,
  nowMs: number,
  onCleanupFailure: (mirrorName: string, error: unknown) => void,
): Promise<void> {
  const rows = await execute(
    `select rel.relname as relname
     from pg_class rel
     join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = current_schema()
       and rel.relkind = 'r'
       and rel.relname like 'verify_constraints_%'`,
  );
  for (const row of rows as Array<{ relname: string }>) {
    // The pattern is the injection guard for the drop below as well as the
    // staleness key: nothing that fails it reaches a statement.
    const match = /^verify_constraints_[a-z0-9_]*_(\d+)$/.exec(row.relname);
    if (!match) continue;
    const age = nowMs - Number(match[1]);
    if (!(age >= MIRROR_REAP_AGE_MS)) continue;
    await execute(`drop table if exists "${row.relname}"`).catch((error) =>
      onCleanupFailure(row.relname, error),
    );
  }
}

export interface ConstraintProbeOutcome {
  /** How many declared constraints the catalog reported back off the mirrors.
   *  Zero means the probe held nothing and must be treated as a failure by the
   *  caller — a vacuous pass is the comment-shaped guard this replaces. */
  declared: number;
  drift: ConstraintDrift[];
}

/**
 * Run the whole comparison against one database (#125).
 *
 * Creates the mirrors, reads `pg_get_constraintdef` for mirrors and schema
 * tables in one catalog query, diffs, and drops the mirrors in a `finally` —
 * whatever the query did. Every statement is passed to `execute` as text:
 * the identifiers in it come from `schema.ts` and the validated suffix, both
 * of which {@link constraintMirrors} refuses anything non-identifier-shaped,
 * and the guard below is what keeps that assumption checked rather than held.
 *
 * The mirrors are REAL tables, not `TEMP` ones, and that is a driver fact
 * rather than a taste: `neon-http` is stateless — each query can land on its
 * own session — and a temp table would vanish between the CREATE and the
 * catalog read.
 */
export async function probeConstraintDrift(
  execute: SqlExecutor,
  suffix: string,
  options: ConstraintProbeOptions = {},
): Promise<ConstraintProbeOutcome> {
  const onCleanupFailure = options.onCleanupFailure ?? warnCleanupFailure;
  const mirrors = constraintMirrors(suffix);
  try {
    // Before this run builds anything: sweep up what a killed run left. A
    // cancelled CI job never reaches its `finally`, so its mirrors are the
    // previous tenant's furniture — reaped by age, never by name collision,
    // which is what keeps a concurrent run's fresh mirrors safe.
    await reapStaleMirrors(execute, (options.now ?? Date.now)(), onCleanupFailure);

    for (const mirror of mirrors) await execute(mirror.createSql);

    const names = [...schemaTableNames(), ...mirrors.map((mirror) => mirror.mirrorName)];
    for (const name of names) {
      // Belt under the braces the mirror builder already wears: every name is
      // written into the catalog query as a quoted literal, and this probe
      // would rather refuse a strange one than trust its own provenance story.
      if (!/^[a-z0-9_]+$/i.test(name)) {
        throw new Error(`table name ${JSON.stringify(name)} is not a bare identifier`);
      }
    }
    const rows = await execute(
      `select rel.relname as table_name,
              con.conname as constraint_name,
              pg_get_constraintdef(con.oid) as definition
       from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       join pg_namespace nsp on nsp.oid = rel.relnamespace
       where con.contype = 'c'
         and nsp.nspname = current_schema()
         and rel.relname in (${names.map((name) => `'${name}'`).join(", ")})`,
    );

    // The mirrors' rows are the expectation, mapped back to the tables they
    // mirror; the schema tables' own rows are what the database actually holds.
    const mirroredTable = new Map(mirrors.map((mirror) => [mirror.mirrorName, mirror.table]));
    const expected: LiveConstraint[] = [];
    const live: LiveConstraint[] = [];
    for (const row of rows as Array<{
      table_name: string;
      constraint_name: string;
      definition: string;
    }>) {
      const constraint = { constraint: row.constraint_name, definition: row.definition };
      const table = mirroredTable.get(row.table_name);
      if (table !== undefined) expected.push({ ...constraint, table });
      else live.push({ ...constraint, table: row.table_name });
    }

    return { declared: expected.length, drift: diffConstraintDefinitions(expected, live) };
  } finally {
    for (const mirror of mirrors) {
      // Best-effort, each on its own: one failed drop must not strand the
      // rest, and a cleanup error must not mask the probe's — which is the one
      // that says what actually went wrong. But reported, never swallowed: a
      // database that refuses drops would otherwise leak one inert mirror per
      // run with no signal until someone counted tables. What does get
      // stranded — here, or by a killed process that never reaches this line —
      // is reaped by the next run's sweep above.
      await execute(`drop table if exists "${mirror.mirrorName}"`).catch((error) =>
        onCleanupFailure(mirror.mirrorName, error),
      );
    }
  }
}
