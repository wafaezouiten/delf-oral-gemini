"use client";

import { CheckCircleIcon, PlayIcon, StopIcon } from "@/app/_components/po/icons";
import { Kicker } from "@/app/_components/po/tag";
import { AudioBars } from "@/app/_components/po/audio-bars";
import { primaryButton, secondaryButton } from "@/app/_components/button-styles";
import { ANNOUNCEMENT_COPY, announcementCard } from "@/lib/ui/announcement-card";
import type { AnnouncementId } from "@/lib/delf/announcements";

/**
 * The examiner's spoken consigne, and its written equivalent (#37).
 *
 * One component for all four moments and for all three of its states, because
 * they are the same card with different controls, and because a candidate should
 * recognise it at the second boundary from having read it at the first.
 *
 * **The text is not a caption, it is the consigne.** It is the same string the
 * clip was generated from (`lib/delf/announcements.ts`), so a candidate who hears
 * none of this — muted, refused by the browser's autoplay policy, sitting
 * somewhere they cannot play sound — loses nothing at all. That is the reason the
 * card outlives its own playback: it folds down to a line, and the words stay one
 * click away for the rest of the phase.
 *
 * **When it is held, it is a decision.** A consigne the browser refused to
 * autoplay stops the phase: the clock is at its full length, nothing is being
 * recorded, and the épreuve is waiting. So that state gets the explanation and a
 * primary button, rather than the quiet strip the other two get.
 */
export function AnnouncementCard({
  announcement,
  playing,
  blocked,
  muted,
  onPlay,
  onSkip,
  onMute,
}: {
  announcement: AnnouncementId | null;
  playing: boolean;
  blocked: boolean;
  muted: boolean;
  /** « Écouter la consigne » and « Réécouter » — one controller call, because the
   *  only difference between them is whether a phase is waiting on the answer. */
  onPlay: () => void;
  onSkip: () => void;
  onMute: () => void;
}) {
  const view = announcementCard({
    announcement,
    announcementPlaying: playing,
    announcementBlocked: blocked,
    announcementsMuted: muted,
  });
  if (!view) return null;

  const { mode } = view;

  /**
   * Heard, and done with.
   *
   * A slim line rather than the card, because on the passation screen this sits
   * between the sujet's title and the document it introduces — and by then the
   * consigne has been given. It says so, and keeps the words one click away for
   * anyone who missed them. « Réécouter » is right there because a candidate who
   * mishears the instruction for a graded task should not have to wonder.
   */
  if (mode === "heard" && !muted) {
    return (
      <div className="border-border flex flex-wrap items-center gap-x-3 gap-y-1.5 border-y py-2">
        <CheckCircleIcon className="text-success size-3.5 shrink-0" aria-hidden />
        <span className="text-muted-foreground text-xs font-medium">
          {ANNOUNCEMENT_COPY.heard}
        </span>
        <details className="min-w-0 basis-full sm:basis-auto">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium">
            Afficher le texte
          </summary>
          <p className="text-foreground/85 mt-2 text-[0.8125rem] leading-relaxed">
            {view.announcement.text}
          </p>
        </details>
        <button
          type="button"
          onClick={onPlay}
          className="text-muted-foreground hover:text-foreground ml-auto flex shrink-0 items-center gap-1.5 text-[0.6875rem] font-semibold transition-colors"
        >
          <PlayIcon className="size-3" />
          {ANNOUNCEMENT_COPY.replay}
        </button>
      </div>
    );
  }

  return (
    <section
      // Politely, and only the heading. The consigne is spoken as it appears, so
      // an assertive region would read it over the voice saying the same words;
      // the text below is reachable and unannounced, exactly like the débat's
      // transcript. When it is held there is no voice, which is when being told
      // matters, and the paragraph in that branch is a live status of its own.
      aria-labelledby="announcement-title"
      className={
        mode === "held"
          ? "border-primary/40 bg-primary-subtle/40 rounded-lg border p-4"
          : "border-border bg-card rounded-lg border p-4"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Kicker>{ANNOUNCEMENT_COPY.kicker}</Kicker>
          <h2 id="announcement-title" className="mt-1 text-[0.84375rem] font-semibold">
            {view.announcement.title}
          </h2>
        </div>
        {/* The same bars the scene uses for the examiner's streamed voice. A
            consigne is the examiner talking, and it should not look like a
            different kind of event. */}
        {playing && (
          <AudioBars heightClass="h-3.5" className="text-primary mt-1 shrink-0" />
        )}
      </div>

      {view.textOpen ? (
        <p className="text-foreground/85 mt-3 text-[0.8125rem] leading-relaxed">
          {view.announcement.text}
        </p>
      ) : (
        // A native disclosure rather than React state: this component holds none,
        // and the phase it belongs to can last thirteen minutes.
        <details className="mt-2.5">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium">
            Afficher le texte de la consigne
          </summary>
          <p className="text-foreground/85 mt-2 text-[0.8125rem] leading-relaxed">
            {view.announcement.text}
          </p>
        </details>
      )}

      {mode === "held" && (
        <p role="status" className="text-foreground/85 mt-3 text-xs leading-relaxed">
          {ANNOUNCEMENT_COPY.blocked}
        </p>
      )}

      {muted && (
        <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
          {ANNOUNCEMENT_COPY.muted}
        </p>
      )}

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        {mode === "held" && (
          <>
            <button type="button" onClick={onPlay} className={primaryButton}>
              <PlayIcon className="size-3.5" />
              {ANNOUNCEMENT_COPY.play}
            </button>
            <button type="button" onClick={onSkip} className={secondaryButton}>
              {ANNOUNCEMENT_COPY.blockedSkip}
            </button>
          </>
        )}

        {mode === "playing" && (
          <button
            type="button"
            onClick={onSkip}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[0.6875rem] font-semibold transition-colors"
          >
            <StopIcon className="size-3" />
            {ANNOUNCEMENT_COPY.skip}
          </button>
        )}

        {mode === "heard" && !muted && (
          <button
            type="button"
            onClick={onPlay}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[0.6875rem] font-semibold transition-colors"
          >
            <PlayIcon className="size-3" />
            {ANNOUNCEMENT_COPY.replay}
          </button>
        )}

        {view.offerMute && (
          <button
            type="button"
            onClick={onMute}
            className="text-muted-foreground hover:text-foreground rounded-md px-2 py-1.5 text-[0.6875rem] font-medium transition-colors"
          >
            {ANNOUNCEMENT_COPY.mute}
          </button>
        )}
      </div>

      {mode !== "heard" && (
        <p className="text-muted-foreground mt-3 text-[0.6875rem] leading-relaxed">
          {ANNOUNCEMENT_COPY.footnote}
        </p>
      )}
    </section>
  );
}
