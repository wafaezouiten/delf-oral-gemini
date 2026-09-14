"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/ui/class-names";
import { devFieldKeyDown } from "@/lib/ui/dev-field-keys";
import {
  ACTIVE_PROMPT_COPY,
  DEV_PROMPT_COPY,
  DEV_PROMPT_SUBMIT_COPY,
  SAVED_PROMPT_COPY,
  describeExaminerModel,
  describePrompt,
  promptSubmitDisabled,
  promptSubmitState,
  savedPromptStale,
  type SavedExaminerPrompt,
} from "@/lib/ui/dev-examiner-prompt";

/**
 * DEVELOPMENT ONLY — edit the examiner's system instruction mid-débat (#152).
 *
 * The examiner's behaviour is a prompt, and until this existed the only way to
 * try a different one was to edit `lib/delf/examiner-prompt.ts`, restart the
 * server, and sit the épreuve from the beginning. This shows the instruction
 * the live examiner is actually running under, lets it be changed, and puts the
 * change in force on the next question.
 *
 * **The débat only (#153).** The monologue's examiner is silent by design —
 * the transport withholds its turn, and its instruction's whole content is
 * « tu écoutes et tu ne parles pas » — so a prompt experiment there has nothing
 * observable to test. Fixing the phase also removed a real footgun this panel
 * used to carry: two different prompts behind one toggle, where an edit made on
 * the part about to end read as an edit that never took.
 *
 * **It is not the transcription panel and shares nothing with it.** That one
 * writes down what the CANDIDATE said; this one changes how the EXAMINER
 * behaves. The candidate still speaks into the microphone throughout — opening
 * this panel does not touch the recorder, the transcript or the grade.
 *
 * **Where the text comes from.** `/api/dev/examiner-prompt`, fetched when the
 * panel first opens, never bundled. `buildExaminerInstruction` is a pure
 * function this component could import directly, and importing it would ship
 * the whole examiner prompt to every production browser — which is the one
 * property `/api/live-token` is built to keep. So it is fetched from a route
 * that 404s off a development build, and the editor opens on the real text
 * rather than on a copy that could drift from it.
 *
 * **When an edit takes effect.** Gemini fixes a session's system instruction
 * when the session opens — it is pinned into the ephemeral token before the
 * socket exists — so no message can replace it afterwards. Applying therefore
 * stores the prompt and opens a NEW session, which is the only thing that can
 * make it govern anything. The panel says so, and says what it costs: the new
 * examiner has no memory of the exchange so far.
 *
 * **A prompt outlives the sitting (#166).** What is applied is written down,
 * per sujet, and the next sitting on that sujet opens under it without this
 * panel being touched — the parent reads it and hands the controller the prompt
 * at mount, which is the only moment early enough for the débat's FIRST session
 * to run it. This component neither reads nor writes that store: it is handed
 * what was saved and reports an apply and a reset upwards. « Réinitialiser » is
 * what erases it, and is therefore the only way back to the shipped
 * instruction.
 *
 * Amber like the transcription panel, and a popover in the same corner for the
 * same reasons — the bar is one row tall and this is not. The one visual
 * difference is the field, which is tall: a system instruction is thousands of
 * characters and an editor showing three lines of it is a search box.
 */
