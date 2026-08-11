"use client";

import { useState } from "react";

import type { ExamEvent } from "@/lib/live/exam-controller";

/**
 * Development-only session diagnostics.
 *
 * Session resumption is invisible when it works, which makes it very hard to
 * tell "reconnected seamlessly" from "never reconnected at all". This panel is
 * the evidence trail: every connect, GoAway, resume and phase transition, with
 * the elapsed time it happened at. It is also what the acceptance test reads to
 * prove a reconnect actually occurred.
 */
export function EventLog({ events }: { events: readonly ExamEvent[] }) {
  const [open, setOpen] = useState(false);

  return (
    <details
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      className="border-border rounded-lg border text-xs"
      data-testid="event-log"
    >
      <summary className="text-muted-foreground cursor-pointer px-3 py-2 font-semibold">
        Journal de session ({events.length})
      </summary>
      <ul className="max-h-48 overflow-y-auto px-3 pb-3">
        {events.map((event, index) => (
          <li key={index} className="text-muted-foreground flex gap-3 py-0.5">
            <span className="tabular w-14 shrink-0">
              {(event.at / 1000).toFixed(1)}s
            </span>
            <span className="w-24 shrink-0">{event.phase}</span>
            <span className="text-foreground font-medium">{event.name}</span>
            {event.detail && <span className="truncate">{event.detail}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
