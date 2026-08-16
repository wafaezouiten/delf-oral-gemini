"use client";

import { useEffect, useRef } from "react";

import { dangerButton, secondaryButton } from "@/app/_components/button-styles";

/**
 * "Quitter le simulateur ?" — the confirmation behind Retour, once the clock has
 * started.
 *
 * PORT NOTE: the reference's `ExamDialog` (shadcn `AlertDialog` underneath),
 * reproduced on the native `<dialog>` element. That is not a downgrade: a modal
 * `<dialog>` gets the focus trap, the inert backdrop, the Escape key and the
 * top-layer stacking from the browser, which is most of what the Radix
 * primitive is for. What it does not give is an animation, and this one does not
 * have one.
 *
 * The copy is stronger here than in the reference, because the stakes are. The
 * reference loses a conversation it never recorded; leaving here destroys audio
 * that exists in this tab and nowhere else until the épreuve ends — the same
 * fact `use-exam-controller`'s `beforeunload` note is written around. So the
 * dialog names the recording, and the confirm button is the danger one while the
 * way back is the plain one: the safe choice is the one that looks safe.
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
      className="bg-card text-foreground border-border m-auto w-[min(28rem,92vw)] rounded-lg border p-0 backdrop:bg-black/40"
    >
      <div className="space-y-3 p-6">
        <h2 id="exit-dialog-title" className="font-serif text-lg font-semibold">
          Quitter l&apos;épreuve ?
        </h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Votre progression ne sera pas enregistrée et le temps déjà écoulé est
          perdu. Votre enregistrement n&apos;existe que dans cet onglet : le
          quitter maintenant le détruit, et cette épreuve ne pourra pas être
          corrigée.
        </p>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} className={secondaryButton}>
            Rester dans l&apos;épreuve
          </button>
          <button type="button" onClick={onConfirm} className={dangerButton}>
            Quitter et tout perdre
          </button>
        </div>
      </div>
    </dialog>
  );
}