export function DevExaminerPromptPanel({
  topicSlug,
  examinerModel,
  active,
  modified,
  sessionOpen,
  saved,
  onActiveChange,
  onApply,
  onReset,
}: {
  topicSlug: string;
  /** The model id the examiner's sessions open with, named on the toggle. */
  examinerModel: string;
  active: boolean;
  /** The examiner is running under an edited prompt, as the controller sees it. */
  modified: boolean;
  /** A session is open, so applying restarts it rather than merely storing. */
  sessionOpen: boolean;
  /** What was saved for this sujet, already in force on the controller (#166). */
  saved: SavedExaminerPrompt | null;
  onActiveChange: (on: boolean) => void;
  /**
   * Put the prompt in force and write it down. `promptVersion` is what the dev
   * route reported for the text this was edited from, saved beside the prompt
   * so a later sitting can be told its prompt predates the current instruction
   * — see `SavedExaminerPrompt.version` for why it travels this way rather than
   * being imported.
   */
  onApply: (prompt: string, promptVersion: string) => void;
  /** Back to the instruction the repository builds, and erase the save. */
  onReset: () => void;
}) {
  /** The shipped instruction for this phase, as the server reports it. */
  const [original, setOriginal] = useState("");
  /** `EXAMINER_PROMPT_VERSION`, from the same answer. Empty until it arrives. */
  const [version, setVersion] = useState("");
  /**
   * What is in force: the original, whatever was last applied — or, on the
   * first open of a sitting that inherited one, the saved prompt. Seeded here
   * rather than awaited from the fetch because it is already what the examiner
   * is running under: the parent applied it at mount.
   */
  const [applied, setApplied] = useState(saved?.prompt ?? "");
  const [draft, setDraft] = useState(saved?.prompt ?? "");
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  /**
   * Derived rather than stored.
   *
   * "We have not got the text yet" is a fact about the text, not a state of its
   * own — and storing it meant setting a flag synchronously at the top of the
   * effect below, which is the cascading render `react-hooks/set-state-in-effect`
   * exists to refuse. Every remaining `setState` here happens in a promise
   * callback, which is what that rule is asking for.
   */
  const loading = active && !loaded && !failed;

  /**
   * Fetch on first open. The débat's instruction, always — this panel renders
   * on no other part (#153). `ignore` is the ordinary out-of-order guard: the
   * fetch outlives a fast close.
   */
  useEffect(() => {
    // Once per mount. Re-opening a panel that already has the text must not
    // refetch it — that would discard an edit in progress back to the default
    // every time the popover was closed and opened. Re-opening after a FAILURE
    // does retry, which is the one case where there is nothing to lose.
    if (!active || loaded) return;
    let ignore = false;
    fetch(`/api/dev/examiner-prompt?phase=debate&topicSlug=${encodeURIComponent(topicSlug)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((body: { prompt?: string; version?: string }) => {
        if (ignore) return;
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        setOriginal(prompt);
        setVersion(typeof body.version === "string" ? body.version : "");
        // Only the text in force and the draft are seeded, and only where the
        // developer has not already put something else in force: re-opening
        // the panel after applying an edit must show the edit rather than
        // silently discarding it back to the default.
        setApplied((current) => current || prompt);
        setDraft((current) => current || prompt);
        setFailed(false);
        setLoaded(true);
      })
      .catch(() => {
        if (ignore) return;
        setFailed(true);
      });
    return () => {
      ignore = true;
    };
  }, [active, loaded, topicSlug]);

  // The caret goes where the typing goes, as it does in the transcription
  // panel. Not while loading — focusing an empty box that is about to be
  // replaced puts the caret at the top of text arriving underneath it.
  useEffect(() => {
    if (active && !loading && !failed) field.current?.focus();
  }, [active, loading, failed]);

  const submitState = promptSubmitState({ draft, active: applied, loading, failed });
  const submitCopy = DEV_PROMPT_SUBMIT_COPY[submitState];
  const refused = promptSubmitDisabled(submitState);
  const source = modified ? "modified" : "default";
  const modelName = describeExaminerModel(examinerModel);

  function apply() {
    const prompt = draft.trim();
    onApply(prompt, version);
    // What is now in force, so the button falls to `unchanged` and
    // « Réinitialiser » knows there is something to undo.
    setApplied(prompt);
  }

  function reset() {
    onReset();
    setApplied(original);
    setDraft(original);
  }

  return (
    // Not `relative`, for the reason the transcription panel documents: which
    // ancestor the popover hangs off has to change with the breakpoint.
    <div className="flex shrink-0 items-center">
      {/* Slimmer than the transcription toggle on purpose (#153): a flat pill
          rather than a button, because two full-height dev buttons side by side
          were crowding a bar whose real control is the microphone.

          Shorter again (#163), and this time along the only axis it had left:
          the label. It is already 9px, so what was left to cut was the half of
          the words that said « Dev · » to a pill that is dashed and amber
          precisely so it does not have to. The tracking goes with them — 0.12em
          on a word this small is a third of a letter between every pair — and
          « Dev · prompt de l'examinateur » stays on `title`. */}
      <button
        type="button"
        onClick={() => onActiveChange(!active)}
        aria-expanded={active}
        title={DEV_PROMPT_COPY.triggerTitle}
        className={cn(
          "flex items-center gap-1 rounded-full border border-dashed border-amber-400 px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-[0.06em] uppercase transition-colors",
          active ? "bg-amber-100 text-amber-900" : "text-amber-700 hover:bg-amber-50",
        )}
      >
        <SlidersIcon />
        <span className="whitespace-nowrap">{DEV_PROMPT_COPY.trigger}</span>
        {/* The dot is the whole reason the badge exists: a prompt left in place
            from an earlier experiment explains a behaviour change that would
            otherwise read as a bug in the examiner. Visible with the panel
            shut, which is when it is needed. */}
        {modified && <span className="size-1.5 shrink-0 rounded-full bg-amber-600" aria-hidden />}
      </button>

      {active && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (refused) return;
            apply();
          }}
          // A narrow column docked to the RIGHT at every breakpoint (#153,
          // second pass). The first fix kept the full-width sub-`xl` layout
          // and only capped the `xl` one, and the user's screenshot answered
          // it: a panel spanning the window buries the épreuve it exists to
          // test beside. So the panel is thin and right-anchored everywhere —
          // the conversation stays visible on its left — and the viewport cap
          // stays, so « Appliquer le prompt » can never be pushed off screen.
          // The prompt itself gives nothing up: the textarea scrolls, resizes,
          // and holds the same nine thousand characters at any width.
          //
          // The height cap is measured rather than guessed (#163). `100%` in a
          // `max-height` resolves against the containing block — the corner
          // cluster from `xl` up, the bar itself below it, and both are the
          // bar's height since the cluster was made to span it. The bar's
          // bottom edge IS the window's bottom edge, the épreuve being a
          // `h-dvh` column, so `100dvh - 100%` is exactly the room above the
          // bar whatever height the bar happens to be, and `4.5rem` pays for
          // three things: the `mb-2` under the panel, the `h-14` top bar the
          // épreuve draws above everything at `z-30`, and half a rem of gap
          // between the two. The top bar is why the number is not `1.5rem`:
          // stopping at the window's edge put the panel's header UNDER the
          // clock and « Quitter », which is a header that is on screen and
          // still cannot be read.
          //
          // The cap it replaces, `100vh - 6.5rem`, was the same sum with the
          // bar's height written down as a constant and the gap left out of
          // it. Measured in a replica of this bar: on any window short enough
          // for the cap to bind it put the panel's top 8px above the window,
          // and the whole overshoot again on every width where the bar's row
          // wraps — which is where the header, the default/modifié badge and
          // « ✕ » went.
          //
          // `min(22rem, …)` because clearing the top bar is not the same as
          // staying away from it. A cap that is only the room available lets
          // the panel take all of it — it opened against the header, which is
          // legible and still wrong, since what is behind the panel is the
          // épreuve it exists to be watched beside. 22rem is the ceiling that
          // holds however tall the window is, or however far the field's own
          // drag handle is pulled; the `dvh` term takes over below it, on a
          // window with less than that to give.
          className="absolute right-4 bottom-full left-auto z-20 mb-2 flex max-h-[min(22rem,calc(100dvh-100%-4.5rem))] w-[min(22rem,calc(100vw-2rem))] flex-col gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 shadow-lg xl:right-0"
        >
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400 px-1.5 py-px text-[0.5625rem] font-bold tracking-[0.1em] text-amber-700 uppercase">
              <SlidersIcon />
              Dev
            </span>
            <span className="text-[0.6875rem] font-semibold text-amber-900">
              {DEV_PROMPT_COPY.title}
            </span>
            <span
              className={cn(
                "rounded-full border px-1.5 py-px text-[0.5625rem] font-semibold whitespace-nowrap",
                modified
                  ? "border-amber-600 bg-amber-200 text-amber-900"
                  : "border-amber-300 text-amber-700",
              )}
            >
              {ACTIVE_PROMPT_COPY[source]}
            </span>
            <button
              type="button"
              onClick={() => onActiveChange(false)}
              aria-label="Fermer"
              className="ml-auto rounded p-0.5 text-amber-700 transition-colors hover:bg-amber-100"
            >
              <CloseIcon />
            </button>
          </div>

          {/* Which examiner this prompt is being tried on (#163). The prompt is
              only half of what makes an examiner behave the way it does: the
              same instruction on 2.5 Native Audio and on 3.1 Flash Live is two
              different épreuves, and the model is chosen on the préparation
              screen, two screens back, where it is long out of sight by the
              time anything is being tested.

              Here rather than on the toggle, where it read as a second label
              on a pill that had just been cut down to one word — and where
              there was no room for the raw id. The id is the point of the
              second half of this line: `liveModelChoices` keeps it visible
              beside the readable name because a name alone cannot answer which
              model actually ran. */}
          <p className="text-[0.625rem] leading-snug text-amber-800">
            {DEV_PROMPT_COPY.model} : <span className="font-semibold">{modelName}</span>
            {modelName !== examinerModel && (
              <span className="text-amber-700/80"> · {examinerModel}</span>
            )}
          </p>

          <textarea
            ref={field}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={devFieldKeyDown(() => onActiveChange(false))}
            spellCheck={false}
            disabled={loading || failed}
            placeholder={loading ? "Chargement du prompt…" : "Prompt système de l'examinateur."}
            // The field is the flexible part of a height-capped column (#153):
            // the form's own ceiling is what keeps the header and « Appliquer »
            // on screen, and this box gives way to it — down to `min-h-24` on
            // a short window — instead of pushing its chrome past the top. It
            // scrolls and resizes either way, so height is a starting point,
            // not a cap on what can be read.
            //
            // `h-48` rather than `h-96` (#163). At 24rem the panel was tall
            // enough to reach its own ceiling on an ordinary laptop, so it
            // opened filling the screen from the top bar to the mic — and a
            // dev tool that takes the whole window is one the épreuve behind
            // it cannot be watched through. 12rem opens on a dozen lines of
            // the instruction and leaves the panel a third of the window
            // instead of all of it; the drag handle is right there for the one
            // edit that wants more, and the form's `min()` ceiling is what
            // that handle stops against.
            className="h-48 min-h-24 shrink resize-y rounded border border-amber-300 bg-white p-1.5 font-mono text-[0.625rem] leading-relaxed text-amber-950 outline-none placeholder:text-amber-700/60 focus:border-amber-500 disabled:bg-amber-100/60"
          />

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              onClick={reset}
              disabled={loading || failed}
              className="shrink-0 rounded-full border border-amber-400 px-2 py-0.5 text-[0.625rem] font-semibold text-amber-800 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {DEV_PROMPT_COPY.reset}
            </button>
            <span className="text-[0.625rem] text-amber-800 tabular-nums">
              {describePrompt(draft)}
            </span>
            <button
              type="submit"
              disabled={refused}
              className="ml-auto shrink-0 rounded bg-amber-600 px-2.5 py-1 text-[0.6875rem] font-semibold text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-amber-600/40"
            >
              {submitCopy.label}
            </button>
          </div>

          {submitCopy.note && (
            <p
              role="status"
              className="rounded border border-amber-300 bg-amber-100 px-1.5 py-1 text-[0.625rem] leading-snug text-amber-900"
            >
              {submitCopy.note}
            </p>
          )}

          {/* The one thing about this panel that is not obvious from using it:
              a system instruction cannot be swapped into a running session, so
              applying opens a new one. Which sentence appears depends on
              whether there is a session to restart — promising a restart during
              an armed part would describe something that is not going to
              happen. */}
          <p className="text-[0.625rem] leading-snug text-amber-700">
            {sessionOpen ? DEV_PROMPT_COPY.restartWarning : DEV_PROMPT_COPY.nextSessionNote}
          </p>

          {/* How long the prompt stays in force, and whether it has aged (#166).
              Below the restart warning because that one is about this press and
              these are about every sitting after it. The stale line is the
              louder of the two and is styled like it: a saved prompt is a
              snapshot of an instruction that keeps changing in the repository,
              and a developer reading an old examiner's behaviour as a bug in
              the current one is the failure it exists to prevent. */}
          {saved && (
            <p className="text-[0.625rem] leading-snug text-amber-700">{SAVED_PROMPT_COPY.saved}</p>
          )}
          {saved && savedPromptStale(saved, version) && (
            <p
              role="status"
              className="rounded border border-amber-500 bg-amber-100 px-1.5 py-1 text-[0.625rem] leading-snug font-semibold text-amber-900"
            >
              {SAVED_PROMPT_COPY.stale(saved.version, version)}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

function SlidersIcon() {
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
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
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
