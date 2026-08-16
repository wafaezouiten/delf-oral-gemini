/**
 * What `POST /api/exams/:examId/progress` will accept.
 *
 * Extracted from the route for the reason `finish-payload.ts` was: the route
 * imports `server-only`, Clerk and the database client, so nothing in it can be
 * loaded by `node --test`, and request validation is the last thing that should
 * go uncovered.
 *
 * ## Why this route exists at all
 *
 * Until Phase 8 the transcript reached the server exactly once, in the finish
 * request, which meant the entire record of a sitting lived in one tab's memory
 * until the épreuve ended. A crash during the débat took the monologue with it,
 * and `oral_exams.phase` — documented in the schema as being persisted "so a
 * candidate who closes the tab mid-exam has a record of how far they got" — was
 * never written to anything but its default.
 *
 * So each speaking phase reports itself as it finalises: its turns are appended
 * to the stored transcript and the sitting's phase moves on. It is insurance for
 * the phase that *completed*, not for the one in flight — the débat a candidate
 * abandons halfway is still lost, because nothing on the client survives to
 * report it.
 */

import { z } from "zod";

import { MAX_PHASE_SECONDS } from "./finish-payload";
import { transcriptSchema } from "./transcript-payload";

/**
 * One finalised phase.
 *
 * `entries` is this phase's turns only, not the transcript so far: the column is
 * appended to server-side, so re-sending everything would either duplicate the
 * monologue or force a read-modify-write the append exists to avoid.
 *
 * There is no duration here, and deliberately so. Speaking time is measured from
 * the uploaded audio at finish, and the audio does not exist yet — a number
 * invented at this point would be the browser's clock wearing the column that
 * decides the duration penalty.
 */
export const progressPayloadSchema = z
  .object({
    phase: z.enum(["monologue", "debate"]),
    entries: transcriptSchema,
    /** Epoch ms. Stamped when the phase was entered. */
    startedAt: z.number().int().nonnegative(),
    /** Epoch ms. Never null here — a phase reports itself *because* it ended. */
    endedAt: z.number().int().nonnegative(),
  })
  .refine((report) => report.endedAt >= report.startedAt, "a phase cannot end before it started")
  .refine(
    (report) => report.endedAt - report.startedAt <= MAX_PHASE_SECONDS * 1000,
    "a phase cannot have run that long",
  )
  .refine(
    // The turns of one phase, tagged as that phase. A payload claiming the
    // monologue finalised while carrying débat turns would append them under a
    // heading the evaluator later reads as the wrong task.
    (report) => report.entries.every((entry) => entry.phase === report.phase),
    "every turn must belong to the phase being reported",
  );

export type ProgressPayload = z.infer<typeof progressPayloadSchema>;
