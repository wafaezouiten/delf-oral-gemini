"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/ui/class-names";
import { TOPBAR_STEPS, topbarStepView, type TopbarStepView } from "@/lib/ui/topbar-steps";
import { ArrowLeftIcon } from "./icons";

/**
 * The simulateur chrome, shared by every screen so the candidate keeps their
 * bearings: Retour and the run's identity on the left, the phase stepper in the
 * middle, and a per-screen `right` slot — the launch buttons on the sujet
 * screen, the clock and the badges on the two that follow.
 *
 * PORT NOTE: `components/po/po-simulator-topbar.tsx`, reproduced structurally.
 * The reference builds its buttons from shadcn's `<Button variant="ghost">`;
 * here Retour is a native `<button>` with this project's own classes, which is
 * the same decision `button-styles.ts` already records — keeping the element
 * native means the keyboard behaviour is the browser's, and the focus ring comes
 * from the one `:focus-visible` rule in `globals.css` rather than from a prop.
 *
 * The three step labels were the reference's exactly (`Sujet · Préparation ·
 * Passage`), tracking this app's three *screens* rather than the épreuve's
 * parts. That is no longer what they say, and the change is deliberate: folding
 * the monologue and the débat into one « Passage » told a candidate halfway
 * through the épreuve that they were on the last step, and it forced a second
 * stepper inside the scene to say which half of it they were in. The parts are
 * what the candidate is examined on, so the parts are what the stepper names —
 * and the inner one is gone rather than disagreeing with this one.
 *
 * The stepper is a `<nav>` with an ordered list inside rather than the
 * reference's row of `<div>`s: it is a summary of where in a sequence the
 * candidate is, `aria-current="step"` is the attribute for saying so, and a
 * screen reader that meets it as a list can count it.
 */

export function SimulatorTopBar({
  kicker,
  currentStep,
  onBack,
  right,
}: {
  /** Uppercase identity line, e.g. "Production orale · DELF B2 · Monologue suivi". */
  kicker: string;
  /** 0 = Préparation, 1 = Exposé, 2 = Débat. See `topbarStep`. */
  currentStep: number;
  onBack: () => void;
  right?: ReactNode;
}) {
  return (
    <header className="border-border bg-card relative z-30 flex h-14 shrink-0 items-center gap-4 border-b px-4 sm:px-5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Retour"
          className="text-muted-foreground hover:text-foreground hover:bg-muted flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-semibold transition-colors"
        >
          <ArrowLeftIcon className="size-4" />
          <span className="hidden sm:inline">Retour</span>
        </button>
        <span className="bg-border hidden h-4 w-px sm:block" aria-hidden />
        <span className="text-muted-foreground truncate text-[0.6875rem] font-semibold tracking-[0.1em] uppercase">
          {kicker}
        </span>
      </div>

      <nav aria-label="Étapes de l'épreuve" className="hidden shrink-0 lg:block">
        <ol className="flex items-center gap-1">
          {TOPBAR_STEPS.map((label, index) => (
            <li key={label} className="flex items-center gap-1">
              {index > 0 && <span className="bg-border h-px w-3" aria-hidden />}
              <Step step={topbarStepView(index, currentStep)} />
            </li>
          ))}
        </ol>
      </nav>

      <div className="flex flex-1 items-center justify-end gap-2">{right}</div>
    </header>
  );
}

// Done and to-do share a pill on purpose: the tick is what tells them apart,
// so the colour is spent on the one step that is live.
const STEP_PILL: Record<TopbarStepView["state"], string> = {
  current: "border-primary bg-primary text-primary-foreground",
  done: "border-border bg-card text-muted-foreground",
  todo: "border-border bg-card text-muted-foreground",
};

const STEP_MARKER: Record<TopbarStepView["state"], string> = {
  current: "text-primary-foreground/70",
  done: "text-muted-foreground/60",
  todo: "text-muted-foreground/60",
};

/**
 * One step's pill. Done is a tick, not merely a dimmer grey: the three states
 * have to be distinguishable without colour, which is the rule `PhaseSteps`
 * was already written under — and `topbarStepView` decides which is which.
 */
function Step({ step }: { step: TopbarStepView }) {
  return (
    <span
      aria-current={step.state === "current" ? "step" : undefined}
      className={cn(
        "flex h-6.5 items-center gap-1.5 rounded-full border px-2.5 text-[0.71875rem] font-medium",
        STEP_PILL[step.state],
      )}
    >
      <span className={cn("tabular text-[0.625rem]", STEP_MARKER[step.state])} aria-hidden>
        {step.marker}
      </span>
      {step.label}
    </span>
  );
}
