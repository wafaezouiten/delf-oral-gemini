"use client";

import { ANNOUNCEMENT_COPY, announcementControl } from "@/lib/ui/announcement-control";

/**
 * The one control the examiner's spoken consigne is allowed on screen (#37, #59).
 *
 * **It is a button now, and it used to be a card.** The consigne arrived inside a
 * panel — kicker, title, the script behind a disclosure, « Réécouter », « Couper
 * les annonces », a footnote — which stayed for the whole phase and, on the
 * préparation, sat at the top of the rail. The words are spoken; a candidate
 * listening to them needs one thing, which is the way to stop listening. So
 * while a clip plays this is « Passer » and nothing else, and when it is over it
 * is nothing at all. `lib/ui/announcement-control.ts` records what that cost and
 * why it was accepted.
 *
 * **The held panel is gone (user's call).** A consigne the browser refused to
 * autoplay used to stop the phase behind a paragraph and two buttons; the
 * controller now forfeits it and moves on, so the refusal never reaches this
 * component — there is nothing playing, and nothing is drawn.
 *
 * One component for all four moments, as before: they are the same button, and
 * the controller call behind it should not be written down twice.
 */
export function AnnouncementControl({
  playing,
  onSkip,
}: {
  playing: boolean;
  /** Silences this clip. The next boundary still speaks. */
  onSkip: () => void;
}) {
  const mode = announcementControl({ announcementPlaying: playing });
  if (!mode) return null;

  // `relative` anchors the `sr-only` span — absolute, and without a
  // positioned ancestor it would anchor to the document and grow the page by
  // the rail's scroll distance (#114).
  return (
    <div className="relative flex shrink-0 justify-end">
      {/* Politely, and once. The visible button says « Passer » and names no
          speaker; this is the whole of what the card's heading used to say, in
          the place the button appears. Polite rather than assertive because the
          consigne is being spoken as this renders — an assertive region would
          read it over the voice it is describing. */}
      <span aria-live="polite" className="sr-only">
        {ANNOUNCEMENT_COPY.speaking}
      </span>
      <button
        type="button"
        onClick={onSkip}
        className="border-border text-muted-foreground hover:text-foreground hover:bg-muted rounded-md border px-3 py-1.5 text-[0.6875rem] font-semibold transition-colors"
      >
        {ANNOUNCEMENT_COPY.skip}
      </button>
    </div>
  );
}
