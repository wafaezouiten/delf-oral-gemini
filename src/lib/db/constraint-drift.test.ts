import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  constraintMirrors,
  declaredChecks,
  diffConstraintDefinitions,
  probeConstraintDrift,
  schemaTableNames,
  type LiveConstraint,
} from "./constraint-drift";

/**
 * The pure half of the #77 drift probe: what the schema declares, the mirror
 * DDL the live comparison needs, and the diff. The half that connects lives in
 * `scripts/verify-persistence.ts`, where the database is.
 */

describe("what the schema declares", () => {
  it("knows every CHECK, on the table that carries it", () => {
    // The five constraints as of #92/#71. A constraint added to `schema.ts`
    // joins `declaredChecks()` by existing — that is the point of enumerating
    // the module's exports — so this list needs updating only to acknowledge
    // the addition, never to make the probe see it.
    const byName = new Map(declaredChecks().map((check) => [check.constraint, check.table]));

    assert.deepEqual(
      byName,
      new Map([
        ["oral_exam_phases_spoken_seconds_check", "oral_exam_phases"],
        ["oral_recordings_duration_check", "oral_recordings"],
        ["evaluations_bands_check", "evaluations"],
        ["evaluations_score_range_check", "evaluations"],
        ["evaluations_score_25_check", "evaluations"],
      ]),
    );
  });

  it("renders expressions as inline SQL with no bound parameters", () => {
    // A bound parameter cannot be written into mirror DDL; the renderer throws
    // on one. What must hold for every check that gets through: the literals
    // are in the text, and the columns are qualified the way the mirror DDL
    // will strip.
    for (const check of declaredChecks()) {
      assert.ok(!/\$\d/.test(check.expression), `${check.constraint} carries a bind marker`);
      assert.ok(
        check.expression.includes(`"${check.table}"."`),
        `${check.constraint} does not qualify its columns`,
      );
    }
  });

  it("lists the schema's tables, which is what scopes the live catalog query", () => {
    const names = schemaTableNames();
    for (const table of [
      "oral_topics",
      "oral_exams",
      "oral_exam_phases",
      "oral_recordings",
      "evaluations",
    ]) {
      assert.ok(names.includes(table), `${table} is missing from the probe's scope`);
    }
  });
});

describe("the mirror tables", () => {
  it("builds one mirror per table that declares a check, and none for the rest", () => {
    const mirrors = constraintMirrors("t1");
    assert.deepEqual(mirrors.map((mirror) => mirror.table).sort(), [
      "evaluations",
      "oral_exam_phases",
      "oral_recordings",
    ]);
    for (const mirror of mirrors) {
      assert.equal(mirror.mirrorName, `verify_constraints_${mirror.table}_t1`);
      assert.ok(mirror.createSql.startsWith(`create table "${mirror.mirrorName}"`));
    }
  });

  it("carries only the columns the checks reference, at their declared types", () => {
    // The types are not a nicety: the bands are smallint, and Postgres prints
    // different casts into `pg_get_constraintdef` for a smallint comparison
    // than an integer one — a mirror typed loosely would report drift where
    // there is none. And nothing beyond the referenced columns may appear, or
    // the mirror grows dependencies (enums, jsonb) the probe does not need.
    const evaluations = constraintMirrors("t1").find((mirror) => mirror.table === "evaluations");
    assert.ok(evaluations);

    assert.ok(evaluations.createSql.includes(`"realisation_tache" smallint`));
    assert.ok(evaluations.createSql.includes(`"score_25" integer`));
    assert.ok(evaluations.createSql.includes(`"absence_penalty" integer`));
    for (const absent of ["exam_id", "feedback", "mode", "model", "created_at"]) {
      assert.ok(
        !evaluations.createSql.includes(`"${absent}"`),
        `"${absent}" is not referenced by any check and must not be mirrored`,
      );
    }
  });

  it("strips the table qualification, so the DDL names no table it is not", () => {
    for (const mirror of constraintMirrors("t1")) {
      assert.ok(
        !mirror.createSql.includes(`"${mirror.table}".`),
        `${mirror.mirrorName} still qualifies columns with "${mirror.table}"`,
      );
      // The constraints came through under their real names — that is what
      // lets the catalog rows be matched back up by (table, constraint).
      assert.ok(mirror.createSql.includes(`constraint "`));
    }
  });

  it("keeps the constraint names identical to the real ones", () => {
    const declared = declaredChecks();
    for (const mirror of constraintMirrors("t1")) {
      for (const check of declared.filter((entry) => entry.table === mirror.table)) {
        assert.ok(mirror.createSql.includes(`constraint "${check.constraint}" check (`));
      }
    }
  });

  it("refuses a suffix that is not a bare identifier", () => {
    // The suffix is written into DDL; anything else is a quoting bug waiting
    // for a caller creative enough to find it.
    assert.throws(() => constraintMirrors(`x"; drop table evaluations; --`));
    assert.throws(() => constraintMirrors(""));
    assert.doesNotThrow(() => constraintMirrors("1755791234567"));
  });
});

