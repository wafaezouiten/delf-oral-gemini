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
 * every moment except the seconds a consigne is audible.
 *
 * There used to be a second mode, `held`: the browser had refused to autoplay
 * and the phase waited on a click, behind a panel explaining the frozen clock
 * and offering « Écouter la consigne » / « Commencer sans écouter ». That whole
 * state is gone on the user's call — a consigne the browser will not play is
 * forfeited by the controller and the épreuve carries on — so the one thing
 * this control can be is the « Passer » button, for as long as the voice lasts.
 */
export type AnnouncementControlMode = "playing";

export const ANNOUNCEMENT_COPY = {
  /**
   * While it plays. Silences this clip only; the next boundary still speaks —
   * the sticky « Couper les annonces » went with the card, and with it the one
   * control on this screen whose effect outlived the phase it was clicked in.
   */
  skip: "Passer",
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

/** What to draw for the controller's current announcement state. */
export function announcementControl(state: {
  announcementPlaying: boolean;
}): AnnouncementControlMode | null {
  return state.announcementPlaying ? "playing" : null;
}
