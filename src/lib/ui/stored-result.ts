import {
  applySittingDurationPenalty,
  partsAbsent,
  type DurationCharge,
} from "@/lib/delf/orale-rubric";
import type { GrilleBand } from "@/lib/delf/grille";
import type { OralTopic } from "@/lib/delf/topics";
import { candidateWordCount, type TranscriptEntry } from "@/lib/delf/transcript";
import type { StoredCorrection, StoredSitting } from "@/lib/exams/sitting-persistence";

/**
 * The correction as the results page reads it — from the finish response's
 * stash in `sessionStorage`, or rebuilt from the stored rows on the server.
 *
 * Here rather than in the page and its client so `node --test` can reach the
 * two readings (#234): the parse, which has to answer for a stash from before
 * a field existed, and the reconstruction, which re-runs the rubric's own
 * functions over the stored bands and the server's measurements to recover
 * what has no column — which halves were absent, where the duration charge
 * landed. Neither is a second copy of a rule.
 */

export interface StoredResult {
  evaluation: {
    mode: "text" | "audio";
    criteria: Record<string, GrilleBand>;
    rawScore25: number;
    score25: number;
    /**
     * What the rubric docked for a short épreuve, and which halves were short.
     *
     * `durationPenalty` is what gates the explanation below the mark: #137
     * removed the old « Note avant pénalité de durée » paragraph and left the
     * penalty firing unexplained, and #189 reversed that on the user's call —
     * « the candidate should know why he got penalized ». So this field is
     * read, and `durationCharges` beside it carries the reason.
     *
     * `shortParts` is still the one nothing renders: it names which halves
     * fell short without saying what that cost, which is the half of the
     * sentence `durationCharges` now carries properly.
     */
    durationPenalty?: number;
    shortParts?: Array<"monologue" | "debate">;
    /** Where the duration charge landed, so the page can explain it (#189).
     *  Optional like the rest of the corrector's working: a stash written
     *  before the field existed carries nothing. */
    durationCharges?: DurationCharge[];
    /**
     * What the halving cost, and which part never happened. Optional for the
     * same reason as the two above, and the fallback matters more here: the
     * old reading would attribute 13 points to a short épreuve, which is not
     * what took them.
     */
    absencePenalty?: number;
    absentParts?: Array<"monologue" | "debate">;
    model: string;
    /**
     * Nullable because `evaluations.latency_seconds` is, and this object is
     * built from that row as well as from a fresh finish response. Nothing
     * renders it today; the type says `number | null` so that whatever renders
     * it next has to decide what an unmeasured correction looks like, instead of
     * inheriting a zero somebody coalesced to make the types line up.
     */
    latencySeconds: number | null;
    feedback: {
      justifications: Record<string, string>;
      appreciationGlobale: string;
      pointsForts: string[];
      axesPrioritaires: string[];
      conseil: string;
      phonologieNonEvaluable: boolean;
    };
  };
  topic: OralTopic;
  transcript: TranscriptEntry[];
  monologueSeconds: number;
  debateSeconds: number;
  reconnectCount: number;
  /**
   * How many times the examiner tried to close the épreuve mid-débat (#92).
   * Optional for the same reason `examinerModel` is: a stash from before the
   * field existed carries nothing, and a row from before the column reads 0.
   * Absent or zero, nothing renders — those corrections were graded by a
   * corrector that was never told, and the note would be false above them.
   */
  earlyClosingCount?: number;
  /**
   * The halves whose recording was kept and can be streamed back (#98), with
   * the mime type each was measured to be — the player needs it to ask the
   * browser `canPlayType` before offering a control that would only error.
   *
   * Optional because this object is also read back out of `sessionStorage`,
   * where a stash from before the field existed carries nothing — and because
   * the stash never carries it even now: the finish response holds no uris, so
   * playback belongs to the server-read path alone. Absent or empty, the
   * transcript renders its parts without players.
   */
  playable?: Array<{ phase: "monologue" | "debate"; mimeType: string; durationSeconds: number }>;
  /**
   * Which Live model played the examiner (#99). Optional for the same reason
   * `durationPenalty` is: this object also comes back out of `sessionStorage`,
   * where a sitting finished before the picker existed carries no such field.
   * Absent or null, the provenance line names the corrector alone.
   */
  examinerModel?: string | null;
}

/**
 * sessionStorage is an external store, so it is read with the API meant for
 * external stores rather than mirrored into state from an effect. The server
 * snapshot is `undefined` (there is no sessionStorage during SSR), which renders
 * the loading state and lets the client fill it in on hydration without a
 * mismatch.
 *
 * Parsing is memoised on the raw string so a re-render does not re-parse, and so
 * `getSnapshot` returns a stable identity as `useSyncExternalStore` requires.
 */
let parsedCache: { raw: string; value: StoredResult | null } | null = null;

export function parseStoredResult(raw: string | null): StoredResult | null | undefined {
  if (raw === null) return null;
  if (parsedCache?.raw === raw) return parsedCache.value;
  let value: StoredResult | null;
  try {
    value = JSON.parse(raw) as StoredResult;
  } catch {
    value = null;
  }
  parsedCache = { raw, value };
  return value;
}

