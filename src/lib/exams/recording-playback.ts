/**
 * What `GET /api/exams/:examId/recordings/:phase` may serve, decided away from
 * the route for the same reason `finish-payload.ts` is: nothing in a route
 * that imports `server-only`, Clerk and the database client can be loaded by
 * `node --test`, and this decision is the difference between a candidate
 * hearing their own voice and hearing somebody else's — the last thing that
 * should go uncovered for that reason.
 *
 * The route's own job stays small: prove ownership (`authorizeExam`, exactly
 * as the finish route does), read the one row, ask here, and stream. The
 * authorisation is NOT re-decided in this module — what is decided is what an
 * *owned* row can honestly be played back as.
 */

import type { OralSpeakingPhase } from "@/lib/db/schema";

/** The url segment, admitted only if it names a phase that can own audio. */
export function parseRecordedPhase(value: string): OralSpeakingPhase | null {
  return value === "monologue" || value === "debate" ? value : null;
}

/** The columns the decision reads — the row as `findRecording` returns it. */
export interface RecordingRowForPlayback {
  uri: string | null;
  mimeType: string;
  byteSize: number | null;
  deletedAt: Date | null;
}

export type PlaybackDecision =
  /** Bytes exist and this deployment can reach them: stream `uri`. */
  | { status: "playable"; uri: string; mimeType: string }
  /**
   * No recording row. A phase whose microphone never worked, a text-mode
   * sitting, or a sitting that never reached this phase — all states the rest
   * of the product already reports, so here they are simply "nothing to play".
   */
  | { status: "no-recording" }
  /**
   * A recording of some length existed and its bytes are gone — every sitting
   * from before #98, and any future purge speaking through `deleted_at`. Not
   * an error, and it must not render as a broken player: the honest sentence
   * is the schema header's, "it existed, and it was disposed of".
   */
  | { status: "disposed" }
  /**
   * The row points at kept bytes this deployment has no credentials to read.
   * The one genuinely broken state — the recording exists, we promised it, and
   * a config regression is standing in front of it — so it is the one that
   * maps to a 5xx rather than a 404.
   */
  | { status: "vault-unreachable" };

export function decidePlayback(
  row: RecordingRowForPlayback | null,
  vaultConfigured: boolean,
): PlaybackDecision {
  if (!row) return { status: "no-recording" };
  // `deleted_at` outranks a uri: a purge stamps the row first and clears the
  // store second, so between the two the row already speaks for the intent.
  if (row.uri === null || row.deletedAt !== null) return { status: "disposed" };
  if (!vaultConfigured) return { status: "vault-unreachable" };
  return { status: "playable", uri: row.uri, mimeType: row.mimeType };
}
