/**
 * The correction's transcript, cut into the two parts the épreuve was sat in (#70).
 *
 * Here rather than in `results-client.tsx` for the reason every other `lib/ui`
 * module is: the sectioning is a decision — which headings print, which duration
 * sits beside which turns, what a turn's timestamp is counted from, and which of
 * two "nothing was said" messages fires — and a decision belongs somewhere it can
 * be wrong in a test rather than only on somebody's finished exam.
 *
 * **Why the split at all.** `transcript.ts` tags every entry with its phase
 * because the monologue and the débat are different tasks graded on different
 * criteria, and `formatTranscript` already hands the evaluator a MONOLOGUE block
 * then a DEBAT block. The candidate's copy was the one place that shape was
 * dropped: one run of turns under a single « Monologue 7:02 · Débat 4:38 » line,
 * leaving the candidate to work out where their exposé ended and the examiner's
 * first objection began — while the rail beside it docks points from « votre
 * débat » by name.
 *
 * **Where this deliberately differs from `formatTranscript`.** That function
 * skips a phase with no turns, because a heading over nothing costs the
 * evaluator context window for no information. This one prints it. The two
 * readers want opposite things: an absent débat is a *fact of this correction* —
 * it is the fact the duration penalty in the rail is about — so the candidate
 * gets the heading, the `0:00` and a quiet line saying nothing was recorded.
 */

import { formatClock, formatTurnOffset } from "@/lib/delf/phases";
import {
  entriesForPhase,
  stripDirectiveEchoes,
  type TranscriptEntry,
  type TranscriptPhase,
} from "@/lib/delf/transcript";

export const CORRECTION_TRANSCRIPT_COPY = {
  kicker: "Transcription de l'épreuve",
  /**
   * Under an empty heading. Quiet — a paragraph, not the danger block below:
   * this is a section of a document reporting that it has nothing to report,
   * and the sitting's actual failure is already stated once, in the rail, with
   * a number attached.
   */
  emptySection: "Aucune intervention enregistrée pour cette partie.",
  /**
   * The whole-page block, for a sitting the microphone caught nothing at all in.
   */
  silentTitle: "Aucune intervention transcrite",
  silentBody:
    "Le micro n'a capté aucune prise de parole. L'évaluation porte donc sur une non-réponse.",
  /**
   * « les durées indiquées », not « ci-dessus »: the durations are no longer
   * above the turns in one combined line, they are beside each section's own
   * heading.
   */
  footnote:
    "Transcription automatique : les hésitations et les pauses sont conservées pour l'évaluation. Les durées indiquées sont celles de l'audio effectivement enregistré, et non du chronomètre.",
} as const;

/**
 * How the two parts are named on the correction.
 *
 * The épreuve already names them, on the player's déroulé (`po-player-view.ts`).
 * The correction reuses those exact words rather than inventing a third set of
 * names for the same two parts — a candidate who sat « Monologue suivi » should
 * not have to match it up with something else on the way out.
 */
export const PHASE_HEADINGS: Record<TranscriptPhase, string> = {
  monologue: "Monologue suivi",
  debate: "Débat",
};

/** The parts in the order they were sat. */
const PHASE_ORDER: readonly TranscriptPhase[] = ["monologue", "debate"];

export interface CorrectionTranscriptTurn {
  entry: TranscriptEntry;
  /**
   * `m:ss` into **this part**, not into the sitting.
   *
   * `TranscriptEntry.timestamp` counts from the start of the exam, so a débat
   * turn carries something like 15:32 — a figure printed under a heading that
   * says the débat lasted 4:38, which is a contradiction a candidate has to
   * resolve before they can use either number. Re-anchoring on the part's first
   * turn makes the stamps read against the duration beside the heading, and
   * makes the monologue's and the débat's stamps comparable to each other.
   *
   * The anchor is the part's first *entry*, not the exam clock reaching the
   * phase: the transcript has no record of when the phase opened, and the gap
   * between opening it and the first word is silence nobody is being shown.
   */
  timeLabel: string;
}

export interface CorrectionTranscriptSection {
  phase: TranscriptPhase;
  heading: string;
  /** `m:ss` of the audio actually recorded for this part. */
  durationLabel: string;
  turns: CorrectionTranscriptTurn[];
  /** Printed under the heading when the part has no turns at all, else null. */
  emptyNote: string | null;
}

export interface CorrectionTranscriptView {
  sections: CorrectionTranscriptSection[];
  /** The red block, when the candidate is nowhere in the transcript. */
  silentNotice: { title: string; body: string } | null;
}

/**
 * The transcript column's whole view model: two sections, and at most one of the
 * two ways of saying nothing was said.
 *
 * **The two "nothing" messages never print together.** The red block fires when
 * the candidate is absent from the *entire* transcript; a section's quiet line
 * fires when that part has no turns. A sitting that was silent throughout would
 * otherwise raise the block plus one quiet line per empty part — three notices
 * for one failure. So the block wins and the per-section lines stand down: an
 * entirely silent épreuve reads as one failure, which is what it is.
 *
 * Note the block's own test is « did the candidate ever speak », not « are there
 * any turns »: an examiner talking to silence still fills the transcript, and
 * that sitting is exactly the one this block exists for.
 */
export function correctionTranscriptView(
  stored: readonly TranscriptEntry[],
  durations: { monologueSeconds: number; debateSeconds: number },
): CorrectionTranscriptView {
  // The rows written before the controller held directive echoes back (#187)
  // still carry them, and a candidate reading their correction must not meet
  // « [Information de service, à ne jamais prononcer : …] » in the examiner's
  // mouth. Scrubbed at read time, once, here — the page shows what was said.
  const transcript = stripDirectiveEchoes(stored);
  const spoke = transcript.some((entry) => entry.speaker === "candidate");

  const seconds: Record<TranscriptPhase, number> = {
    monologue: durations.monologueSeconds,
    debate: durations.debateSeconds,
  };

  const sections = PHASE_ORDER.map((phase): CorrectionTranscriptSection => {
    const entries = entriesForPhase(transcript, phase);
    const anchor = entries[0]?.timestamp ?? 0;
    return {
      phase,
      heading: PHASE_HEADINGS[phase],
      durationLabel: formatClock(seconds[phase]),
      turns: entries.map((entry) => ({
        entry,
        timeLabel: formatTurnOffset(entry.timestamp - anchor),
      })),
      emptyNote: entries.length === 0 && spoke ? CORRECTION_TRANSCRIPT_COPY.emptySection : null,
    };
  });

  return {
    sections,
    silentNotice: spoke
      ? null
      : {
          title: CORRECTION_TRANSCRIPT_COPY.silentTitle,
          body: CORRECTION_TRANSCRIPT_COPY.silentBody,
        },
  };
}
