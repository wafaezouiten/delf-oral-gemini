/**
 * The three buttons this product has, as class strings rather than a component.
 *
 * A wrapper component would have to re-expose `type`, `disabled`, `onClick`,
 * `href`, `aria-*` and the difference between a `<button>` and a `<Link>` — for
 * three sets of colours. Class strings compose with both, keep the elements
 * native (so keyboard behaviour is the browser's and not ours), and stop the
 * eight call sites drifting into eight slightly different paddings.
 *
 * The focus ring is not here: it is one rule in `globals.css` on
 * `:focus-visible`, so a control cannot lose it by being styled with something
 * other than these.
 */

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors";

/** The action that moves the épreuve forward. One per screen, at most. */
export const primaryButton = `${BASE} bg-primary text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50`;

/** Everything else: going back, opening a subject, leaving. */
export const secondaryButton = `${BASE} border border-border bg-card text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50`;

/** Recovering from a failure — the only red button, and never a destructive one. */
export const dangerButton = `${BASE} border border-danger/40 bg-danger-subtle text-danger hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50`;
