"use client";

import { dangerButton, secondaryButton } from "@/app/_components/button-styles";
import { AlertIcon } from "./icons";
import { ExamDialog } from "./exam-dialog";

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
 * **`pending`, but no `failed`.** The abandon next door blocks on its write
 * because the zero it promised must be recorded before the screen changes; this
 * confirm writes nothing, and what it waits on is the exposé being written down
 * — the monologue is transcribed off its own recording (#206) and that call is
 * normally waited out when the débat's session opens, which is the one thing
 * this exit never does. So the dialog holds while the controller waits, up to
 * the same thirty seconds the débat would have. Dropping the candidate back onto
 * an armed débat for that long, with nothing having visibly happened, is the
 * alternative.
 *
 * No `failed`, though, because there is no outcome to report: a transcription
 * that fails or times out costs the exposé's words and not the épreuve, and
 * everything past the wait — the encode, the upload, its progress and its retry
 * — is « Épreuve terminée »'s and has been since #86.
 *
 * The `<dialog>` itself is `ExamDialog`'s, shared with the two dialogs either
 * side of this one.
 */
export function QuitBeforeDebateDialog({
  open,
  pending = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** The exposé is still being written down; the épreuve ends when it is. */
  pending?: boolean;
  onCancel: () => void;
  /** Ends the épreuve with the débat unspoken and sends it for correction. */
  onConfirm: () => void;
}) {
  return (
    <ExamDialog open={open} title="Quitter avant le débat ?" onCancel={onCancel}>
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
        Votre exposé sera corrigé et apparaîtra dans votre historique. L&apos;épreuve s&apos;arrête
        ici : vous ne pourrez pas revenir au débat.
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
        <button
          type="button"
          onClick={onCancel}
          className={secondaryButton}
          disabled={pending}
          autoFocus
        >
          Continuer
        </button>
        {/* « Envoi… » rather than a longer sentence about transcription: the
            candidate has decided to leave and is watching one button, and what
            they need to know is that the click landed. */}
        <button type="button" onClick={onConfirm} disabled={pending} className={dangerButton}>
          {pending ? "Envoi…" : "Quitter et faire corriger"}
        </button>
      </div>
    </ExamDialog>
  );
}
