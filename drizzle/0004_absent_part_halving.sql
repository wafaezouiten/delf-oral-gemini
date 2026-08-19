ALTER TABLE "evaluations" DROP CONSTRAINT "evaluations_score_range_check";--> statement-breakpoint
ALTER TABLE "evaluations" DROP CONSTRAINT "evaluations_score_25_check";--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "absence_penalty" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_score_range_check" CHECK ("evaluations"."raw_score_25" between 0 and 25 and "evaluations"."score_25" between 0 and 25
        and "evaluations"."duration_penalty" >= 0 and "evaluations"."absence_penalty" >= 0);--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_score_25_check" CHECK ("evaluations"."score_25" = greatest("evaluations"."raw_score_25" - "evaluations"."absence_penalty" - "evaluations"."duration_penalty", 0));