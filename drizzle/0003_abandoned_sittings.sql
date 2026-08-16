--> A sitting the candidate walked out of, having been warned it would count.
-->
--> Nullable with no default and no backfill, which is correct rather than merely
--> convenient: every row that exists before this migration was either graded or
--> is still open, and neither is an abandonment. Backfilling would invent a
--> decision nobody made — and since an abandoned sitting is scored zero against
--> the candidate's record, inventing one is inventing a failure.
ALTER TABLE "oral_exams" ADD COLUMN "abandoned_at" timestamp with time zone;
