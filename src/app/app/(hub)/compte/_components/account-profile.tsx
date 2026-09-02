"use client";

import { UserProfile } from "@clerk/nextjs";

import { clerkAppearance } from "@/lib/ui/clerk-appearance";

/**
 * Clerk's account screens, drawn in this product's palette.
 *
 * The avatar has no menu any more (#183): it is a link, and this is where it
 * lands. « Gérer le compte » was one of the two entries of the `<UserButton>`
 * popover that used to stand at the foot of the rail and was already this page;
 * the other, « Se déconnecter », is now the button below this card.
 *
 * Embedded rather than reproduced. Name, e-mail, password and sessions are
 * Clerk's to draw: they change when the provider changes, and a hand-written
 * copy would be a second place to change an e-mail with one of the two
 * eventually wrong. What is ours is the palette — and the width: see
 * `clerk-appearance.ts`, which makes the card fill the page's column instead of
 * sitting off-centre inside it.
 *
 * `routing="path"` with the `[[...rest]]` segment under this route, so each of
 * Clerk's own tabs is a real URL the browser can go back through. The hash
 * router would have saved the catch-all and cost the back button.
 *
 * It carries no custom page. « Repartir de zéro » is this product's own business
 * and sits on the page below it, under its own heading, rather than dressed up as
 * one of Clerk's account tabs.
 */
export function AccountProfile() {
  return <UserProfile routing="path" path="/app/compte" appearance={clerkAppearance} />;
}
