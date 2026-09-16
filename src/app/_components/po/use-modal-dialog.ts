"use client";

import { useEffect, useRef, type RefObject } from "react";

import { syncModal } from "@/lib/ui/modal-dialog";

/**
 * A `<dialog>` driven by state: `showModal()` when `open` turns true, `close()`
 * when it turns false, from an effect rather than by rendering the `open`
 * attribute — that attribute produces a *non-modal* dialog, with no backdrop,
 * no focus trap and no Escape, which looks identical until somebody tries to
 * tab out of it. The rule itself is `syncModal`, tested; this attaches it.
 */
export function useModalDialog(open: boolean): RefObject<HTMLDialogElement | null> {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => syncModal(ref.current, open), [open]);
  return ref;
}
