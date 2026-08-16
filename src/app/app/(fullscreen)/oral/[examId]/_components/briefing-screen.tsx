"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Notice } from "@/app/_components/notice";
import { AudioBars } from "@/app/_components/po/audio-bars";
import { CheckCircleIcon, PlayIcon, ArrowRightIcon } from "@/app/_components/po/icons";
import { SimulatorTopBar } from "@/app/_components/po/topbar";
import { cn } from "@/lib/ui/class-names";
import { formatClock, PHASE_DURATIONS } from "@/lib/delf/phases";
import {
  buildDeroule,
  MONOLOGUE_TITLE,
  partSubtitle,
  poKicker,
  shortPartLabel,
} from "@/lib/ui/po-player-view";
import type { OralTopic } from "@/lib/delf/topics";

/**
 * The sujet screen: the brief the candidate meets before the clock starts.
 *
 * PORT NOTE: `components/po/po-briefing-screen.tsx`, reproduced whole. A light
 * "séance" rail on the left carries the identity, the déroulé and the pre-flight
 * checks; the column on the right is the document déclencheur, set as the
 * printed page it is on the day. The reference's own note on the right column is
 * worth restating because it explains a choice that otherwise looks like a bug:
 * the paragraphs are justified with `hyphens-auto` deliberately, because this is
 * the widest measure in the product and a flush right edge without word breaks
 * fills with rivers.
 *
 * The pre-flight card answers "can I do this now?" and nothing else. Every row
 * is something the candidate can act on before they commit thirty minutes. Two
 * departures from the reference's version of it, both of them this project's
 * facts rather than preferences:
 *
 *  - **The transport row is gone.** The reference gates it on `isAdmin` and
 *    returns `undefined` for candidates, so it never renders for one. There is
 *    no admin role here, so the row would have no reader at all.
 *  - **A browser row is added.** A browser without WebCodecs cannot compress the
 *    recording, so the correction is made from the transcript alone and the
 *    duration penalty applies as if nothing had been recorded (#24). The
 *    reference has no analogue because it never uploads audio. This is the last
 *    moment the candidate can do anything about it, so it is a check here and a
 *    danger notice below, and the CTA stays shut until the question is answered.
 */

/** What a real `getUserMedia` call has told us so far. */
type MicState = "idle" | "testing" | "tested" | "failed";

/**
 * A genuine mic check: requests the microphone and reports whether the browser
 * granted it. The bars are a "listening" cue, not a level meter.
 *
 * PORT NOTE: the reference's `useMicCheck`, reproduced including its two
 * lifetime guards, because both are load-bearing and neither is obvious:
 *
 * The stream is held in a ref, not just in the timeout's closure, because the
 * mic must be released down every path — not only the happy one. Leaving a track
 * live keeps the browser's "recording" indicator lit with nothing left to close
 * it: a privacy tell, before an exam, that the candidate cannot dismiss. That
 * matters more here than in the reference, since this product's whole claim is
 * that nothing is recorded before the monologue and a lit indicator on the
 * briefing screen contradicts it in the one place it is stated.
 *
 * `getUserMedia` cannot be cancelled, so a grant that lands after unmount still
 * has to be stopped on arrival; `liveRef` is what makes that decidable.
 */
function useMicCheck(): [MicState, () => void] {
  const [state, setState] = useState<MicState>("idle");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const liveRef = useRef(true);

  const release = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      release();
    };
  }, [release]);

  const check = useCallback(() => {
    // Re-checking drops the previous grant before asking for another.
    release();
    setState("testing");
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      setState("failed");
      return;
    }
    media
      .getUserMedia({ audio: true })
      .then((stream) => {
        // Unmounted (or re-checked) while the prompt was open: this grant is
        // already orphaned, so stop it here rather than store it.
        if (!liveRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        timeoutRef.current = setTimeout(() => {
          release();
          setState("tested");
        }, 1800);
      })
      .catch(() => {
        if (liveRef.current) setState("failed");
      });
  }, [release]);

  return [state, check];
}

const MIC_COPY: Record<MicState, string> = {
  idle: "Vérifiez votre niveau d'entrée.",
  testing: "Parlez normalement…",
  tested: "Micro autorisé, vous êtes prêt.",
  failed: "Autorisez le micro, puis réessayez.",
};

