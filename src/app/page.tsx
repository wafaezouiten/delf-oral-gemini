import { auth } from "@clerk/nextjs/server";
import { SignInButton, SignUpButton } from "@clerk/nextjs";
import { redirect } from "next/navigation";

import { primaryButton, secondaryButton } from "./_components/button-styles";
import { PHASE_DURATIONS } from "@/lib/delf/phases";
import { COMPETENCY_MAX } from "@/lib/delf/constants";
import { ORAL_CRITERIA, ORAL_CRITERIA_LABELS } from "@/lib/delf/criteria";

/**
 * Landing page. A signed-in candidate is sent straight to their dashboard —
 * this product has exactly one job, so there is no marketing surface to linger
 * on.
 *
 * The numbers are read off the exam's own constants rather than typed into the
 * copy. A landing page that promises seven minutes while the timer gives five is
 * the cheapest possible way to lose a candidate's trust, and it is exactly the
 * kind of thing that drifts.
 */
export default async function HomePage() {
  const { userId } = await auth();
  if (userId) redirect("/app");

  const prepMinutes = PHASE_DURATIONS.preparation / 60;
  const monologueMinutes = PHASE_DURATIONS.monologue / 60;
  const debateMinutes = PHASE_DURATIONS.debate / 60;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-10 px-6 py-16">
      <div className="space-y-4">
        <p className="text-primary text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
          DELF B2 · Production orale
        </p>
        <h1 className="font-serif text-4xl leading-[1.15] font-semibold tracking-tight text-balance">
          Passez l&apos;épreuve orale complète, face à un examinateur qui vous
          contredit.
        </h1>
        <p className="text-muted-foreground max-w-2xl text-lg leading-relaxed">
          {prepMinutes} minutes de préparation, un monologue suivi de 5 à{" "}
          {monologueMinutes} minutes, puis un débat argumenté d&apos;environ{" "}
          {debateMinutes} minutes. À la fin, une note sur {COMPETENCY_MAX} selon
          les cinq critères de la grille officielle.
        </p>
      </div>

      <ul className="border-border divide-border grid divide-y rounded-lg border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {[
          ["Préparation", `${prepMinutes} min`, "Le sujet et vos notes."],
          ["Monologue suivi", `5–${monologueMinutes} min`, "Sans interruption."],
          ["Débat", `~${debateMinutes} min`, "L'examinateur vous conteste."],
        ].map(([title, duration, detail]) => (
          <li key={title} className="px-5 py-4">
            <p className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
              {title}
            </p>
            <p className="font-serif tabular mt-1 text-xl font-semibold">{duration}</p>
            <p className="text-muted-foreground mt-1 text-sm">{detail}</p>
          </li>
        ))}
      </ul>

      <div className="space-y-3">
        <p className="text-muted-foreground text-sm">
          Corrigé sur les cinq critères de la grille :{" "}
          {ORAL_CRITERIA.map((key) => ORAL_CRITERIA_LABELS[key].toLowerCase()).join(
            ", ",
          )}
          .
        </p>
        {/* Modals, not navigations.
         *
         * These were two `<Link>`s to `/sign-up` and `/sign-in`, which meant a
         * candidate who only wanted to start an épreuve left the page, waited on
         * a route, filled a form, waited on a verification step, and came back —
         * several full page loads before they had seen anything of the product.
         * `mode="modal"` runs the whole flow in an overlay on top of this page:
         * same Clerk forms, same verification, no navigation between the steps.
         *
         * `withSignUp` on the sign-in button is the other half of it. Without
         * it, someone who clicks "Se connecter" and turns out not to have an
         * account is bounced to a separate sign-up flow and starts again; with
         * it, Clerk carries the address they already typed straight into
         * creating the account.
         *
         * `forceRedirectUrl` on both, and the *cross* redirects too
         * (`signUpForceRedirectUrl` / `signInForceRedirectUrl`): a candidate who
         * enters through one door and leaves through the other must still land
         * on the dashboard rather than back on this page, which — being a
         * landing page that redirects signed-in visitors — would then bounce
         * them and make the whole thing look like a loop.
         *
         * The `/sign-in` and `/sign-up` routes stay. They are what
         * `requireUserId()` redirects a deep link to, and Clerk needs real
         * routes for the SSO callback and the email-link return; the modal is
         * the front door, not the only one.
         */}
        <div className="flex flex-wrap gap-3">
          <SignUpButton
            mode="modal"
            forceRedirectUrl="/app"
            signInForceRedirectUrl="/app"
          >
            <button type="button" className={`${primaryButton} px-5 py-2.5`}>
              Créer un compte
            </button>
          </SignUpButton>
          <SignInButton
            mode="modal"
            withSignUp
            forceRedirectUrl="/app"
            signUpForceRedirectUrl="/app"
          >
            <button type="button" className={`${secondaryButton} px-5 py-2.5`}>
              Se connecter
            </button>
          </SignInButton>
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        Un microphone est nécessaire. L&apos;épreuve se déroule entièrement en
        français.
      </p>
    </main>
  );
}
