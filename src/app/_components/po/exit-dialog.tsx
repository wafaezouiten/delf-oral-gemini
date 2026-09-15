"use client";

import { COMPETENCY_MAX } from "@/lib/delf/constants";
import { dangerButton, secondaryButton } from "@/app/_components/button-styles";
import { AlertIcon } from "./icons";
import { pendingLabel } from "@/lib/ui/action-label";
import { ExamDialog } from "./exam-dialog";

/**
 * "Abandonner l'épreuve ?" — the confirmation behind Retour on a part that is
 * running.
 *
 * Running, and nothing else. This used to be every screen after the
 * préparation, and it charged a candidate who had not said a word the same zero
 * as one who walked out mid-débat (#113) — first the préparation, which now
 * opens `QuitBeforeSpeakingDialog`, and then the armed parts, which are the same
 * mistake one screen further on (#199): a part opens with its consigne spoken,
 * its control reading « Enregistrer » and no clock running, and for that whole
 * window this dialog's zero was a warning the product would not honour, which is
 * exactly what it was built not to be (see below). `examExitRoute` holds the
 * boundary: the zero is owed from « Enregistrer ».
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
 * The `<dialog>` itself — the ref, the open/close effect, the Escape handler and
 * the frame — is `ExamDialog`'s, shared with the two dialogs either side of this
 * one. Nothing that makes a claim is in there.
 */
export function ExitDialog({
  open,
  pending = false,
  failed = false,
  onCancel,
  onConfirm,
  onLeaveAnyway,
}: {
  open: boolean;
  /** The abandon is in flight. See `ExamClient`. */
  pending?: boolean;
  /** The server did not record it — the promised zero was not written. */
  failed?: boolean;
  onCancel: () => void;
  /** Marks the sitting abandoned, then leaves. */
  onConfirm: () => void;
  /** Leaves without a record, once recording it has been tried and failed. */
  onLeaveAnyway: () => void;
}) {
  return (
    <ExamDialog open={open} title={<>Abandonner l&apos;épreuve ?</>} onCancel={onCancel}>
      {/* One fact, in one line, in its own frame. This block used to carry
          three sentences — the score, the historique, the moyenne, and a
          comparison to leaving the exam room — and a candidate mid-épreuve
          reads none of it. What they need to know is the number. */}
      <div className="border-danger/40 bg-danger-subtle text-danger flex items-center gap-2.5 border p-3">
        <AlertIcon className="size-4 shrink-0" />
        <p className="text-sm font-semibold">Vous aurez 0/{COMPETENCY_MAX} à cette épreuve.</p>
      </div>

      <p className="text-muted-foreground text-sm leading-relaxed">
        Votre enregistrement sera perdu et l&apos;épreuve ne pourra pas être corrigée.
      </p>

      {/* The promise could not be kept, and saying nothing would make that the
          second broken promise of one click. Assertive, because the candidate
          is on their way out and will not come looking for it. */}
      {failed && (
        <p
          role="alert"
          className="border-border bg-muted text-foreground border p-2.5 text-sm leading-relaxed"
        >
          L&apos;abandon n&apos;a pas pu être enregistré. Vous pouvez réessayer, ou quitter quand
          même — cette épreuve restera alors en cours et ne comptera pas.
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        {/* Autofocused: the dialog opens on the way out, so the key the
            candidate is most likely to press next should be the one that
            keeps their épreuve. */}
        <button
          type="button"
          onClick={onCancel}
          className={secondaryButton}
          disabled={pending}
          autoFocus
        >
          Continuer
        </button>
        {failed && (
          <button type="button" onClick={onLeaveAnyway} className={secondaryButton}>
            Quitter quand même
          </button>
        )}
        <button type="button" onClick={onConfirm} disabled={pending} className={dangerButton}>
          {pendingLabel({ pending, failed }, { idle: "Abandonner", pending: "Abandon en cours…" })}
        </button>
      </div>
    </ExamDialog>
  );
}
