/**
 * Database schema — one DELF B2 production orale sitting, end to end.
 *
 * Five tables, and no more: the subject, the sitting, its two speaking phases,
 * the recording it produced, and the corrections that graded it. Nothing here
 * serves billing, an admin console or a scraped catalogue, all of which the
 * reproduction audit marks "Drop" (§01).
 *
 * The five decisions worth recording, because each one is a departure from
 * something:
 *
 *  - **Corrections are their own table, keyed by `mode`.** The incumbent stores
 *    one correction inline as a jsonb column on the attempt. The entire premise
 *    of this project is comparing an audio-graded score against a text-graded
 *    score for the SAME performance, and repeatedly (§10, step 13: "never
 *    compare single runs"), so one sitting must carry many evaluations.
 *  - **The five criteria are five columns, not a jsonb blob.** They are a closed
 *    set fixed by the official grille, each on the discrete 0/1/3/5 band scale.
 *    As columns the database can enforce the legal bands, and the comparison
 *    memo can ask for a per-criterion distribution without digging through json.
 *    `satisfies Record<OralCriterion, …>` below makes the compiler reject any
 *    drift between these columns and the Phase 1 rubric.
 *  - **The phases are rows, not column pairs.** The audit's sketch put
 *    `monologue_seconds` / `debate_seconds` on the sitting, for the right reason:
 *    one duration integer cannot say which half the candidate ran short on. But
 *    each phase also has a start, an end and (later) its own artefacts, and four
 *    more `monologue_*` / `debate_*` column pairs on the sitting is exactly the
 *    duplication a row removes.
 *  - **The transcript stays a jsonb column.** It is written once when the exam
 *    ends and read whole, and its entries already carry their own phase tag
 *    (`TranscriptEntry.phase`). A row-per-turn table would buy queries nobody
 *    runs, cost a join on every read, and store the phase twice.
 *  - **Starting over is a stamp, not a delete.** A candidate who resets their
 *    record (#69) archives it: `oral_exams.archived_at` takes the sittings out
 *    of the figures and leaves every row, correction and recording exactly where
 *    it was. Nothing in this schema deletes a sitting, and the one product
 *    feature that sounds like it does not either.
 *
 * This schema deliberately did not decide which of the two rubric
 * implementations on `develop` won: it stores the five bands, the pre-penalty
 * total, the penalty in points and the floor verdict, every one of which both
 * could produce. #9 settled it in the evaluation layer, where it belonged —
 * `lib/delf/orale-rubric.ts` survives, `rubric.ts` is deleted, and the row is
 * now written from one `scoreSitting` call.
 */

import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import type { OralCriterion } from "@/lib/delf/criteria";
import type { GrilleBand } from "@/lib/delf/grille";
import type { TranscriptEntry } from "@/lib/delf/transcript";

// =====================================================
// ENUMS
// =====================================================

/**
 * The exam state machine's four phases, in order (`lib/delf/phases.ts`).
 *
 * A Postgres enum rather than a varchar: the set is closed, one-way and already
 * defined in code, so a typo'd phase should fail at the INSERT rather than at
 * whatever later reads it. `schema.test.ts` asserts these values stay identical
 * to `ORAL_PHASES` — the enum is a mirror of the machine, never a second opinion.
 */
export const oralPhase = pgEnum("oral_phase", ["preparation", "monologue", "debate", "finished"]);

/**
 * The two phases the candidate actually speaks in, and therefore the only two
 * that are graded. `preparation` is silent and `finished` is terminal, so
 * neither can own a row in `oral_exam_phases`. Matches `TranscriptPhase`.
 */
export const oralSpeakingPhase = pgEnum("oral_speaking_phase", ["monologue", "debate"]);

/**
 * The experiment's independent variable: `text` grades the transcript alone,
 * `audio` grades the transcript plus the candidate's actual recording.
 */
export const evaluationMode = pgEnum("evaluation_mode", ["text", "audio"]);

/** `text` | `audio`. Owned here so the evaluator and the column cannot drift. */
export type EvaluationMode = (typeof evaluationMode.enumValues)[number];

