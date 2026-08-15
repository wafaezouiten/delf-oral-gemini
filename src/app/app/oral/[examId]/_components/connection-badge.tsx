import type { ConnectionState } from "@/lib/live/session-manager";

/**
 * Connection status.
 *
 * A reconnect deliberately reads as "Reconnexion" rather than an error: the exam
 * IS continuing, the transcript is intact and the examiner still remembers
 * everything. Presenting a routine, expected event as a failure would make
 * candidates abandon a perfectly healthy exam.
 *
 * Every state carries a word and a mark as well as a colour, so the badge reads
 * the same in greyscale as in colour — the accessibility requirement of #11
 * applied to the one component whose whole job is to signal. The mark is a
 * character rather than an icon font: it inherits the text colour, scales with
 * the text, and cannot fail to load.
 *
 * The badge is a polite live region. A candidate is not watching the corner of
 * the screen while they argue a point, and "the examiner has gone" is exactly
 * the kind of thing they need to be told rather than shown.
 */
const COPY: Record<ConnectionState, { label: string; mark: string; tone: string }> = {
  idle: {
    label: "En attente",
    mark: "◦",
    tone: "border-border bg-muted text-muted-foreground",
  },
  connecting: {
    label: "Connexion…",
    mark: "◌",
    tone: "border-border bg-muted text-muted-foreground",
  },
  connected: {
    label: "Examinateur en ligne",
    mark: "●",
    tone: "border-success/30 bg-success-subtle text-success",
  },
  reconnecting: {
    label: "Reconnexion, l'épreuve continue",
    mark: "↻",
    tone: "border-warning/40 bg-warning-subtle text-warning",
  },
  // A resume is the good half of a reconnect: the handle is in hand, so the
  // examiner will still remember the exam. Same amber, more reassuring words.
  resuming: {
    label: "Reprise de l'épreuve en cours",
    mark: "↻",
    tone: "border-warning/40 bg-warning-subtle text-warning",
  },
  closed: {
    label: "Session close",
    mark: "○",
    tone: "border-border bg-muted text-muted-foreground",
  },
  failed: {
    label: "Connexion perdue",
    mark: "✕",
    tone: "border-danger/40 bg-danger-subtle text-danger",
  },
};

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  const { label, mark, tone } = COPY[state];
  return (
    <span
      role="status"
      aria-live="polite"
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold ${tone}`}
    >
      <span aria-hidden>{mark}</span>
      {label}
    </span>
  );
}
