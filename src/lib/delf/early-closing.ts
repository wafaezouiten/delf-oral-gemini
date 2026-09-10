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
 *
 * That pricing predates #92, which raised the stake: the count this detection
 * feeds now waives the débat's penalties, so a false positive — an examiner
 * whose « merci de votre participation » was praise rather than dismissal —
 * also excuses a débat that then falls short, of a halving or a −3 it would
 * otherwise have taken. Chosen knowingly when the waiver was decided (#92):
 * the borderline sitting is one where the examiner said something a candidate
 * could reasonably hear as the end, and pricing that doubt against the
 * candidate is the mistake the waiver exists to stop. The list stays broad;
 * what changed is that additions to it should now weigh a waived penalty, not
 * just a spare directive.
 *
 * There are three lists now rather than one, because a later sitting produced
 * two goodbyes neither broad nor narrow wording could have caught together:
 * {@link CLOSING_PHRASES} reads as a goodbye unconditionally,
 * {@link WRAPPING_UP_PHRASES} only while the app has not itself authorised an
 * end-of-débat announcement, and {@link CLOSING_THANKS_PHRASES} only on a
 * completed turn that asks nothing. Each list's doc says which failure it was
 * written for and what its condition buys.
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
 *
 * These read as a goodbye whatever surrounds them and whatever the app has
 * already authorised, which is what separates them from the two lists below.
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
 * Telling the candidate the débat is ending — which is a goodbye when nobody
 * asked for it, and the app's own words when somebody did.
 *
 * The sitting in #213 produced « Nous arrivons au terme de notre débat » at 4:56 of
 * thirteen minutes and « Nous arrivons à la fin de cet échange » at 9:39, and
 * neither was on any list: the model was winding the exchange up twice, out
 * loud, to a candidate who had eight minutes and then three left. Announcing
 * the end early is not the same failure as walking out — the model asked one
 * more question each time — but it is the same lie told to the candidate, and
 * the candidate cannot tell them apart. `resumeDebateInstruction` is the right
 * answer to both.
 *
 * **Gated on the last question having been announced, and that gate is the
 * whole design.** `lastQuestionInstruction` asks for exactly this sentence —
 * « Nous arrivons à la fin de cet entretien. Une dernière question : … » — in
 * the closing two minutes, and contradicting the announcement the app itself
 * ordered would be the app arguing with its own directive in front of the
 * candidate. So these phrases count only while the announcement is still
 * pending. Before it, « nous arrivons à la fin » is false; after it, it is
 * true, and `examiner-prompt.ts` is where the wording it is allowed to take
 * lives.
 *
 * The same gate is why « touche à sa fin » can be listed at all: it is the
 * directive's own opening words, and a model that echoes them can only do so
 * after the directive has been sent.
 */
const WRAPPING_UP_PHRASES: readonly string[] = [
  "nous arrivons au terme",
  "nous en arrivons au terme",
  "nous arrivons a la fin",
  "nous en arrivons a la fin",
  "nous approchons de la fin",
  "touche a sa fin",
  "nous allons conclure",
  "il est temps de conclure",
];

/**
 * Thanking the candidate and stopping — the quietest way to abandon a débat,
 * and the one that needs a whole turn to recognise.
 *
 * The sitting in #213, twice: « Vous proposez donc une approche globale pour évaluer
 * l'ensemble des impacts de cette mesure. Je vous remercie. » at 5:33, and the
 * same shape again at 7:10. Summary, thanks, silence — no dismissal, no « au
 * revoir », nothing the list above could see. The candidate answered the second
 * one with « Mais il en reste 7 minutes, non ? », which is the reader doing the
 * app's job for it.
 *
 * **Only when the turn asks nothing, and only once the turn is whole.** « Je
 * vous remercie pour cette précision, mais ne pensez-vous pas que… ? » is an
 * examiner being polite mid-objection, and contradicting it would send
 * `resumeDebateInstruction` — « enchaîne immédiatement avec une nouvelle
 * objection » — on top of a question just asked, which is the two-questions-in-
 * a-row hazard #193 exists to prevent. The discriminator is that a wrap-up
 * hands the floor back with nothing to answer, so a question mark anywhere in
 * the turn disqualifies it. That reading is only sound on a COMPLETED turn:
 * mid-turn, the question mark has not arrived yet. Hence `turnComplete`, and
 * hence the controller running this reading at the turn boundary rather than
 * on every fragment.
 *
 * The genuine closing says « je vous remercie » too — `closingInstruction`
 * asks for it in so many words — and is not a false positive here for the
 * reason the whole file is only ever consulted outside a closing handshake.
 */
const CLOSING_THANKS_PHRASES: readonly string[] = [
  "je vous remercie",
  "merci pour cet echange",
  "merci pour ce debat",
  "merci pour cette discussion",
];

/** How the caller says what the app has already authorised, and how much of a
 *  turn it is holding. See each phrase list for what its flag buys. */
export interface ClosingReadOptions {
  /**
   * Whether `lastQuestionInstruction` has gone out. Defaults to false, the
   * broadest reading: a caller that cannot know — the finish route, reading a
   * stored transcript — only ever CAPS a claim with what it finds, so reading
   * more turns as goodbyes there can never invent one.
   */
  lastQuestionAnnounced?: boolean;
  /** Whether `text` is a whole examiner turn rather than the fragments of one
   *  so far. Defaults to false; only {@link CLOSING_THANKS_PHRASES} reads it. */
  turnComplete?: boolean;
}

/**
 * Does this examiner turn read as a goodbye?
 *
 * Called with the turn accumulated so far, not with one transcription fragment:
 * Gemini splits a sentence across fragments on its own schedule, and « vous
 * pouvez » in one and « quitter la salle » in the next is the same goodbye.
 */
export function readsAsClosing(text: string, options: ClosingReadOptions = {}): boolean {
  const haystack = normalise(text);
  if (CLOSING_PHRASES.some((phrase) => haystack.includes(phrase))) return true;
  if (
    !options.lastQuestionAnnounced &&
    WRAPPING_UP_PHRASES.some((phrase) => haystack.includes(phrase))
  ) {
    return true;
  }
  if (!options.turnComplete || asksSomething(text)) return false;
  return CLOSING_THANKS_PHRASES.some((phrase) => haystack.includes(phrase));
}

/**
 * Is there a question anywhere in this turn?
 *
 * The question mark and nothing cleverer. Gemini's transcription punctuates
 * its own output reliably, and every alternative — interrogative openers,
 * inversion, « est-ce que » — is a French grammar exercise whose failures land
 * on the side that sends a spurious directive. A missed question mark costs a
 * wrap-up that goes uncontradicted, which is the failure the app already had.
 */
function asksSomething(text: string): boolean {
  return text.includes("?");
}

/**
 * How many examiner turns of the débat read as a goodbye — the most the
 * transcript can witness about the incident the count claims (#92).
 *
 * Débat examiner turns only, exactly where detection ever listened: a phrase
 * in the candidate's own mouth, or anywhere in the monologue, corroborates
 * nothing.
 *
 * Read at the WIDEST setting the options allow — whole turns, and no last
 * question ever announced — which is deliberate and is safe in exactly one
 * direction. A stored transcript says nothing about when the app's directives
 * went out, so this cannot reconstruct the reading the controller made; and it
 * does not need to, because {@link resolveEarlyClosingCount} only ever CAPS the
 * client's claim with this number. Reading more turns as goodbyes here can
 * loosen a cap; it can never invent a goodbye the controller did not count. A
 * narrower reading could do the opposite — clamp away a genuine incident
 * because the stored text no longer shows what the live socket heard.
 */
export function countClosingTurns(
  entries: ReadonlyArray<Pick<TranscriptEntry, "phase" | "speaker" | "text">>,
): number {
  return entries.filter(
    (entry) =>
      entry.phase === "debate" &&
      entry.speaker === "examiner" &&
      readsAsClosing(entry.text, { turnComplete: true }),
  ).length;
}

/**
 * The finish route's corroboration of the client's `earlyClosingCount` claim
 * (#92): the claim, clamped to what the transcript beside it can witness.
 *
 * The claim waives the débat's penalties and is stored on the sitting as the
 * record of how often the examiner misbehaves. So a raw number in a payload is
 * not taken alone, on either axis:
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
 * WHAT THIS DOES NOT DO: stop a forger. The transcript is client-authored in
 * the same request, so whoever sets `earlyClosingCount: 1` can paste the
 * matching examiner turn beside it, and this function will pass the claim —
 * fabricated text alone waives penalties otherwise anchored to measured audio.
 * That is ACCEPTED with #92, not overlooked, for two reasons. First, there is
 * no stronger witness to check against: the browser is the only observer of
 * the Live session — transcript, recordings and clocks all originate there —
 * and moving the count to a mid-sitting progress write would be the same
 * client asserting the same fact earlier, an effort bar rather than ground
 * truth. Second, the blast radius is the sender's own practice score: this is
 * a self-study tool, not a certification body, and every write is scoped to
 * the candidate's own sitting. What the clamp actually buys is narrower and
 * real — a claim must tell a coherent story (which also catches a client that
 * miscounts through a bug), and the stored figure is bounded. A test pins the
 * forgeable case by name, so a future reader finds a decision here, not a gap;
 * if that guarantee is ever needed, the fix is a different witness, not a
 * sharper phrase list.
 */
export function resolveEarlyClosingCount(
  claimed: number,
  entries: ReadonlyArray<Pick<TranscriptEntry, "phase" | "speaker" | "text">>,
): number {
  return Math.min(claimed, countClosingTurns(entries));
}