export function BriefingScreen({
  topic,
  onStart,
  onSkip,
  onBack,
  canEncode,
  checking,
}: {
  topic: OralTopic;
  onStart: () => void;
  /** Straight to the monologue, skipping the préparation. The reference's own
   *  "Passer et aller directement à l'épreuve". */
  onSkip: () => void;
  onBack: () => void;
  /** Null while the browser is still being asked, and if it never answered. */
  canEncode: boolean | null;
  /** Whether that question is still open. */
  checking: boolean;
}) {
  const [micState, checkMic] = useMicCheck();
  const deroule = buildDeroule();
  const partLabel = shortPartLabel(MONOLOGUE_TITLE);
  // Minutes, not `formatClock`. The reference prints "7:00 sans interruption"
  // here, which works beside a single part; across the whole sitting "20:00 de
  // prise de parole" reads as a clock somebody forgot to start rather than as a
  // length. Every other duration on this screen is a countdown and is formatted
  // as one — this is the only one that is a quantity.
  const speakingMinutes = (PHASE_DURATIONS.monologue + PHASE_DURATIONS.debate) / 60;

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <SimulatorTopBar
        kicker={poKicker(partLabel)}
        currentStep={0}
        onBack={onBack}
        right={
          <>
            <button
              type="button"
              onClick={onSkip}
              disabled={checking}
              className="text-muted-foreground hover:text-foreground hover:bg-muted flex h-8 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="hidden xl:inline">Passer et commencer l&apos;épreuve</span>
              <span className="xl:hidden">Passer</span>
              <ArrowRightIcon className="size-3.5" />
            </button>
            {/* Held shut until the browser has answered, so the encoding
                warning cannot be outrun by a candidate clicking straight
                through. `Briefing` does not come back. */}
            <button
              type="button"
              onClick={onStart}
              disabled={checking}
              className="bg-primary text-primary-foreground flex h-8 shrink-0 items-center gap-1.5 rounded-full px-4 text-xs font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PlayIcon className="size-3.5" />
              {checking ? "Vérification…" : "Commencer la préparation"}
              {!checking && (
                <span className="tabular text-primary-foreground/70 text-[0.6875rem] font-normal">
                  {formatClock(PHASE_DURATIONS.preparation)}
                </span>
              )}
            </button>
          </>
        }
      />

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {/* Left — la séance */}
        <aside className="border-border bg-muted/40 w-full border-b lg:h-full lg:max-w-[27.5rem] lg:min-w-[22.5rem] lg:overflow-y-auto lg:border-r lg:border-b-0">
          <div className="flex flex-col gap-7 px-8 py-8">
            <div>
              <h1 className="font-serif text-[2.5rem] leading-[1.05] font-semibold">
                {partLabel}
              </h1>
              <p className="text-muted-foreground font-serif mt-1 text-xl">
                {partSubtitle(MONOLOGUE_TITLE)}
              </p>
            </div>

            <section>
              <h2 className="text-muted-foreground pb-2 text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
                Déroulé de la séance
              </h2>
              <ol>
                {deroule.map((step) => (
                  <li key={step.n} className="border-border flex gap-3.5 border-t py-3.5">
                    <span className="text-primary tabular w-6 shrink-0 text-[0.9375rem] font-semibold">
                      {step.n}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2.5">
                        <span className="text-sm font-semibold">{step.title}</span>
                        <span className="text-muted-foreground tabular shrink-0 text-xs font-medium">
                          {step.durationLabel}
                        </span>
                      </div>
                      <p className="text-muted-foreground mt-0.5 text-xs leading-snug">
                        {step.caption}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4">
              <h2 className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
                Avant de commencer
              </h2>

              <PreflightRow
                title="Microphone"
                detail={MIC_COPY[micState]}
                right={
                  micState === "testing" ? (
                    <AudioBars heightClass="h-5" className="text-primary shrink-0 px-1.5" />
                  ) : micState === "tested" ? (
                    <span className="border-success/30 bg-success-subtle text-success inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[0.6875rem] font-semibold">
                      <CheckCircleIcon className="size-3.5" />
                      Opérationnel
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={checkMic}
                      className="border-border bg-card hover:bg-muted shrink-0 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors"
                    >
                      {micState === "failed" ? "Réessayer" : "Tester"}
                    </button>
                  )
                }
              />

              <PreflightRow
                title="Endroit calme"
                detail={`${speakingMinutes} min de prise de parole sans interruption`}
                right={
                  <span className="text-muted-foreground shrink-0 text-xs font-medium">
                    requis
                  </span>
                }
              />

              <PreflightRow
                title="Navigateur"
                detail={
                  checking
                    ? "Vérification de la compression audio…"
                    : canEncode === false
                      ? "Ne sait pas compresser l'enregistrement."
                      : "Peut envoyer votre enregistrement."
                }
                right={
                  checking ? (
                    <span className="text-muted-foreground shrink-0 text-xs font-medium">
                      en cours
                    </span>
                  ) : canEncode === false ? (
                    <span className="border-danger/40 bg-danger-subtle text-danger inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[0.6875rem] font-semibold">
                      <span aria-hidden>✕</span>
                      Incompatible
                    </span>
                  ) : (
                    <span className="border-success/30 bg-success-subtle text-success inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[0.6875rem] font-semibold">
                      <CheckCircleIcon className="size-3.5" />
                      Compatible
                    </span>
                  )
                }
              />
            </section>

            <div className="space-y-4">
              <Notice tone="info" title="Microphone et enregistrement">
                Le microphone vous sera demandé au début du monologue, pas
                maintenant. Rien n&apos;est enregistré avant que vous ne
                l&apos;autorisiez : un témoin
                &laquo;&nbsp;Enregistrement&nbsp;&raquo; reste visible en haut de
                l&apos;écran pendant toute l&apos;épreuve. Vos deux prises de
                parole sont enregistrées séparément, puis envoyées pour la
                correction une fois l&apos;épreuve terminée. Utilisez un casque :
                sans lui, l&apos;examinateur s&apos;entend lui-même et la
                transcription en souffre.
              </Notice>

              {canEncode === false && (
                // Said here, and only here: after the épreuve the candidate can
                // do nothing about it, and the results page will only be able to
                // report that the correction was made without the audio.
                <Notice
                  tone="danger"
                  title="Votre navigateur ne peut pas envoyer l'enregistrement"
                >
                  Il ne sait pas compresser l&apos;audio. Votre prestation sera
                  corrigée à partir de la transcription seule, sans écoute de
                  votre prononciation, et la pénalité de durée s&apos;appliquera
                  comme si aucun enregistrement n&apos;existait. Passez plutôt
                  l&apos;épreuve sur une version récente de Chrome, Edge, Safari
                  ou Firefox.
                </Notice>
              )}
            </div>
          </div>
        </aside>

        {/* Right — le document */}
        <section className="flex-1 lg:overflow-y-auto">
          <div className="mx-auto max-w-[47.5rem] px-6 py-10 sm:px-12 sm:py-12">
            <div className="flex items-center justify-end">
              <span className="text-primary bg-primary-subtle inline-flex items-center rounded-md px-2.5 py-0.5 text-[0.6875rem] font-semibold">
                DELF B2
              </span>
            </div>

            <h2 className="font-serif mt-4 text-[2.5rem] leading-[1.12] font-semibold text-balance">
              {topic.title}
            </h2>

            <h3 className="text-muted-foreground border-border mt-8 border-b pb-2 text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
              Document déclencheur
            </h3>
            <p className="document-text mt-4">{topic.document}</p>

            <div className="border-border bg-muted/40 mt-8 rounded-lg border p-5">
              <h3 className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
                Consigne
              </h3>
              <p className="text-foreground/85 mt-2.5 text-justify text-sm leading-relaxed hyphens-auto">
                {topic.consigne}
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

/** One row of the pre-flight card: what it is, how it stands, what to do. */
function PreflightRow({
  title,
  detail,
  right,
  className,
}: {
  title: string;
  detail: string;
  right: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-border flex items-center justify-between gap-3 border-t pt-3 first:border-t-0 first:pt-0", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[0.8125rem] font-semibold">{title}</span>
        <span className="text-muted-foreground text-xs">{detail}</span>
      </div>
      {right}
    </div>
  );
}
