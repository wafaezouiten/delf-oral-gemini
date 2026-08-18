/**
 * The copy and the arithmetic behind the débat's conversation (#48, #60).
 *
 * Here rather than in the component for the reason every other `lib/ui` module
 * is: the words a candidate reads mid-épreuve and the rule that decides whether
 * the feed follows the conversation are both testable, and neither needs a DOM
 * to be wrong in.
 *
 * **This panel has been added, removed and added back, and the shape it settled
 * in is the reason it works now.** #48 printed the exchange in place of the
 * screen's status card, beside the sujet, under a scene that had been deleted —
 * three things competing for one viewport, so the exchange lived in a 20rem box.
 * #60 removed it: what a candidate needs while being argued with is to know
 * whose turn it is. Both were right about a part of it. The débat now shows the
 * two protagonists **and** the exchange, and pays for the room by dropping the
 * document — the sujet's title stays, its paragraphs go, because during the
 * débat the candidate is answering the examiner rather than reading.
 */

import type { TranscriptEntry, TranscriptSpeaker } from "@/lib/delf/transcript";

export const DEBATE_CONVERSATION_COPY = {
  title: "Échange avec l'examinateur",
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
 * Should the page scroll itself to the newest turn?
 *
 * Asked of the scroll position *before* the new text lands, so a candidate who
 * has scrolled up to re-read an earlier objection is not yanked back down by the
 * examiner continuing to speak. The metrics are the screen's scroller rather
 * than a box of the panel's own: the conversation has no scrollbar of its own,
 * the whole column scrolls.
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
