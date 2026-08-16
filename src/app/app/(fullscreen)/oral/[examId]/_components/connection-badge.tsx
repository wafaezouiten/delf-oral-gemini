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
 * The badge announces, but not for every state, and `announce` is why.
 *
 * What is worth interrupting a candidate for is whether they may speak: the
 * socket is opening, the examiner is there, the examiner has briefly gone and is
 * coming back. Those are announced, politely, because a candidate arguing a
 * point is not watching the corner of the screen.
 *
 * `failed` is deliberately silent here, and that is the one that looks wrong.
 * The exam screen renders an assertive `<Notice>` for exactly this condition —
 * `status === "error"` is `session === "failed"`, per `examStatus` in
 * `state-machine.ts` — and that notice carries the sentence explaining the exam
 * is still running, plus the button that fixes it. Leaving the badge live too
 * would announce one event twice, in two different wordings, the second of
 * which is a bare « Connexion perdue » with nothing to do about it. One event,
 * one announcement, and it should be the one attached to the remedy. The badge
 * stays visible; it just stops competing.
 *
 * `idle` and `closed` are silent for a duller reason: they are bookkeeping
 * between phases, not facts about whose turn it is.
 */
const COPY: Record<
  ConnectionState,
  { label: string; mark: string; tone: string; announce: boolean }
> = {
  idle: {
    label: "En attente",
    mark: "◦",
    tone: "border-border bg-muted text-muted-foreground",
    announce: false,
  },
  connecting: {
    label: "Connexion…",
    mark: "◌",
    tone: "border-border bg-muted text-muted-foreground",
    announce: true,
  },
  connected: {
    label: "Examinateur en ligne",
    mark: "●",
    tone: "border-success/30 bg-success-subtle text-success",
    announce: true,
  },
  reconnecting: {
    label: "Reconnexion, l'épreuve continue",
    mark: "↻",
    tone: "border-warning/40 bg-warning-subtle text-warning",
    announce: true,
  },
  // A resume is the good half of a reconnect: the handle is in hand, so the
  // examiner will still remember the exam. Same amber, more reassuring words.
  resuming: {
    label: "Reprise de l'épreuve en cours",
    mark: "↻",
    tone: "border-warning/40 bg-warning-subtle text-warning",
    announce: true,
  },
  closed: {
    label: "Session close",
    mark: "○",
    tone: "border-border bg-muted text-muted-foreground",
    announce: false,
  },
  failed: {
    label: "Connexion perdue",
    mark: "✕",
    tone: "border-danger/40 bg-danger-subtle text-danger",
    announce: false,
  },
};

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  const { label, mark, tone, announce } = COPY[state];
  return (
    <span
      role="status"
      // `role="status"` is implicitly polite, so silencing it takes an explicit
      // `off` rather than the absence of an attribute.
      aria-live={announce ? "polite" : "off"}
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold ${tone}`}
    >
      <span aria-hidden>{mark}</span>
      {label}
    </span>
  );
}
