"use client";

import type { ErrorPageProps } from "./_components/error-props";

/**
 * The root layout itself failed.
 *
 * `error.tsx` cannot catch this: an error boundary does not wrap the layout
 * above it in the same segment, so a `ClerkProvider` that will not mount, or a
 * font that will not load, takes the whole document down and lands here. This
 * file replaces the root layout, which is why it declares its own `<html>` and
 * `<body>` — and why it cannot use `<Notice>`, the button styles, or any token
 * from `globals.css`: **`global-error` renders its own document and this app's
 * global stylesheet does not reach it.** Every colour below is therefore
 * literal, and the dark scheme is done with `color-scheme` plus a media query in
 * one inline stylesheet rather than the variables the rest of the product uses.
 *
 * Two consequences of that isolation, both deliberate:
 *
 *  - The copy stays French, because the épreuve is, and this is the one screen
 *    where falling back to English would be easiest and least excusable.
 *  - `metadata` is not available in a Client Component, so the title is set with
 *    React's `<title>` — the alternative the Next 16 docs give
 *    (`03-file-conventions/error.md`).
 *
 * `retry` and not `reset`: both props are passed and only `retry` re-fetches.
 * The type is shared with `error.tsx` and checked against Next's own, which is
 * where that is explained — `_components/error-props.ts`.
 */
export default function GlobalError({ error, retry }: ErrorPageProps) {
  return (
    <html lang="fr">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          colorScheme: "light dark",
          background: "Canvas",
          color: "CanvasText",
        }}
      >
        <title>Erreur · DELF B2 Production orale</title>
        <main style={{ maxWidth: "32rem", textAlign: "center" }}>
          <p
            style={{
              margin: 0,
              fontSize: "0.6875rem",
              fontWeight: 600,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              opacity: 0.7,
            }}
          >
            DELF B2 · Production orale
          </p>
          <h1 style={{ margin: "0.5rem 0 0", fontSize: "1.5rem" }}>
            L&apos;application n&apos;a pas pu démarrer
          </h1>
          <p style={{ margin: "0.75rem 0 0", lineHeight: 1.6, opacity: 0.8 }}>
            Le problème vient de notre côté. Réessayez dans un instant ; si vous
            étiez en train de passer une épreuve, elle a été interrompue.
          </p>
          <button
            type="button"
            onClick={() => retry()}
            style={{
              marginTop: "1.5rem",
              padding: "0.6rem 1.25rem",
              fontSize: "0.875rem",
              fontWeight: 600,
              borderRadius: "0.375rem",
              border: "1px solid currentColor",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            Réessayer
          </button>
          {error.digest && (
            <p style={{ marginTop: "1.5rem", fontSize: "0.75rem", opacity: 0.6 }}>
              Code à communiquer en cas de besoin : <code>{error.digest}</code>
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
