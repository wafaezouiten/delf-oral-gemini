import type { Metadata } from "next";

import { Kicker } from "@/app/_components/po/tag";
import { requireUserId } from "@/lib/auth/exam-guard";
import { AccountProfile } from "../_components/account-profile";
import { ResetRecord } from "../_components/reset-record";
import { SignOut } from "../_components/sign-out";

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
  description: "Votre compte DELF B2 : profil, sécurité, et repartir de zéro sans rien supprimer.",
};

// Per-user, and one of its controls writes to the candidate's record.
export const dynamic = "force-dynamic";

export default async function ComptePage() {
  // On the page, not only in the layout: a layout does not re-render on a client
  // transition and does not decide whether this segment renders.
  await requireUserId();

  // Left of the column the other reading screens centre in, and two widths wide:
  // the header runs to `4xl` so « Réinitialiser » sits well out to the right,
  // while the card below keeps the `2xl` measure it wants — a Clerk card
  // stretched to the header's width is a login form the width of a desk.
  //
  // The account is a form to work through rather than a document to read, which
  // is why it is not the sujets' wide centred measure: a list of fields only
  // looks emptier the more room it is given. `lg:mx-0 lg:ml-20` rather than a
  // translate, so it stays in normal flow — and centred on the phone, where
  // there is nowhere else to be.
  return (
    // The phone gets narrower margins and a shorter rhythm (#185). `px-6` on a
    // 390 px screen spent a twelfth of the width on white either side of a
    // Clerk card that is a column of input fields; `px-4` is what every other
    // screen in the product gives a phone, and this one had no reason to be
    // the exception.
    <main className="mx-auto flex w-full max-w-2xl flex-col px-4 py-6 sm:px-6 sm:py-8 lg:mx-0 lg:ml-20 lg:max-w-4xl">
      {/* The title on the left, the reset on the right, stacked on a phone.
          `items-start` rather than a baseline: the left side is three lines and
          the right is a button, and aligning them on anything but their tops
          drops the button into the middle of the paragraph. */}
      <header className="flex w-full flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <Kicker>DELF B2 · Production orale</Kicker>
          <h1 className="mt-1 font-serif text-xl leading-tight font-semibold sm:text-2xl">
            Mon compte
          </h1>
          <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
            Votre profil, votre sécurité, et votre record d&apos;épreuves.
          </p>
        </div>

        <ResetRecord />
      </header>

      {/* The card keeps the narrow measure; only the header takes the wider one.
          A Clerk card stretched to 4xl is a login form the width of a desk.
          `min-w-0` so a wide row inside Clerk's card scrolls itself instead of
          pushing this column past the phone's viewport. */}
      <div className="mt-5 w-full min-w-0 sm:mt-6 lg:max-w-2xl">
        <AccountProfile />
      </div>

      {/* « Se déconnecter », under the card (#183). It arrived with the avatar:
          the rail's `<UserButton>` popover carried « Gérer le compte » and this,
          the avatar now goes straight to the first, and the second belongs on
          the page that manages the account rather than in a menu that no longer
          exists. Below Clerk's card rather than in the header, because the
          header is where the one control that changes the record lives, and two
          buttons up there would put a sign out beside a reset.

          It now says what it costs, which on this page is nothing (#185): a
          candidate reading a page whose other button archives their whole
          record should not have to wonder whether this one does too. The
          sentence leads on a phone and the button follows it full-width; from
          `sm` up they share a row with the button at the end. */}
      <div className="border-border mt-5 w-full border-t pt-5 sm:mt-6 sm:pt-6 lg:max-w-2xl">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <p className="text-muted-foreground max-w-[52ch] text-xs leading-relaxed">
            Vous déconnecter de cet appareil. Vos épreuves, vos corrections et vos enregistrements
            restent enregistrés.
          </p>
          <SignOut />
        </div>
      </div>
    </main>
  );
}
