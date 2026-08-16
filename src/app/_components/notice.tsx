import type { ReactNode } from "react";

/**
 * The one way this product tells a candidate that something went wrong.
 *
 * #11 asks that every failure the earlier phases can produce has a *visible,
 * non-technical* message. Having one component for all of them is what makes
 * that checkable: a failure path either renders a `<Notice>` or it renders
 * nothing, and the second is a bug you can grep for.
 *
 * Three properties, all deliberate:
 *
 *  - **Never colour alone.** Each tone has a mark and a heading in words. A
 *    candidate who cannot tell amber from red still reads « Attention » or
 *    « Problème ».
 *  - **Announced when it is a problem.** `danger` is `role="alert"`, which is
 *    assertive: a lost connection interrupts, because the candidate is talking
 *    to nobody until they act. `warning` is `role="status"`, polite: a
 *    microphone that has gone quiet is worth saying at the next pause, not over
 *    the top of the examiner. `info` is neither — it is context, and context
 *    that announces itself is an alert. The two roles are never combined with a
 *    contradicting `aria-live`, which is the usual way this gets written and
 *    leaves the politeness undefined.
 *  - **No technical text.** This component cannot enforce that, but it is where a
 *    reviewer looks — every caller passes prose written for a candidate, and the
 *    error object goes to `console.error` beside it, never into `children`.
 *
 * `title` is a paragraph and not a heading, deliberately. A notice is a
 * transient statement about right now, and putting each one in the document
 * outline would mean the heading list of the exam screen changes shape every
 * time the microphone hiccups — the outline is meant to describe the page, not
 * its current mood. Discoverability is not lost: the two tones worth finding
 * announce themselves through their role, and both appear directly above the
 * control that answers them rather than somewhere a candidate has to navigate to.
 */
/**
 * Three tones, because this product has three things to say. There is no
 * `success`: nothing in an épreuve is announced by a banner saying it went
 * well — a working microphone is the recording badge, and a passing score is the
 * grille. A fourth tone with no caller is a colour waiting for someone to invent
 * a reason for it.
 */
type NoticeTone = "info" | "warning" | "danger";

const TONES: Record<NoticeTone, { mark: string; heading: string; classes: string }> = {
  info: {
    mark: "i",
    heading: "À savoir",
    classes: "border-border bg-muted text-foreground",
  },
  warning: {
    mark: "!",
    heading: "Attention",
    classes: "border-warning/40 bg-warning-subtle text-warning",
  },
  danger: {
    mark: "✕",
    heading: "Problème",
    classes: "border-danger/40 bg-danger-subtle text-danger",
  },
};

export function Notice({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: NoticeTone;
  /** Overrides the tone's generic heading when there is something better to say. */
  title?: string;
  children: ReactNode;
  /** A way out of the failure, when one exists. Rendered inside the notice so it
   *  cannot drift away from the message that explains it. */
  action?: ReactNode;
}) {
  const { mark, heading, classes } = TONES[tone];
  const role = tone === "danger" ? "alert" : tone === "warning" ? "status" : undefined;

  return (
    <div role={role} className={`flex gap-3 rounded-lg border px-4 py-3 ${classes}`}>
      <span
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-current text-[0.6875rem] font-bold"
        aria-hidden
      >
        {mark}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-semibold">{title ?? heading}</p>
        <div className="text-sm leading-relaxed">{children}</div>
        {action}
      </div>
    </div>
  );
}
