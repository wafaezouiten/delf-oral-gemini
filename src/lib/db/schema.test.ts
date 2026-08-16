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

import { COMPETENCY_FLOOR, COMPETENCY_MAX } from "@/lib/delf/constants";
import { ORAL_CRITERIA } from "@/lib/delf/criteria";
import { GRILLE_BANDS } from "@/lib/delf/grille";
import { ORAL_PHASES } from "@/lib/delf/phases";
import { scoreSitting } from "@/lib/delf/orale-rubric";
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
 * `criteria.ts` / `grille.ts`. Until #9 the row that actually reached the INSERT
 * was built by a second rubric, so two tests here asserted that the two copies
 * agreed about the criteria, the bands and the floor. There is one rubric now,
 * and the question those tests were really asking is better asked directly:
 * can the rubric produce a row this table would reject?
 *
 * Every constraint on `evaluations` is checked against the rubric's own output,
 * including from inputs a model should never send. A failure here is a 500 on a
 * candidate's finish request, after the paid call, inside a catch that only
 * logs — which is the least visible place in the system for a rule to break.
 */
test("no correction the rubric can produce violates the constraints on the row", () => {
  const durations = [
    { monologueSeconds: 400, debateSeconds: 700 }, // a full sitting
    { monologueSeconds: 0, debateSeconds: 0 }, // nothing recorded
    { monologueSeconds: 400, debateSeconds: 10 }, // one half short
  ];
  // Legal bands, the illegal 2 and 4 the prompt forbids, and the out-of-range
  // numbers a model has no business emitting at all.
  const scores = [0, 1, 2, 3, 4, 5, 4.5, -1, 99];
  // Both correction modes: the unheard one caps « phonologie », which is another
  // path by which a band reaches the column and therefore another path by which
  // an illegal one could (#29).
  const heard = [true, false];

  for (const raw of scores) {
    for (const duration of durations) {
      for (const phonologyHeard of heard) {
      const scored = scoreSitting(
        Object.fromEntries(ORAL_CRITERIA.map((criterion) => [criterion, raw])) as Record<
          (typeof ORAL_CRITERIA)[number],
          number
        >,
        { ...duration, phonologyHeard },
      );

      for (const criterion of ORAL_CRITERIA) {
        assert.ok(
          (GRILLE_BANDS as readonly number[]).includes(scored.criteria[criterion]),
          `evaluations_bands_check: ${criterion} = ${scored.criteria[criterion]} from ${raw}`,
        );
      }
      // evaluations_score_range_check
      assert.ok(scored.rawScore25 >= 0 && scored.rawScore25 <= COMPETENCY_MAX);
      assert.ok(scored.score25 >= 0 && scored.score25 <= COMPETENCY_MAX);
      assert.ok(scored.durationPenalty >= 0);
      // evaluations_score_25_check, written exactly as the SQL states it.
      assert.equal(
        scored.score25,
        Math.max(scored.rawScore25 - scored.durationPenalty, 0),
        `evaluations_score_25_check with ${JSON.stringify(scored)}`,
      );
      // `meets_floor` has no constraint tying it back to `score_25`, so it is
      // pinned here instead — against the same constant the column documents.
      assert.equal(scored.meetsFloor, scored.score25 >= COMPETENCY_FLOOR);
      }
    }
  }
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

test("a recording belongs to one speaking phase, and only one row can claim it", () => {
  // The Phase 6 invariant, in the database rather than in the route: the
  // candidate speaks twice against two different duration floors, so an
  // untagged artefact cannot answer "which half ran short?", and two rows for
  // the same half cannot answer it either.
  const columns = columnsByName(oralRecordings);
  const phase = columns.get("phase");
  assert.ok(phase, "a recording says which task it is");
  assert.equal(phase.notNull, true);
  assert.equal(phase.getSQLType(), oralSpeakingPhase.enumName);

  const unique = getTableConfig(oralRecordings).indexes.find((index) => index.config.unique);
  assert.deepEqual(
    unique?.config.columns.map((column) => ("name" in column ? column.name : undefined)),
    ["exam_id", "phase"],
    "at most one recording per (sitting, phase)",
  );
});

test("the sitting keeps its transcript and its topic", () => {
  const columns = columnsByName(oralExams);
  assert.equal(columns.get("transcript")?.getSQLType(), "jsonb");
  assert.equal(columns.get("topic_id")?.notNull, true);
  assert.ok(columnsByName(oralTopics).get("slug"));
});
