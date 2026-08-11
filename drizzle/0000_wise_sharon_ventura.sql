CREATE TABLE "evaluations" (
	"id" serial PRIMARY KEY NOT NULL,
	"exam_id" integer NOT NULL,
	"mode" varchar(8) NOT NULL,
	"criteria" jsonb NOT NULL,
	"raw_score_25" integer NOT NULL,
	"score_25" integer NOT NULL,
	"feedback" jsonb NOT NULL,
	"model" varchar(64) NOT NULL,
	"prompt_version" varchar(32) NOT NULL,
	"latency_seconds" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oral_exams" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"topic_id" integer NOT NULL,
	"phase" varchar(16) DEFAULT 'preparation' NOT NULL,
	"monologue_seconds" integer DEFAULT 0 NOT NULL,
	"debate_seconds" integer DEFAULT 0 NOT NULL,
	"transcript" jsonb,
	"audio_url" text,
	"reconnect_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oral_topics" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(128) NOT NULL,
	"title" text NOT NULL,
	"document" text NOT NULL,
	"consigne" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oral_topics_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_exam_id_oral_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."oral_exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oral_exams" ADD CONSTRAINT "oral_exams_topic_id_oral_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."oral_topics"("id") ON DELETE restrict ON UPDATE no action;