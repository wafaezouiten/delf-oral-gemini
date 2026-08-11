/**
 * Database schema — deliberately small.
 *
 * The brief is explicit: do not copy the reference project's schema, and do not
 * build Stripe, entitlements, streaks or admin tables. So this is four tables
 * covering exactly what the product needs to run one DELF B2 oral exam and show
 * its result.
 *
 * Two decisions worth recording:
 *
 *  - **The transcript is a jsonb column, not a table.** It is written once when
 *    the exam ends and read whole. Normalising it into a row-per-turn table
 *    would buy queries nobody runs and cost a join on every read.
 *  - **`evaluations` is a separate table with a `mode` column, not a column on
 *    the exam.** The audio-versus-text experiment (§20) needs to score the SAME
 *    exam twice and compare, so one exam must be able to hold several
 *    evaluations.
 */

import { relations } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

import type { TranscriptEntry } from "@/lib/delf/transcript";
import type { CriteriaScores, OralCriterion } from "@/lib/delf/rubric";

/** The subject catalogue, seeded from `lib/delf/topics.ts`. */
export const oralTopics = pgTable("oral_topics", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 128 }).notNull().unique(),
  title: text("title").notNull(),
  document: text("document").notNull(),
  consigne: text("consigne").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One attempt at the exam.
 *
 * `phase` is persisted so a candidate who closes the tab mid-exam has a record
 * of how far they got, and so an abandoned attempt is distinguishable from a
 * completed one in the dashboard.
 */
export const oralExams = pgTable("oral_exams", {
  id: serial("id").primaryKey(),
  /** Clerk user id. Not a foreign key: Clerk owns the user, we only reference it. */
  userId: varchar("user_id", { length: 255 }).notNull(),
  topicId: integer("topic_id")
    .notNull()
    .references(() => oralTopics.id, { onDelete: "restrict" }),

  phase: varchar("phase", { length: 16 }).notNull().default("preparation"),

  /** Per-phase speaking time, in seconds. Kept separate because the DELF
   *  duration penalty is measured against the total, but a marker reading the
   *  result wants to know which half the candidate ran short on. */
  monologueSeconds: integer("monologue_seconds").notNull().default(0),
  debateSeconds: integer("debate_seconds").notNull().default(0),

  transcript: jsonb("transcript").$type<TranscriptEntry[]>(),

  /** Where the candidate's WAV lives, when audio was kept. */
  audioUrl: text("audio_url"),

  /** How many times the Live connection was re-established mid-exam. Recorded
   *  because the acceptance test asserts on it, and because a session that
   *  reconnects ten times is a signal worth seeing in production. */
  reconnectCount: integer("reconnect_count").notNull().default(0),

  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/** What the model returns alongside the five bands. */
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
 * One scoring of one exam.
 *
 * `mode` is the experiment's independent variable: `text` grades the transcript
 * alone, `audio` grades the transcript plus the candidate's actual recording.
 */
export const evaluations = pgTable("evaluations", {
  id: serial("id").primaryKey(),
  examId: integer("exam_id")
    .notNull()
    .references(() => oralExams.id, { onDelete: "cascade" }),

  mode: varchar("mode", { length: 8 }).notNull(),

  criteria: jsonb("criteria").$type<CriteriaScores>().notNull(),
  /** Sum of the five bands, before the duration penalty. */
  rawScore25: integer("raw_score_25").notNull(),
  /** What the candidate is actually shown. */
  score25: integer("score_25").notNull(),

  feedback: jsonb("feedback").$type<EvaluationFeedback>().notNull(),

  /** Provenance, so an old result can be traced to the prompt and model that
   *  produced it — the reference project learned this the hard way. */
  model: varchar("model", { length: 64 }).notNull(),
  promptVersion: varchar("prompt_version", { length: 32 }).notNull(),
  /** Wall-clock seconds the evaluation call took (the audio run is slower). */
  latencySeconds: real("latency_seconds"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oralExamsRelations = relations(oralExams, ({ one, many }) => ({
  topic: one(oralTopics, {
    fields: [oralExams.topicId],
    references: [oralTopics.id],
  }),
  evaluations: many(evaluations),
}));

export const evaluationsRelations = relations(evaluations, ({ one }) => ({
  exam: one(oralExams, {
    fields: [evaluations.examId],
    references: [oralExams.id],
  }),
}));

export type OralExam = typeof oralExams.$inferSelect;
export type OralTopicRow = typeof oralTopics.$inferSelect;
export type Evaluation = typeof evaluations.$inferSelect;
