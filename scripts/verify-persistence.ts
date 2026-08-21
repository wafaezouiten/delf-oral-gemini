/**
 * Verify the Phase 8 persistence path against a REAL Neon database.
 *
 * `sitting-persistence.test.ts` proves the orchestration — the order things
 * happen in, what a second submission costs — against an in-memory store. What
 * it cannot prove is that `db/sittings.ts` expresses those same conditions in
 * SQL, because the conditions are the SQL: a jsonb append that must not
 * duplicate, an enum comparison that makes a replayed request a no-op, a
 * `not exists` that decides who may write the correction, and a `batch()` that
 * either commits three tables or none.
 *
 * So this script runs the round trip for real:
 *
 *   create → append the monologue → append it again → append the débat
 *          → correct → correct again → read back → start over → clean up
 *
 * It writes to whatever `DATABASE_URL` points at, under a synthetic user id, and
 * deletes everything it wrote in a `finally`. Point it at a development branch,
 * not at production.
 *
 *   pnpm verify:db
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { eq, sql } from "drizzle-orm";

import { getDb, isDatabaseConfigured } from "../src/lib/db";
import { archiveCandidateRecord } from "../src/lib/db/account";
import {
  constraintMirrors,
  diffConstraintDefinitions,
  schemaTableNames,
  type LiveConstraint,
} from "../src/lib/db/constraint-drift";
import { readCandidateHistory } from "../src/lib/db/history";
import { oralExams, oralTopics } from "../src/lib/db/schema";
import { archivePreparationExit, neonSittingStore } from "../src/lib/db/sittings";
import { ORAL_CRITERIA } from "../src/lib/delf/criteria";
import { ORAL_TOPICS } from "../src/lib/delf/topics";
import { correctSitting, type CorrectionRow } from "../src/lib/exams/sitting-persistence";
import { scoreSitting } from "../src/lib/delf/orale-rubric";
import type { TranscriptEntry } from "../src/lib/delf/transcript";

if (!isDatabaseConfigured()) {
  console.error("DATABASE_URL is not set. Add your Neon connection string to .env.local.");
  process.exit(1);
}

/** Unmistakably not a real candidate, so a stray row is obvious in the table. */
const USER = `verify_${Date.now()}`;
const TOPIC = ORAL_TOPICS[0];

const bands = Object.fromEntries(ORAL_CRITERIA.map((c) => [c, 3])) as CorrectionRow["criteria"];

/**
 * The row this script writes, and deliberately NOT the boring one.
 *
 * A 90-second monologue followed by an abandoned débat: halved for the part
 * that never happened, then docked 3 for the part that ran short. 15 → 7 → 4 —
 * an `absence_penalty` of 8 and a `duration_penalty` of 3, both non-zero at
 * once, which is the only shape that exercises the constraint as a sum.
 *
 * The earlier fixture hard-coded a clean `15/15` with both penalties at 0, and
 * that number is why this script once passed against a database whose
 * `evaluations_score_25_check` was still the single-penalty version: a row with
 * no penalties satisfies the old constraint and the new one identically, so the
 * round trip could not tell them apart. It found out in production instead,
 * when the first candidate to skip the débat had their correction refused by
 * the constraint and lost.
 *
 * Produced by `scoreSitting` rather than written out by hand, so the numbers
 * are ones the rubric can actually emit and cannot drift from it.
 */
const scored = scoreSitting(bands, {
  monologueSeconds: 90,
  debateSeconds: 0,
  monologueWords: 120,
  debateWords: 0,
  phonologyHeard: true,
  // False on purpose: excusing the débat would zero the absence penalty, and a
  // fixture with a penalty at zero is exactly the shape this probe exists to
  // avoid (see the header above).
  examinerClosedEarly: false,
});

