import type { ResetOutcome } from "@/lib/account/reset";
import { pendingLabel } from "@/lib/ui/action-label";

/**
 * Why a reset did not happen, in the candidate's words. The three are told
 * apart because they ask for three different things: wait, sign in again, or
 * simply try again.
 */
export function resetFailure(outcome: Extract<ResetOutcome, { reset: false }>): string {
  if (outcome.reason === "unreachable") {
    return "Votre connexion n'a pas permis d'enregistrer la réinitialisation. Réessayez.";
  }
  if (outcome.status === 401) return "Votre session a expiré. Reconnectez-vous, puis réessayez.";
  return "La réinitialisation n'a pas pu être enregistrée. Réessayez dans un instant.";
}

/** What a reset archived, said after — where it is a fact rather than a promise. */
export function archivedMessage(archived: number): string {
  if (archived === 0) return "Il n'y avait aucune épreuve à archiver.";
  if (archived === 1)
    return "1 épreuve est passée aux archives. Vous la retrouvez dans l'historique.";
  return `${archived} épreuves sont passées aux archives. Vous les retrouvez dans l'historique.`;
}

/** The one slot under the button, and the three things it can say. */
export type ResetSlot =
  | { kind: "failed"; text: string }
  | { kind: "archived"; text: string }
  | { kind: "idle"; text: string };

export function resetSlot(failed: string | null, archived: number | null): ResetSlot {
  if (failed) return { kind: "failed", text: failed };
  if (archived !== null) return { kind: "archived", text: archivedMessage(archived) };
  // The whole warning — and it says *archive* rather than *supprime*, which is
  // the one thing a candidate has to know before pressing.
  return {
    kind: "idle",
    text: "Archive vos épreuves passées et remet vos tableaux de bord à zéro.",
  };
}

export function resetButtonLabel(pending: boolean, failed: boolean): string {
  return pendingLabel({ pending, failed }, { idle: "Réinitialiser", pending: "Réinitialisation…" });
}
