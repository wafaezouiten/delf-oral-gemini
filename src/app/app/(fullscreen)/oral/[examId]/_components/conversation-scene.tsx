"use client";

import { UserIcon } from "@/app/_components/po/icons";
import { cn } from "@/lib/ui/class-names";
import { formatClock } from "@/lib/delf/phases";

/**
 * The débat's two protagonists: the examiner on the left, the candidate on the
 * right, a ring pulsing around whoever holds the floor (#60).
 *
 * PORT NOTE: `components/po/po-conversation-scene.tsx`. It was reproduced whole
 * in #34, deleted in #37 with the rest of the avatar layout, and is back here
 * for the débat alone — this is that file minus its beat stepper.
 *
 * **Why it came back.** The débat printed its exchange and nothing else (#48):
 * a candidate being argued with could re-read the objection, and had no cue at
 * all for whose turn it was except text appearing. This answers that question
 * and only that one — the exchange is under it (`DebateConversation`), and the
 * two together are what the screen is. The room comes from the document, which
 * the débat no longer prints.
 *
 * **The inner stepper did not come back with it.** `SceneStepper` named the two
 * beats — Exposé, Débat — between the two faces, and the topbar's stepper names
 * the épreuve's three parts since #37. Two steppers disagreeing about what step
 * the candidate is on is the reason the inner one was deleted, and none of that
 * changed.
 *
 * **It sticks to the top of the column while the exchange scrolls (#88).** The
 * screen kept one scroller and this row got `position: sticky` — the sujet's
 * document scrolls away above it, the turns scroll away beneath it, and the one
 * thing that answers « whose turn is it » stays where it can be read. The
 * stickiness is applied where the row is placed (`passation-screen.tsx`) rather
 * than here: this component is the two faces and their statuses, and it is the
 * screen's business how far up the page they are.
 *
 * **The clock here is elapsed, and that is not a duplicate of the topbar's.**
 * The ring counts down what is left; this counts up what has been used. Two
 * different questions, which is why the reference keeps both, and why printing
 * *remaining* twice was the thing it had to remove.
 *
 * **Accessibility, and it is load-bearing.** A pulsing ring and a line of status
 * text are both invisible to a screen reader, and the conversation below is
 * deliberately *not* a live region — announcing every partial fragment would
 * recite the examiner over the examiner. So this is the screen's one
 * announcement of a turn change: a single polite region, with the visible
 * statuses `aria-hidden` so it is not said three times. Polite rather than
 * assertive, because a turn change is worth announcing at the next pause and
 * never worth cutting the examiner off mid-sentence.
 */
export function ConversationScene({
  examinerSpeaking,
  examinerStatus,
  candidateRecording,
  candidateStatus,
  candidateStatusUrgent = false,
  elapsed,
  total,
}: {
  examinerSpeaking: boolean;
  examinerStatus: string;
  candidateRecording: boolean;
  candidateStatus: string;
  /** The last minute. Turns the candidate's line red, and nothing else. */
  candidateStatusUrgent?: boolean;
  elapsed: number;
  total: number;
}) {
  const percent =
    total <= 0 ? 0 : Math.min(100, Math.round((Math.min(elapsed, total) / total) * 100));

  const turnAnnouncement = examinerSpeaking
    ? `L'examinateur parle. ${examinerStatus}`
    : candidateRecording
      ? `À vous de parler. ${candidateStatus}`
      : examinerStatus;

  // `relative` on the row anchors the `sr-only` span — absolute, and without
  // a positioned ancestor it would anchor to the document and grow the page
  // by the column's scroll distance (#114).
  return (
    <div className="border-border bg-card relative flex shrink-0 items-center gap-3 rounded-lg border p-4 sm:gap-4 sm:px-5">
      <span aria-live="polite" className="sr-only">
        {turnAnnouncement}
      </span>

      {/* Examiner */}
      <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:gap-3">
        <SpeakerFace active={examinerSpeaking} tone="examiner" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[0.8125rem] font-bold whitespace-nowrap">Examinateur</span>
            <span className="text-primary bg-primary-subtle rounded-md px-1.5 py-0.5 text-[0.625rem] font-semibold">
              IA
            </span>
          </div>
          <p aria-hidden className="text-muted-foreground mt-0.5 truncate text-[0.71875rem]">
            {examinerStatus}
          </p>
        </div>
      </div>

      {/* Elapsed clock */}
      <div className="hidden shrink-0 flex-col items-center gap-1.5 sm:flex">
        <span className="tabular text-[0.6875rem] whitespace-nowrap">
          {formatClock(elapsed)}
          <span className="text-muted-foreground"> / {formatClock(total)}</span>
        </span>
        <div className="bg-muted h-[5px] w-[8.125rem] overflow-hidden rounded-full" aria-hidden>
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {/* Candidate */}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2.5 sm:gap-3">
        <div className="min-w-0 text-right">
          <p className="text-[0.8125rem] font-bold whitespace-nowrap">Vous</p>
          <p
            aria-hidden
            className={cn(
              "mt-0.5 truncate text-[0.71875rem]",
              candidateStatusUrgent ? "text-danger" : "text-muted-foreground",
            )}
          >
            {candidateStatus}
          </p>
        </div>
        <SpeakerFace active={candidateRecording} tone="candidate" />
      </div>
    </div>
  );
}

/**
 * One protagonist's avatar, with a ring that pulses while they hold the floor.
 *
 * The ring is the reference's `motion.span` as a CSS class — see `.po-ring` in
 * globals.css for why that swap is deliberate rather than a shortcut.
 */
function SpeakerFace({
  active,
  tone,
}: {
  active: boolean;
  tone: "examiner" | "candidate";
}) {
  return (
    <span className="relative size-11 shrink-0 sm:size-[2.875rem]" aria-hidden>
      {active && (
        <span
          className={cn(
            "po-ring absolute inset-0 rounded-full border-2",
            tone === "examiner" ? "border-primary" : "border-danger",
          )}
        />
      )}
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center rounded-full",
          tone === "examiner"
            ? "bg-primary-subtle text-primary"
            : // The candidate's own face goes red while their microphone is
              // live, matching the recording badge rather than the brand: on
              // this screen the question the colour answers is "am I being
              // recorded?", and there is one answer to it in this product.
              active
              ? "bg-danger-subtle text-danger"
              : "bg-muted text-muted-foreground",
        )}
      >
        <UserIcon className="size-5" />
      </span>
    </span>
  );
}
