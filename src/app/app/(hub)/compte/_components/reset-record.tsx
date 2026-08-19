"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { secondaryButton } from "@/app/_components/button-styles";
import { requestRecordReset } from "@/lib/account/reset";

/**
 * « Réinitialiser ma progression » — the button, its confirmation and what it
 * says after (#69).
 *
 * The foot of the account's own frame on /app/compte: Clerk's screens above,
 * this under a rule, one container around both. Not a page of Clerk's nav —
 * this touches nothing Clerk owns, and filing it beside *Profil* and *Sécurité*
 * claimed it was an account setting.
 *
 * The copy is the candidate's own wording, with two claims taken out because
 * they are not true of this product: it names one épreuve rather than four, and
 * it says nothing about passes, which do not exist here. Everything else — what
 * is archived, what stays readable, what is untouched — is theirs.
 *
 * The confirmation is a second state of the block rather than a `<dialog>`,
 * which is a deliberate retreat from how the exit dialog does it. That dialog
 * interrupts an épreuve in progress and has to; this interrupts nothing, and a
 * modal for a control the candidate came to this page on purpose to use is a
 * ceremony rather than a safeguard. Two states of one block also keep the
 * consequence in the place the button is.
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
      <h2 className="font-serif text-lg font-semibold">Réinitialiser ma progression</h2>

      <p className="text-muted-foreground text-sm leading-relaxed">
        Vos scores et vos épreuves corrigées sont archivés : ils restent
        consultables dans votre historique, mais vos tableaux de bord repartent de
        zéro. Votre compte et vos accès ne sont pas touchés.
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
            Vos épreuves quitteront vos tableaux de bord.
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
          Réinitialiser ma progression
        </button>
      )}
    </div>
  );
}
