"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { primaryButton, secondaryButton } from "@/app/_components/button-styles";
import { Notice } from "@/app/_components/notice";
import { AlertIcon } from "@/app/_components/po/icons";
import { requestRecordReset } from "@/lib/account/reset";

/**
 * « Repartir de zéro » — the reset, its confirmation, and what it says afterwards
 * (#69).
 *
 * The copy does the work that a red button would otherwise be asked to do, and
 * it has one job: say what moves and what stays. A candidate pressing this is
 * usually not trying to destroy anything — they want a tableau de bord that
 * describes the French they speak now rather than the fortnight they spent
 * learning the interface — and the product's answer is that nothing is
 * destroyed. Every épreuve keeps its correction and stays in the historique.
 *
 * So the confirm is the primary button and not the danger one. Red in this
 * product means "recover from a failure" (`button-styles.ts`) and, in the exit
 * dialog, a zero the candidate is about to take; borrowing it here would claim a
 * loss that does not happen. What carries the weight instead is the count in its
 * own framed block — the exit dialog's structure, for the same reason: the
 * number is the fact that must not be skimmed past.
 *
 * « Annuler » is autofocused all the same. The safe choice should be the one the
 * keyboard lands on, whatever the colours are doing.
 *
 * `showModal()` from an effect rather than the `open` attribute, which produces
 * a *non-modal* dialog — no backdrop, no focus trap, no Escape — that looks
 * identical until somebody tries to tab out of it.
 */
export function ResetRecord({
  /** Sittings on the record right now. The number the dialog names. */
  current,
  /** Sittings already archived by an earlier reset. */
  archived,
}: {
  current: number;
  archived: number;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  /** How many moved, once some have. Cleared when the dialog reopens. */
  const [done, setDone] = useState<number | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const empty = current === 0;

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

    setOpen(false);
    setDone(outcome.archived);
    // The count on this page, the tableau de bord and the sujet cards are all
    // server-rendered from the record that just changed. Without this the screen
    // would go on printing the number it was built with.
    router.refresh();
  }

  return (
    <section className="border-border bg-card mt-6 sheet border p-6">
      <h2 className="text-sm font-semibold">Repartir de zéro</h2>

      <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
        Remet votre tableau de bord et vos cartes de sujets à leur état de départ.
        Vos épreuves ne sont pas supprimées : elles passent aux archives de
        l&apos;historique, avec leurs corrections, et restent consultables.
      </p>

      <p className="mt-3 text-sm leading-relaxed">
        {empty
          ? "Vous n'avez aucune épreuve sur votre record actuel."
          : `${current} épreuve${current > 1 ? "s" : ""} sur votre record actuel.`}
        {archived > 0 && (
          <span className="text-muted-foreground">
            {" "}
            {archived} déjà archivée{archived > 1 ? "s" : ""}.
          </span>
        )}
      </p>

      {/* Assertive enough to be heard, quiet enough not to look like a failure:
          the reset worked, and the only thing worth saying is where the épreuves
          went. */}
      {done !== null && (
        <div className="mt-4">
          <Notice title="Record réinitialisé">
            {done === 0
              ? "Il n'y avait aucune épreuve à archiver."
              : `${done} épreuve${done > 1 ? "s" : ""} ${done > 1 ? "sont passées" : "est passée"} aux archives. Vous les retrouvez dans l'historique.`}
          </Notice>
        </div>
      )}

      <div className="mt-5">
        <button
          type="button"
          onClick={() => {
            setDone(null);
            setFailed(null);
            setOpen(true);
          }}
          disabled={empty}
          className={secondaryButton}
        >
          Repartir de zéro
        </button>
      </div>

      <dialog
        ref={dialogRef}
        // Escape closes a modal dialog without going through the buttons, so the
        // state behind it has to hear about that or it cannot be reopened.
        onCancel={(event) => {
          event.preventDefault();
          if (!pending) setOpen(false);
        }}
        aria-labelledby="reset-dialog-title"
        className="bg-card text-foreground border-border m-auto w-[min(32rem,92vw)] border p-0 backdrop:bg-black/50"
      >
        <div className="space-y-4 p-6">
          <h2 id="reset-dialog-title" className="font-serif text-lg font-semibold">
            Repartir de zéro ?
          </h2>

          {/* One fact, in one line, in its own frame — the exit dialog's shape,
              because the number is what must not be skimmed past. */}
          <div className="border-border bg-muted flex items-center gap-2.5 border p-3.5">
            <AlertIcon className="size-4 shrink-0" />
            <p className="text-sm font-semibold">
              {current} épreuve{current > 1 ? "s" : ""} {current > 1 ? "quitteront" : "quittera"}{" "}
              votre tableau de bord.
            </p>
          </div>

          <p className="text-muted-foreground text-sm leading-relaxed">
            Rien n&apos;est supprimé. Vos corrections restent consultables dans
            l&apos;historique, sous « Archives ». Vos cartes de sujets réafficheront
            « Commencer ».
          </p>

          {failed && (
            <p
              role="alert"
              className="border-danger/40 bg-danger-subtle text-danger border p-3 text-sm leading-relaxed"
            >
              {failed}
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={secondaryButton}
              disabled={pending}
              autoFocus
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={pending}
              className={primaryButton}
            >
              {pending ? "Réinitialisation…" : failed ? "Réessayer" : "Repartir de zéro"}
            </button>
          </div>
        </div>
      </dialog>
    </section>
  );
}
