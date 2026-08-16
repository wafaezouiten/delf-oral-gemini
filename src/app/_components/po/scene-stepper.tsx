import { cn } from "@/lib/ui/class-names";

/**
 * The passation's inner stepper: the épreuve's spoken turn walks through two
 * named beats — an Exposé, then a Débat — and this row of pills lights the one
 * the candidate is in. It sits in the scene header, between the two faces.
 *
 * PORT NOTE: `components/po/po-scene-stepper.tsx`. It is NOT the top-level
 * stepper drawn by `SimulatorTopBar` — that one tracks the three screens; this
 * one tracks the beats inside the passation. The reference has to say the same
 * thing in its own header, which is a fair sign the distinction needs saying.
 *
 * The reference's version takes an arbitrary `steps` array because its
 * catalogue has parts with one beat and parts with two. Here the two beats are
 * the épreuve, so they are a constant and this takes only which one is live.
 */

const BEATS = ["Exposé", "Débat"] as const;

export function SceneStepper({
  currentStep,
  className,
}: {
  /** 0 = Exposé, 1 = Débat. */
  currentStep: number;
  className?: string;
}) {
  return (
    <ol className={cn("flex items-center gap-1.5", className)} aria-label="Étape de la passation">
      {BEATS.map((label, index) => {
        const active = index === currentStep;
        const done = index < currentStep;
        return (
          <li key={label} className="flex items-center gap-1.5">
            {index > 0 && <span className="bg-border h-px w-3.5" aria-hidden />}
            <span
              aria-current={active ? "step" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[0.6875rem] font-semibold whitespace-nowrap transition-colors",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : done
                    ? "border-border bg-muted text-muted-foreground"
                    : "border-border bg-card text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "tabular",
                  active ? "text-primary-foreground/70" : "text-muted-foreground/60",
                )}
                aria-hidden
              >
                {done ? "✓" : index + 1}
              </span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
