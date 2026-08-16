"use client";

import { SceneStepper } from "@/app/_components/po/scene-stepper";
import { UserIcon } from "@/app/_components/po/icons";
import { cn } from "@/lib/ui/class-names";
import { formatClock } from "@/lib/delf/phases";
import { activeBeat, type SpeakingPhase } from "@/lib/ui/po-player-view";

/**
 * The passation "scene": the two protagonists of the oral — the examiner on the
 * left, the candidate on the right — with the beat stepper and the running clock
 * between them. It is the fixed head of the passation, the thing that says "you
 * are in the exam room" while the épreuve runs underneath.
 *
 * PORT NOTE: `components/po/po-conversation-scene.tsx`, reproduced whole. A ring
 * pulses around whoever holds the floor, so the turn is legible at a glance; the
 * clock reads elapsed / total and drains a hairline bar.
 *
 * The clock here is **elapsed**, and that is not a duplicate of the topbar's
 * ring — the ring counts down what is left, this counts up what has been used.
 * Two different questions, which is the reason the reference keeps both and why
 * printing *remaining* in either place twice was the thing it had to remove.
 *
 * Accessibility, kept from the reference and worth its comment: this screen
 * carries no transcript by design, so the only cue that the turn changed is a
 * pulsing ring and a line of status text — both invisible to a screen reader.
 * One polite live region says it once; the visible statuses are `aria-hidden` so
 * it is not said three times. Polite rather than assertive, because a turn
 * change is worth announcing at the next pause and never worth cutting the
 * examiner off mid-sentence.
 */
export function ConversationScene({
  phase,
  examinerSpeaking,
  examinerStatus,
  candidateRecording,
  candidateStatus,
  candidateStatusUrgent = false,
  elapsed,
  total,
}: {
  phase: SpeakingPhase;
  examinerSpeaking: boolean;
  examinerStatus: string;
  candidateRecording: boolean;
  candidateStatus: string;
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

  return (
    <div className="border-border bg-card flex shrink-0 items-center gap-3 rounded-lg border p-4 sm:gap-4 sm:px-5">
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

      {/* Beat stepper + elapsed clock */}
      <div className="hidden shrink-0 flex-col items-center gap-2 sm:flex">
        <SceneStepper currentStep={activeBeat(phase)} />
        <div className="flex items-center gap-2">
          <span className="tabular text-[0.6875rem] whitespace-nowrap">
            {formatClock(elapsed)}
            <span className="text-muted-foreground"> / {formatClock(total)}</span>
          </span>
          <div
            className="bg-muted h-[5px] w-[8.125rem] overflow-hidden rounded-full"
            aria-hidden
          >
            <div
              className="bg-primary h-full rounded-full transition-[width] duration-500"
              style={{ width: `${percent}%` }}
            />
          </div>
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
