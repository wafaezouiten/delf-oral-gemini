/**
 * The copy and the state behind the examiner's spoken consigne (#37, #59).
 *
 * Here rather than in the component for the reason every other `lib/ui` module
 * is: the words a candidate reads mid-épreuve, and the rule deciding which
 * controls they are offered, are both testable and neither needs a DOM to be
 * wrong in.
 *
 * **This used to be a card, and is now a button (#59).** The consigne arrived
 * wrapped in a kicker, a title, the script behind a disclosure, a « Réécouter »,
 * a « Couper les annonces » and a footnote — a panel that outlived its own
 * playback and took the top of the préparation rail with it. What a candidate
 * has to be offered while an examiner is talking is one way to stop them, so
 * that is what is left. The voice is unchanged: same clips, same order, same
 * hold at every boundary.
 *
 * **Nothing prints the script any more.** The card's argument was that the text
 * was not a caption but the consigne itself, so that a candidate who heard none
 * of it lost nothing. That fallback is gone on purpose, not by oversight — the
 * words in `lib/delf/announcements.ts` are now what the clip is spoken from and
 * nothing else.
 *
 * **« Passer » is free to be « Passer » now.** This module used to forbid it: the
 * préparation carried a ghost « Passer et commencer maintenant » which ended a
 * thirty-minute phase, and a second « Passer » beside it, silencing a twenty-five
 * second clip, would have been genuinely ambiguous. #59 deletes that ghost — the
 * only way on from the préparation is « Commencer » in the topbar — so the short
 * label is unambiguous and is the one the candidate asked for.
 */

/**
 * What the control is doing, or `null` when there is nothing to draw — which is
 * every moment except the seconds a consigne is audible or held.
 *
 * `held` is the one that is not a button on its own. It means the browser refused
 * to autoplay: nothing is audible, the phase's clock is at its full length,
 * nothing is being recorded and the épreuve is waiting on the candidate. A lone
 * « Passer » there would offer to skip a silence and leave a frozen timer
 * unexplained, so that state keeps a sentence and names both ways out.
 */
export type AnnouncementControlMode = "playing" | "held";

export const ANNOUNCEMENT_COPY = {
  /**
   * While it plays. Silences this clip only; the next boundary still speaks —
   * the sticky « Couper les annonces » went with the card, and with it the one
   * control on this screen whose effect outlived the phase it was clicked in.
   */
  skip: "Passer",
  /** After the browser refused to autoplay: the way to hear it after all. */
  play: "Écouter la consigne",
  /**
   * Shown with the two buttons below, and it has to explain a hold rather than
   * label a control. The phase genuinely has not started — the clock is at its
   * full length and nothing is being recorded — and a candidate who is not told
   * that reads the frozen timer as a bug.
   */
  blocked:
    "Votre navigateur n'a pas autorisé la lecture automatique. L'épreuve attend : écoutez la consigne, ou passez à la suite sans l'écouter.",
  /** The other way out of a hold. Names what it starts, so it cannot be read as
   *  the audio-only skip above. */
  blockedSkip: "Commencer sans écouter",
  /**
   * Said once, politely, while the clip plays.
   *
   * The card carried a heading naming the examiner; a bare button carries
   * nothing, and « Passer » alone tells a screen-reader user neither who is
   * speaking nor what would be skipped. This is the whole of what the card said
   * out loud, and it is said in the same place the visible button appears.
   */
  speaking: "L'examinateur donne la consigne.",
} as const;

/**
 * What to draw for the controller's current announcement state.
 *
 * `held` outranks `playing` deliberately: the two flags can both be set for a
 * tick around a refusal, and the state that matters is the one the épreuve is
 * waiting in.
 */
export function announcementControl(state: {
  announcementPlaying: boolean;
  announcementBlocked: boolean;
}): AnnouncementControlMode | null {
  if (state.announcementBlocked) return "held";
  if (state.announcementPlaying) return "playing";
  return null;
}
