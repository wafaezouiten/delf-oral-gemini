import Link from "next/link";

import { secondaryButton } from "./_components/button-styles";

/**
 * The 404, in French, because it is a page candidates actually reach.
 *
 * Not only mistyped URLs: `notFound()` is the deliberate answer to two real
 * cases from the earlier phases, and without this file both of them answered in
 * Next's default English.
 *
 *  - **A sitting that is not yours** (Phase 3). `requireExamAccess` refuses, and
 *    the exam route calls `notFound()` rather than saying whose it is — an
 *    "accès refusé" page confirms the id exists, which is a fact about somebody
 *    else's account.
 *  - **A subject that no longer exists** (Phase 1). The catalogue lives in code
 *    and sittings store a slug, so a subject removed between two deploys leaves
 *    an id whose sujet cannot be shown.
 *
 * The copy names both without claiming to know which happened, because this
 * component genuinely does not — `notFound()` carries no reason, deliberately.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-5 px-6 py-16">
      <div className="space-y-2 text-center">
        <p className="text-primary text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
          DELF B2 · Production orale
        </p>
        <h1 className="font-serif text-2xl font-semibold">Page introuvable</h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Cette page n&apos;existe pas, ou l&apos;épreuve que vous cherchez
          n&apos;est pas accessible depuis ce compte.
        </p>
      </div>
      <div className="flex justify-center">
        <Link href="/app" className={secondaryButton}>
          Revenir au tableau de bord
        </Link>
      </div>
    </main>
  );
}