/**
 * The correction of a persisted sitting, rebuilt from its rows.
 *
 * `absentParts` and `durationCharges` have no column and are recovered by
 * re-running the rubric's own functions over the same inputs it saw at grading
 * time — the stored bands, the server's measurement of the recordings — never
 * by a second copy of the rule.
 */
export function storedResultFromSitting(
  sitting: StoredSitting,
  correction: StoredCorrection,
  topic: OralTopic,
): StoredResult {
  const measured = (phase: "monologue" | "debate") =>
    sitting.phases.find((row) => row.phase === phase)?.spokenSeconds ??
    sitting.recordings.find((row) => row.phase === phase)?.durationSeconds ??
    0;

  // The recordings whose bytes were kept (#98): a uri to serve and no purge
  // stamp. Everything else — pre-#98 sittings, vaultless deployments, uploads
  // that failed — renders exactly as before, a duration with nothing to play,
  // which is the honest sentence for a recording that existed and is gone.
  const playable = sitting.recordings
    .filter((row) => row.uri !== null && row.deletedAt === null)
    .map((row) => ({
      phase: row.phase,
      mimeType: row.mimeType,
      // From the row, so the player can print « 0:00 / 1:38 » before a single
      // byte has moved — its file stays unfetched until play is pressed.
      durationSeconds: row.durationSeconds,
    }));

  return {
    evaluation: {
      mode: correction.mode,
      criteria: correction.criteria,
      rawScore25: correction.rawScore25,
      score25: correction.score25,
      durationPenalty: correction.durationPenalty,
      // No `shortParts`: which half ran short is the corrector's working and has
      // no column. The client already treats it as optional, because a stored
      // correction was always going to be the other thing it renders.
      absencePenalty: correction.absencePenalty,
      // `absentParts` has no column either, but unlike `shortParts` it can be
      // recovered exactly: it was read off the transcript, and the transcript
      // is stored. This is the rubric's own `partsAbsent`, over the same input
      // it saw at grading time — not a second copy of the rule.
      //
      // Guarded on the penalty so a row written before the halving existed
      // (`absence_penalty` defaults to 0) is never labelled with a charge it
      // did not take.
      //
      // And minus the débat the examiner closed early (#92), exactly as the
      // rubric dropped it at grading time: a positive count means the waiver
      // was live (the column and the waiver shipped together, and old rows
      // read 0), so a silent débat here was excused, not charged — leaving it
      // in would caption a monologue-only halving as « aucune des deux
      // parties ».
      absentParts:
        correction.absencePenalty > 0
          ? partsAbsent({
              monologueWords: candidateWordCount(sitting.transcript, "monologue"),
              debateWords: candidateWordCount(sitting.transcript, "debate"),
            }).filter((part) => part !== "debate" || sitting.earlyClosingCount === 0)
          : [],
      // `durationCharges` has no column either, and is recovered the way
      // `absentParts` above is: by re-running the rubric's own function over
      // the same inputs it saw at grading time — the stored bands, and the
      // server's measurement of the recordings. Not a second copy of the rule.
      //
      // The score handed in is the stored raw: only `charges` is read from the
      // result, and those depend on the bands and the durations, never on the
      // running total.
      //
      // `excluded` has to be reconstructed too, or the sentence would name a
      // part the rubric never charged: an absent part is dropped (the halving
      // already answered for it) and so is a débat the examiner closed early.
      // Both are the same reconstructions used just above.
      durationCharges:
        correction.durationPenalty > 0
          ? applySittingDurationPenalty(
              correction.rawScore25,
              correction.criteria,
              { monologueSeconds: measured("monologue"), debateSeconds: measured("debate") },
              [
                ...(correction.absencePenalty > 0
                  ? partsAbsent({
                      monologueWords: candidateWordCount(sitting.transcript, "monologue"),
                      debateWords: candidateWordCount(sitting.transcript, "debate"),
                    })
                  : []),
                ...(sitting.earlyClosingCount > 0 ? (["debate"] as const) : []),
              ],
            ).charges
          : [],
      model: correction.model,
      latencySeconds: correction.latencySeconds,
      feedback: correction.feedback,
    },
    topic,
    transcript: sitting.transcript,
    // The number the duration penalty was computed from — see `measured`.
    monologueSeconds: measured("monologue"),
    debateSeconds: measured("debate"),
    reconnectCount: sitting.reconnectCount,
    // The examiner's early goodbyes (#92) — unlike `reconnectCount` above,
    // something actually renders this: the note explaining that the fault was
    // not held against the candidate.
    earlyClosingCount: sitting.earlyClosingCount,
    playable,
    // Which model spoke (#99) — the counterpart of `evaluation.model`, which
    // names the one that graded. Null on sittings from before the column, and
    // shown as nothing rather than guessed: today's default is not evidence
    // about which examiner an old sitting heard.
    examinerModel: sitting.examinerModel,
  };
}
