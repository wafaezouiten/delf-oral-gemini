/**
 * The bounds on a transcript arriving from the browser, and the schema for one
 * turn of it.
 *
 * Extracted from `finish-payload.ts` when Phase 8 added a second route that
 * accepts transcript turns — the progress route, which takes one phase's worth
 * as that phase finalises instead of the whole sitting at the end. Both write
 * into the same `oral_exams.transcript` column, so both have to agree about what
 * a legal turn is; two copies of these numbers would be two copies that drift.
 *
 * Everything here is a bound on something the server cannot check any other way.
 * The transcript is a thing only the browser witnessed, so it is taken on trust,
 * and the trust is bounded.
 */

import { z } from "zod";

import type { TranscriptEntry } from "@/lib/delf/transcript";

/**
 * How long one turn's text may be.
 *
 * Sized against what the transcript actually produces, not against a guess.
 * `appendFragment` coalesces consecutive fragments from the same speaker, and
 * the monologue is by construction ONE turn — Gemini emits nothing until
 * `activityEnd` and then the whole exposé at once. Seven minutes of fast French
 * is roughly 1 300 words, call it 9 000 characters, so a 4 000-character cap
 * would reject a perfectly ordinary sitting. 20 000 is comfortably clear of the
 * longest legitimate turn and still four orders of magnitude below what an
 * unbounded field allows.
 */
export const MAX_TURN_CHARS = 20_000;

/** Turns in a sitting. A talkative 13-minute débat is well under a hundred. */
export const MAX_TURNS = 500;

/**
 * And the whole transcript, bounded independently of how it is distributed
 * across turns — 500 turns of 20 000 characters each is 10 MB, which is not a
 * bound worth having. 200 000 characters is about 35 000 words against a
 * 20-minute exam's realistic ceiling of roughly 4 000.
 */
export const MAX_TRANSCRIPT_CHARS = 200_000;

export const transcriptEntrySchema = z.object({
  phase: z.enum(["monologue", "debate"]),
  speaker: z.enum(["candidate", "examiner"]),
  timestamp: z.number(),
  text: z.string().max(MAX_TURN_CHARS),
}) satisfies z.ZodType<TranscriptEntry>;

/**
 * A run of turns, bounded by count and by total size.
 *
 * Applied per request, which for the progress route means per phase rather than
 * per sitting. That is deliberately the looser reading: a sitting cannot exceed
 * these bounds by arriving in two halves, because the finish route re-sends the
 * whole transcript and is checked against them whole.
 */
export const transcriptSchema = z
  .array(transcriptEntrySchema)
  .max(MAX_TURNS)
  .refine(
    (entries) => entries.reduce((n, entry) => n + entry.text.length, 0) <= MAX_TRANSCRIPT_CHARS,
    "the transcript is longer than any real épreuve produces",
  );
