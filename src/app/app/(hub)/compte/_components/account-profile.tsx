"use client";

import { UserProfile } from "@clerk/nextjs";

import { RefreshIcon } from "@/app/_components/po/icons";
import { clerkAppearance } from "@/lib/ui/clerk-appearance";
import { ResetRecord } from "./reset-record";

/**
 * Mon compte: Clerk's account screens and this product's record, in one card.
 *
 * The avatar keeps its menu — « Gérer le compte » and « Se déconnecter », as it
 * always had. What changed is that the first of those two lands here rather than
 * opening Clerk's modal over the app: `userProfileMode="navigation"` in the
 * sidebar points it at this route, so the account is a page with a left-hand nav
 * — *Profil*, *Sécurité*, *Repartir de zéro* — instead of a dialog. Signing out
 * stays in the menu, which is why there is no sign-out control on this page.
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
 */
export function AccountProfile() {
  return (
    <UserProfile routing="path" path="/app/compte" appearance={clerkAppearance}>
      <UserProfile.Page
        label="Repartir de zéro"
        url="repartir-de-zero"
        labelIcon={<RefreshIcon className="size-4" />}
      >
        <ResetRecord />
      </UserProfile.Page>
    </UserProfile>
  );
}
