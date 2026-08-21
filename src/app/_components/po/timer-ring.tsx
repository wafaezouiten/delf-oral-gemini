"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/ui/class-names";
import { formatClock, type OralPhase } from "@/lib/delf/phases";
import {
  clockLabel,
  crossedMilestone,
  isClockUrgent,
  milestoneMessage,
} from "@/lib/ui/clock-announcements";

/**
 * The phase clock, drawn as a draining ring in the topbar.
 *
 * PORT NOTE: `components/po/po-timer-ring.tsx`. The ring, its geometry, its
 * urgency window and its position in the chrome are the reference's. What it
 * absorbs is the whole of this project's `PhaseClock`, which it replaces: the
 * `role="timer"` and its spelled-out accessible name, the milestone
 * announcements, and the word « dernière minute » beside the tint.
 *
 * That merge is the point. The reference's ring is a silent decoration around a
 * number — it has no accessible name at all, and a candidate who cannot see it
 * gets nothing. This project already solved that in #11 and the solution has to
 * survive the reskin, so the two are one component rather than a ring with a
 * hidden clock behind it.
 *
 * There is exactly ONE clock on screen, and it lives here. The reference learnt
 * that the hard way (its issue #183): a second live countdown of the same number
 * a few hundred pixels away reads as a bug rather than as emphasis. The
 * préparation rail and the passation scene both deliberately stop short of
 * printing the remaining time again — the scene prints *elapsed* over total,
 * which is a different number answering a different question.
 */

const RADIUS = 8.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Share of the phase still left, clamped to 0..1. Drives the ring's dash. */
function remainingFraction(remaining: number, total: number): number {
  if (!Number.isFinite(remaining) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, remaining / total));
}

export function TimerRing({
  remaining,
  total,
  phase,
}: {
  remaining: number;
  total: number;
  phase: OralPhase;
}) {
  const urgent = isClockUrgent(phase, remaining);
  const dashOffset = CIRCUMFERENCE * (1 - remainingFraction(remaining, total));
  const [announcement, setAnnouncement] = useState("");

  /**
   * The previous reading, kept in a ref because it drives an announcement and
   * not the render. Reset at a phase boundary: without that, the first tick of
   * the débat would be compared against the last tick of the monologue, and the
   * two clocks have nothing to say to each other.
   */
  const previous = useRef<{ phase: OralPhase; remaining: number } | null>(null);

  useEffect(() => {
    const last = previous.current;
    previous.current = { phase, remaining };
    if (!last || last.phase !== phase) return;

    const milestone = crossedMilestone(last.remaining, remaining);
    if (milestone === null) return;
    setAnnouncement(milestoneMessage(phase, milestone));
  }, [phase, remaining]);

  return (
    <>
      <div
        role="timer"
        aria-label={clockLabel(phase, remaining)}
        className={cn(
          // `relative` anchors the `sr-only` status span — absolute, and
          // without a positioned ancestor it would anchor to the document
          // and could grow the page past its content (#114).
          "relative flex shrink-0 items-center gap-1.5 rounded-full border py-1 pr-3 pl-2",
          urgent
            ? "border-danger/40 bg-danger-subtle text-danger"
            : "border-border bg-card text-foreground",
        )}
      >
        <svg viewBox="0 0 22 22" className="size-5 shrink-0" aria-hidden>
          <circle cx="11" cy="11" r={RADIUS} fill="none" strokeWidth="2.5" className="stroke-border" />
          <circle
            cx="11"
            cy="11"
            r={RADIUS}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 11 11)"
            className={cn(
              "transition-[stroke-dashoffset] duration-1000 ease-linear",
              urgent ? "stroke-danger" : "stroke-primary",
            )}
          />
        </svg>
        <span className="tabular text-[0.8125rem] font-semibold" aria-hidden>
          {formatClock(remaining)}
        </span>
        {/* The last minute is not a tint alone. In greyscale the clock still
            says so, which is the accessibility rule #11 states about tokens. */}
        {urgent && (
          <span className="text-[0.625rem] leading-none font-semibold" aria-hidden>
            dernière
            <br />
            minute
          </span>
        )}

        {/* One sentence at a time, and only at a milestone. Assertive would cut
            across the examiner mid-sentence, which is worse than arriving late.
            Inside the ring's box rather than beside it, so the box's `relative`
            is the span's anchor. */}
        <span role="status" aria-live="polite" className="sr-only">
          {announcement}
        </span>
      </div>
    </>
  );
}
