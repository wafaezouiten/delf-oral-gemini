/**
 * The keyboard contract of a development panel's text field.
 *
 * Ctrl/Cmd+Enter submits the field's form; plain Enter breaks the line, which
 * in a field that takes a pasted exposé of several paragraphs or a
 * multi-paragraph system instruction is not negotiable — Enter-to-send would
 * truncate at the first blank line. Escape closes the panel, as it would for
 * any popover; for the transcription panel closing is also what hands the
 * microphone back, so there is no state to get stuck in.
 *
 * Written once because both panels had it word for word, and a third would
 * have too. Typed on the DOM event rather than React's so `node --test` can
 * hand it a plain object.
 */
export interface FieldKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  preventDefault(): void;
  currentTarget: { form: { requestSubmit(): void } | null };
}

export function devFieldKeyDown(onClose: () => void): (event: FieldKeyEvent) => void {
  return (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
    if (event.key === "Escape") onClose();
  };
}
