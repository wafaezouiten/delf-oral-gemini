"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/ui/class-names";
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
 * The three step labels are the reference's exactly (`Sujet · Préparation ·
 * Passage`), and they are deliberately NOT this project's four phase names.
 * They track the three *screens*: the monologue and the débat are one screen —
 * the passation — with their own inner stepper drawn by `SceneStepper`. Naming
 * the phases here instead would give the candidate two steppers disagreeing
 * about how many steps there are.
 *
 * The stepper is a `<nav>` with an ordered list inside rather than the
 * reference's row of `<div>`s: it is a summary of where in a sequence the
 * candidate is, `aria-current="step"` is the attribute for saying so, and a
 * screen reader that meets it as a list can count it.
 */

const STEP_LABELS = ["Sujet", "Préparation", "Passage"] as const;

export function SimulatorTopBar({
  kicker,
  currentStep,
  onBack,
  right,
}: {
  /** Uppercase identity line, e.g. "Production orale · DELF B2 · Monologue suivi". */
  kicker: string;
  /** 0 = Sujet, 1 = Préparation, 2 = Passage. */
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
          {STEP_LABELS.map((label, index) => {
            const current = index === currentStep;
            const done = index < currentStep;
            return (
              <li key={label} className="flex items-center gap-1">
                {index > 0 && <span className="bg-border h-px w-3" aria-hidden />}
                <span
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "flex h-6.5 items-center gap-1.5 rounded-full border px-2.5 text-[0.71875rem] font-medium",
                    current
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-muted-foreground",
                  )}
                >
                  {/* Done is a tick, not merely a dimmer grey: the three states
                      have to be distinguishable without colour, which is the
                      rule `PhaseSteps` was already written under. */}
                  <span
                    className={cn(
                      "tabular text-[0.625rem]",
                      current ? "text-primary-foreground/70" : "text-muted-foreground/60",
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
      </nav>

      <div className="flex flex-1 items-center justify-end gap-2">{right}</div>
    </header>
  );
}
