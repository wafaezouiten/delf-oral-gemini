"use client";

import type { ReactNode } from "react";

import { PencilIcon } from "@/app/_components/po/icons";
import { Kicker } from "@/app/_components/po/tag";
import { SimulatorTopBar } from "@/app/_components/po/topbar";
import { TimerRing } from "@/app/_components/po/timer-ring";
import { PHASE_DURATIONS } from "@/lib/delf/phases";
import {
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
 * carries the checks, the plan the candidate is expected to follow, and the
 * notes. The notes written here stay under the candidate's eyes through the
 * passation, in the drawer.
 *
 * PORT NOTE: `components/po/po-preparation-screen.tsx`. The rail's order was
 * reproduced whole — passation card, notes, structure attendue, a ghost
 * "commencer maintenant" at the foot — and no longer is: the passation card and
 * the ghost went with #59, and the rest was reordered on the user's call to
 * checks → structure → notes, with the déroulé card dropped entirely (its
 * durations are already on the sujet's launch dialog).
 *
 * There is exactly ONE clock, and it lives in the topbar. The reference's own
 * header explains why at length and it is worth keeping: the rail used to carry
 * a large ring of its own, on the theory that it made "time left" the first
 * thing the eye landed on, and two live countdowns of the same number ticking in
 * sync a few hundred pixels apart read as a bug rather than as emphasis. The
 * topbar is the one that stays, because the passation keeps its clock there and
 * nowhere else — so the number never moves under the candidate mid-run.
 *
 * **« Commencer » is up there with it now (#59), and there is only one of it.**
 * The way on used to be a rail card explaining what happens when the time runs
 * out, plus a ghost repeat of the same action at the foot of the rail — a
 * control the candidate scrolled past twice on a laptop, three cards below the
 * clock that tells them whether to press it. Ending the préparation is a
 * decision about time, so it belongs beside the time. What the rail card said in
 * prose is said by what is left: the microphone is `PreflightCard`'s first row,
 * and the clock running out still starts the passation on its own.
 *
 * **This is now the first screen of the épreuve (#55).** A briefing screen used
 * to stand in front of it, carrying the déroulé, the pre-flight checks and a
 * « Commencer la préparation » — so a candidate who had pressed « Commencer » on
 * the sujet was asked to press it again, and the examiner's spoken consigne,
 * which the controller fires on `start()`, could not be heard until they did.
 * The screen is gone; of its cards, the checks (`PreflightCard`) survive at the
 * head of this rail. The déroulé rode along for a while and is gone too — its
 * durations are on the sujet's launch dialog, which every candidate has just
 * read. What is lost is nothing a candidate acted on.
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
  examinerModel,
  examinerSaving,
  examinerError,
  onChooseExaminer,
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
  /** The examiner this sitting will hear (#99), and the machinery to change
   *  it. Rendered by `PreflightCard`; the choice itself lives on the sitting. */
  examinerModel: string;
  examinerSaving: boolean;
  examinerError: boolean;
  onChooseExaminer: (model: string) => void;
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
   * The examiner's spoken consigne (#37) — « Passer », for the twenty-five
   * seconds it is audible (#59).
   *
   * On the « Document déclencheur » rule, at the right-hand end of it. The rail
   * is the control column and this is a control, which is where it started —
   * but it is a control about the sujet, it exists for twenty-five seconds, and
   * on a laptop the rail's head is a scroll away from the document the consigne
   * is telling the candidate to read. It costs the heading no height: the row it
   * shares was already there.
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
          <>
            <TimerRing
              remaining={remaining}
              total={PHASE_DURATIONS.preparation}
              phase="preparation"
            />
            {/* The only way on, beside the only clock (#59). It keeps the gate
                the rail card's button carried: `checking` is the WebCodecs
                question, and a candidate who clicks through on a slow device
                would otherwise outrun the one warning there will ever be about a
                browser that cannot send the recording. The label is one word
                because the topbar is 3.5rem tall and already carries the ring;
                the accessible name says what it starts. */}
            <button
              type="button"
              onClick={onStartExam}
              disabled={checking}
              aria-label="Commencer la passation"
              className="bg-primary text-primary-foreground h-8.5 shrink-0 rounded-md px-3.5 text-[0.8125rem] font-semibold whitespace-nowrap transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checking ? "Vérification…" : "Commencer"}
            </button>
          </>
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

          {/* « Passer » rides on this heading rather than sitting in the rail
              (#59): the consigne is being spoken about the document, the eye is
              already here, and the rail is a scroll away on a laptop. It wraps
              to its own line when the browser refused to autoplay, because that
              state is a paragraph and two buttons rather than one word. */}
          <div className="border-border mt-6 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2 border-b pb-2">
            <h2 className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
              Document déclencheur
            </h2>
            {announcement}
          </div>
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
          {/* The checks lead the rail. They used to sit below the notes, on the
              argument that the notes are what the thirty minutes are spent in
              and a one-time test should not push the writing surface a screen
              down; the order was reversed on the user's call — a card headed
              « Avant de commencer » opens the column, the plan the exposé will
              be marked against comes next, and the notes take the remaining
              height at the foot. What must not be missed still is not in here:
              the browser that cannot send a recording is a danger notice over
              the sujet, and it holds the passation button shut. */}
          <PreflightCard
            canEncode={canEncode}
            checking={checking}
            examinerModel={examinerModel}
            examinerSaving={examinerSaving}
            examinerError={examinerError}
            onChooseExaminer={onChooseExaminer}
          />

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

          {/* Last, and elastic: `flex-1` hands the notes whatever height the two
              fixed cards above leave, so the writing surface grows with the
              viewport instead of the gap at the rail's foot doing it. */}
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
        </aside>
      </main>
    </div>
  );
}
