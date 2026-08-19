"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { dangerButton, secondaryButton } from "@/app/_components/button-styles";
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
 * The header carries the button and one line saying what it is for — enough to
 * tell a candidate whether this is the control they came for, and no more. The
 * paragraph of consequences arrives with the confirmation, where it is read
 * because it has to be rather than skimmed past because it is always there.
 *
 * A panel rather than a `<dialog>`. The exit dialog interrupts an épreuve in
 * progress and has to; this interrupts nothing, and a modal for a control the
 * candidate came to this page to use is a ceremony rather than a safeguard.
 *
 * **Red, on the candidate's instruction, and the confirm is not.** Nothing here
 * is deleted — the épreuves go to the archive of the historique with their
 * corrections and stay open there — so by this product's own colour rule the
 * trigger would not be red. It is, because a reset of somebody's record should
 * announce itself as consequential whether or not it is reversible, and that is
 * a fair reading. What the colour must not do is *hurry* the decision: the
 * confirm inside the panel stays a plain button, so the red is a warning to
 * read the panel rather than a second red button to click through.
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
    // Full width on a phone, where the header stacks. From `sm` up it shrinks to
    // its contents and is pushed to the far right by `ml-auto` — the flex row
    // above already puts it there, and this makes it independent of what the
    // title beside it happens to be doing. `items-end` then takes the button to
    // the container's last pixel instead of leaving it inside a block that ends
    // there.
    <div className="ml-auto flex w-full flex-col items-stretch sm:w-auto sm:shrink-0 sm:items-end">
      {confirming ? (
        <div className="border-border bg-muted w-full space-y-3 border p-4 sm:w-72">
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
        // Only as wide as its label: it is the header's second element, not a
        // form control, and a button stretched to the width of a column reads as
        // the page's main action.
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
          <button
            type="button"
            onClick={() => {
              setArchived(null);
              setFailed(null);
              setConfirming(true);
            }}
            className={`${dangerButton} w-full sm:w-auto`}
          >
            Réinitialiser
          </button>
          {/* Capped, so the line wraps into a short block under the button
              instead of stretching the header cell and dragging the button back
              in from the edge. */}
          <p className="text-muted-foreground max-w-56 text-xs leading-relaxed sm:text-right">
            Archive vos épreuves passées et remet vos tableaux de bord à zéro.
          </p>
        </div>
      )}

      {archived !== null && !confirming && (
        <p
          role="status"
          className="border-border bg-muted mt-3 w-full border p-3 text-sm leading-relaxed sm:w-72"
        >
          {archived === 0
            ? "Il n'y avait aucune épreuve à archiver."
            : `${archived} épreuve${archived > 1 ? "s" : ""} ${archived > 1 ? "sont passées" : "est passée"} aux archives. Vous ${archived > 1 ? "les" : "la"} retrouvez dans l'historique.`}
        </p>
      )}
    </div>
  );
}
