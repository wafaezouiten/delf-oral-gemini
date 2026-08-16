"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/ui/class-names";
import {
  DEV_PANEL_COPY,
  describeDraft,
  exampleExpose,
  resolveDevSeconds,
} from "@/lib/ui/dev-transcription";

/**
 * DEVELOPMENT ONLY — replace the exposé's recording with typed text.
 *
 * Exercising anything downstream of the transcript (the rubric, the
 * persistence, the results page, the duration penalty) otherwise costs twenty
 * minutes of speaking French into a microphone. That is slow enough that those
 * paths get tested rarely, which is the opposite of what they need.
 *
 * Behind a button, and the button has a real effect: opening it turns the
 * microphone off. That is a thing to decide to do, not a thing to discover you
 * have been doing.
 *
 * **Where it lives.** In the control bar, beside « Transcription vide » — the
 * two belong together. That notice is what appears when the monologue recorded
 * nothing, which is exactly the moment somebody reaches for this, and both are
 * about the transcript rather than about the épreuve.
 *
 * That placement is why the panel is a popover rather than a block: the bar is
 * one row tall and the panel is not, so it opens upward over the conversation
 * instead of stretching the bar. The trigger stays mounted underneath it, both
 * as the anchor and because a control that disappears when you use it leaves
 * nothing to say where the panel came from.
 *
 * **The exposé only.** The caller does not render this in the débat, and the
 * controller gives the microphone back when the monologue ends, so the two
 * cannot drift into a state where the mode is on with no way to use it.
 *
 * The open/closed state lives on the controller, not here, because the
 * controller is what pauses the recorder. A copy in this component could
 * disagree with the microphone, invisibly.
 *
 * Amber throughout, and nothing else in the épreuve is amber: the panel writes
 * an exam transcript without anyone speaking, so it should never be mistakeable
 * for part of the sitting.
 */
export function DevTranscriptionPanel({
  subject,
  active,
  onActiveChange,
  onSubmit,
}: {
  /** Seeds « Exemple », so the sample answers the sujet actually on screen. */
  subject: string;
  active: boolean;
  onActiveChange: (on: boolean) => void;
  onSubmit: (text: string, seconds: number) => void;
}) {
  const [text, setText] = useState("");
  const [duration, setDuration] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  // Opening the panel is a decision to type, so the caret goes where the typing
  // goes. Without this the first thing it asks for is another click.
  useEffect(() => {
    if (active) field.current?.focus();
  }, [active]);

  const ready = text.trim().length > 0;

  return (
    // Deliberately NOT `relative`. The panel below is positioned against the
    // nearest positioned ancestor, and which one that is *should* change with
    // the breakpoint: from `xl` the corner cluster is `absolute`, so the panel
    // hangs off the cluster and lands in the same corner; below `xl` the cluster
    // is in flow and the control bar is the positioned one, so the panel spans
    // the bar instead. Making this box `relative` would freeze both cases onto
    // the trigger, which is 188px from the left on a phone — the panel is wider
    // than that, so it ran off the screen.
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => onActiveChange(!active)}
        aria-expanded={active}
        className={cn(
          "flex items-center gap-1.5 rounded-md border border-dashed border-amber-400 px-2 py-1.5 text-[0.625rem] font-semibold tracking-[0.14em] uppercase transition-colors",
          active ? "bg-amber-100 text-amber-900" : "text-amber-700 hover:bg-amber-50",
        )}
      >
        <GearIcon />
        <span className="whitespace-nowrap">Dev · transcription</span>
      </button>

      {active && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            onSubmit(text, resolveDevSeconds(text, duration));
            setText("");
            setDuration("");
          }}
          // Opens upward, so it never covers the mic or the notice it sits
          // beside. Below `xl` it spans the control bar between its own
          // margins; from `xl` it hangs off the corner cluster and takes its
          // natural width. See the wrapper above for why the anchor changes.
          className="absolute inset-x-4 bottom-full z-20 mb-2 flex flex-col gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 shadow-lg xl:left-auto xl:right-0 xl:w-[26rem]"
        >
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400 px-1.5 py-px text-[0.5625rem] font-bold tracking-[0.1em] text-amber-700 uppercase">
              <GearIcon />
              Dev
            </span>
            <span className="text-[0.6875rem] font-semibold text-amber-900">
              {DEV_PANEL_COPY.title}
            </span>
            <button
              type="button"
              onClick={() => onActiveChange(false)}
              // The close button gives the microphone back, so it says so to a
              // screen reader rather than reading as a dismissed dialog.
              aria-label="Fermer et rendre le micro"
              className="ml-auto rounded p-0.5 text-amber-700 transition-colors hover:bg-amber-100"
            >
              <CloseIcon />
            </button>
          </div>

          <textarea
            ref={field}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // Ctrl/Cmd+Enter sends; plain Enter breaks the line. The opposite
              // of the one-line box this replaced, and deliberately: the field
              // takes a pasted exposé of several paragraphs, where Enter-to-send
              // truncates at the first blank line.
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
              // Escape closes, as it would for any popover — and closing is what
              // hands the microphone back, so there is no state to get stuck in.
              if (event.key === "Escape") onActiveChange(false);
            }}
            rows={3}
            placeholder={DEV_PANEL_COPY.placeholder}
            className="min-h-14 resize-y rounded border border-amber-300 bg-white p-1.5 text-[0.6875rem] leading-relaxed text-amber-950 outline-none placeholder:text-amber-700/60 focus:border-amber-500"
          />

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              onClick={() => setText(exampleExpose(subject))}
              className="shrink-0 rounded-full border border-amber-400 px-2 py-0.5 text-[0.625rem] font-semibold text-amber-800 transition-colors hover:bg-amber-100"
            >
              Exemple
            </button>
            <label className="flex items-center gap-1 text-[0.625rem] text-amber-800">
              Durée (s)
              <input
                type="number"
                min={0}
                value={duration}
                onChange={(event) => setDuration(event.target.value)}
                placeholder="auto"
                className="w-14 rounded border border-amber-300 bg-white px-1 py-0.5 text-[0.625rem] text-amber-950 outline-none placeholder:text-amber-700/60 focus:border-amber-500"
              />
            </label>
            <span className="text-[0.625rem] tabular-nums text-amber-800">
              {describeDraft(text, duration)}
            </span>
            <button
              type="submit"
              disabled={!ready}
              className="ml-auto shrink-0 rounded bg-amber-600 px-2.5 py-1 text-[0.6875rem] font-semibold text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-amber-600/40"
            >
              {DEV_PANEL_COPY.submit}
            </button>
          </div>

          {/* The reference this is modelled on says « Micro occupé. Arrêtez
              l'enregistrement avant d'envoyer un texte. » — a warning, because
              there the microphone keeps running and you stop it yourself. Here
              opening the panel stops it, so that state cannot arise and the line
              reports rather than warns. */}
          <p className="text-[0.625rem] leading-snug text-amber-700">
            Micro coupé : rien n&apos;est enregistré tant que ce panneau est
            ouvert. Le micro revient au débat.
          </p>
        </form>
      )}
    </div>
  );
}

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-2.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-3"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
