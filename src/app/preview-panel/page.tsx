"use client";

/**
 * TEMPORARY — DELETE BEFORE MERGING #42.
 *
 * The transcription panel is stripped from every deployed build: it renders
 * only when `NODE_ENV !== "production"`, and a Vercel preview is a production
 * build. That guard is deliberate and is not being relaxed — it is what stops a
 * shipped build carrying a way to write an exam transcript without speaking.
 *
 * The cost of it is that the panel cannot be reviewed on a pull request, which
 * is what this page buys back. It renders the real component with the real
 * styles, driven by local state: there is no controller, no sitting, no
 * microphone and no request. Nothing here can write anything.
 *
 * It is a review aid with a lifetime of one pull request. It has no link
 * pointing at it and it goes out with the branch.
 */

import { useState } from "react";

import { DevTranscriptionPanel } from "../app/(fullscreen)/oral/[examId]/_components/dev-transcription-panel";

const SUBJECT = "Le télétravail a-t-il vraiment amélioré nos vies ?";

export default function PreviewPanelPage() {
  const [openActive, setOpenActive] = useState(true);
  const [closedActive, setClosedActive] = useState(false);
  const [sent, setSent] = useState<Array<{ text: string; seconds: number }>>([]);

  return (
    <main className="mx-auto flex max-w-md flex-col gap-8 p-6">
      <header className="flex flex-col gap-2">
        <span className="w-fit rounded-full bg-red-100 px-2 py-0.5 text-[0.625rem] font-bold tracking-[0.12em] text-red-700 uppercase">
          Page temporaire
        </span>
        <h1 className="text-lg font-semibold">Dev · Transcription directe</h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Aperçu du panneau pour la revue de la PR #42. Le panneau n&apos;existe
          pas dans un build déployé — cette page le rend hors de l&apos;épreuve,
          sans contrôleur, sans micro et sans requête. À supprimer avant la
          fusion.
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-xs font-semibold tracking-[0.14em] uppercase">
          Ouvert
        </h2>
        <DevTranscriptionPanel
          subject={SUBJECT}
          active={openActive}
          onActiveChange={setOpenActive}
          onSubmit={(text, seconds) => setSent((all) => [...all, { text, seconds }])}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-xs font-semibold tracking-[0.14em] uppercase">
          Fermé, tel qu&apos;il apparaît sous la passation
        </h2>
        <DevTranscriptionPanel
          subject={SUBJECT}
          active={closedActive}
          onActiveChange={setClosedActive}
          onSubmit={(text, seconds) => setSent((all) => [...all, { text, seconds }])}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-xs font-semibold tracking-[0.14em] uppercase">
          Envois
        </h2>
        {sent.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            Rien pour l&apos;instant. « Exemple » remplit le champ, « Durée (s) »
            remplace l&apos;estimation.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {sent.map((entry, index) => (
              <li key={index} className="text-xs">
                <span className="font-semibold tabular-nums">{entry.seconds} s</span> ·{" "}
                {entry.text.slice(0, 60)}…
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
