/** The épreuve's three steps, as the simulator's top bar names them. */
export const TOPBAR_STEPS = ["Préparation", "Exposé", "Débat"] as const;

export type TopbarStepState = "done" | "current" | "todo";

export interface TopbarStepView {
  label: string;
  state: TopbarStepState;
  /** A tick once done, the step's number otherwise — the three states have to
   *  be distinguishable without colour. */
  marker: string;
}

export function topbarStepView(index: number, currentStep: number): TopbarStepView {
  const label = TOPBAR_STEPS[index] ?? "";
  if (index < currentStep) return { label, state: "done", marker: "✓" };
  if (index === currentStep) return { label, state: "current", marker: String(index + 1) };
  return { label, state: "todo", marker: String(index + 1) };
}
