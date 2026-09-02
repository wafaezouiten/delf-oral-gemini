"use client";

import { SignOutButton } from "@clerk/nextjs";

import { secondaryButton } from "@/app/_components/button-styles";

/**
 * « Se déconnecter », at the foot of the account page (#183).
 *
 * It is here because the avatar stopped being a menu. The sign out used to be
 * the second entry of Clerk's `<UserButton>` popover in the rail; the avatar now
 * navigates straight to this page, so the one thing that popover carried and
 * this page did not had to land somewhere — and the account page is where the
 * account is managed.
 *
 * Not red. This product spends red on the two controls that change the
 * candidate's record (see `button-styles.ts`), and signing out changes nothing:
 * the épreuves, the corrections and the recordings are all still there at the
 * next sign in. A destructive treatment here would be the loudest thing on a
 * page whose actually destructive-looking control is the reset above.
 *
 * `redirectUrl="/"` — the marketing page, which is the only screen a signed-out
 * visitor can read. Left to Clerk's default it returns to `/app/compte`, which
 * the middleware bounces straight back to the sign-in form, so the candidate
 * signs out and is immediately asked to sign in again.
 */
export function SignOut() {
  return (
    <SignOutButton redirectUrl="/">
      <button type="button" className={secondaryButton}>
        Se déconnecter
      </button>
    </SignOutButton>
  );
}
