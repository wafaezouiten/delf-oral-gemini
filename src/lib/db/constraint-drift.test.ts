import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  constraintMirrors,
  declaredChecks,
  diffConstraintDefinitions,
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
