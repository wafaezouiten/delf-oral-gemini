"use client";

import { PlayIcon } from "@/app/_components/po/icons";
import { primaryButton, secondaryButton } from "@/app/_components/button-styles";
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
 * **The held state is the exception, and it is not cosmetic.** A consigne the
 * browser refused to autoplay stops the phase: the clock is at its full length,
 * nothing is being recorded, and the épreuve is waiting on a click. A lone
 * « Passer » would offer to silence a silence and leave the frozen timer
 * unexplained, so that branch keeps its sentence and names both ways out.
 *
 * One component for all four moments, as before: they are the same button, and
 * the two controller calls behind it should not be written down twice.
 */
export function AnnouncementControl({
  playing,
  blocked,
  onPlay,
  onSkip,
}: {
  playing: boolean;
  blocked: boolean;
  /** « Écouter la consigne » — the way out of a hold that hears it after all. */
  onPlay: () => void;
  /** Silences this clip. The next boundary still speaks. */
  onSkip: () => void;
}) {
  const mode = announcementControl({
    announcementPlaying: playing,
    announcementBlocked: blocked,
  });
  if (!mode) return null;

  if (mode === "held") {
    return (
      <section
        aria-label={ANNOUNCEMENT_COPY.speaking}
        className="border-primary/40 bg-primary-subtle/40 rounded-lg border p-4"
      >
        {/* A live status rather than a heading: there is no voice in this state,
            being told is the whole of what the branch does, and it is what says
            why the timer has not moved. */}
        <p role="status" className="text-foreground/85 text-xs leading-relaxed">
          {ANNOUNCEMENT_COPY.blocked}
        </p>

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <button type="button" onClick={onPlay} className={primaryButton}>
            <PlayIcon className="size-3.5" />
            {ANNOUNCEMENT_COPY.play}
          </button>
          <button type="button" onClick={onSkip} className={secondaryButton}>
            {ANNOUNCEMENT_COPY.blockedSkip}
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="flex justify-end">
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
