/**
 * Reading the examiner's own words for a goodbye it was never asked to say (#85).
 *
 * The app already refuses to let the model end a phase: `onTurnComplete`
 * advances only inside a closing handshake the app opened, and the clock is the
 * only thing that opens one. What it could not do was notice that the examiner
 * had said goodbye ANYWAY — announcing a third part of an épreuve that has two,
 * telling the candidate they may leave the room, with seven minutes of débat
 * still on the clock. The phase correctly kept running, which is what made it
 * bad: the candidate was left with an examiner that believed it was finished,
 * and no way to tell whether to keep talking.
 *
 * The examiner's transcript is the only signal there is. Gemini reports no
 * intent, and the closing sentence is ordinary French, so this is a phrase list
 * and it is honest about being one. Two things keep that from mattering much:
 *
 *  - **It is only ever consulted mid-débat, outside a closing handshake.** The
 *    examiner has no legitimate reason to take its leave there, so the phrases
 *    below do not have to be distinguished from a real closing. The real one
 *    happens when `closing` is already true and this is never asked.
 *  - **A false positive costs one directive**, telling an examiner that was not
 *    concluding to carry on with the débat, which is what it was doing anyway.
 *    A false negative costs the candidate the rest of their épreuve.
 */

import type { TranscriptEntry } from "./transcript";

/**
 * Fold a spoken sentence down to something a fixed phrase can be found in:
 * lower case, accents stripped, and every apostrophe, dash and punctuation mark
 * turned into a space. « L'épreuve est terminée. » becomes « l epreuve est
 * terminee », so the patterns below can be written without worrying which
 * apostrophe Gemini produced or whether it accented the participle.
 */
function normalise(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * What an examiner says when it thinks the épreuve is over.
 *
 * Grouped by what each one gets wrong, because that is what a future addition
 * has to match rather than the wording:
 *
 *  - Dismissing the candidate. The observed sitting had « Vous pouvez disposer »
 *    and « vous pouvez maintenant quitter la salle ».
 *  - Declaring the épreuve, the examen or the entretien finished.
 *  - Taking leave. « Au revoir » has no other use in the middle of a débat.
 *  - Announcing a part that does not exist. The DELF B2 production orale has two
 *    parts; the model announced a third and then dismissed the candidate into it.
 */
const CLOSING_PHRASES: readonly string[] = [
  "vous pouvez disposer",
  "vous pouvez partir",
  "vous pouvez quitter",
  "quitter la salle",
  "epreuve est terminee",
  "epreuve est finie",
  "epreuve est bien terminee",
  "entretien est termine",
  "examen est termine",
  "fin de l epreuve",
  "nous avons termine",
  "nous en avons termine",
  "vous avez fini",
  "au revoir",
  "troisieme partie",
  "de votre participation",
];

/**
 * Does this examiner turn read as a goodbye?
 *
 * Called with the turn accumulated so far, not with one transcription fragment:
 * Gemini splits a sentence across fragments on its own schedule, and « vous
 * pouvez » in one and « quitter la salle » in the next is the same goodbye.
 */
export function readsAsClosing(text: string): boolean {
  const haystack = normalise(text);
  return CLOSING_PHRASES.some((phrase) => haystack.includes(phrase));
}

/**
 * How many examiner turns of the débat read as a goodbye — the most the
 * transcript can witness about the incident the count claims (#92).
 *
 * Débat examiner turns only, exactly where detection ever listened: a phrase
 * in the candidate's own mouth, or anywhere in the monologue, corroborates
 * nothing.
 */
export function countClosingTurns(
  entries: ReadonlyArray<Pick<TranscriptEntry, "phase" | "speaker" | "text">>,
): number {
  return entries.filter(
    (entry) =>
      entry.phase === "debate" && entry.speaker === "examiner" && readsAsClosing(entry.text),
  ).length;
}

/**
 * The finish route's corroboration of the client's `earlyClosingCount` claim
 * (#92): the claim, clamped to what the transcript beside it can witness.
 *
 * The claim waives the débat's penalties — including the duration penalty the
 * route measures out of the uploaded bytes precisely so no client claim can
 * reach it — and it is stored on the sitting as the record of how often the
 * examiner misbehaves. So a raw number in a payload is not taken alone, on
 * either axis:
 *
 *  - **Zero matching turns zeroes the claim.** A genuine count ALWAYS has its
 *    turn to show, because the controller read the goodbye off the very
 *    examiner turns the finish payload re-submits, with this file's own phrase
 *    list; a positive count above a transcript with no goodbye anywhere is
 *    asserting an incident its own transcript denies.
 *  - **The magnitude is capped at the matching-turn count.** The rubric only
 *    ever asks whether the count is positive, but the column is also the
 *    measure of whether #85's prompt rules work, and `count: 500` beside one
 *    real goodbye would be stored as-is — an unbounded claim in an analytics
 *    column, and past 2³¹ a number a Postgres `integer` refuses at the INSERT,
 *    failing the sender's own finish. Capped, the stored figure can never
 *    exceed the transcript's turn bound.
 *
 * The cap can UNDER-record a genuine tally by design: the controller counts
 * per spoken turn, but only a controller directive forces a turn break in the
 * transcript — so a repeat goodbye past the recovery cap, which is answered by
 * nothing, coalesces into the previous goodbye's entry and two counted
 * goodbyes become one matching turn. A clamped genuine claim stays positive,
 * which is all the waiver and the candidate's note read, and "at most what the
 * transcript shows" is the honest server-derivable magnitude.
 *
 * And be honest about what none of this can buy. `closing` does not survive
 * into the transcript, so a matching turn cannot be told from the legitimate
 * closing sentence the app itself asked for at the end of most sittings — and
 * the transcript is an artefact the client authors anyway. This is a
 * consistency floor, not a proof: it stops a claim that did not even bother to
 * tell a coherent story, and a client that miscounts through a bug. The
 * unforgeable record of the incident remains the audio, which the corrector
 * hears.
 */
export function resolveEarlyClosingCount(
  claimed: number,
  entries: ReadonlyArray<Pick<TranscriptEntry, "phase" | "speaker" | "text">>,
): number {
  return Math.min(claimed, countClosingTurns(entries));
}