const correction: CorrectionRow = {
  mode: "audio",
  criteria: scored.criteria,
  rawScore25: scored.rawScore25,
  absencePenalty: scored.absencePenalty,
  durationPenalty: scored.durationPenalty,
  score25: scored.score25,
  meetsFloor: scored.meetsFloor,
  feedback: {
    justifications: Object.fromEntries(
      ORAL_CRITERIA.map((c) => [c, `${c} : vérification`]),
    ) as CorrectionRow["feedback"]["justifications"],
    appreciationGlobale: "Vérification de la persistance.",
    pointsForts: ["Plan clair"],
    axesPrioritaires: ["Rien"],
    conseil: "Rien à conseiller, ceci est un test.",
    phonologieNonEvaluable: false,
  },
  model: "verify-script",
  promptVersion: "verify",
  latencySeconds: 0.1,
};

const turn = (phase: "monologue" | "debate", text: string, at: number): TranscriptEntry => ({
  phase,
  speaker: "candidate",
  timestamp: at,
  text,
});

const MONOLOGUE = [turn("monologue", "Voici mon exposé.", 1_000)];
const DEBATE = [turn("debate", "Je maintiens ma position.", 500_000)];

let failures = 0;
function check(what: string, ok: boolean, detail?: unknown): void {
  console.log(
    `${ok ? "  ok  " : "  FAIL"}  ${what}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
  );
  if (!ok) failures += 1;
}

/**
 * The push-vs-migrate footgun, checked structurally (#77).
 *
 * `drizzle-kit push` applies a new column and silently leaves CHECK constraints
 * at whatever the database already had; the WARNING in `schema.ts` records the
 * sitting that lesson cost. A comment only guards people who read it, so this
 * compares every live `pg_get_constraintdef` against what the schema declares
 * and fails loudly on any difference — from push, from a hand edit, from any
 * cause at all.
 *
 * The mechanics (and why nothing here parses SQL) live in
 * `src/lib/db/constraint-drift.ts`: short-lived mirror tables carry the
 * schema's constraints into the SAME database, so both sides of the comparison
 * come out of the same server's normaliser and bare string equality is the
 * whole test. Runs first, before the round trip below — when a constraint has
 * drifted, the write failures further down are symptoms, and this is the line
 * that names their cause.
 */
async function verifyConstraints(db: ReturnType<typeof getDb>): Promise<void> {
  console.log("constraints");
  const mirrors = constraintMirrors(`${Date.now()}`);
  try {
    for (const mirror of mirrors) await db.execute(sql.raw(mirror.createSql));

    const names = [...schemaTableNames(), ...mirrors.map((mirror) => mirror.mirrorName)];
    const result = await db.execute(sql`
      select rel.relname as table_name,
             con.conname as constraint_name,
             pg_get_constraintdef(con.oid) as definition
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      where con.contype = 'c'
        and nsp.nspname = current_schema()
        and rel.relname in (${sql.join(
          names.map((name) => sql`${name}`),
          sql`, `,
        )})
    `);
    const rows = result.rows as Array<{
      table_name: string;
      constraint_name: string;
      definition: string;
    }>;

    // The mirrors' rows are the expectation, mapped back to the tables they
    // mirror; the schema tables' own rows are what the database actually holds.
    const mirroredTable = new Map(mirrors.map((mirror) => [mirror.mirrorName, mirror.table]));
    const expected: LiveConstraint[] = [];
    const live: LiveConstraint[] = [];
    for (const row of rows) {
      const constraint = {
        constraint: row.constraint_name,
        definition: row.definition,
      };
      const table = mirroredTable.get(row.table_name);
      if (table !== undefined) expected.push({ ...constraint, table });
      else live.push({ ...constraint, table: row.table_name });
    }

    // Guards the probe against itself: a refactor that stopped the mirrors
    // being created would otherwise report a database with no declared checks
    // as clean, which is the comment-shaped failure this section replaces.
    check("the schema declares checks for the probe to hold", expected.length > 0, {
      declared: expected.length,
    });

    const drift = diffConstraintDefinitions(expected, live);
    check(
      "every live CHECK matches the schema, word for word",
      drift.length === 0,
      drift.length > 0 ? drift : { constraints: expected.length },
    );
  } finally {
    for (const mirror of mirrors) {
      await db.execute(sql.raw(`drop table if exists "${mirror.mirrorName}"`));
    }
  }
}

async function main(): Promise<number> {
  const db = getDb();
  const store = neonSittingStore();

  await verifyConstraints(db);

  // The catalogue row the sitting has to reference, upserted the way
  // `POST /api/exams` does it.
  const existingTopic = await db
    .select({ id: oralTopics.id })
    .from(oralTopics)
    .where(eq(oralTopics.slug, TOPIC.slug))
    .limit(1);
  const topicId =
    existingTopic[0]?.id ??
    (
      await db
        .insert(oralTopics)
        .values({
          slug: TOPIC.slug,
          title: TOPIC.title,
          document: TOPIC.document,
          consigne: TOPIC.consigne,
        })
        .returning({ id: oralTopics.id })
    )[0].id;

  const [created] = await db
    .insert(oralExams)
    .values({ userId: USER, topicId, phase: "preparation" })
    .returning({ id: oralExams.id });

  const ref = { examId: created.id, userId: USER };
  console.log(`\nsitting ${ref.examId}, user ${USER}\n`);

  try {
    console.log("append");
    check(
      "a phase that skips the one before it is refused",
      (await store.appendFinalisedPhase(ref, {
        phase: "debate",
        entries: DEBATE,
        startedAt: new Date(),
        endedAt: new Date(),
      })) === false,
    );

    check(
      "the monologue is recorded",
      await store.appendFinalisedPhase(ref, {
        phase: "monologue",
        entries: MONOLOGUE,
        startedAt: new Date(Date.now() - 900_000),
        endedAt: new Date(Date.now() - 500_000),
      }),
    );

    check(
      "a replayed monologue writes nothing",
      (await store.appendFinalisedPhase(ref, {
        phase: "monologue",
        entries: MONOLOGUE,
        startedAt: new Date(),
        endedAt: new Date(),
      })) === false,
    );

    check(
      "the débat is recorded",
      await store.appendFinalisedPhase(ref, {
        phase: "debate",
        entries: DEBATE,
        startedAt: new Date(Date.now() - 500_000),
        endedAt: new Date(),
      }),
    );

    const midway = await store.readSitting(ref);
    check("the transcript was appended once, not twice", midway?.transcript.length === 2, {
      turns: midway?.transcript.length,
    });
    check("an unsubmitted sitting reads as in progress", midway?.outcome === "in-progress", {
      outcome: midway?.outcome,
    });

    console.log("\ncorrect");
    let graded = 0;
    const input = {
      transcript: [...MONOLOGUE, ...DEBATE],
      reconnectCount: 1,
      // Non-zero so the round trip proves the column takes a value, not just
      // its default — a probe that writes 0 over DEFAULT 0 verifies nothing.
      earlyClosingCount: 2,
      phases: [
        {
          phase: "monologue" as const,
          startedAt: Date.now() - 900_000,
          endedAt: Date.now() - 500_000,
        },
        { phase: "debate" as const, startedAt: Date.now() - 500_000, endedAt: Date.now() },
      ],
      recordings: [
        {
          phase: "monologue" as const,
          mimeType: "audio/ogg",
          byteSize: 210_000,
          durationSeconds: 402.6,
        },
        {
          phase: "debate" as const,
          mimeType: "audio/ogg",
          byteSize: 640_000,
          durationSeconds: 761.2,
        },
      ],
      evaluate: async () => {
        graded += 1;
        return correction;
      },
      now: () => new Date(),
    };

    const first = await correctSitting(store, ref, input);
    check("the correction is stored", first.status === "stored", { status: first.status });

    const second = await correctSitting(store, ref, input);
    check("finishing twice is a no-op", second.status === "already-corrected", {
      status: second.status,
    });
    check("and the second one never graded", graded === 1, { graded });

    console.log("\nread back");
    const stored = await store.readSitting(ref);
    check("the sitting reads as corrected", stored?.outcome === "corrected", {
      outcome: stored?.outcome,
    });
    check("both phases came back", stored?.phases.length === 2, { phases: stored?.phases.length });
    check(
      "with the MEASURED speaking time, not the clock",
      stored?.phases.find((p) => p.phase === "monologue")?.spokenSeconds === 403,
      { spokenSeconds: stored?.phases.find((p) => p.phase === "monologue")?.spokenSeconds },
    );
    check(
      "the phase stamps from the progress route survived the upsert",
      stored?.phases.every((p) => p.startedAt !== null && p.endedAt !== null) ?? false,
    );
    check("both recordings came back", stored?.recordings.length === 2);
    check(
      "recorded as disposed of, with no uri",
      stored?.recordings.every((r) => r.uri === null && r.deletedAt !== null) ?? false,
    );
    check("the correction came back whole", stored?.correction?.score25 === scored.score25, {
      score25: stored?.correction?.score25,
      expected: scored.score25,
    });
    // The two penalty columns, separately. Checking only `score_25` would pass
    // a row that stored the whole 10 points as a duration penalty, which is a
    // correction nobody can explain — and the reason `absence_penalty` is its
    // own column rather than more of the other one.
    check(
      "with both penalties, each under its own name",
      stored?.correction?.absencePenalty === scored.absencePenalty &&
        stored?.correction?.durationPenalty === scored.durationPenalty,
      {
        absencePenalty: stored?.correction?.absencePenalty,
        durationPenalty: stored?.correction?.durationPenalty,
        expected: { absence: scored.absencePenalty, duration: scored.durationPenalty },
      },
    );
    check(
      "with its five bands intact",
      ORAL_CRITERIA.every((c) => stored?.correction?.criteria[c] === 3),
    );
    check("the transcript is the complete one", stored?.transcript.length === 2);
    check("the reconnect count was stored", stored?.reconnectCount === 1);
    check("the early-closing count was stored", stored?.earlyClosingCount === 2);

    console.log("\nownership");
    const intruder = { examId: ref.examId, userId: "verify_intruder" };
    check("a stranger reads nothing", (await store.readSitting(intruder)) === null);
    check("a stranger finds no correction", (await store.findCorrection(intruder)) === null);
    check(
      "a stranger cannot claim it",
      (await store.claimForCorrection(intruder, {
        transcript: [],
        reconnectCount: 99,
        earlyClosingCount: 99,
        finishedAt: new Date(),
      })) === false,
    );
    check(
      "a stranger cannot append to it",
      (await store.appendFinalisedPhase(intruder, {
        phase: "debate",
        entries: DEBATE,
        startedAt: new Date(),
        endedAt: new Date(),
      })) === false,
    );

    const after = await store.readSitting(ref);
    check(
      "and nothing they did left a mark",
      after?.reconnectCount === 1 && after?.transcript.length === 2,
    );

    /**
     * Leaving the préparation (#113).
     *
     * Two clauses are worth a live probe here, because each is a boundary the
     * unit tests cannot see. `archivePreparationExit`'s `phase = 'preparation'`
     * is what keeps a quit from touching a sitting whose épreuve has moved on;
     * and `abandonSitting`'s deliberate LACK of the mirror clause is what keeps
     * a mid-monologue walk-out recordable at all — the row still reads
     * `preparation` until the monologue's progress report lands, so a phase
     * guard on the abandon would refuse a real walk-out.
     */
    console.log("\nleaving the préparation");
    const [prep] = await db
      .insert(oralExams)
      .values({ userId: USER, topicId, phase: "preparation" })
      .returning({ id: oralExams.id });
    const prepRef = { examId: prep.id, userId: USER };

    check(
      "a stranger cannot archive it",
      (await archivePreparationExit({ examId: prep.id, userId: "verify_intruder" }, new Date())) ===
        false,
    );
    check(
      "leaving during the préparation archives the sitting",
      await archivePreparationExit(prepRef, new Date()),
    );
    check(
      "a second leave writes nothing",
      (await archivePreparationExit(prepRef, new Date())) === false,
    );
    check(
      "and the sitting reaches no record, not even the archive",
      (await readCandidateHistory(USER, { includeArchived: true })).every(
        (s) => s.examId !== prep.id,
      ),
    );
    check(
      "a sitting past the préparation is not archivable this way",
      (await archivePreparationExit(ref, new Date())) === false,
    );
    // The guard's mirror: a walk-out racing the exit — the dialog confirmed as
    // the clock expired, the abandon sent from the screen that replaced it —
    // must not stamp a zero onto a sitting the candidate was just told would
    // never appear. This is `abandonSitting`'s `archived_at is null` clause,
    // which #113 made newly reachable: it is the first archive on a live row.
    check(
      "an archived préparation cannot be walked out of afterwards",
      (await store.abandonSitting(prepRef, new Date())) === false,
    );

    // A walk-out stamped while the row still reads `preparation` — which is
    // every mid-monologue walk-out there is. This is the row the abandon's
    // missing phase clause exists for.
    const [midMonologue] = await db
      .insert(oralExams)
      .values({ userId: USER, topicId, phase: "preparation" })
      .returning({ id: oralExams.id });
    check(
      "a walk-out lands while the row still reads préparation",
      await store.abandonSitting({ examId: midMonologue.id, userId: USER }, new Date()),
    );
    check(
      "and a walked-out sitting keeps its filing against a préparation exit",
      (await archivePreparationExit({ examId: midMonologue.id, userId: USER }, new Date())) ===
        false,
    );
    // Deleted rather than left: it is a real walk-out, and the next section
    // counts the record it would otherwise join.
    await db.delete(oralExams).where(eq(oralExams.id, midMonologue.id));

    /**
     * Starting over (#69).
     *
     * Here rather than in a unit test for the reason the whole script exists:
     * what `archiveCandidateRecord` promises is a WHERE clause, and the clause
     * IS the behaviour. In particular the one that is easy to get wrong and
     * impossible to notice — "everything on the record" is not "every row of
     * this candidate's", and a reset that archives a sitting still in progress
     * loses the épreuve the candidate sits *after* pressing the button.
     *
     * So the record gets one more of each kind first: a walk-out, which must be
     * archived, and an untouched sitting, which must not.
     */
    console.log("\nstarting over");
    const [walkedOut] = await db
      .insert(oralExams)
      .values({ userId: USER, topicId, phase: "monologue", abandonedAt: new Date() })
      .returning({ id: oralExams.id });
    const [running] = await db
      .insert(oralExams)
      .values({ userId: USER, topicId, phase: "preparation" })
      .returning({ id: oralExams.id });

    const before = await readCandidateHistory(USER);
    check("the record holds the corrected sitting and the walk-out", before.length === 2, {
      sittings: before.length,
    });

    const moved = await archiveCandidateRecord(USER, new Date());
    check("both of them are archived, and only them", moved === 2, { archived: moved });

    const stillRunning = await db
      .select({ archivedAt: oralExams.archivedAt })
      .from(oralExams)
      .where(eq(oralExams.id, running.id));
    check(
      "a sitting still in progress is left on the new record",
      stillRunning[0]?.archivedAt === null,
      { archivedAt: stillRunning[0]?.archivedAt },
    );

    check("the record now reads empty", (await readCandidateHistory(USER)).length === 0);

    const archive = await readCandidateHistory(USER, { includeArchived: true });
    check("and the archive still has both, stamped", archive.length === 2, {
      sittings: archive.length,
    });
    check(
      "including the walk-out, still scored zero",
      archive.some((s) => s.examId === walkedOut.id && s.score25 === 0 && s.archivedAt !== null),
    );
    check(
      "and the correction, which nothing deleted",
      archive.some((s) => s.examId === ref.examId && s.score25 === scored.score25),
    );

    check("a second reset moves nothing", (await archiveCandidateRecord(USER, new Date())) === 0);
    check(
      "and a stranger's reset never reaches these rows",
      (await archiveCandidateRecord("verify_intruder", new Date())) === 0,
    );
  } finally {
    // Cascades to phases, recordings and evaluations (`onDelete: "cascade"`).
    await db.delete(oralExams).where(eq(oralExams.userId, USER));
    console.log(`\ncleaned up sitting ${ref.examId}`);
  }

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
