--> NOT NULL with no default and no backfill, which is only safe because
--> `oral_recordings` has never had a row written to it: Phase 2 created the
--> table and Phase 6 is the first code that inserts into it. If that is ever
--> untrue of an environment, this statement is where it will say so, loudly,
--> rather than by inventing a phase for audio nobody can attribute.
ALTER TABLE "oral_recordings" ADD COLUMN "phase" "oral_speaking_phase" NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "oral_recordings_exam_phase_idx" ON "oral_recordings" USING btree ("exam_id","phase");--> statement-breakpoint
ALTER TABLE "oral_recordings" ADD CONSTRAINT "oral_recordings_duration_check" CHECK ("oral_recordings"."duration_seconds" >= 0);