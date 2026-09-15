import type { LiveModelOption } from "@/lib/gemini/constants";

/**
 * What the pre-flight card's three rows say, decided here (#234). The card
 * asks three questions before the épreuve — is the microphone working, which
 * examiner, keep the audio — and each row is a sentence and a control whose
 * state this module chooses. The component draws them.
 */

export type MicCheckState = "idle" | "testing" | "tested" | "failed";

export interface MicRowView {
  detail: string;
  /** The level bars while testing, the green check once passed, else a button. */
  control: "bars" | "check" | "button";
  buttonLabel: "Tester" | "Réessayer";
}

const MIC_COPY: Record<MicCheckState, string> = {
  idle: "Vérifiez votre niveau d'entrée.",
  testing: "Parlez normalement…",
  tested: "Micro autorisé, vous êtes prêt.",
  failed: "Autorisez le micro, puis réessayez.",
};

export function micRow(state: MicCheckState): MicRowView {
  return {
    detail: MIC_COPY[state],
    control: state === "testing" ? "bars" : state === "tested" ? "check" : "button",
    buttonLabel: state === "failed" ? "Réessayer" : "Tester",
  };
}

export interface ExaminerRowView {
  detail: string;
  /** A sitting from before the allow-list changed can name an examiner that
   *  outlives the catalogue: shown under its raw id rather than snapped to an
   *  option it never was (#99). */
  unlisted: boolean;
}

export function examinerRow(
  model: string,
  saving: boolean,
  failed: boolean,
  choices: readonly LiveModelOption[],
): ExaminerRowView {
  const choice = choices.find((option) => option.id === model);
  return {
    // The row never advances on a failed write: what it shows is always what
    // the sitting will hear.
    detail: failed
      ? "Le choix n'a pas pu être enregistré, réessayez."
      : saving
        ? "Enregistrement du choix…"
        : (choice?.detail ?? model),
    unlisted: choice === undefined,
  };
}

export function retentionDetail(keepAudio: boolean): string {
  return keepAudio
    ? "Votre voix sera conservée avec vos résultats."
    : "Votre voix ne sera pas conservée.";
}
