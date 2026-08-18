"use client";

import type { ReactNode } from "react";

import { PencilIcon, PlayIcon } from "@/app/_components/po/icons";
import { Kicker } from "@/app/_components/po/tag";
import { SimulatorTopBar } from "@/app/_components/po/topbar";
import { TimerRing } from "@/app/_components/po/timer-ring";
import { PHASE_DURATIONS } from "@/lib/delf/phases";
import {
  buildDeroule,
  poKicker,
  shortPartLabel,
  topbarStep,
  EXPOSE_PLAN,
  MONOLOGUE_TITLE,
} from "@/lib/ui/po-player-view";
import type { OralTopic } from "@/lib/delf/topics";
import { PreflightCard } from "./preflight-card";

/**
 * The préparation desk: the sujet to read on the left, a rail on the right that
 * carries the notes and the plan the candidate is expected to follow. The notes
 * written here stay under the candidate's eyes through the passation, in the
 * drawer.
 *
 * PORT NOTE: `components/po/po-preparation-screen.tsx`, reproduced whole
 * including the rail's order — passation card, notes, structure attendue, and a
 * ghost "commencer maintenant" at the foot.
 *
 * There is exactly ONE clock, and it lives in the topbar. The reference's own
 * header explains why at length and it is worth keeping: the rail used to carry
 * a large ring of its own, on the theory that it made "time left" the first
 * thing the eye landed on, and two live countdowns of the same number ticking in
 * sync a few hundred pixels apart read as a bug rather than as emphasis. The
 * topbar is the one that stays, because the passation keeps its clock there and
 * nowhere else — so the number never moves under the candidate mid-run.
 *
 * The rail card keeps the job the clock was not doing anyway, which is
 * explaining what happens when the time runs out and offering the way on.
 *
 * **This is now the first screen of the épreuve (#55).** A briefing screen used
 * to stand in front of it, carrying the déroulé, the pre-flight checks and a
 * « Commencer la préparation » — so a candidate who had pressed « Commencer » on
 * the sujet was asked to press it again, and the examiner's spoken consigne,
 * which the controller fires on `start()`, could not be heard until they did.
 * The screen is gone and its two useful cards moved into this rail: the checks
 * (`PreflightCard`) under the passation card, and the déroulé at the foot. What
 * is lost is nothing a candidate acted on — the déroulé's durations are already
 * on the sujet's launch dialog, and this screen prints them again.
 */
