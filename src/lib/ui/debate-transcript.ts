/**
 * The copy and the arithmetic behind the débat's live transcript (#48).
 *
 * Here rather than in the component for the reason every other `lib/ui` module
 * is: the words a candidate reads mid-épreuve and the rule that decides whether
 * the feed follows the conversation are both testable, and neither needs a DOM
 * to be wrong in.
 */

import type { TranscriptEntry, TranscriptSpeaker } from "@/lib/delf/transcript";

export const DEBATE_TRANSCRIPT_COPY = {
  title: "Transcription du débat",
  /** On the panel, which is open by default. */
  hide: "Masquer",
  /** On the status card, which is what is on screen once it has been hidden. */
  show: "Afficher la transcription",
  empty: "L'échange s'affichera ici, au fil des interventions.",
  /**
   * Said once, under the feed. Gemini's transcription does not arrive in step
   * with the audio it transcribes — a turn can be printed slightly before or
   * after it is heard — and a candidate who notices that without being told
   * reads it as the product being broken.
   */
  footnote:
    "Transcription automatique : elle peut arriver avec un léger décalage sur la voix.",
} as const;

/**
 * How the two speakers are named on screen.
 *
 * « Vous » rather than « Candidat », matching the results page's transcript
 * (`results-client.tsx`) — the same exchange printed twice should not change
 * who it says was speaking.
 */
export function speakerLabel(speaker: TranscriptSpeaker): string {
  return speaker === "candidate" ? "Vous" : "Examinateur";
}

/**
 * How close to the bottom counts as "following the conversation".
 *
 * Not zero, and that is the point: the last turn *grows* as fragments merge into
 * it (`appendFragment`), so a feed pinned to the exact bottom is a pixel off it
 * again the moment the examiner says another word. Anything within a line of the
 * end is someone reading the newest turn, not someone who has scrolled back.
 */
export const STICK_THRESHOLD_PX = 32;

/**
 * Should the feed scroll itself to the newest turn?
 *
 * Asked of the scroll position *before* the new text lands, so a candidate who
 * has scrolled up to re-read an earlier objection is not yanked back down by the
 * examiner continuing to speak.
 */
export function isNearBottom(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold: number = STICK_THRESHOLD_PX,
): boolean {
  const distance = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distance <= threshold;
}

/**
 * A key for a turn that survives the tail growing.
 *
 * The last entry is edited in place by `appendFragment` rather than replaced, so
 * keying by content would remount the turn currently being spoken on every
 * fragment — losing a text selection and, on some browsers, the scroll position
 * with it. The timestamp is fixed when the turn starts and the index only ever
 * appends, so the pair is stable for the life of a turn.
 */
export function turnKey(entry: TranscriptEntry, index: number): string {
  return `${entry.timestamp}-${index}`;
}
