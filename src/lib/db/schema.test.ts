/**
 * Schema-level tests.
 *
 * These assert the one property the schema cannot enforce on its own: that it
 * still agrees with the Phase 1 DELF layer. The columns are checked against
 * `ORAL_CRITERIA`, the enums against `ORAL_PHASES` — so a rename or an added
 * criterion in `lib/delf/` fails here rather than at the first INSERT against a
 * migrated database.
 *
 * No database is involved: Drizzle's table metadata is read directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import { ORAL_CRITERIA } from "@/lib/delf/criteria";
import { GRILLE_BANDS } from "@/lib/delf/grille";
import { ORAL_PHASES } from "@/lib/delf/phases";
import {
  GRILLE_BANDS as RUBRIC_BANDS,
  ORAL_CRITERIA as RUBRIC_CRITERIA,
} from "@/lib/delf/rubric";
import {
  evaluationMode,
  evaluations,
  oralExamPhases,
  oralExams,
  oralPhase,
  oralRecordings,
  oralSpeakingPhase,
  oralTopics,
} from "./schema";

const evaluationsConfig = getTableConfig(evaluations);
const examsConfig = getTableConfig(oralExams);
const phasesConfig = getTableConfig(oralExamPhases);

/** Column names of a table, keyed by the TypeScript property name. */
function columnsByName(table: Parameters<typeof getTableConfig>[0]) {
  return new Map(getTableConfig(table).columns.map((column) => [column.name, column]));
}

/**
 * The schema's `satisfies Record<OralCriterion, …>` is anchored to the ported
 * `criteria.ts` / `grille.ts`, because those are the modules the audit makes
 * canonical and the ones that survive the reconciliation in #9. The row that
 * actually reaches the INSERT, though, is built by `rubric.ts` — `evaluate.ts`
 * types `EvaluationResult.criteria` with its `CriteriaScores`, and the route
 * spreads that straight into `.values()`.
 *
 * So the compile-time net only covers the write path for as long as the two
 * agree. This asserts that they do. When #9 deletes `rubric.ts`, this test stops
 * compiling — which is the right way to find out.
 */
test("the ported criteria and the ones that build the row are the same five", () => {
  assert.deepEqual([...RUBRIC_CRITERIA], [...ORAL_CRITERIA]);
  assert.deepEqual([...RUBRIC_BANDS], [...GRILLE_BANDS]);
});

test("the phase enum mirrors the exam state machine", () => {
  assert.deepEqual([...oralPhase.enumValues], [...ORAL_PHASES]);
});

test("the speaking-phase enum is the graded subset of the state machine", () => {
  assert.deepEqual([...oralSpeakingPhase.enumValues], ["monologue", "debate"]);
  for (const phase of oralSpeakingPhase.enumValues) {
    assert.ok(ORAL_PHASES.includes(phase), `${phase} is not a phase of the exam`);
  }
});

test("the evaluation mode enum is the experiment's two arms", () => {
  assert.deepEqual([...evaluationMode.enumValues], ["text", "audio"]);
});

test("the correction carries exactly the five grille criteria", () => {
  const expected = ORAL_CRITERIA.map((criterion) =>
    criterion.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
  );
  const present = evaluationsConfig.columns
    .map((column) => column.name)
    .filter((name) => expected.includes(name));

  assert.deepEqual(present, expected);
  assert.equal(present.length, 5);
});

test("every criterion column is a required 0/1/3/5 band", () => {
  assert.deepEqual([...GRILLE_BANDS], [0, 1, 3, 5]);

  const columns = columnsByName(evaluations);
  for (const criterion of ORAL_CRITERIA) {
    const name = criterion.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    const column = columns.get(name);
    assert.ok(column, `${name} is missing`);
    assert.equal(column.notNull, true, `${name} must be NOT NULL`);
    assert.equal(column.getSQLType(), "smallint", `${name} must be a smallint`);
  }

  // The legal bands are enforced by the database, not only by `snapToBand`.
  const bandCheck = evaluationsConfig.checks.find(
    (constraint) => constraint.name === "evaluations_bands_check",
  );
  assert.ok(bandCheck, "the band constraint is missing");
});

test("the correction stores the whole rubric outcome, not just the mark", () => {
  const columns = columnsByName(evaluations);
  for (const name of ["raw_score_25", "duration_penalty", "score_25", "meets_floor"]) {
    const column = columns.get(name);
    assert.ok(column, `${name} is missing`);
    assert.equal(column.notNull, true, `${name} must be NOT NULL`);
  }

  const names = evaluationsConfig.checks.map((constraint) => constraint.name);
  assert.ok(names.includes("evaluations_score_25_check"));
  assert.ok(names.includes("evaluations_score_range_check"));
});

test("a sitting holds many corrections and many recordings", () => {
  const examId = columnsByName(evaluations).get("exam_id");
  assert.ok(examId);
  assert.equal(examId.notNull, true);
  // Not unique: the experiment scores the same sitting repeatedly, in two modes.
  assert.equal(
    evaluationsConfig.indexes.some((index) => index.config.unique),
    false,
  );

  const recordingId = columnsByName(evaluations).get("recording_id");
  assert.ok(recordingId);
  assert.equal(recordingId.notNull, false, "a text-mode correction has no recording");
});

test("a sitting has at most one row per speaking phase", () => {
  const unique = phasesConfig.indexes.find((index) => index.config.unique);
  assert.ok(unique, "the (exam, phase) unique index is missing");
  assert.deepEqual(
    unique.config.columns.map((column) => ("name" in column ? column.name : "")),
    ["exam_id", "phase"],
  );
});

test("per-phase durations live on the phase, never on the sitting", () => {
  const phaseColumns = columnsByName(oralExamPhases);
  assert.ok(phaseColumns.get("spoken_seconds"));

  for (const name of examsConfig.columns.map((column) => column.name)) {
    assert.ok(
      !/^(monologue|debate)_/.test(name),
      `oral_exams.${name} duplicates what oral_exam_phases already stores`,
    );
  }
});

test("the recording row can outlive the recording", () => {
  const columns = columnsByName(oralRecordings);
  const uri = columns.get("uri");
  assert.ok(uri);
  assert.equal(uri.notNull, false, "retention is forbidden: a recording may have no URI");
  assert.ok(columns.get("deleted_at"));
});

test("the sitting keeps its transcript and its topic", () => {
  const columns = columnsByName(oralExams);
  assert.equal(columns.get("transcript")?.getSQLType(), "jsonb");
  assert.equal(columns.get("topic_id")?.notNull, true);
  assert.ok(columnsByName(oralTopics).get("slug"));
});
