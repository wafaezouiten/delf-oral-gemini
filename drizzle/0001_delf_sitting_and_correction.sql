CREATE TYPE "public"."evaluation_mode" AS ENUM('text', 'audio');--> statement-breakpoint
CREATE TYPE "public"."oral_phase" AS ENUM('preparation', 'monologue', 'debate', 'finished');--> statement-breakpoint
CREATE TYPE "public"."oral_speaking_phase" AS ENUM('monologue', 'debate');--> statement-breakpoint
CREATE TABLE "oral_exam_phases" (
	"id" serial PRIMARY KEY NOT NULL,
	"exam_id" integer NOT NULL,
	"phase" "oral_speaking_phase" NOT NULL,
	"spoken_seconds" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "oral_exam_phases_spoken_seconds_check" CHECK ("oral_exam_phases"."spoken_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "oral_recordings" (
	"id" serial PRIMARY KEY NOT NULL,
	"exam_id" integer NOT NULL,
	"uri" text,
	"mime_type" varchar(64) DEFAULT 'audio/wav' NOT NULL,
	"byte_size" integer,
	"duration_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "evaluations" ALTER COLUMN "mode" SET DATA TYPE "public"."evaluation_mode" USING "mode"::"public"."evaluation_mode";--> statement-breakpoint
ALTER TABLE "oral_exams" ALTER COLUMN "phase" SET DEFAULT 'preparation'::"public"."oral_phase";--> statement-breakpoint
ALTER TABLE "oral_exams" ALTER COLUMN "phase" SET DATA TYPE "public"."oral_phase" USING "phase"::"public"."oral_phase";--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "recording_id" integer;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "realisation_tache" smallint NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "interaction" smallint NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "lexique" smallint NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "morphosyntaxe" smallint NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "phonologie" smallint NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "duration_penalty" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "meets_floor" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "oral_exam_phases" ADD CONSTRAINT "oral_exam_phases_exam_id_oral_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."oral_exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oral_recordings" ADD CONSTRAINT "oral_recordings_exam_id_oral_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."oral_exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oral_exam_phases_exam_phase_idx" ON "oral_exam_phases" USING btree ("exam_id","phase");--> statement-breakpoint
CREATE INDEX "oral_recordings_exam_id_idx" ON "oral_recordings" USING btree ("exam_id");--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_recording_id_oral_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."oral_recordings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evaluations_exam_id_idx" ON "evaluations" USING btree ("exam_id");--> statement-breakpoint
CREATE INDEX "oral_exams_user_id_idx" ON "oral_exams" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "evaluations" DROP COLUMN "criteria";--> statement-breakpoint
ALTER TABLE "oral_exams" DROP COLUMN "monologue_seconds";--> statement-breakpoint
ALTER TABLE "oral_exams" DROP COLUMN "debate_seconds";--> statement-breakpoint
ALTER TABLE "oral_exams" DROP COLUMN "audio_url";--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_bands_check" CHECK ("evaluations"."realisation_tache" in (0, 1, 3, 5)
        and "evaluations"."interaction" in (0, 1, 3, 5)
        and "evaluations"."lexique" in (0, 1, 3, 5)
        and "evaluations"."morphosyntaxe" in (0, 1, 3, 5)
        and "evaluations"."phonologie" in (0, 1, 3, 5));--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_score_range_check" CHECK ("evaluations"."raw_score_25" between 0 and 25 and "evaluations"."score_25" between 0 and 25 and "evaluations"."duration_penalty" >= 0);--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_score_25_check" CHECK ("evaluations"."score_25" = greatest("evaluations"."raw_score_25" - "evaluations"."duration_penalty", 0));