"use client";

import { useEffect, useRef } from "react";

import { dangerButton, secondaryButton } from "@/app/_components/button-styles";
import { AlertIcon } from "./icons";

/**
 * « Quitter avant le débat ? » — Retour on a débat that has not begun (#199).
 *
 * The third of the three, and the one the boundary was missing. Its window is
 * narrow and entirely real: the exposé has been given, the handover consigne has
 * been spoken, the control reads « Enregistrer », and the candidate decides they
 * are done. Until this existed the only way out of it was `ExitDialog`, which
 * promised a zero and stamped `abandoned_at` — throwing away an exposé that had
 * actually been spoken, for a débat that had not.
 *
 * A third component rather than a prop on either neighbour, for the reason
 * `QuitBeforeSpeakingDialog` is not a variant of `ExitDialog`: the three make
 * three different claims, and the claim is the whole dialog. This one is neither
 * "nothing counts" nor "everything is a zero" — the prestation is corrected, and
 * the half that was not produced is charged for.
 *
 * **What it may promise is exactly what the rubric already does.** The débat
 * carries no words, `partsAbsent` therefore calls it absent, and
 * `applyAbsentPartPenalty` halves the /25 — the same rule, unchanged, that a
 * candidate meets by sitting silently through the débat. Nothing about the
 * scoring was added for this exit, which is why the sentence can be written
 * flatly and why it will still be true after the next change to the grille.
 *
 * The halving is `ExitDialog`'s structure, for `ExitDialog`'s reason: the cost
 * is a framed block of its own rather than a clause in a paragraph, because it
 * is the fact that must not be skimmed past. Danger-toned and a danger confirm,
 * unlike the dialog next door — this one does change the candidate's record on
 * purpose, and the safe choice is still the one that looks safe.
 *
 * **No `pending` and no `failed`, unlike the abandon.** That flow blocks on its
 * write because the zero it promised must be recorded before the screen changes.
 * This confirm does not write anything: it hands the sitting to the controller's
 * ordinary finish, and the candidate lands on « Épreuve terminée » — which owns
 * the encode, the upload, its progress and its retry, and has since #86. There
 * is no outcome for this dialog to wait on or to break bad news about.
 *
 * The `<dialog>` mechanics are `ExitDialog`'s, documented there.
 */
export function QuitBeforeDebateDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  /** Ends the épreuve with the débat unspoken and sends it for correction. */
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
      aria-labelledby="quit-before-debate-title"
      className="bg-card text-foreground border-border m-auto w-[min(27rem,92vw)] border p-0 backdrop:bg-black/50"
    >
      <div className="space-y-3 p-4 sm:p-5">
        <h2 id="quit-before-debate-title" className="font-serif text-lg font-semibold">
          Quitter avant le débat ?
        </h2>

        {/* The cost, in its own frame. Said in words rather than as a figure
            because the figure does not exist yet — the halving is applied to a
            mark the correcteur has not produced — and a dialog that invented one
            would be the arithmetic this product does not promise. */}
        <div className="border-danger/40 bg-danger-subtle text-danger flex items-center gap-2.5 border p-3">
          <AlertIcon className="size-4 shrink-0" />
          <p className="text-sm font-semibold">
            Le débat comptera comme absent : votre note sera divisée par deux.
          </p>
        </div>

        <p className="text-muted-foreground text-sm leading-relaxed">
          Votre exposé sera corrigé et apparaîtra dans votre historique. L&apos;épreuve
          s&apos;arrête ici : vous ne pourrez pas revenir au débat.
        </p>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {/* Autofocused, like its neighbours: the dialog opens on the way out,
              so the key the candidate is most likely to press next should be the
              one that keeps their débat.

              « Continuer », not « Continuer l'épreuve », which is what this said
              first. Both siblings label their safe button that way, and the
              longer version was also the reason this row was the only one of the
              three to wrap onto two lines at 375px — the confirm here carries
              four words where theirs carry one. */}
          <button type="button" onClick={onCancel} className={secondaryButton} autoFocus>
            Continuer
          </button>
          <button type="button" onClick={onConfirm} className={dangerButton}>
            Quitter et faire corriger
          </button>
        </div>
      </div>
    </dialog>
  );
}
