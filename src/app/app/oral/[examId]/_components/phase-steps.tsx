import { ORAL_PHASES, PHASE_LABELS, phaseDurationSeconds, type OralPhase } from "@/lib/delf/phases";

/**
 * Where in the épreuve the candidate is.
 *
 * The real convocation prints the three parts and their durations before the
 * candidate sits down, and a simulator that shows only the current one makes the
 * exam feel longer than it is — there is no way to tell a monologue that is
 * nearly over from one that has just started without the phase clock, and the
 * phase clock is the one thing a nervous candidate misreads.
 *
 * Order and labels come from the state machine (`lib/delf/phases.ts`) rather
 * than a list retyped here, so a phase can never appear on this rail without
 * appearing in the exam.
 *
 * `finished` is dropped: it is a terminal state, not a step, and this rail is
 * only ever on screen while the exam is running.
 */
const STEPS: readonly OralPhase[] = ORAL_PHASES.filter((phase) => phase !== "finished");

export function PhaseSteps({ current }: { current: OralPhase }) {
  const currentIndex = STEPS.indexOf(current);

  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {STEPS.map((phase, index) => {
        const done = currentIndex > index;
        const active = currentIndex === index;
        const minutes = Math.round(phaseDurationSeconds(phase) / 60);

        return (
          <li key={phase} className="flex items-center gap-2">
            <span
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold ${
                active
                  ? "bg-primary text-primary-foreground"
                  : done
                    ? "text-muted-foreground"
                    : "text-muted-foreground/60"
              }`}
              // The rail is a summary of state shown elsewhere in words; naming
              // the current step again would have a screen reader read the phase
              // three times on every transition.
              aria-current={active ? "step" : undefined}
            >
              {/* Done is a tick and not merely a dimmer grey: the three states
                  have to be distinguishable without colour. */}
              <span aria-hidden>{done ? "✓" : index + 1}</span>
              {PHASE_LABELS[phase]}
              <span className={active ? "opacity-80" : "opacity-70"}>· {minutes} min</span>
            </span>
            {index < STEPS.length - 1 && (
              <span className="text-muted-foreground/40" aria-hidden>
                →
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
