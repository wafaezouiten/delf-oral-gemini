"use client";

/**
 * DEVELOPMENT ONLY — fast-forward the exam clock (#149).
 *
 * PORT NOTE: the reference's `po-admin-time-skip.tsx`, reproduced whole: a
 * fixed pill above the control bar with a « Dev » badge, two step buttons and
 * « Fin du temps », in the warning palette so it can never be mistaken for
 * exam chrome. It only shifts the client's start stamp (see the controller's
 * `devSkipTime`), so it exercises the real close-out path exactly as a genuine
 * timeout would — no back door around it.
 *
 * Two adaptations, both forced by what differs here rather than chosen:
 *
 *  - **Gated on the development build, not on an admin.** The reference showed
 *    this to a signed-in admin on a live production session; this project's
 *    dev tooling is `DEV_TOOLS_ENABLED` (#36), which fails closed in
 *    production, and the caller applies that gate the same way it does for
 *    every other dev control.
 *  - **Its own SVGs.** The reference pulls FastForward/Next from hugeicons;
 *    this repo inlines its dev-tool icons (see the dev panels), so these two
 *    are drawn here the same way.
 */

const SKIP_STEPS = [
  { label: "+30 s", seconds: 30 },
  { label: "+2 min", seconds: 120 },
] as const;

export function DevTimeSkip({
  onSkip,
  onSkipToEnd,
}: {
  /** Advance the derived elapsed time by this many seconds. */
  onSkip: (seconds: number) => void;
  /** Jump straight to time-up and trigger the close-out. */
  onSkipToEnd: () => void;
}) {
  return (
    <div className="border-warning/50 bg-warning-subtle text-warning pointer-events-auto fixed bottom-24 left-4 z-20 flex items-center gap-1.5 rounded-full border px-2 py-1.5 shadow-sm">
      <span className="border-warning/60 mr-0.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase">
        <FastForwardIcon />
        Dev
      </span>
      {SKIP_STEPS.map((step) => (
        <button
          key={step.seconds}
          type="button"
          onClick={() => onSkip(step.seconds)}
          className="hover:bg-warning/20 rounded-full px-2 py-1 text-[11.5px] font-semibold transition-colors"
        >
          {step.label}
        </button>
      ))}
      <button
        type="button"
        onClick={onSkipToEnd}
        className="hover:bg-warning/20 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11.5px] font-semibold transition-colors"
      >
        <NextIcon />
        Fin du temps
      </button>
    </div>
  );
}

function FastForwardIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 19l9-7-9-7v14zM2 19l9-7-9-7v14z" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 4l10 8-10 8V4zM19 5v14" />
    </svg>
  );
}
