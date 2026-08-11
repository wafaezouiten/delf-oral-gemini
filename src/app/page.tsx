import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

/**
 * Landing page. A signed-in candidate is sent straight to their dashboard —
 * this product has exactly one job, so there is no marketing surface to linger
 * on.
 */
export default async function HomePage() {
  const { userId } = await auth();
  if (userId) redirect("/app");

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-8 px-6 py-16">
      <div className="space-y-4">
        <p className="text-muted-foreground text-xs font-semibold tracking-[0.13em] uppercase">
          DELF B2 · Production orale
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-balance">
          Passez l&apos;épreuve orale complète, face à un examinateur qui vous
          contredit.
        </h1>
        <p className="text-muted-foreground text-lg leading-relaxed">
          30 minutes de préparation, un monologue suivi de 5 à 7 minutes, puis un
          débat argumenté d&apos;environ 13 minutes. À la fin, une note sur 25
          selon les cinq critères de la grille officielle.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/sign-up"
          className="bg-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-semibold"
        >
          Créer un compte
        </Link>
        <Link
          href="/sign-in"
          className="border-border rounded-lg border px-5 py-2.5 text-sm font-semibold"
        >
          Se connecter
        </Link>
      </div>

      <p className="text-muted-foreground text-xs">
        Un microphone est nécessaire. L&apos;épreuve se déroule entièrement en
        français.
      </p>
    </main>
  );
}
