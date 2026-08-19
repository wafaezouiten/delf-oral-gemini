"use client";

import { useEffect } from "react";

import { Notice } from "./_components/notice";
import { primaryButton, secondaryButton } from "./_components/button-styles";
import type { ErrorPageProps } from "./_components/error-props";

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
 * The props come from `ErrorPageProps`, which is checked against Next's own
 * `ErrorInfo` rather than retyped here. That indirection is the whole defence
 * against wiring this button to `reset` — the prop Next also passes, which only
 * clears the boundary and re-runs the same broken render. Nothing else in the
 * toolchain would catch it; see the note in that file.
 */
export default function ExamError({ error, retry }: ErrorPageProps) {
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
