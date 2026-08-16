"use client";

import { useEffect, useRef, useState } from "react";

/**
 * DEVELOPMENT ONLY — turn the microphone off and type what you would have said.
 *
 * Exercising anything downstream of the transcript (the rubric, the
 * persistence, the results page, the duration penalty) otherwise costs twenty
 * minutes of speaking French into a microphone, twice. That is slow enough that
 * those paths get tested rarely, which is the opposite of what they need.
 *
 * Behind a button rather than always on screen (#36). Two reasons, and only the
 * first is about clutter:
 *
 *  - The passation is the screen whose layout matters most — it is what the
 *    candidate looks at for twenty minutes — and a permanent dashed box under
 *    the controls is not what is being designed.
 *  - Entering the mode has a real effect now: the microphone stops. That is a
 *    thing to decide to do, not a thing to discover you have been doing.
 *
 * The mode's state lives on the controller, not here, because the controller is
 * what pauses the recorder. A copy in this component could disagree with the
 * microphone, and the disagreement would be invisible.
 *
 * `injectCandidateSpeech` is guarded on `NODE_ENV` as well as this component's
 * render, so there are two independent reasons a production build cannot reach
 * it. Both are deliberate: one of them is a UI condition somebody could
 * plausibly refactor away, and the other is not.
 */
export function DevSpeechBox({
  active,
  onActiveChange,
  onSubmit,
}: {
  /** Whether text mode is on — read off the controller, which owns it. */
  active: boolean;
  onActiveChange: (on: boolean) => void;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  // Opening the mode is a decision to type, so the caret goes where the typing
  // goes. Without this the first thing the mode asks for is another click.
  useEffect(() => {
    if (active) field.current?.focus();
  }, [active]);

  if (!active) {
    return (
      <button
        type="button"
        onClick={() => onActiveChange(true)}
        className="border-border text-muted-foreground hover:bg-muted w-full rounded-md border border-dashed px-3 py-1.5 text-[0.6875rem] font-semibold tracking-[0.16em] uppercase transition-colors"
      >
        Dev · dicter au clavier
      </button>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!text.trim()) return;
        onSubmit(text);
        setText("");
      }}
      className="border-border bg-muted/40 flex flex-col gap-2 rounded-md border border-dashed p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
          Dev · dictée au clavier
        </span>
        <button
          type="button"
          onClick={() => onActiveChange(false)}
          className="text-muted-foreground hover:text-foreground shrink-0 text-[0.6875rem] font-semibold underline underline-offset-2"
        >
          Rendre le micro
        </button>
      </div>
      <textarea
        ref={field}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends, Shift+Enter breaks the line. A monologue typed for a
          // test is several sentences, so both have to be reachable.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        rows={3}
        placeholder="Ce que le candidat aurait dit… (Entrée pour envoyer, Maj+Entrée pour un retour à la ligne)"
        className="border-border bg-card min-h-16 resize-y rounded-md border p-2 text-xs leading-relaxed outline-none"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-[0.6875rem]">
          Micro coupé : rien n&apos;est enregistré tant que ce mode est actif. La
          session est corrigée sur sa transcription et prend la pénalité de
          durée.
        </span>
        <button
          type="submit"
          disabled={!text.trim()}
          className="border-border bg-card hover:bg-muted shrink-0 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40"
        >
          Envoyer
        </button>
      </div>
    </form>
  );
}
