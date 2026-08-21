"use client";

import { useEffect, useRef } from "react";

import { secondaryButton } from "@/app/_components/button-styles";
import { AlertIcon } from "./icons";

/**
 * « Quitter la préparation ? » — the confirmation behind Retour while nothing
 * has been said yet (#113).
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
 * The `<dialog>` mechanics — `showModal()` from an effect, the cancel handler
 * that keeps the parent's state honest — are `ExitDialog`'s, for the reasons
 * documented there.
 */
export function QuitPreparationDialog({
  open,
  pending = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** The archive write is in flight; the candidate leaves when it settles. */
  pending?: boolean;
  onCancel: () => void;
  /** Archives the sitting, then leaves — on any outcome. */
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
      aria-labelledby="quit-preparation-title"
      className="bg-card text-foreground border-border m-auto w-[min(30rem,92vw)] border p-0 backdrop:bg-black/50"
    >
      <div className="space-y-4 p-6">
        <h2 id="quit-preparation-title" className="font-serif text-lg font-semibold">
          Quitter la préparation ?
        </h2>

        {/* The one fact that decides the click: what leaving costs. */}
        <div className="border-warning/40 bg-warning-subtle text-warning flex items-center gap-2.5 border p-3.5">
          <AlertIcon className="size-4 shrink-0" />
          <p className="text-sm font-semibold">
            Votre temps de préparation et vos notes seront perdus.
          </p>
        </div>

        <p className="text-muted-foreground text-sm leading-relaxed">
          Rien n&apos;a encore été dit : cette épreuve ne sera pas notée et
          n&apos;apparaîtra pas dans votre historique. Vous pourrez reprendre ce
          sujet plus tard, depuis le début.
        </p>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {/* Autofocused: the dialog opens on the way out, so the key the
              candidate is most likely to press next should be the one that
              keeps their préparation. */}
          <button
            type="button"
            onClick={onCancel}
            className={secondaryButton}
            disabled={pending}
            autoFocus
          >
            Continuer la préparation
          </button>
          {/* Plain, not red. `dangerButton` is reserved for the controls that
              change a candidate's record on purpose, and this dialog's whole
              claim is that nothing on the record is at stake — a red confirm
              would visually re-promise the risk the copy just took away. The
              reset flow's confirm is a plain button for the same reason. */}
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={secondaryButton}
          >
            {pending ? "Sortie…" : "Quitter"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
