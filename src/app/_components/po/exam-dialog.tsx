"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * The modal every exit confirmation is drawn in: the shell, and nothing that
 * makes a claim.
 *
 * PORT NOTE: the reference's own `ExamDialog` (shadcn `AlertDialog`
 * underneath), and getting back to one component is the point of extracting it.
 * The port reproduced it on the native `<dialog>` element — which is not a
 * downgrade, since a modal `<dialog>` gets the focus trap, the inert backdrop,
 * the Escape key and the top-layer stacking from the browser, and that is most
 * of what the Radix primitive is for. What the port did not reproduce was the
 * sharing: `ExitDialog` carried the mechanics itself, `QuitBeforeSpeakingDialog`
 * copied them, and #199's third dialog copied them again.
 *
 * **What belongs here and what does not.** Each dialog's whole reason to exist
 * is the claim it makes — no zero, a halved mark, a zero — and those claims are
 * opposite enough that one component branching on all three was rejected
 * outright. None of that is in here. This holds the ref, the open/close effect,
 * the Escape handler, the frame and the heading: the parts that are identical in
 * all three because they are about being a dialog, not about being *this*
 * dialog. The body, the tone of its framed block, the buttons and their labels
 * stay with the dialog that means them.
 *
 * `showModal()` runs from an effect rather than by rendering the `open`
 * attribute, because that attribute produces a *non-modal* dialog — no backdrop,
 * no focus trap, no Escape — which looks identical until somebody tries to tab
 * out of it.
 *
 * `useId()` rather than an id from the caller: `aria-labelledby` has to point at
 * the heading this renders, and three callers each inventing a unique string is
 * three chances to typo a link nothing would notice was broken.
 */
export function ExamDialog({
  open,
  title,
  onCancel,
  children,
}: {
  open: boolean;
  /** The question, as the `<h2>` the dialog is labelled by. */
  title: ReactNode;
  /** Escape, and every dialog's own safe button. */
  onCancel: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

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
      aria-labelledby={titleId}
      className="bg-card text-foreground border-border m-auto w-[min(27rem,92vw)] border p-0 backdrop:bg-black/50"
    >
      <div className="space-y-3 p-4 sm:p-5">
        <h2 id={titleId} className="font-serif text-lg font-semibold">
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}
