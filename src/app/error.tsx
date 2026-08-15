"use client";

import { useEffect } from "react";

import { Notice } from "./_components/notice";
import { primaryButton, secondaryButton } from "./_components/button-styles";

/**
 * The last message between a crash and a blank page.
 *
 * Every failure the earlier phases produce deliberately has its own message
 * where it happens: a lost socket on the exam screen, a refused microphone
 * beside the clock, a correction that would not send on the finish screen. This
 * is for the ones nobody wrote — a Neon outage in a server component, a bad
 * render — where the alternative is Next's own error page, in English, telling a
 * candidate about a digest.
 *
 * The digest is still shown, in small print and labelled as a code for support,
 * because it is the only handle a server-side error leaves: the message itself
 * is withheld from the client in production, so `digest` is what matches this
 * screen to a line in the logs. It is not presented as something the candidate
 * should understand.
 *
 * **`retry` is the recovery prop, and it is not interchangeable with `reset`.**
 * Next 16 passes both — see `client/components/error-boundary.js`, where the
 * boundary renders `errorComponent` with `{ error, reset, retry }` — so a
 * component typed against either one compiles, and `next build` and
 * `next typegen` both stay silent: the generated `.next/types/validator.ts`
 * covers pages, layouts and route handlers only, and this file is none of them.
 * The difference is at runtime. `reset` only clears the boundary's error state,
 * so the same broken render is attempted against the same stale data and throws
 * straight back. `retry` wraps `router.refresh()` around that reset, which is
 * what actually re-fetches — and it is the one the Next 16 docs document
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`).
 * A button wired to `reset` is not dead, which is worse: it flickers and returns
 * to this screen.
 */
export default function ExamError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-5 px-6 py-16">
      <div className="space-y-2 text-center">
        <p className="text-primary text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
          DELF B2 · Production orale
        </p>
        <h1 className="font-serif text-2xl font-semibold">Une erreur est survenue</h1>
      </div>

      <Notice
        tone="danger"
        title="Cette page n'a pas pu s'afficher"
        action={
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => retry()} className={primaryButton}>
              Réessayer
            </button>
            {/* A full navigation rather than a `<Link>`: whatever failed may
                have left the client router holding a broken tree, and a soft
                transition would hand the candidate the same crash again. */}
            <a href="/app" className={secondaryButton}>
              Revenir au tableau de bord
            </a>
          </div>
        }
      >
        Le problème vient de notre côté, pas de votre épreuve. Réessayez : si vous
        étiez en train de passer une épreuve, elle a été interrompue et vous
        pourrez en commencer une nouvelle.
      </Notice>

      {error.digest && (
        <p className="text-muted-foreground text-center text-xs">
          Code à communiquer en cas de besoin : <code className="tabular">{error.digest}</code>
        </p>
      )}
    </main>
  );
}
