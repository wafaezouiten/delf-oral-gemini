// A type-only deep import. Erased at build, so nothing here reaches the bundle
// or the runtime — see the assertion below for why it is worth the coupling.
import type { ErrorInfo } from "next/dist/client/components/error-boundary";

/**
 * The props an `error.tsx` / `global-error.tsx` receives, checked by the
 * compiler rather than asserted in a comment.
 *
 * This exists because of a gap worth naming. Next 16 hands the error component
 * **both** `reset` and `retry` — `client/components/error-boundary.js` renders
 * it with `{ error, reset, retry }` — and the two are not interchangeable:
 *
 *     this.reset = () => { this.setState({ error: null }) }
 *     this.retry = () => { startTransition(() => { this.context?.refresh(); this.reset() }) }
 *
 * `reset` only clears the boundary's state, so the same render runs again
 * against the same stale data and throws straight back; `retry` wraps
 * `router.refresh()` around it, which is what actually re-fetches. A button
 * wired to `reset` therefore is not dead — it flickers and returns to the error
 * screen, which is harder to notice and harder to diagnose.
 *
 * Nothing in the toolchain catches getting that wrong. `.next/types/validator.ts`
 * validates pages, layouts and route handlers; an `error.tsx` is none of the
 * three, so `next typegen`, `tsc --noEmit` and `next build` are all silent about
 * this file's signature, and React ignores a prop nobody destructures.
 *
 * So the check is made here instead. `Assignable` fails to compile if this type
 * ever stops matching the one Next actually passes — a renamed prop, a changed
 * signature — and the deep import fails loudly if the module moves. Both
 * failures land on this comment, which is the point: a Next upgrade that breaks
 * this line is a Next upgrade that needs a human to look at the error screens,
 * and that is much better than the button quietly doing the wrong thing.
 *
 * The import is `import type`, so it contributes nothing at runtime.
 */
export interface ErrorPageProps {
  error: Error & { digest?: string };
  /** Re-fetches and re-renders. Not `reset` — see above. */
  retry: () => void;
}

/**
 * Compile-time only: Next must still be passing a `retry` of this shape.
 *
 * Two ways to fail, both loud. If `retry` is renamed or dropped, `ErrorInfo["retry"]`
 * is not a property and the indexed access errors. If its signature changes, the
 * conditional resolves to `never` and the assignment below cannot be made.
 *
 * `error` is not asserted against `ErrorInfo["error"]`: Next types it `unknown`
 * and its own source says why (`TODO(NAR-804): Docs say this is an Error object,
 * but we don't guarantee that`). Narrowing it here is this app's choice, and
 * pinning it to Next's would only break on a change that does not matter.
 */
type NextStillPassesRetry = ErrorInfo["retry"] extends () => void ? true : never;

/** Exported so the assertion is a value the checker must evaluate, not dead code. */
export const ERROR_PROPS_MATCH_NEXT: NextStillPassesRetry = true;
