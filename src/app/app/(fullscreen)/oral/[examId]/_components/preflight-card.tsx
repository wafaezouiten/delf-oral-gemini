"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AudioBars } from "@/app/_components/po/audio-bars";
import { CheckCircleIcon } from "@/app/_components/po/icons";
import { cn } from "@/lib/ui/class-names";
import { PHASE_DURATIONS } from "@/lib/delf/phases";
import { liveModelChoices } from "@/lib/gemini/constants";

/**
 * « Avant de commencer » — the card that answers "can I do this now?".
 *
 * PORT NOTE: the reference's pre-flight card, from `po-briefing-screen.tsx`. It
 * used to be on a briefing screen of our own that stood between the sujet and
 * the préparation; that screen is gone (#55) and this is the half of it that had
 * to survive, so it moved to the préparation rail rather than being deleted with
 * the rest. Every row is still something the candidate can act on *before* they
 * commit — which is now the thirty minutes of préparation they are already
 * sitting in, and the passation they have not started.
 *
 * Two departures from the reference, both of them this project's facts rather
 * than preferences:
 *
 *  - **The transport row is gone.** The reference gates it on `isAdmin` and
 *    returns `undefined` for candidates, so it never renders for one. There is
 *    no admin role here, so the row would have no reader at all.
 *  - **A browser row is added.** A browser without WebCodecs cannot compress the
 *    recording, so the correction is made from the transcript alone and the
 *    duration penalty applies as if nothing had been recorded (#24). The
 *    reference has no analogue because it never uploads audio. The préparation is
 *    the last moment the candidate can do anything about it, so it is a row here
 *    and a danger notice over the sujet, and « Commencer la passation » stays
 *    shut until the question is answered.
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
 * it: a privacy tell, during préparation, that the candidate cannot dismiss.
 * That matters more here than in the reference, since this product's whole claim
 * is that nothing is recorded before the exposé and a lit indicator over a
 * notes page contradicts it in the one place it is stated.
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

/**
 * The examiners on offer (#99). Computed once: the list is a build-time fact —
 * the verified allow-list, with the configured default first — and it cannot
 * change under a mounted card.
 */
const EXAMINER_CHOICES = liveModelChoices();

export function PreflightCard({
  canEncode,
  checking,
  examinerModel,
  examinerSaving,
  examinerError,
  onChooseExaminer,
}: {
  /** Null while the browser is still being asked, and if it never answered. */
  canEncode: boolean | null;
  /** Whether that question is still open. */
  checking: boolean;
  /**
   * The examiner this sitting will hear, and the machinery to change it (#99).
   *
   * A pre-flight concern, which is why it lives on this card beside the
   * microphone rather than anywhere near the clock: it is decided before the
   * passation and immutable after it — the server refuses the write once the
   * préparation ends. The value only advances when the row was written (or
   * provably has no row), so what this shows is what will actually speak.
   */
  examinerModel: string;
  examinerSaving: boolean;
  /** The last change did not take; the shown model is still the sitting's. */
  examinerError: boolean;
  onChooseExaminer: (model: string) => void;
}) {
  const [micState, checkMic] = useMicCheck();
  /** The « Enregistrement audio » consent, on by default. Local until the
   *  historique-recordings issue gives it something to govern — see its row. */
  const [keepAudio, setKeepAudio] = useState(true);
  // Minutes, not `formatClock`. The reference prints "7:00 sans interruption"
  // here, which works beside a single part; across the whole sitting "20:00 de
  // prise de parole" reads as a clock somebody forgot to start rather than as a
  // length. Every other duration on this screen is a countdown and is formatted
  // as one — this is the only one that is a quantity.
  const speakingMinutes = (PHASE_DURATIONS.monologue + PHASE_DURATIONS.debate) / 60;

  return (
    <section className="border-border bg-card flex shrink-0 flex-col gap-3 rounded-lg border p-4">
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

      {/* The examiner, under the microphone: the two decisions a candidate can
          actually take on this card, together at its head. The <select> shows
          readable names; the raw model id is the option's value, the row's
          tooltip, and what the correction will print — a label alone would
          hide which model actually ran (#99). The row never advances on a
          failed write: what it shows is always what the sitting will hear. */}
      <PreflightRow
        title="Examinateur"
        detail={
          examinerError
            ? "Le choix n'a pas pu être enregistré, réessayez."
            : examinerSaving
              ? "Enregistrement du choix…"
              : (EXAMINER_CHOICES.find((choice) => choice.id === examinerModel)?.detail ??
                examinerModel)
        }
        right={
          <select
            value={examinerModel}
            onChange={(event) => onChooseExaminer(event.target.value)}
            disabled={examinerSaving}
            aria-label="Modèle de l'examinateur"
            title={examinerModel}
            className="border-border bg-card hover:bg-muted max-w-[11rem] shrink rounded-md border px-2 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {EXAMINER_CHOICES.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
            {/* A sitting can name a model the list no longer carries — the row
                outlives the catalogue. Shown under its raw id rather than
                snapped to an option it never was. */}
            {!EXAMINER_CHOICES.some((choice) => choice.id === examinerModel) && (
              <option value={examinerModel}>{examinerModel}</option>
            )}
          </select>
        }
      />

      <PreflightRow
        title="Endroit calme"
        detail={`${speakingMinutes} min de prise de parole sans interruption`}
        right={
          <span className="text-muted-foreground shrink-0 text-xs font-medium">requis</span>
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

      {/* Whether the candidate's voice is kept with the sitting. The switch is
          AHEAD of its feature, on the user's call: the retention itself — the
          recording landing on the historique page — is an issue not yet
          started, so today this toggle holds its state in this card and
          nothing reads it. When that issue is built, the state lifts to the
          exam client and rides the finish request; the control is here first
          so the consent question is asked where every other pre-flight
          question already is. */}
      <PreflightRow
        title="Enregistrement audio"
        detail="Votre voix sera conservée avec vos résultats."
        right={
          <button
            type="button"
            role="switch"
            aria-checked={keepAudio}
            aria-label="Conserver l'enregistrement audio"
            onClick={() => setKeepAudio((keep) => !keep)}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
              keepAudio ? "border-primary bg-primary" : "border-border bg-muted",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "bg-card absolute size-3.5 rounded-full shadow-sm transition-transform",
                keepAudio ? "translate-x-[1.125rem]" : "translate-x-0.5",
              )}
            />
          </button>
        }
      />

      {/* What the briefing said in a full `<Notice>`, kept because both halves
          are promises: nothing is captured during the préparation, and a
          headset is what stops the examiner hearing itself back. Set as a
          footnote rather than an alert — this rail is 360px wide and a blue box
          of five sentences beside a notes field is not read. */}
      <p className="text-muted-foreground border-border border-t pt-3 text-[0.6875rem] leading-relaxed">
        Rien n&apos;est enregistré avant votre exposé : le microphone vous sera
        demandé à ce moment-là. Utilisez un casque, sans quoi l&apos;examinateur
        s&apos;entend lui-même et la transcription en souffre.
      </p>
    </section>
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
    <div
      className={cn(
        "border-border flex items-center justify-between gap-3 border-t pt-3 first:border-t-0 first:pt-0",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[0.8125rem] font-semibold">{title}</span>
        <span className="text-muted-foreground text-xs">{detail}</span>
      </div>
      {right}
    </div>
  );
}
