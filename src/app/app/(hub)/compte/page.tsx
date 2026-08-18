import type { Metadata } from "next";
import { currentUser } from "@clerk/nextjs/server";

import { Kicker } from "@/app/_components/po/tag";
import { requireUserId } from "@/lib/auth/exam-guard";
import { readCandidateHistory } from "@/lib/db/history";
import { ResetRecord } from "./_components/reset-record";

/**
 * Mon compte: who you are signed in as, and the one thing this product lets you
 * do to your own record.
 *
 * The screen exists because « Repartir de zéro » (#69) had nowhere to live. The
 * account was Clerk's `<UserButton />` and nothing else — name, email, sign
 * out — and a reset that empties three screens does not belong inside a
 * third-party modal where it cannot be linked to and cannot be explained.
 *
 * Which is also why the identity block here is read-only and says so. Clerk owns
 * the account; this page owns the record. Reproducing Clerk's form would give
 * the product two places to change an email and one of them would eventually be
 * wrong.
 *
 * It is not in the rail and not in the tab bar: the entry point is « Mon compte »
 * beside the avatar, which was already there as dead text. Four destinations
 * stay four destinations, and the account keeps being reached where an account
 * is reached.
 */

export const metadata: Metadata = {
  title: "Mon compte · Production orale DELF B2",
  description:
    "Votre compte et votre record d'épreuves de production orale DELF B2 : repartir de zéro sans rien supprimer.",
};

// Per-user, and it prints a count of somebody's épreuves.
export const dynamic = "force-dynamic";

export default async function ComptePage() {
  // On the page, not only in the layout: a layout does not re-render on a client
  // transition and does not decide whether this segment renders.
  const userId = await requireUserId();

  // One read for both numbers. The archive is asked for here and nowhere else
  // except the historique — every other screen wants the current record only.
  const [user, everything] = await Promise.all([
    currentUser(),
    readCandidateHistory(userId, { includeArchived: true }),
  ]);

  const current = everything.filter((sitting) => sitting.archivedAt === null);
  const archived = everything.length - current.length;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <Kicker>DELF B2 · Production orale</Kicker>
      <h1 className="font-serif mt-1 text-2xl leading-tight font-semibold">Mon compte</h1>

      <section className="border-border bg-card mt-6 sheet border p-6">
        <h2 className="text-sm font-semibold">Identité</h2>
        <dl className="mt-3 space-y-2 text-sm">
          {user?.fullName && (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">Nom</dt>
              <dd>{user.fullName}</dd>
            </div>
          )}
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">Adresse e-mail</dt>
            <dd>{user?.primaryEmailAddress?.emailAddress ?? "—"}</dd>
          </div>
        </dl>
        <p className="text-muted-foreground mt-4 text-sm leading-relaxed">
          Pour modifier votre nom, votre adresse ou votre mot de passe, ou pour vous
          déconnecter, ouvrez le menu de votre avatar.
        </p>
      </section>

      <ResetRecord current={current.length} archived={archived} />
    </main>
  );
}