describe("the diff", () => {
  const constraint = (table: string, name: string, definition: string): LiveConstraint => ({
    table,
    constraint: name,
    definition,
  });

  it("reports nothing when the definitions agree", () => {
    const both = [constraint("evaluations", "evaluations_bands_check", "CHECK ((x = 1))")];
    assert.deepEqual(diffConstraintDefinitions(both, both), []);
  });

  it("names a constraint whose rule changed, quoting both sides", () => {
    // The #71 shape: same name, older arithmetic. The failure has to carry
    // both definitions, because "mismatch" alone is the useless half of the
    // message.
    const drift = diffConstraintDefinitions(
      [constraint("evaluations", "evaluations_score_25_check", "CHECK (new)")],
      [constraint("evaluations", "evaluations_score_25_check", "CHECK (old)")],
    );
    assert.deepEqual(drift, [
      {
        kind: "different",
        table: "evaluations",
        constraint: "evaluations_score_25_check",
        expected: "CHECK (new)",
        actual: "CHECK (old)",
      },
    ]);
  });

  it("names a declared constraint the database does not have", () => {
    const drift = diffConstraintDefinitions(
      [constraint("oral_recordings", "oral_recordings_duration_check", "CHECK (d >= 0)")],
      [],
    );
    assert.deepEqual(drift, [
      {
        kind: "missing",
        table: "oral_recordings",
        constraint: "oral_recordings_duration_check",
        expected: "CHECK (d >= 0)",
      },
    ]);
  });

  it("names a live constraint the schema never declared", () => {
    // Drift from the other side — a hand-added rule, or one a rollback left
    // behind. It decides row acceptance just as surely as a declared one.
    const drift = diffConstraintDefinitions(
      [],
      [constraint("evaluations", "evaluations_legacy_check", "CHECK (legacy)")],
    );
    assert.deepEqual(drift, [
      {
        kind: "undeclared",
        table: "evaluations",
        constraint: "evaluations_legacy_check",
        actual: "CHECK (legacy)",
      },
    ]);
  });

  it("matches by table AND name, so twins on different tables stay apart", () => {
    // Both phase and recording tables could plausibly carry a check named
    // alike; a diff keyed on the name alone would pair them across tables.
    const drift = diffConstraintDefinitions(
      [constraint("oral_exam_phases", "duration_check", "CHECK (a)")],
      [constraint("oral_recordings", "duration_check", "CHECK (a)")],
    );
    assert.deepEqual(drift.map((entry) => entry.kind).sort(), ["missing", "undeclared"]);
  });
});

