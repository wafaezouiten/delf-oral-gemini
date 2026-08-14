import type { ConnectionState } from "@/lib/live/session-manager";

/**
 * Connection status.
 *
 * A reconnect deliberately reads as "Reconnexion" rather than an error: the exam
 * IS continuing, the transcript is intact and the examiner still remembers
 * everything. Presenting a routine, expected event as a failure would make
 * candidates abandon a perfectly healthy exam.
 */
const COPY: Record<ConnectionState, { label: string; tone: string }> = {
  idle: { label: "En attente", tone: "bg-muted text-muted-foreground" },
  connecting: { label: "Connexion…", tone: "bg-muted text-muted-foreground" },
  connected: { label: "Examinateur en ligne", tone: "bg-success-subtle text-success" },
  reconnecting: { label: "Reconnexion, l'épreuve continue", tone: "bg-warning-subtle text-warning" },
  // A resume is the good half of a reconnect: the handle is in hand, so the
  // examiner will still remember the exam. Same amber, more reassuring words.
  resuming: { label: "Reprise de l'épreuve en cours", tone: "bg-warning-subtle text-warning" },
  closed: { label: "Session close", tone: "bg-muted text-muted-foreground" },
  failed: { label: "Connexion perdue", tone: "bg-danger-subtle text-danger" },
};

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  const { label, tone } = COPY[state];
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${tone}`}>{label}</span>
  );
}
