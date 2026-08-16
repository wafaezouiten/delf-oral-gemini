"use client";

import { useState } from "react";

/**
 * DEVELOPMENT ONLY — type what you would have said.
 *
 * Exercising anything downstream of the transcript (the rubric, the
 * persistence, the results page, the duration penalty) otherwise costs twenty
 * minutes of speaking French into a microphone, twice. That is slow enough that
 * those paths get tested rarely, which is the opposite of what they need.
 *
 * The controller's `injectCandidateSpeech` is guarded on `NODE_ENV` as well as
 * this component's render, so there are two independent reasons a production
 * build cannot reach it. Both are deliberate: one of them is a UI condition
 * somebody could plausibly refactor away, and the other is not.
 *
 * The submitted text goes into the transcript as a candidate turn AND to the
 * examiner, so the exchange stays coherent — but no audio is recorded, so the
 * sitting is graded from its transcript and takes the duration penalty. That is
 * the honest outcome: nothing was spoken.
 */
export function DevSpeechBox({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [text, setText] = useState("");

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
      <label className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
        Dev · dicter au clavier
      </label>
      <textarea
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
          Ajouté à la transcription et envoyé à l&apos;examinateur. Aucun audio
          n&apos;est enregistré : la pénalité de durée s&apos;applique.
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
