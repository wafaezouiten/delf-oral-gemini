"use client";

import { useEffect, useRef, useState } from "react";

import type { TranscriptPhase } from "@/lib/delf/transcript";
import {
  describeDraft,
  devPanelCopy,
  exampleExpose,
  resolveDevSeconds,
} from "@/lib/ui/dev-transcription";

/**
 * DEVELOPMENT ONLY — replace a phase's recording with typed text.
 *
 * Exercising anything downstream of the transcript (the rubric, the
 * persistence, the results page, the duration penalty) otherwise costs twenty
 * minutes of speaking French into a microphone, twice. That is slow enough that
 * those paths get tested rarely, which is the opposite of what they need.
 *
 * Behind a button rather than always on screen, and the button has a real
 * effect: opening the panel turns the microphone off. That is a thing to decide
 * to do, not a thing to discover you have been doing.
 *
 * The open/closed state lives on the controller, not here, because the
 * controller is what pauses the recorder. A copy in this component could
 * disagree with the microphone, invisibly.
 *
 * Amber throughout, and nothing else in the épreuve is amber. The panel writes
 * an exam transcript without anyone speaking, so it should never be mistakeable
 * for part of the sitting.
 */
export function DevTranscriptionPanel({
  phase,
  subject,
  active,
  onActiveChange,
  onSubmit,
}: {
  phase: TranscriptPhase;
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
  // goes. Without this the first thing the mode asks for is another click.
  useEffect(() => {
    if (active) field.current?.focus();
  }, [active]);

  const copy = devPanelCopy(phase);
  const ready = text.trim().length > 0;

  if (!active) {
    return (
      <button
        type="button"
        onClick={() => onActiveChange(true)}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-amber-400 px-3 py-1.5 text-[0.6875rem] font-semibold tracking-[0.16em] text-amber-700 uppercase transition-colors hover:bg-amber-50"
      >
        <GearIcon />
        Dev · transcription directe
      </button>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onSubmit(text, resolveDevSeconds(text, duration));
        setText("");
        setDuration("");
      }}
      className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-400 px-2 py-0.5 text-[0.625rem] font-bold tracking-[0.12em] text-amber-700 uppercase">
          <GearIcon />
          Dev
        </span>
        <span className="text-sm font-semibold text-amber-900">{copy.title}</span>
        <button
          type="button"
          onClick={() => onActiveChange(false)}
          // The close button gives the microphone back, so it says so to a
          // screen reader rather than reading as a dismissed dialog.
          aria-label="Fermer et rendre le micro"
          className="ml-auto rounded p-1 text-amber-700 transition-colors hover:bg-amber-100"
        >
          <CloseIcon />
        </button>
      </div>

      <p className="text-xs leading-relaxed text-amber-800">{copy.description}</p>

      <textarea
        ref={field}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Ctrl/Cmd+Enter sends; plain Enter breaks the line. The opposite of
          // the old one-line box, and deliberately: this field takes a pasted
          // exposé of several paragraphs, where Enter-to-send truncates at the
          // first blank line.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        rows={8}
        placeholder={copy.placeholder}
        className="min-h-40 resize-y rounded-lg border border-amber-300 bg-white p-3 text-sm leading-relaxed text-amber-950 outline-none placeholder:text-amber-700/60 focus:border-amber-500"
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={() => setText(exampleExpose(subject))}
          className="shrink-0 rounded-full border border-amber-400 px-3 py-1 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100"
        >
          Exemple
        </button>
        <label className="flex items-center gap-2 text-xs text-amber-800">
          Durée (s)
          <input
            type="number"
            min={0}
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
            placeholder="auto"
            className="w-20 rounded-md border border-amber-300 bg-white px-2 py-1 text-xs text-amber-950 outline-none placeholder:text-amber-700/60 focus:border-amber-500"
          />
        </label>
        <span className="ml-auto text-xs tabular-nums text-amber-800">
          {describeDraft(text, duration)}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* The reference this is modelled on says « Micro occupé. Arrêtez
            l'enregistrement avant d'envoyer un texte. » — a warning, because
            there the microphone keeps running and you have to stop it yourself.
            Here opening the panel stops it, so that state cannot arise and the
            line reports rather than warns. */}
        <span className="max-w-[22rem] text-xs leading-relaxed text-amber-800">
          Micro coupé : rien n&apos;est enregistré tant que ce panneau est ouvert.
        </span>
        <button
          type="submit"
          disabled={!ready}
          className="shrink-0 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-amber-600/40"
        >
          {copy.submit}
        </button>
      </div>
    </form>
  );
}

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-3"
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
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
