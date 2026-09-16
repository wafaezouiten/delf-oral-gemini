/**
 * What a button that sends something says: its verb, « … en cours » while the
 * request is out, and « Réessayer » once one has failed — the same ladder on
 * the exit dialog's « Abandonner » and the account page's « Réinitialiser ».
 *
 * Pending outranks failed: a retry that is in flight is in flight.
 */
export function pendingLabel(
  state: { pending: boolean; failed: boolean },
  words: { idle: string; pending: string; retry?: string },
): string {
  if (state.pending) return words.pending;
  if (state.failed) return words.retry ?? "Réessayer";
  return words.idle;
}
