"use client";

import { secondaryButton } from "@/app/_components/button-styles";
import { AlertIcon } from "./icons";
import { ExamDialog } from "./exam-dialog";

/**
 * The confirmation behind Retour while nothing has been said yet (#113, #199).
 *
 * Its own component rather than a variant of `ExitDialog`, because the two
 * dialogs make opposite claims and a shared body would have to branch on every
 * sentence. The exit dialog warns of a zero and its confirm exists to keep that
 * promise; this one's central fact is that there is NO zero — the candidate has
 * not spoken, so there is no performance to score, and the sitting simply never
 * reaches the historique. A warning the product does not honour is the thing the
 * exit dialog was explicitly built not to be, which is why the préparation
 * stopped opening it.
 *
 * **`stage` is where that boundary now falls (#199).** This used to be the
 * préparation's dialog and nothing else, on the reading that the préparation
 * ending is when a candidate starts performing. It is not: a speaking part opens
 * *armed*, with the consigne spoken, the control reading « Enregistrer », no
 * clock running and nothing being captured. The monologue is that part, and for
 * the whole of that window this dialog's claim is as true as it is during the
 * préparation — nothing has been said. The real boundary is « Enregistrer », and
 * `examExitRoute` is where it is written down.
 *
 * Only two strings move with the stage, and both are about *where* the candidate
 * is rather than what leaving costs: the question in the title, and what the
 * safe button offers to go back to. The framed loss and the paragraph under it
 * are shared because they are the same facts — the notes and the préparation
 * clock are gone either way, and the sitting is unnotée either way. A prop that
 * changed the promise would be two dialogs wearing one name.
 *
 * What IS worth a confirmation is what the candidate actually loses: the
 * préparation clock and the notes. That is the framed block — warning-toned, not
 * danger-toned, because the épreuve itself is not at stake.
 *
 * No `failed` state, deliberately. The confirm archives the sitting server-side
 * so a deliberate exit is not stranded looking like a crashed tab, but nothing
 * the candidate was told rides on that write — an exit that never lands
 * produces the same "this will not count" the dialog claimed. The caller logs
 * and leaves on any outcome, so this dialog never has bad news to break.
 *
 * The `<dialog>` itself is `ExamDialog`'s, shared with the two dialogs either
 * side of this one.
 */
export function QuitBeforeSpeakingDialog({
  open,
  stage,
  pending = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** Which side of the préparation → monologue boundary the candidate is on.
   *  Not a difference in consequence — see above — only in what to call the
   *  thing they are about to leave. */
  stage: "preparation" | "monologue";
  /** The archive write is in flight; the candidate leaves when it settles. */
  pending?: boolean;
  onCancel: () => void;
  /** Archives the sitting, then leaves — on any outcome. */
  onConfirm: () => void;
}) {
  return (
    <ExamDialog
      open={open}
      title={
        stage === "preparation" ? (
          <>Quitter la préparation ?</>
        ) : (
          // The préparation is over and the exposé has not begun, so neither
          // half of « Quitter la préparation ? » is true any more — and a
          // candidate who reads a dialog naming a phase they have left has to
          // wonder which screen it is actually about.
          <>Quitter l&apos;épreuve ?</>
        )
      }
      onCancel={onCancel}
    >
      {/* The one fact that decides the click: what leaving costs. */}
      <div className="border-warning/40 bg-warning-subtle text-warning flex items-center gap-2.5 border p-3">
        <AlertIcon className="size-4 shrink-0" />
        <p className="text-sm font-semibold">
          Votre temps de préparation et vos notes seront perdus.
        </p>
      </div>

      <p className="text-muted-foreground text-sm leading-relaxed">
        Rien n&apos;a encore été dit : cette épreuve ne sera pas notée et n&apos;apparaîtra pas dans
        votre historique. Vous pourrez reprendre ce sujet plus tard, depuis le début.
      </p>

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
          {stage === "preparation" ? "Continuer la préparation" : "Continuer"}
        </button>
        {/* Plain, not red. `dangerButton` is reserved for the controls that
            change a candidate's record on purpose, and this dialog's whole
            claim is that nothing on the record is at stake — a red confirm
            would visually re-promise the risk the copy just took away. The
            reset flow's confirm is a plain button for the same reason. */}
        <button type="button" onClick={onConfirm} disabled={pending} className={secondaryButton}>
          {pending ? "Sortie…" : "Quitter"}
        </button>
      </div>
    </ExamDialog>
  );
}
