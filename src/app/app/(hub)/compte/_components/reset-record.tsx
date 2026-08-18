"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { secondaryButton } from "@/app/_components/button-styles";
import { requestRecordReset } from "@/lib/account/reset";

/**
 * « Repartir de zéro » — the button, its confirmation and what it says after
 * (#69).
 *
 * Mounted as a page of Clerk's `<UserProfile>`, so it sits in the same card as
 * *Profil* and *Sécurité* and inherits their chrome. This component draws its
 * own body and nothing else: no card, no border, no heading furniture that would
 * make it look like a panel bolted onto the side of Clerk's.
 *
 * The confirmation is a second state of the panel rather than a `<dialog>`,
 * which is a deliberate retreat from how the exit dialog does it. The exam
 * screen owns its whole viewport; this is content inside somebody else's
 * component, and a modal opened from in there puts two focus traps in one
 * document to argue over the keyboard. Two states of one panel need no second
 * trap, and the consequence is read in the same place either way.
 *
 * Neither button is the red one. Red in this product means recovering from a
 * failure, and in the exit dialog a zero the candidate is about to take;
 * borrowing it here would claim a loss that does not happen, since nothing is
 * deleted — the épreuves go to the archive of the historique with their
 * corrections and stay open there.
 *
 * No count is promised before the reset, and that is a saving rather than an
 * omission: a number here would mean handing this client component the
 * candidate's record every time the account screen mounts. The route reports
 * what it archived, so the panel says the number *after*, where it is a fact.
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
    <div className="text-foreground space-y-4">
      <h1 className="font-serif text-lg font-semibold">Repartir de zéro</h1>

      <p className="text-muted-foreground text-sm leading-relaxed">
        Remet votre tableau de bord et vos cartes de sujets à leur état de départ.
        Vos épreuves ne sont pas supprimées : elles passent aux archives de
        l&apos;historique, avec leurs corrections, et restent consultables.
      </p>

      {archived !== null && (
        <p role="status" className="border-border bg-muted border p-3 text-sm leading-relaxed">
          {archived === 0
            ? "Il n'y avait aucune épreuve à archiver."
            : `${archived} épreuve${archived > 1 ? "s" : ""} ${archived > 1 ? "sont passées" : "est passée"} aux archives. Vous ${archived > 1 ? "les" : "la"} retrouvez dans l'historique.`}
        </p>
      )}

      {failed && (
        <p
          role="alert"
          className="border-danger/40 bg-danger-subtle text-danger border p-3 text-sm leading-relaxed"
        >
          {failed}
        </p>
      )}

      {confirming ? (
        <div className="border-border bg-muted space-y-3 border p-4">
          <p className="text-sm font-semibold">
            Vos épreuves quitteront votre tableau de bord.
          </p>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Rien n&apos;est supprimé : vous les retrouverez dans l&apos;historique,
            sous « Archives », et vos cartes de sujets réafficheront « Commencer ».
          </p>
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
          className={secondaryButton}
        >
          Repartir de zéro
        </button>
      )}
    </div>
  );
}
