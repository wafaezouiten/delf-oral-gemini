"use client";

import { useEffect, useState } from "react";

import {
  parsePromptAnswer,
  savedPromptSeed,
  type SavedExaminerPrompt,
} from "@/lib/ui/dev-examiner-prompt";

export interface ExaminerPromptText {
  /** `EXAMINER_PROMPT_VERSION`, from the dev route's answer. Empty until it arrives. */
  version: string;
  /** What is in force: the original, whatever was last applied, or the saved prompt. */
  applied: string;
  draft: string;
  setDraft: (draft: string) => void;
  loading: boolean;
  failed: boolean;
  /** Take the draft into force; returns the prompt as applied, trimmed. */
  apply: () => string;
  /** Back to the shipped instruction, field and all. */
  reset: () => void;
}

/**
 * The text the dev panel edits: fetched from `/api/dev/examiner-prompt` on
 * the panel's first open, never bundled (see the panel's doc for why), and
 * the draft/applied pair the buttons move.
 *
 * `applied` and `draft` are seeded from the saved prompt rather than awaited
 * from the fetch because that is already what the examiner is running under:
 * the parent applied it at mount. And they are only seeded from the fetch
 * where nothing else has been put in force — re-opening the panel after
 * applying an edit must show the edit rather than silently discarding it back
 * to the default.
 */
export function useExaminerPromptText(
  active: boolean,
  topicSlug: string,
  saved: SavedExaminerPrompt | null,
): ExaminerPromptText {
  /** The shipped instruction for this phase, as the server reports it. */
  const [original, setOriginal] = useState("");
  const [version, setVersion] = useState("");
  const [applied, setApplied] = useState(() => savedPromptSeed(saved));
  const [draft, setDraft] = useState(() => savedPromptSeed(saved));
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // Derived rather than stored: "we have not got the text yet" is a fact
  // about the text, not a state of its own — and storing it meant setting a
  // flag synchronously at the top of the effect below, which is the cascading
  // render `react-hooks/set-state-in-effect` exists to refuse. Every
  // remaining `setState` here happens in a promise callback.
  const loading = active && !loaded && !failed;

  // Fetch on first open. The débat's instruction, always — this panel renders
  // on no other part (#153). `ignore` is the ordinary out-of-order guard: the
  // fetch outlives a fast close. Once per mount: re-opening a panel that
  // already has the text must not refetch it — that would discard an edit in
  // progress back to the default every time the popover was closed and
  // opened. Re-opening after a FAILURE does retry, which is the one case
  // where there is nothing to lose.
  useEffect(() => {
    if (!active || loaded) return;
    let ignore = false;
    fetch(`/api/dev/examiner-prompt?phase=debate&topicSlug=${encodeURIComponent(topicSlug)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((body: unknown) => {
        if (ignore) return;
        const answer = parsePromptAnswer(body);
        setOriginal(answer.prompt);
        setVersion(answer.version);
        setApplied((current) => current || answer.prompt);
        setDraft((current) => current || answer.prompt);
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

  return {
    version,
    applied,
    draft,
    setDraft,
    loading,
    failed,
    apply: () => {
      const prompt = draft.trim();
      // What is now in force, so the button falls to `unchanged` and
      // « Réinitialiser » knows there is something to undo.
      setApplied(prompt);
      return prompt;
    },
    reset: () => {
      setApplied(original);
      setDraft(original);
    },
  };
}