describe("the probe, end to end against a fake database (#125)", () => {
  const SUFFIX = "probetest";

  /** The catalog rows a database whose constraints match the schema would
   *  return: one row per declared check off its mirror, one off its table. */
  function agreeingCatalog(definitionOf: (constraint: string) => string) {
    const mirrors = constraintMirrors(SUFFIX);
    const rows: Array<{ table_name: string; constraint_name: string; definition: string }> = [];
    for (const check of declaredChecks()) {
      const mirror = mirrors.find((entry) => entry.table === check.table);
      assert.ok(mirror);
      rows.push({
        table_name: mirror.mirrorName,
        constraint_name: check.constraint,
        definition: definitionOf(check.constraint),
      });
      rows.push({
        table_name: check.table,
        constraint_name: check.constraint,
        definition: definitionOf(check.constraint),
      });
    }
    return rows;
  }

  /** An executor that records every statement and answers the catalog query
   *  from a canned set of rows — the whole database, as the probe sees it. */
  function fakeDatabase(options: {
    catalog?: Array<{ table_name: string; constraint_name: string; definition: string }>;
    failCatalog?: Error;
    failDrops?: boolean;
    /** What the reaper's sweep finds already sitting in the schema. */
    leftovers?: string[];
  }) {
    const statements: string[] = [];
    const execute = async (statement: string) => {
      statements.push(statement);
      if (statement.startsWith("drop table") && options.failDrops) {
        throw new Error("drop refused");
      }
      if (statement.includes("like 'verify_constraints_%'")) {
        return (options.leftovers ?? []).map((relname) => ({ relname }));
      }
      if (statement.includes("pg_constraint")) {
        if (options.failCatalog) throw options.failCatalog;
        return options.catalog ?? [];
      }
      return [];
    };
    return { statements, execute };
  }

  it("creates the mirrors, reads once, drops them, and reports a clean database clean", async () => {
    const db = fakeDatabase({ catalog: agreeingCatalog((name) => `CHECK (${name})`) });

    const outcome = await probeConstraintDrift(db.execute, SUFFIX);

    assert.equal(outcome.declared, declaredChecks().length);
    assert.deepEqual(outcome.drift, []);

    // The statement trace is the contract: every mirror created before the one
    // catalog read, every mirror dropped after it.
    const creates = db.statements.filter((s) => s.startsWith("create table"));
    const drops = db.statements.filter((s) => s.startsWith("drop table if exists"));
    const catalogAt = db.statements.findIndex((s) => s.includes("pg_constraint"));
    assert.equal(creates.length, constraintMirrors(SUFFIX).length);
    assert.equal(drops.length, creates.length);
    assert.ok(db.statements.slice(0, catalogAt).every((s) => !s.startsWith("drop")));
    assert.ok(db.statements.slice(catalogAt + 1).every((s) => s.startsWith("drop")));
  });

  it("names a drifted rule, quoting the schema's side and the database's", async () => {
    // The #71 shape, staged: the mirror reports the schema's arithmetic, the
    // real table still carries the old one.
    const catalog = agreeingCatalog((name) => `CHECK (${name})`).map((row) =>
      row.table_name === "evaluations" && row.constraint_name === "evaluations_score_25_check"
        ? { ...row, definition: "CHECK (the old arithmetic)" }
        : row,
    );
    const db = fakeDatabase({ catalog });

    const outcome = await probeConstraintDrift(db.execute, SUFFIX);

    assert.deepEqual(outcome.drift, [
      {
        kind: "different",
        table: "evaluations",
        constraint: "evaluations_score_25_check",
        expected: "CHECK (evaluations_score_25_check)",
        actual: "CHECK (the old arithmetic)",
      },
    ]);
  });

  it("drops the mirrors even when the catalog read throws, and rethrows the read's error", async () => {
    const db = fakeDatabase({ failCatalog: new Error("catalog unavailable") });

    await assert.rejects(probeConstraintDrift(db.execute, SUFFIX), /catalog unavailable/);

    const drops = db.statements.filter((s) => s.startsWith("drop table if exists"));
    assert.equal(drops.length, constraintMirrors(SUFFIX).length, "no mirror was stranded");
  });

  it("lets a failed cleanup neither mask the probe's error nor fail a clean run", async () => {
    // A drop that fails after a failed read must not replace the error that
    // says what actually went wrong; after a clean read it must not turn a
    // healthy database into a red build over a stranded, inert mirror.
    const silent = { onCleanupFailure: () => undefined };
    const broken = fakeDatabase({ failCatalog: new Error("the real failure"), failDrops: true });
    await assert.rejects(probeConstraintDrift(broken.execute, SUFFIX, silent), /the real failure/);

    const clean = fakeDatabase({
      catalog: agreeingCatalog((name) => `CHECK (${name})`),
      failDrops: true,
    });
    const outcome = await probeConstraintDrift(clean.execute, SUFFIX, silent);
    assert.deepEqual(outcome.drift, []);
  });

  it("reports every drop it could not perform, instead of leaking mirrors silently", async () => {
    // Tolerated is not ignored: a database that refuses drops would strand one
    // inert mirror per run, and the only thing standing between that and
    // nobody ever knowing is this callback.
    const reported: string[] = [];
    const db = fakeDatabase({
      catalog: agreeingCatalog((name) => `CHECK (${name})`),
      failDrops: true,
    });

    const outcome = await probeConstraintDrift(db.execute, SUFFIX, {
      onCleanupFailure: (mirrorName) => reported.push(mirrorName),
    });

    assert.deepEqual(outcome.drift, [], "the failed cleanup did not fail the run");
    assert.deepEqual(
      reported.sort(),
      constraintMirrors(SUFFIX)
        .map((m) => m.mirrorName)
        .sort(),
    );
  });

  it("reaps a stale mirror from a killed run, and touches nothing fresh or strange", async () => {
    // A cancelled CI job dies without reaching its own cleanup, so its mirrors
    // outlive it. The next probe sweeps them by AGE — a concurrent run's fresh
    // mirrors and any name whose suffix does not parse as a timestamp are left
    // exactly where they are.
    const now = 10_000_000_000;
    const stale = `verify_constraints_evaluations_${now - 2 * 60 * 60 * 1000}`;
    const fresh = `verify_constraints_evaluations_${now - 60 * 1000}`;
    const strange = "verify_constraints_evaluations_notatimestamp";
    const db = fakeDatabase({
      catalog: agreeingCatalog((name) => `CHECK (${name})`),
      leftovers: [stale, fresh, strange],
    });

    await probeConstraintDrift(db.execute, SUFFIX, { now: () => now });

    const reaped = db.statements.filter(
      (s) => s.startsWith("drop table if exists") && !s.includes(SUFFIX),
    );
    assert.deepEqual(reaped, [`drop table if exists "${stale}"`]);
    // And the sweep runs before this run builds anything, so it can never
    // read its own mirrors as somebody else's leftovers.
    assert.ok(
      db.statements.findIndex((s) => s.includes("like 'verify_constraints_%'")) <
        db.statements.findIndex((s) => s.startsWith("create table")),
    );
  });

  it("reports a database with no mirrored rows as zero declared, for the caller to refuse", async () => {
    // The vacuous case: the catalog answers, but nothing in it is a mirror row
    // — the shape a broken CREATE or an over-filtered query would produce.
    // Refusing it is the caller's job (both scripts fail on declared === 0);
    // the probe's job is to report the zero rather than dress it as clean.
    const db = fakeDatabase({ catalog: [] });

    const outcome = await probeConstraintDrift(db.execute, SUFFIX);

    assert.equal(outcome.declared, 0);
    assert.deepEqual(outcome.drift, []);
  });
});