/** Which speaking phase a row belongs to. */
export type OralSpeakingPhase = (typeof oralSpeakingPhase.enumValues)[number];

// =====================================================
// SUBJECT
// =====================================================

/** The subject catalogue, seeded from `lib/delf/topics.ts`. */
export const oralTopics = pgTable("oral_topics", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 128 }).notNull().unique(),
  title: text("title").notNull(),
  document: text("document").notNull(),
  consigne: text("consigne").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// =====================================================
// SITTING
// =====================================================

/**
 * One attempt at the épreuve.
 *
 * `phase` is persisted so a candidate who closes the tab mid-exam has a record
 * of how far they got, and so an abandoned attempt is distinguishable from a
 * completed one in the dashboard.
 */
export const oralExams = pgTable(
  "oral_exams",
  {
    id: serial("id").primaryKey(),
    /** Clerk user id. Not a foreign key: Clerk owns the user, we only reference it. */
    userId: varchar("user_id", { length: 255 }).notNull(),
    topicId: integer("topic_id")
      .notNull()
      .references(() => oralTopics.id, { onDelete: "restrict" }),

    /** Where the state machine stopped. Transitions are one-way. */
    phase: oralPhase("phase").notNull().default("preparation"),

    /**
     * Which Live model played the examiner (#99) — the counterpart of
     * `evaluations.model`, which names the corrector. Stamped with the build's
     * default when the sitting is created, and overwritten if the candidate
     * picks another during the préparation; the token route reads it on every
     * mint, INCLUDING every reconnect, which is what stops a dropped connection
     * from switching examiners mid-débat.
     *
     * Nullable, and null is a statement about time rather than a default: rows
     * written before this column existed genuinely do not record which examiner
     * spoke, and backfilling today's default onto them would be a guess wearing
     * a provenance column. Same length as `evaluations.model`, same reason.
     */
    examinerModel: varchar("examiner_model", { length: 64 }),

    /** Phase-tagged and written once, at the end. See the header note. */
    transcript: jsonb("transcript").$type<TranscriptEntry[]>(),

    /**
     * How many times the Live connection was re-established during the sitting.
     * Sitting-level rather than per-phase because that is the only granularity
     * the controller actually counts (`ExamController.reconnectCount`), and a
     * per-phase column would be a number nobody can honestly fill in.
     */
    reconnectCount: integer("reconnect_count").notNull().default(0),

    /**
     * How many times the examiner tried to end the épreuve early — a goodbye
     * heard mid-débat, outside any closing handshake the app opened (#92).
     *
     * The same shape as `reconnect_count`, deliberately and for the same
     * reason: a reliability fact about the sitting, counted by the controller
     * (`ExamController.earlyClosingCount`), written once at finish. A count
     * rather than timestamps because a count is what the questions this column
     * answers actually need — "was this correction graded around an examiner
     * fault?" and "how often does the examiner still try to leave?" — and
     * `reconnect_count` already settled that a per-event record is a place for
     * facts to go unread.
     *
     * `default(0)` is a truthful backfill: rows from before the column were
     * graded by a corrector that was never told, and their penalties stood.
     * Everything that reads this column — the corrector's prompt line, the
     * débat penalty waiver, the note on the correction — therefore keys on it
     * being positive, so an old row keeps meaning exactly what it meant.
     */
    earlyClosingCount: integer("early_closing_count").notNull().default(0),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    /**
     * When the candidate walked out, having been told it would count.
     *
     * A separate column rather than a reading of the two that already exist, and
     * the distinction it draws is the reason. `finished_at` means "submitted for
     * correction"; `phase` means "where the state machine stopped". Between them
     * they can already describe a sitting that ran to the end and was never
     * graded — but they cannot tell that apart from a tab closed by a flat
     * battery, and only one of those is a decision the candidate made.
     *
     * That difference is the whole point here: an abandoned sitting is scored
     * zero and counts against the candidate's record, so the thing being
     * recorded is their *choice* to leave after an explicit warning. Inferring
     * it from an absence would score a dropped connection as a walk-out.
     *
     * Never set alongside a correction: `abandonSitting` refuses once an
     * evaluation exists, so a sitting is graded or abandoned and never both.
     */
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),

    /**
     * When the candidate drew a line under their record and started over (#69).
     *
     * A line, not a delete. An archived sitting keeps its correction, its
     * recording and its `/app/results/:id`; what it loses is its vote on what
     * the tableau de bord averages and what the sujet cards print. So the reset
     * is reversible in principle and destroys nothing in practice, which is what
     * lets it be a single confirmed click rather than a typed-name ceremony.
     *
     * On the row rather than in a `candidate_resets` table keyed by reset
     * instant, and the read is the reason: `readCandidateHistory` is the single
     * query behind the hub, the tableau de bord and the historique, so this is
     * one `is null` on a query that is already filtered by `user_id` — against a
     * correlated subquery re-deriving the latest reset on every render of every
     * one of those screens. It also puts the fact on the row that carries it,
     * which leaves archiving a single sitting possible later without a second
     * mechanism.
     *
     * Stamped only on sittings already **on** the record — graded, or walked out
     * of. A sitting still in progress when the button is pressed belongs to the
     * new record, and archiving it would file a correction that has not landed
     * yet: the candidate would sit an épreuve *after* resetting and never see it
     * counted. See `archiveCandidateRecord`.
     *
     * One other writer since #113: quitting during the préparation stamps this
     * same column on that one sitting (`archivePreparationExit`). The meaning is
     * the reset's — off the record by the candidate's own decision — applied to
     * a sitting that was never going to be on it; the stamp is what tells a
     * deliberate exit apart from a crashed tab.
     *
     * No index of its own: every read that filters on it also filters on
     * `user_id`, and one candidate's sittings are already few enough that the
     * index below does the work.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    // Every read in the product is "this user's sittings" or "this sitting, if
    // it is this user's" — the ownership check is on the hot path, not the side.
    index("oral_exams_user_id_idx").on(table.userId),
  ],
);

/**
 * One speaking phase of one sitting: the monologue suivi, then the débat.
 *
 * At most one row per (sitting, phase), enforced by a unique index rather than
 * by application code — the audit's one pattern worth stealing outright (§01):
 * put the invariant in the database when the answer matters. Two monologue rows
 * would make "how long did the candidate speak?" unanswerable.
 *
 * Rows appear as the phases are entered, so an abandoned sitting has a monologue
 * row and no débat row, which is exactly the truth about it.
 */
export const oralExamPhases = pgTable(
  "oral_exam_phases",
  {
    id: serial("id").primaryKey(),
    examId: integer("exam_id")
      .notNull()
      .references(() => oralExams.id, { onDelete: "cascade" }),

    phase: oralSpeakingPhase("phase").notNull(),

    /**
     * Candidate speaking time in this phase, in seconds.
     *
     * Stored per phase because the rule measures the duration penalty per part:
     * since #189 each part is placed in a tier against the same two thresholds
     * (`FULL_DEVELOPMENT_SECONDS` and `SHORT_DEVELOPMENT_SECONDS`, 8 and 4
     * minutes) and charged to the criterion that part is graded on. Note this
     * column is the CLIENT's clock and is an audit trail only: the figure the
     * rubric actually reads is measured server-side from the uploaded bytes.
     */
    spokenSeconds: integer("spoken_seconds").notNull().default(0),

    /** Null until the phase is entered / left. Wall-clock, for the audit trail. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("oral_exam_phases_exam_phase_idx").on(table.examId, table.phase),
    check("oral_exam_phases_spoken_seconds_check", sql`${table.spokenSeconds} >= 0`),
  ],
);

// =====================================================
// RECORDING
// =====================================================

/**
 * One recording of one speaking phase — the row, with the bytes in a private
 * store it points at.
 *
 * The recording is the whole point of the project (phonologie heard rather
 * than inferred from the number of "euh"s in a transcript), and it is also the
 * thing a candidate re-listens to — so since #98 the finish path keeps it.
 * `uri` names the copy in the vault (`lib/storage/recording-vault.ts`; never a
 * public URL — playback goes through our own authorised route), and
 * `deleted_at` means exactly what it says. That reverses a decision this
 * header used to defend: the audit's schema sketch had `audio_url` "stay NULL:
 * retention is forbidden", and until #98 every row was written pre-disposed.
 *
 * The row still outlives the bytes wherever bytes were not, or are no longer,
 * kept. `uri` is null on every sitting from before #98, on deployments with no
 * vault configured, and on any upload the vault failed — there the size, the
 * duration and `deleted_at` remain as an honest record that a recording
 * existed, how long it was, and that it was disposed of. An audio-mode
 * correction points here either way, which is how "which artefact produced
 * this score?" stays answerable whether or not the artefact can still be
 * played.
 *
 * **One row per phase, not per sitting** (Phase 6). The candidate speaks twice,
 * against two different duration floors, and one 20-minute artefact cannot say
 * which half ran short. `phase` is what makes the two rows tell those two
 * stories apart, and the unique index is what stops a repeated finish quietly
 * filing a third. It is also why playback is two players, not one (#98): the
 * artefacts were cut per task so each half could be re-listened to on its own.
 */
export const oralRecordings = pgTable(
  "oral_recordings",
  {
    id: serial("id").primaryKey(),
    examId: integer("exam_id")
      .notNull()
      .references(() => oralExams.id, { onDelete: "cascade" }),

    /** Which task this is the recording of. Same closed set as the phase rows. */
    phase: oralSpeakingPhase("phase").notNull(),

    /** Where the audio lives, when it lives anywhere. Null = transient upload. */
    uri: text("uri"),
    mimeType: varchar("mime_type", { length: 64 }).notNull().default("audio/wav"),
    byteSize: integer("byte_size"),
    /**
     * Length of the recording, **measured from its samples** — not the phase
     * clock, which is `oral_exam_phases.started_at`/`ended_at`. The two diverge
     * whenever the microphone stopped delivering mid-phase, and this is the one
     * the duration penalty is computed from, so it has to be the measured one.
     */
    durationSeconds: integer("duration_seconds"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the bytes were purged. Null = still referenced by `uri`. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("oral_recordings_exam_id_idx").on(table.examId),
    uniqueIndex("oral_recordings_exam_phase_idx").on(table.examId, table.phase),
    check("oral_recordings_duration_check", sql`${table.durationSeconds} >= 0`),
  ],
);

// =====================================================
// CORRECTION
// =====================================================

/** What the corrector returns alongside the five bands: prose, read whole. */
export interface EvaluationFeedback {
  justifications: Record<OralCriterion, string>;
  appreciationGlobale: string;
  pointsForts: string[];
  axesPrioritaires: string[];
  conseil: string;
  /** True when the input did not allow a real phonology judgement. */
  phonologieNonEvaluable: boolean;
}

/**
 * One criterion of the official grille: `smallint`, because the only legal
 * values are 0, 1, 3 and 5 (`GRILLE_BANDS`) and the type says so more honestly
 * than `integer` does. The band constraint itself is on the table below.
 */
const bandColumn = (name: string) => smallint(name).$type<GrilleBand>().notNull();

/**
 * The five criteria of the DELF B2 production orale grille, defined once.
 *
 * `satisfies Record<OralCriterion, …>` is the acceptance criterion "correction
 * columns match the Phase 1 rubric exactly", expressed so the compiler checks
 * it: rename a criterion in `lib/delf/criteria.ts`, or add a sixth, and this
 * stops compiling.
 */
const criterionColumns = {
  realisationTache: bandColumn("realisation_tache"),
  interaction: bandColumn("interaction"),
  lexique: bandColumn("lexique"),
  morphosyntaxe: bandColumn("morphosyntaxe"),
  phonologie: bandColumn("phonologie"),
} satisfies Record<OralCriterion, ReturnType<typeof bandColumn>>;

/**
 * One scoring of one sitting.
 *
 * The three score columns are not redundant with each other, they are the three
 * numbers the rubric produces in order: the sum of the bands, the points docked
 * for a short épreuve, and what the candidate is actually shown. Storing only
 * the last would make a penalised 12/25 indistinguishable from an honest one.
 */
export const evaluations = pgTable(
  "evaluations",
  {
    id: serial("id").primaryKey(),
    examId: integer("exam_id")
      .notNull()
      .references(() => oralExams.id, { onDelete: "cascade" }),

    /**
     * The recording this correction listened to. Null in `text` mode, and null
     * again once a recording row is hard-deleted — a score outlives its audio.
     */
    recordingId: integer("recording_id").references(() => oralRecordings.id, {
      onDelete: "set null",
    }),

    mode: evaluationMode("mode").notNull(),

    // The five official grille criteria, each a 0/1/3/5 band.
    ...criterionColumns,

    /** Sum of the five bands, before either penalty. */
    rawScore25: integer("raw_score_25").notNull(),
    /**
     * Points lost because a part of the épreuve never happened — the candidate
     * walked out of the débat, or sat through the monologue in silence. The
     * mark is halved, so this is `raw_score_25 − floor(raw_score_25 / 2)`, and
     * 0 for the ordinary sitting where both parts ran.
     *
     * A separate column rather than more `duration_penalty`, which is the shape
     * that would need no migration: the two answer different questions ("spoke
     * for less than the épreuve asks" versus "did not sit half of it"), they are
     * charged from different evidence — seconds of recording versus words of
     * transcript — and a row that records 13 points of "duration penalty" is a
     * mark nobody can explain to the candidate who received it.
     *
     * `default(0)` because rows written before this column existed were scored
     * under the old rule, which had no halving. That is a truthful backfill, not
     * a convenience: those sittings really were docked nothing for it.
     */
    absencePenalty: integer("absence_penalty").notNull().default(0),
    /**
     * Points docked because the candidate spoke for less than the épreuve asks.
     *
     * The penalty the rubric **nominally** applied, since #9. A 2/25 docked 3
     * records a penalty of 3 and a score of 0 — "the rubric wanted 3, the score
     * could absorb 2" — and `evaluations_score_25_check` still holds, because it
     * compares against `greatest(raw − penalty, 0)` rather than the difference.
     *
     * It was the *effective* figure until `applyDurationPenalty` was changed to
     * return what it asked for, so rows written before #9 record the smaller
     * number on any score below the penalty. Only reachable under 3/25.
     */
    durationPenalty: integer("duration_penalty").notNull().default(0),
    /** What the candidate is shown: `raw − absence_penalty − duration_penalty`,
     *  floored at 0. */
    score25: integer("score_25").notNull(),
    /**
     * Whether this score clears the DELF per-competency floor (≥ 5/25). Derived
     * from `score_25`, but stored rather than computed in SQL: the threshold is
     * a Phase 1 constant (`COMPETENCY_FLOOR`), and pinning it into a generated
     * column would be a second, unverifiable copy of a business rule.
     */
    meetsFloor: boolean("meets_floor").notNull(),

    feedback: jsonb("feedback").$type<EvaluationFeedback>().notNull(),

    /** Provenance, so an old result can be traced to the prompt and model that
     *  produced it — the reference project learned this the hard way. */
    model: varchar("model", { length: 64 }).notNull(),
    promptVersion: varchar("prompt_version", { length: 32 }).notNull(),
    /** Wall-clock seconds the evaluation call took (the audio run is slower). */
    latencySeconds: real("latency_seconds"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("evaluations_exam_id_idx").on(table.examId),
    // The grille has no 2 and no 4. `snapToBand` is the net in application code;
    // this is the net under the net, for anything that writes a row without it.
    // Written through the typed columns rather than as name strings: this file's
    // whole thesis is that drift is a compile error, and a renamed column with a
    // stale string here would only surface as a failed migration.
    check(
      "evaluations_bands_check",
      sql`${table.realisationTache} in (0, 1, 3, 5)
        and ${table.interaction} in (0, 1, 3, 5)
        and ${table.lexique} in (0, 1, 3, 5)
        and ${table.morphosyntaxe} in (0, 1, 3, 5)
        and ${table.phonologie} in (0, 1, 3, 5)`,
    ),
    check(
      "evaluations_score_range_check",
      sql`${table.rawScore25} between 0 and 25 and ${table.score25} between 0 and 25
        and ${table.durationPenalty} >= 0 and ${table.absencePenalty} >= 0`,
    ),
    // WARNING, learned the hard way: `drizzle-kit push` applies a new COLUMN and
    // silently leaves these CHECK constraints at whatever the database already
    // had. A pushed database therefore ends up with `absence_penalty` present
    // and `evaluations_score_25_check` still reading `raw − duration`, which
    // accepts every correction that took no absence penalty and refuses every
    // one that did. That is not a theoretical drift — it strands a real
    // candidate's correction, because the finish route logs the failed write
    // and shows them « correction perdue ». Constraint changes must be applied
    // from the generated migration; `pnpm verify:db` now writes a row with both
    // penalties non-zero, which is the only shape that notices.
    //
    // Since #77 this comment is no longer the only guard: `pnpm verify:db`
    // compares every live `pg_get_constraintdef` against what this file
    // declares (`constraint-drift.ts`) and fails loudly on any difference —
    // so a pushed database announces its drift the first time anyone verifies
    // it, instead of on the first row that needed the new arithmetic.
    //
    // Keeps the four score columns telling one story. Both rubric copies apply
    // the penalty the same way — subtract, floor at 0 — so this constraint is
    // neutral in the disagreement between them.
    //
    // The two penalties are summed rather than nested because the halving can
    // never drive the score below 0 on its own: it takes at most half of a
    // non-negative number. So `greatest(raw − absence − duration, 0)` and
    // `greatest(greatest(raw − absence, 0) − duration, 0)` — which is the order
    // `scoreSitting` actually applies — agree on every row.
    check(
      "evaluations_score_25_check",
      sql`${table.score25} = greatest(${table.rawScore25} - ${table.absencePenalty} - ${table.durationPenalty}, 0)`,
    ),
  ],
);

// =====================================================
// RELATIONS
// =====================================================

export const oralTopicsRelations = relations(oralTopics, ({ many }) => ({
  exams: many(oralExams),
}));

export const oralExamsRelations = relations(oralExams, ({ one, many }) => ({
  topic: one(oralTopics, {
    fields: [oralExams.topicId],
    references: [oralTopics.id],
  }),
  phases: many(oralExamPhases),
  recordings: many(oralRecordings),
  evaluations: many(evaluations),
}));

export const oralExamPhasesRelations = relations(oralExamPhases, ({ one }) => ({
  exam: one(oralExams, {
    fields: [oralExamPhases.examId],
    references: [oralExams.id],
  }),
}));

export const oralRecordingsRelations = relations(oralRecordings, ({ one, many }) => ({
  exam: one(oralExams, {
    fields: [oralRecordings.examId],
    references: [oralExams.id],
  }),
  evaluations: many(evaluations),
}));

export const evaluationsRelations = relations(evaluations, ({ one }) => ({
  exam: one(oralExams, {
    fields: [evaluations.examId],
    references: [oralExams.id],
  }),
  recording: one(oralRecordings, {
    fields: [evaluations.recordingId],
    references: [oralRecordings.id],
  }),
}));

// =====================================================
// INFERRED TYPES
// =====================================================
// Every column shape downstream phases need, inferred rather than restated. No
// phase after this one should ever hand-write a row type.

export type OralTopicRow = typeof oralTopics.$inferSelect;
export type NewOralTopicRow = typeof oralTopics.$inferInsert;

export type OralExam = typeof oralExams.$inferSelect;
export type NewOralExam = typeof oralExams.$inferInsert;

export type OralExamPhase = typeof oralExamPhases.$inferSelect;
export type NewOralExamPhase = typeof oralExamPhases.$inferInsert;

export type OralRecording = typeof oralRecordings.$inferSelect;
export type NewOralRecording = typeof oralRecordings.$inferInsert;

export type Evaluation = typeof evaluations.$inferSelect;
export type NewEvaluation = typeof evaluations.$inferInsert;

/** The five bands as stored, keyed exactly like the Phase 1 rubric. */
export type StoredCriteria = Pick<Evaluation, OralCriterion>;
