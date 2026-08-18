"use client";

import { SignOutButton, UserProfile } from "@clerk/nextjs";

import { secondaryButton } from "@/app/_components/button-styles";
import { ExitIcon, RefreshIcon } from "@/app/_components/po/icons";
import { clerkAppearance } from "@/lib/ui/clerk-appearance";
import { ResetRecord } from "./reset-record";

/**
 * Mon compte: Clerk's account screens and this product's record, in one card.
 *
 * The avatar in the rail is a link to this page rather than a menu, so there is
 * one route to the account instead of a dropdown that offers a modal and a sign
 * out. What used to be two clicks through somebody else's popover is now a page
 * with a left-hand nav — *Profil*, *Sécurité*, *Repartir de zéro* — which is
 * where a candidate looks for their account anyway.
 *
 * `<UserProfile>` embedded rather than reproduced. Name, e-mail, password and
 * sessions are Clerk's to draw: they change when the provider changes, and a
 * hand-written copy would be a second place to change an e-mail with one of the
 * two eventually wrong. What is ours is the palette it is drawn in — see
 * `clerk-appearance.ts`, whose whole job is that this card reads as stationery
 * rather than as a widget from another application.
 *
 * `routing="path"` with the `[[...rest]]` segment under this route, so each of
 * Clerk's tabs is a real URL the browser can go back through. The hash router
 * would have saved the catch-all and cost the back button.
 *
 * Sign out is here because the menu it used to live in is gone, and it is our
 * button rather than Clerk's row: it is the one control on this page that ends
 * the session, and it should look like every other control in the product that
 * takes you somewhere.
 */
export function AccountProfile() {
  return (
    <div className="space-y-6">
      <UserProfile routing="path" path="/app/compte" appearance={clerkAppearance}>
        <UserProfile.Page
          label="Repartir de zéro"
          url="repartir-de-zero"
          labelIcon={<RefreshIcon className="size-4" />}
        >
          <ResetRecord />
        </UserProfile.Page>
      </UserProfile>

      <div className="flex justify-end">
        {/* `redirectUrl` rather than Clerk's default: signing out from inside the
            app should land on the product's own front door, not on a page that
            still looks like the app with nothing in it. */}
        <SignOutButton redirectUrl="/">
          <button type="button" className={secondaryButton}>
            <ExitIcon className="size-4" />
            Se déconnecter
          </button>
        </SignOutButton>
      </div>
    </div>
  );
}
