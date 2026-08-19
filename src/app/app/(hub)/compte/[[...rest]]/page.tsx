import type { Metadata } from "next";

import { Kicker } from "@/app/_components/po/tag";
import { requireUserId } from "@/lib/auth/exam-guard";
import { AccountProfile } from "../_components/account-profile";
import { ResetRecord } from "../_components/reset-record";

/**
 * Mon compte — one page, two blocks, one column.
 *
 * « Réinitialiser ma progression » in the header, opposite the title, and
 * Clerk's card below it — name, e-mail, password, sessions, all of it Clerk's to
 * draw.
 *
 * The reset is not in that card and not a page of its nav, and the reason is
 * what it is rather than where it fits: it touches nothing Clerk owns. It is
 * also the one control on this screen a candidate might arrive looking for, and
 * the header is the only place on a page this tall that is visible the moment it
 * loads.
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

// Per-user, and one of its controls writes to the candidate's record.
export const dynamic = "force-dynamic";

export default async function ComptePage() {
  // On the page, not only in the layout: a layout does not re-render on a client
  // transition and does not decide whether this segment renders.
  await requireUserId();

  // Narrower than the other reading screens, and left of the column they centre
  // in. The account is a form to work through rather than a document to read:
  // the sujets and the tableau de bord earn a wide centred measure because they
  // are full of prose and figures, and this is a list of fields that only looks
  // emptier the more room it is given. `lg:mx-0 lg:ml-20` rather than a
  // translate, so it stays in normal flow — and centred on the phone, where
  // there is nowhere else to be.
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col px-6 py-8 lg:mx-0 lg:ml-20">
      {/* The title on the left, the reset on the right, stacked on a phone.
          `items-start` rather than a baseline: the left side is three lines and
          the right is a button, and aligning them on anything but their tops
          drops the button into the middle of the paragraph. */}
      <header className="flex w-full flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Kicker>DELF B2 · Production orale</Kicker>
          <h1 className="font-serif mt-1 text-2xl leading-tight font-semibold">Mon compte</h1>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            Votre profil, votre sécurité, et votre record d&apos;épreuves.
          </p>
        </div>

        <ResetRecord />
      </header>

      <div className="mt-6 w-full">
        <AccountProfile />
      </div>
    </main>
  );
}
