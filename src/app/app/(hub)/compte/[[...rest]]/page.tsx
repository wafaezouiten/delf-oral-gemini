import type { Metadata } from "next";

import { Kicker } from "@/app/_components/po/tag";
import { requireUserId } from "@/lib/auth/exam-guard";
import { AccountProfile } from "../_components/account-profile";

/**
 * Mon compte — one page for the account and for the record.
 *
 * The catch-all segment is Clerk's requirement, not a route this product
 * invented: `<UserProfile routing="path">` gives each of its tabs a real URL
 * under `/app/compte`, and Next has to be willing to render them. It is the
 * price of the back button working inside the account, which the hash router
 * would not have given.
 *
 * Under `(hub)`, so the rail and the tab bar stay where they are: this is a
 * screen to read, like the sujets and the tableau de bord, not a passation that
 * wants the viewport to itself.
 */

export const metadata: Metadata = {
  title: "Mon compte · Production orale DELF B2",
  description:
    "Votre compte DELF B2 : profil, sécurité, et repartir de zéro sans rien supprimer.",
};

// Per-user, and one of its tabs writes to the candidate's record.
export const dynamic = "force-dynamic";

export default async function ComptePage() {
  // On the page, not only in the layout: a layout does not re-render on a client
  // transition and does not decide whether this segment renders.
  await requireUserId();

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <Kicker>DELF B2 · Production orale</Kicker>
      <h1 className="font-serif mt-1 text-2xl leading-tight font-semibold">Mon compte</h1>
      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
        Votre profil, votre sécurité, et votre record d&apos;épreuves.
      </p>

      <div className="mt-6">
        <AccountProfile />
      </div>
    </main>
  );
}
