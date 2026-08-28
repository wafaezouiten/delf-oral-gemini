/**
 * The rules and the copy behind the development examiner-prompt editor (#152).
 *
 * DEVELOPMENT ONLY in effect, but a plain module by construction — the same
 * split `dev-transcription.ts` makes, and for the same reason: nothing here
 * reads `NODE_ENV`, opens a socket or knows what a controller is, so it is the
 * part `node --test` can check. The gates live where the consequences are: the
 * panel's render, the controller's `setExaminerPrompt`, the token route's own
 * refusal, and the dev-only route that serves the default text.
 *
 * **What this editor is for.** The examiner's behaviour is a system
 * instruction, and until now the only way to try a different one was to edit
 * `lib/delf/examiner-prompt.ts`, restart, and sit the épreuve again. This lets
 * a developer read the instruction the live examiner is actually running under,
 * change a line, and hear the difference on the next question.
 *
 * **What it is emphatically not.** It does not put words in the candidate's
 * mouth. The candidate still speaks into the microphone and Gemini still
 * transcribes them; nothing here touches the transcript, the recording or the
 * grade. The two concepts are one keystroke apart in a text box and could not
 * be further apart in what they mean, so they do not share a panel.
 */

/**
 * The longest prompt the editor will send.
 *
 * The shipped instruction is a few thousand characters and the point of the
 * tool is to try variations on it, so this is room to spare rather than a
 * target. It exists because the text crosses a network boundary into a token
 * constraint: a request that would be refused by Google should be refused here,
 * where the reason can be read, rather than there, where it arrives as a socket
 * that opens and dies.
 */
export const MAX_EXAMINER_PROMPT_LENGTH = 32_000;

/**
 * Trim, and nothing else.
 *
 * Deliberately not "tidy": the interior of a system instruction is
 * whitespace-sensitive in ways that matter to a model — blank lines separate
 * the blocks, and the leading `- ` of every absolute rule is load-bearing. A
 * normaliser that collapsed runs would silently edit the thing under test.
 */
export function normaliseExaminerPrompt(raw: string): string {
  return raw.trim();
}

/** Whether a draft says anything different from the prompt now in force. */
export function isPromptModified(draft: string, active: string): boolean {
  return normaliseExaminerPrompt(draft) !== normaliseExaminerPrompt(active);
}

/**
 * What « Appliquer le prompt » can do at this instant.
 *
 *  - `loading` — the default text is still being fetched from the server. It
 *    is not in the client bundle and must not be; see the dev route.
 *  - `failed` — the fetch did not answer. There is nothing to edit, so there is
 *    nothing to apply.
 *  - `empty` — the box has been cleared. An empty system instruction is not an
 *    experiment, it is a session with no examiner in it.
 *  - `toolong` — past {@link MAX_EXAMINER_PROMPT_LENGTH}.
 *  - `unchanged` — the draft is the prompt already in force. Pressing would
 *    restart the examiner to install the text it is already running.
 *  - `ready` — press it.
 *
 * There is deliberately no `sending` state, unlike the transcription panel's:
 * applying is synchronous. The controller stores the prompt and reopens the
 * socket without the panel awaiting anything, so a press that is "in flight"
 * is a state this form cannot be in.
 */
export type PromptSubmitState = "ready" | "loading" | "failed" | "empty" | "toolong" | "unchanged";

export function promptSubmitState(input: {
  draft: string;
  /** The instruction the examiner is running under right now. */
  active: string;
  loading: boolean;
  failed: boolean;
}): PromptSubmitState {
  if (input.loading) return "loading";
  if (input.failed) return "failed";
  const draft = normaliseExaminerPrompt(input.draft);
  if (!draft) return "empty";
  if (draft.length > MAX_EXAMINER_PROMPT_LENGTH) return "toolong";
  if (!isPromptModified(draft, input.active)) return "unchanged";
  return "ready";
}

/** Whether the button should refuse the press. Everything but `ready`. */
export function promptSubmitDisabled(state: PromptSubmitState): boolean {
  return state !== "ready";
}

/**
 * The panel's words.
 *
 * The two notes that matter are the ones about WHEN a prompt takes effect and
 * what it costs, because both are consequences of the transport rather than
 * choices this panel made: Gemini cannot be handed a new system instruction
 * mid-session, so applying one opens a new session, and a new session is an
 * examiner that has forgotten the exchange so far.
 */
export const DEV_PROMPT_COPY = {
  title: "Prompt de l'examinateur",
  /**
   * One word (#163). « Dev · prompt » spent most of its width saying "dev" to
   * a bar where the dashed amber pill, the icon and the panel's own `DEV`
   * badge all say it already — and it says it in 9px uppercase with letter
   * spacing, which is the most expensive way to spell anything. The pill's
   * full name survives on `title`, for the one reader who needs it.
   */
  trigger: "Prompt",
  /** The trigger's `title`: what the pill is, spelled out on hover. */
  triggerTitle: "Dev · prompt de l'examinateur",
  apply: "Appliquer le prompt",
  reset: "Réinitialiser",
  /** Said whenever a session is live, because then applying restarts it. */
  restartWarning:
    "Appliquer ouvre une nouvelle session : l'examinateur repart sur ce prompt et perd la mémoire de l'échange en cours.",
  /** Said when no session is open, where there is nothing to restart. */
  nextSessionNote: "Le prompt s'appliquera à la prochaine session de l'examinateur.",
} as const;

export const DEV_PROMPT_SUBMIT_COPY: Record<
  PromptSubmitState,
  { label: string; note: string | null }
> = {
  ready: { label: DEV_PROMPT_COPY.apply, note: null },
  loading: { label: DEV_PROMPT_COPY.apply, note: "Chargement du prompt en cours…" },
  failed: {
    label: DEV_PROMPT_COPY.apply,
    note: "Le prompt n'a pas pu être chargé. Rechargez la page.",
  },
  empty: {
    label: DEV_PROMPT_COPY.apply,
    note: "Un prompt vide laisserait la session sans examinateur.",
  },
  toolong: {
    label: DEV_PROMPT_COPY.apply,
    note: `Prompt trop long : maximum ${MAX_EXAMINER_PROMPT_LENGTH} caractères.`,
  },
  unchanged: { label: DEV_PROMPT_COPY.apply, note: "Ce prompt est déjà celui en vigueur." },
};

/**
 * Which instruction the examiner is running under — the panel's own headline.
 *
 * The distinction is the reason the badge exists: a modified prompt behaves
 * differently from the shipped one by design, and a developer who has forgotten
 * they left one in place will read the difference as a bug in the examiner.
 */
export type ActivePromptSource = "default" | "modified";

export const ACTIVE_PROMPT_COPY: Record<ActivePromptSource, string> = {
  default: "Prompt par défaut",
  modified: "Prompt modifié (dev)",
};

/** `« 6 214 caractères »` — the counter under the field. */
export function describePrompt(text: string): string {
  const count = normaliseExaminerPrompt(text).length;
  // Narrow no-break spaces as a French thousands separator, which is what the
  // rest of the interface uses for figures this size.
  const grouped = count.toLocaleString("fr-FR").replace(/\u202f|\u00a0/g, "\u202f");
  return `${grouped} ${count === 1 ? "caractère" : "caractères"}`;
}
