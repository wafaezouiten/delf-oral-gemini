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
 * The copy is deliberately short. It went through a long version first — the
 * score, the historique, the effect on the average, and a comparison to walking
 * out of the exam room — and every sentence of it was true and none of it was
 * read: this dialog opens on someone who is mid-épreuve, possibly panicking,
 * deciding in about two seconds. So it says the number, then the one other
 * consequence, and stops.
 *
 * What survives from the long version is the *structure*: the score is a
 * bordered block of its own rather than a clause in a paragraph, because it is
 * the fact that must not be skimmed past. It is also the reason `onConfirm`
 * marks the sitting abandoned server-side rather than merely navigating away —
 * a warning the product does not honour would be worse than no warning.
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

        {/* One fact, in one line, in its own frame. This block used to carry
            three sentences — the score, the historique, the moyenne, and a
            comparison to leaving the exam room — and a candidate mid-épreuve
            reads none of it. What they need to know is the number. */}
        <div className="border-danger/40 bg-danger-subtle text-danger flex items-center gap-2.5 border p-3.5">
          <AlertIcon className="size-4 shrink-0" />
          <p className="text-sm font-semibold">
            Vous aurez 0/{COMPETENCY_MAX} à cette épreuve.
          </p>
        </div>

        <p className="text-muted-foreground text-sm leading-relaxed">
          Votre enregistrement sera perdu et l&apos;épreuve ne pourra pas être
          corrigée.
        </p>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {/* Autofocused: the dialog opens on the way out, so the key the
              candidate is most likely to press next should be the one that
              keeps their épreuve. */}
          <button type="button" onClick={onCancel} className={secondaryButton} autoFocus>
            Continuer
          </button>
          <button type="button" onClick={onConfirm} className={dangerButton}>
            Abandonner
          </button>
        </div>
      </div>
    </dialog>
  );
}
