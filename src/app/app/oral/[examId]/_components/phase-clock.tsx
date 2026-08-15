"use client";

import { useEffect, useRef, useState } from "react";

import { formatClock, type OralPhase } from "@/lib/delf/phases";
import {
  clockLabel,
  crossedMilestone,
  isClockUrgent,
  milestoneMessage,
} from "@/lib/ui/clock-announcements";

/**
 * The per-phase countdown. Deliberately shows the phase's own remaining time,
 * never a total exam clock: the candidate needs to know how long they have left
 * to speak in THIS task.
 *
 * Three things make it usable without sight, and all three are requirements of
 * #11 rather than decoration:
 *
 *  - **The digits are not a live region.** They carry `role="timer"` and an
 *    accessible name that spells out the phase and the time, so a candidate can
 *    go and read the clock whenever they want.
 *  - **Milestones are announced, the seconds are not.** The polite region below
 *    receives one sentence when the clock crosses ten, five, two, one minutes,
 *    thirty seconds and zero. `crossedMilestone` decides; see
 *    `lib/ui/clock-announcements.ts` for why that is a crossing and not an
 *    equality.
 *  - **The last minute is not amber alone.** The colour changes and the word
 *    « dernière minute » appears with it. In greyscale the clock still says so.
 */
export function PhaseClock({ remaining, phase }: { remaining: number; phase: OralPhase }) {
  const urgent = isClockUrgent(phase, remaining);
  const [announcement, setAnnouncement] = useState("");

  /**
   * The previous reading, kept in a ref because it drives an announcement and
   * not the render. It is reset at a phase boundary: without that, the first
   * tick of the débat would be compared against the last tick of the monologue,
   * and the two clocks have nothing to say to each other.
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
        className={`flex items-center gap-2 rounded-md border px-3 py-1.5 ${
          urgent
            ? "border-warning/40 bg-warning-subtle text-warning"
            : "border-border bg-card text-foreground"
        }`}
      >
        <span className="tabular text-lg leading-none font-semibold" aria-hidden>
          {formatClock(remaining)}
        </span>
        {urgent && (
          <span className="text-[0.6875rem] leading-tight font-semibold" aria-hidden>
            dernière
            <br />
            minute
          </span>
        )}
      </div>

      {/* One sentence at a time, and only at a milestone. Assertive would cut
          across the examiner mid-sentence, which is worse than arriving a beat
          late. */}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
