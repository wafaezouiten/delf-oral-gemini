/**
 * The copy and the state machine behind the spoken consigne's card (#37).
 *
 * Here rather than in the component for the reason every other `lib/ui` module
 * is: the words a candidate reads mid-épreuve, and the rule deciding which
 * controls they are offered, are both testable and neither needs a DOM to be
 * wrong in.
 *
 * The labels are the careful part. `PreparationScreen` already carries a ghost
 * button reading « Passer et commencer maintenant », which ends a thirty-minute
 * phase. A second control reading « Passer » that silenced a twenty-five second
 * clip would be genuinely ambiguous, and the two are on screen at the same time.
 * So nothing here says « Passer » on its own: the audio controls name the audio.
 */

import { ANNOUNCEMENTS, type Announcement, type AnnouncementId } from "@/lib/delf/announcements";

export const ANNOUNCEMENT_COPY = {
  kicker: "Consigne de l'examinateur",
  /** While it plays. Silences this clip only; the next phase still speaks. */
  skip: "Passer l'annonce",
  /** Sticky, for the rest of the sitting. See `ExamController.muteAnnouncements`. */
  mute: "Couper les annonces",
  /**
   * The collapsed card, once the consigne is over.
   *
   * It states what happened rather than naming a control, because that is the
   * question a candidate arriving at a part actually has: the examiner said
   * something, is that dealt with? Two words answer it, and the text is one click
   * behind them.
   */
  heard: "Consigne écoutée.",
  /** Once it has been heard. */
  replay: "Réécouter la consigne",
  /** After the browser refused to autoplay: the way to hear it after all. */
  play: "Écouter la consigne",
  /**
   * Shown with the button above, and it has to explain a hold rather than just
   * label a control. The phase genuinely has not started — the clock is at its
   * full length and nothing is being recorded — and a candidate who is not told
   * that reads the frozen timer as a bug.
   */
  blocked:
    "Votre navigateur n'a pas autorisé la lecture automatique. L'épreuve attend : écoutez la consigne, ou passez à la suite sans l'écouter.",
  /** The other way out of a hold. Names what it starts, so it cannot be read as
   *  the audio-only skip above. */
  blockedSkip: "Commencer sans écouter",
  /** Under the text, once. Says the two things a candidate needs to know about a
   *  voice they may have missed: nothing is lost, and it is not being graded. */
  footnote:
    "La consigne est reprise ci-dessus par écrit. Elle n'est ni enregistrée ni évaluée : votre temps de parole commence après.",
  /** Print, not speech: the muted state still shows the words. */
  muted: "Annonces coupées pour cette épreuve. Le texte reste affiché.",
} as const;

/**
 * What the card is doing.
 *
 * `held` is the one that is not cosmetic. It means the épreuve is waiting on the
 * candidate, so the card is a decision rather than a notice, and the caller draws
 * it as the primary thing on screen.
 */
export type AnnouncementCardMode = "playing" | "held" | "heard";

export interface AnnouncementCardView {
  announcement: Announcement;
  mode: AnnouncementCardMode;
  /** Whether the full text is printed rather than folded behind a disclosure.
   *  Open whenever the candidate might be reading instead of listening. */
  textOpen: boolean;
  /** Whether « Couper les annonces » is worth offering. Not once they have. */
  offerMute: boolean;
}

/**
 * The card for the current state, or null when there is nothing to draw.
 *
 * Null before the first consigne of the sitting, and never again after: a
 * consigne stays on screen for the phase it governs, because it is the written
 * equivalent of something the candidate may not have heard.
 */
export function announcementCard(state: {
  announcement: AnnouncementId | null;
  announcementPlaying: boolean;
  announcementBlocked: boolean;
  announcementsMuted: boolean;
}): AnnouncementCardView | null {
  if (!state.announcement) return null;

  const mode: AnnouncementCardMode = state.announcementBlocked
    ? "held"
    : state.announcementPlaying
      ? "playing"
      : "heard";

  return {
    announcement: ANNOUNCEMENTS[state.announcement],
    mode,
    // Folded away only once the consigne has been heard and there is a phase to
    // get on with. A held or playing card is the thing to be reading.
    textOpen: mode !== "heard" || state.announcementsMuted,
    offerMute: !state.announcementsMuted && mode !== "heard",
  };
}