export function PreparationScreen({
  topic,
  notes,
  onNotes,
  remaining,
  onStartExam,
  onExit,
  canEncode,
  checking,
  notices,
  announcement,
}: {
  topic: OralTopic;
  notes: string;
  onNotes: (value: string) => void;
  remaining: number;
  onStartExam: () => void;
  onExit: () => void;
  /** Whether this browser can compress the recording. Null while it is being
   *  asked, and if it never answered. See `PreflightCard`. */
  canEncode: boolean | null;
  /**
   * That question is still open, and the passation is held shut until it is
   * answered.
   *
   * The gate came off the briefing's CTA with the briefing (#55) and had to land
   * somewhere: a candidate who clicks straight through on a slow device would
   * otherwise outrun the only warning there will ever be about a browser that
   * cannot send the recording. `isConfigSupported` answers in milliseconds and
   * this screen lasts thirty minutes, so in practice nobody meets it.
   */
  checking: boolean;
  /** Failures raised by the controller. Above the sujet, where they are read. */
  notices?: ReactNode;
  /**
   * The examiner's spoken briefing (#37).
   *
   * First card in the rail, above « Passation ». The rail is the control column
   * and this carries controls; putting it over the sujet instead would push the
   * document the candidate has thirty minutes to read below the fold on a laptop,
   * to make room for an instruction about reading it.
   */
  announcement?: ReactNode;
}) {
  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <SimulatorTopBar
        kicker={poKicker(shortPartLabel(MONOLOGUE_TITLE))}
        // Read off the phase rather than written here. It said 1 — « Exposé » —
        // through the whole of the préparation, a leftover from when the stepper
        // named this app's three screens (`Sujet · Préparation · Passage`)
        // rather than the épreuve's three parts.
        currentStep={topbarStep("preparation")}
        onBack={onExit}
        right={
          <TimerRing
            remaining={remaining}
            total={PHASE_DURATIONS.preparation}
            phase="preparation"
          />
        }
      />

      <main className="mx-auto grid min-h-0 w-full max-w-[76.25rem] flex-1 grid-cols-1 gap-4 overflow-y-auto px-4 py-4 lg:grid-cols-[minmax(0,1fr)_22.5rem] lg:overflow-hidden lg:px-6">
        {/* Sujet — the printed sheet, on the paper stock the picker uses. */}
        <section className="border-paper-border bg-paper rounded-lg border px-6 py-7 sm:px-10 sm:py-9 lg:min-h-0 lg:overflow-y-auto">
          {notices && <div className="mb-5 space-y-3">{notices}</div>}

          <div className="border-border flex items-baseline justify-between gap-3 border-b pb-3">
            <Kicker>Sujet · Monologue suivi</Kicker>
            <span className="text-muted-foreground shrink-0 text-[0.625rem]">
              Tirage au sort
            </span>
          </div>

          <h1 className="font-serif mt-4 text-[1.75rem] leading-[1.2] font-semibold text-balance">
            {topic.title}
          </h1>

          <h2 className="text-muted-foreground border-border mt-6 border-b pb-2 text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
            Document déclencheur
          </h2>
          <p className="document-text mt-4">{topic.document}</p>

          <div className="border-border bg-muted/40 mt-6 rounded-lg border p-4">
            <Kicker>Votre mission</Kicker>
            <p className="text-foreground/85 mt-2 text-[0.8125rem] leading-relaxed">
              {topic.consigne}
            </p>
          </div>
        </section>

        {/* Rail */}
        <aside className="flex min-h-0 flex-col gap-3.5 lg:overflow-y-auto lg:pr-0.5">
          {announcement && <div className="shrink-0">{announcement}</div>}

          <div className="border-border bg-card shrink-0 rounded-lg border p-5">
            <Kicker>Passation</Kicker>
            <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
              La passation démarrera à la fin du temps de préparation, ou dès que
              vous êtes prêt. Le microphone vous sera demandé à ce moment-là.
            </p>
            <button
              type="button"
              onClick={onStartExam}
              disabled={checking}
              className="bg-primary text-primary-foreground mt-3 h-9.5 w-full rounded-md text-[0.8125rem] font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checking ? "Vérification…" : "Commencer la passation"}
            </button>
          </div>

          <div className="border-border bg-card flex min-h-[13.75rem] flex-1 flex-col overflow-hidden rounded-lg border">
            <div className="border-border flex items-center gap-2 border-b px-4 py-3">
              <PencilIcon className="text-muted-foreground size-3.5" />
              <h2 className="text-[0.78125rem] font-semibold">
                <label htmlFor="notes">Mes notes de préparation</label>
              </h2>
            </div>
            <textarea
              id="notes"
              value={notes}
              onChange={(event) => onNotes(event.target.value)}
              placeholder="Problématique, plan, arguments, exemples, connecteurs…"
              spellCheck={false}
              className="min-h-[9.375rem] flex-1 resize-none border-0 bg-transparent px-4 py-3.5 text-[0.84375rem] leading-[1.75] outline-none"
            />
          </div>

          <div className="border-border bg-card shrink-0 rounded-lg border p-4">
            {/* The same list the exposé screen prints as « Votre plan », so the
                structure a candidate is given thirty minutes to absorb is the
                one still in front of them while they speak. It used to be a
                separate four-line list written in a different voice. */}
            <Kicker>Structure attendue</Kicker>
            <ol className="mt-2.5 flex flex-col gap-2.5">
              {EXPOSE_PLAN.map((step, index) => (
                <li key={step.title} className="flex items-start gap-2.5">
                  <span
                    className="bg-primary-subtle text-primary tabular mt-px flex size-4.5 shrink-0 items-center justify-center rounded-md text-[0.625rem] font-semibold"
                    aria-hidden
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-foreground/85 text-xs font-semibold">{step.title}</p>
                    <p className="text-muted-foreground mt-0.5 text-[0.6875rem] leading-relaxed">
                      {step.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {/* The checks sit BELOW the notes, which is not where a card headed
              « Avant de commencer » wants to be. The rail is 632px of viewport
              against 1786px of content on a laptop, and the order is therefore a
              ranking: the consigne is arriving now, the CTA is the way out, and
              the notes are what the next thirty minutes are spent in. A one-time
              microphone test above them would push the writing surface a full
              screen down for every candidate, to save a scroll for the one who
              tests. What must not be missed is not in here anyway — the browser
              that cannot send a recording is a danger notice over the sujet, and
              it holds the passation button shut. */}
          <PreflightCard canEncode={canEncode} checking={checking} />

          {/* The déroulé, off the briefing screen it was written for (#55). It is
              the only place the sitting's shape is laid out end to end, and it
              is worth more here than it was there: a candidate deciding whether
              to spend their remaining préparation is deciding against the 7:00
              and the 13:00 below. */}
          <div className="border-border bg-card shrink-0 rounded-lg border p-4">
            <Kicker>Déroulé de la séance</Kicker>
            <ol className="mt-1.5">
              {buildDeroule().map((step) => (
                <li key={step.n} className="border-border flex gap-3 border-t py-2.5 last:pb-0">
                  <span className="text-primary tabular w-4 shrink-0 text-xs font-semibold">
                    {step.n}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2.5">
                      <span className="text-xs font-semibold">{step.title}</span>
                      <span className="text-muted-foreground tabular shrink-0 text-[0.6875rem] font-medium">
                        {step.durationLabel}
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-0.5 text-[0.6875rem] leading-snug">
                      {step.caption}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="flex shrink-0 justify-center pb-1">
            <button
              type="button"
              onClick={onStartExam}
              disabled={checking}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PlayIcon className="size-3.5" />
              Passer et commencer maintenant
            </button>
          </div>
        </aside>
      </main>
    </div>
  );
}
