"use client";

import { useEffect, useRef } from "react";

import { COMPETENCY_MAX } from "@/lib/delf/constants";
import { dangerButton, secondaryButton } from "@/app/_components/button-styles";
import { AlertIcon } from "./icons";

/**
 * "Quitter l'épreuve ?" — the confirmation behind Retour, once the clock has
 * started.
 *
 * PORT NOTE: the reference's `ExamDialog` (shadcn `AlertDialog` underneath),
 * reproduced on the native `<dialog>` element. That is not a downgrade: a modal
 * `<dialog>` gets the focus trap, the inert backdrop, the Escape key and the
 * top-layer stacking from the browser, which is most of what the Radix
 * primitive is for.
 *
 * The copy is a great deal stronger than the reference's, because the
 * consequences are. The reference loses a conversation it never recorded and
 * never scored, so « votre progression ne sera pas sauvegardée » is the whole
 * truth of it. Here, leaving does three things, and the dialog names all three
 * in the order they cost the candidate:
 *
 *  1. **The épreuve is scored zero and joins their record.** This is the one
 *     that must not be buried, so it is a bordered block rather than a clause in
 *     a paragraph — and it is the reason `onConfirm` marks the sitting abandoned
 *     server-side rather than merely navigating away. A warning the product does
 *     not honour would be worse than no warning.
 *  2. **The recording is destroyed.** It lives in this tab and nowhere else
 *     until the épreuve ends, the fact `use-exam-controller`'s `beforeunload`
 *     note is written around.
 *  3. **The time already spent is gone.**
 *
 * The safe choice is the one that looks safe: "Rester" is the plain button and
 * the confirm is the danger one, which is the opposite of a dialog that styles
 * its confirm as the primary action.
 *
 * `showModal()` is called from an effect rather than rendering `open`, because
 * the `open` attribute produces a *non-modal* dialog — no backdrop, no focus
 * trap, no Escape — which looks identical until somebody tries to tab out of it.
 */
export function ExitDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  /** Marks the sitting abandoned, then leaves. See `ExamClient`. */
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      // Escape closes a modal dialog without going through the buttons, so the
      // parent's state has to hear about it or the dialog cannot be reopened.
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      aria-labelledby="exit-dialog-title"
      className="bg-card text-foreground border-border m-auto w-[min(30rem,92vw)] border p-0 backdrop:bg-black/50"
    >
      <div className="space-y-4 p-6">
        <h2 id="exit-dialog-title" className="font-serif text-lg font-semibold">
          Abandonner l&apos;épreuve ?
        </h2>

        {/* The consequence that cannot be undone, given its own frame so it is
            not read as the tail of a sentence about saving progress. */}
        <div className="border-danger/40 bg-danger-subtle text-danger flex items-start gap-2.5 border p-3.5">
          <AlertIcon className="mt-0.5 size-4 shrink-0" />
          <p className="text-sm leading-relaxed">
            <span className="font-semibold">
              Cette épreuve comptera comme une tentative, notée 0/{COMPETENCY_MAX}.
            </span>{" "}
            Elle apparaîtra dans votre historique et pèsera sur votre moyenne,
            exactement comme un candidat qui quitte la salle le jour de
            l&apos;examen.
          </p>
        </div>

        <p className="text-muted-foreground text-sm leading-relaxed">
          Votre enregistrement n&apos;existe que dans cet onglet : le quitter le
          détruit, et cette épreuve ne pourra plus être corrigée. Le temps déjà
          écoulé est perdu.
        </p>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {/* Autofocused: the dialog opens on the way out, so the key the
              candidate is most likely to press next should be the one that
              keeps their épreuve. */}
          <button type="button" onClick={onCancel} className={secondaryButton} autoFocus>
            Continuer l&apos;épreuve
          </button>
          <button type="button" onClick={onConfirm} className={dangerButton}>
            Abandonner et prendre 0
          </button>
        </div>
      </div>
    </dialog>
  );
}
