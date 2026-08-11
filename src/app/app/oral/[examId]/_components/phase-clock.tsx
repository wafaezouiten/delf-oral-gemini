import { formatClock, type OralPhase } from "@/lib/delf/phases";

/**
 * The per-phase countdown. Deliberately shows the phase's own remaining time,
 * never a total exam clock: the candidate needs to know how long they have left
 * to speak in THIS task.
 */
export function PhaseClock({ remaining, phase }: { remaining: number; phase: OralPhase }) {
  const urgent = remaining <= 60 && phase !== "preparation";

  return (
    <div
      className={`tabular rounded-lg px-3 py-1.5 text-lg font-semibold ${
        urgent ? "bg-warning-subtle text-warning" : "bg-muted"
      }`}
      aria-label={`Temps restant : ${formatClock(remaining)}`}
    >
      {formatClock(remaining)}
    </div>
  );
}
