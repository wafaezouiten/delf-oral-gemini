"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { secondaryButton } from "@/app/_components/button-styles";
import { requestRecordReset } from "@/lib/account/reset";

/**
 * « Réinitialiser ma progression » — the control, its confirmation and what it
 * says after (#69).
 *
 * It sits in the page header, opposite the title, rather than anywhere in the
 * account card below it. Two reasons, and the second is the one that decided it:
 * it is not an account setting — it touches nothing Clerk owns — and Clerk's
 * card is tall enough that a control under it opens below the fold, where nobody
 * scrolls to find it.
 *
 * So the header shows a button and nothing else, and the explanation arrives
 * with the confirmation instead of sitting on the screen permanently. That is
 * the right way round for a control whose copy is entirely about consequences: a
 * candidate who is not pressing it does not need the paragraph, and one who is
 * needs it right then.
 *
 * A panel rather than a `<dialog>`. The exit dialog interrupts an épreuve in
 * progress and has to; this interrupts nothing, and a modal for a control the
 * candidate came to this page to use is a ceremony rather than a safeguard.
 *
 * Neither button is the red one. Red in this product means recovering from a
 * failure, and in the exit dialog a zero the candidate is about to take;
 * borrowing it here would claim a loss that does not happen, since nothing is
 * deleted — the épreuves go to the archive of the historique with their
 * corrections and stay open there.
 *
 * No count is promised beforehand: a number would mean handing this client
 * component the candidate's record every time the account page mounts. The route
 * reports what it archived, so the panel says the number *after*, where it is a
 * fact rather than a promise.
 */
export function ResetRecord() {
  const router = useRouter();

  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [archived, setArchived] = useState<number | null>(null);

  async function confirm() {
    setPending(true);
    setFailed(null);

    const outcome = await requestRecordReset();

    setPending(false);
    if (!outcome.reset) {
      setFailed(
        outcome.reason === "unreachable"
          ? "Votre connexion n'a pas permis d'enregistrer la réinitialisation. Réessayez."
          : outcome.status === 401
            ? "Votre session a expiré. Reconnectez-vous, puis réessayez."
            : "La réinitialisation n'a pas pu être enregistrée. Réessayez dans un instant.",
      );
      return;
    }

    setConfirming(false);
    setArchived(outcome.archived);
    // The tableau de bord, the sujet cards and the historique are all rendered
    // from the record that just changed. Without this they would go on printing
    // the numbers they were built with until the next full navigation.
    router.refresh();
  }

  return (
    // Full width on a phone, where the header stacks; a column of its own beside
    // the title from `sm` up, wide enough for the confirmation to be read in
    // sentences rather than in two-word lines.
    <div className="w-full sm:w-80 sm:shrink-0">
      {confirming ? (
        <div className="border-border bg-muted space-y-3 border p-4">
          <p className="text-sm font-semibold">Réinitialiser ma progression ?</p>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Vos scores et vos épreuves corrigées sont archivés : ils restent
            consultables dans votre historique, mais vos tableaux de bord
            repartent de zéro. Votre compte et vos accès ne sont pas touchés.
          </p>

          {failed && (
            <p
              role="alert"
              className="border-danger/40 bg-danger-subtle text-danger border p-3 text-sm leading-relaxed"
            >
              {failed}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className={secondaryButton}
              autoFocus
            >
              Annuler
            </button>
            <button type="button" onClick={confirm} disabled={pending} className={secondaryButton}>
              {pending ? "Réinitialisation…" : failed ? "Réessayer" : "Confirmer"}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setArchived(null);
            setFailed(null);
            setConfirming(true);
          }}
          className={`${secondaryButton} w-full`}
        >
          Réinitialiser ma progression
        </button>
      )}

      {archived !== null && !confirming && (
        <p
          role="status"
          className="border-border bg-muted mt-3 border p-3 text-sm leading-relaxed"
        >
          {archived === 0
            ? "Il n'y avait aucune épreuve à archiver."
            : `${archived} épreuve${archived > 1 ? "s" : ""} ${archived > 1 ? "sont passées" : "est passée"} aux archives. Vous ${archived > 1 ? "les" : "la"} retrouvez dans l'historique.`}
        </p>
      )}
    </div>
  );
}
