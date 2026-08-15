/**
 * Whether the candidate's voice is going to disc.
 *
 * On screen for the whole épreuve rather than only while recording, and that is
 * the point of it: "nothing is recorded before consent" is a claim, and a claim
 * the candidate cannot check is worth very little. An indicator that is visibly
 * dark through thirty minutes of preparation and lights up at the monologue —
 * after the browser has asked them — is the same claim, verifiable.
 *
 * The dot pulses while recording. It is the one animation in the exam UI: a
 * static red dot is indistinguishable from a decoration, and this one is a
 * statement about the microphone. It stands down under
 * `prefers-reduced-motion` (see `globals.css`), where the word carries it alone.
 *
 * Announced rather than only shown. A candidate who cannot see the dot has the
 * same right to know when the microphone started, and "you can check it" is not
 * a property of a colour — which is also why the two states differ in their
 * wording and their outline, and not only in their tint.
 */
export function RecordingBadge({ recording }: { recording: boolean }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold ${
        recording
          ? "border-danger/40 bg-danger-subtle text-danger"
          : "border-border bg-muted text-muted-foreground"
      }`}
    >
      <span
        className={`size-2 rounded-full ${
          recording ? "bg-danger animate-pulse" : "border-muted-foreground/50 border"
        }`}
        aria-hidden
      />
      {recording ? "Enregistrement en cours" : "Aucun enregistrement"}
    </span>
  );
}
