/** The three things this needs of a `<dialog>` — so a test can hand it a fake. */
export interface ModalLike {
  readonly open: boolean;
  showModal(): void;
  close(): void;
}

/**
 * Bring a `<dialog>` into line with the state that owns it.
 *
 * `showModal()` rather than the `open` attribute, because the attribute
 * produces a *non-modal* dialog — no backdrop, no focus trap, no Escape — which
 * looks identical until somebody tries to tab out of it. And only on a change:
 * `showModal()` on a dialog that is already open throws, and a `close()` on a
 * closed one fires a `close` event nobody asked for.
 */
export function syncModal(dialog: ModalLike | null, open: boolean): void {
  if (!dialog || dialog.open === open) return;
  if (open) dialog.showModal();
  else dialog.close();
}
