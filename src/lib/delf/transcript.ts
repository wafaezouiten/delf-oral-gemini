/**
 * The exam transcript — phase-tagged, append-only, reconnect-safe.
 *
 * The reference ElevenLabs implementation stored a flat `{role, content}[]` built
 * from transport events, which loses the one distinction DELF actually grades on:
 * the monologue and the débat are *different tasks* with *different criteria*.
 * Here every entry carries its phase, so the evaluator can score « réalisation de
 * la tâche » on the monologue and « interaction » on the débat instead of
 * averaging two unrelated performances.
 *
 * Two Gemini realities shape this module:
 *
 *  1. **Transcription arrives in fragments.** `inputAudioTranscription` and
 *     `outputAudioTranscription` stream partial text, many messages per spoken
 *     sentence. Appending each fragment as its own entry would produce a
 *     shredded transcript, so `appendFragment` coalesces consecutive fragments
 *     from the same speaker in the same phase into one entry.
 *  2. **Sessions restart.** A reconnect mid-débat opens a NEW Gemini session, but
 *     it must not open a new transcript. The transcript lives above the session
 *     and is only ever appended to, which is what makes a reconnect invisible.
 */

export type TranscriptPhase = "monologue" | "debate";
export type TranscriptSpeaker = "candidate" | "examiner";

export interface TranscriptEntry {
  phase: TranscriptPhase;
  speaker: TranscriptSpeaker;
  /** Ms since the exam started — not wall-clock, so it survives a reconnect. */
  timestamp: number;
  text: string;
}

/**
 * Append a streamed transcription fragment.
 *
 * Returns a NEW array (never mutates) so React state updates stay sound. A
 * fragment merges into the previous entry when it comes from the same speaker in
 * the same phase; otherwise it starts a new turn. Blank fragments are dropped —
 * Gemini emits them at turn boundaries and they would otherwise create empty
 * turns that the evaluator reads as silence.
 *
 * `startsTurn` is the one way to say "this is a new turn even though the same
 * speaker said the last one" (#101). Coalescing is right for the fragments of
 * one spoken sentence and wrong for two: when the app makes the examiner speak
 * again into a silence, the relance is a separate intervention, ten seconds
 * after the question it is rephrasing, and merging it welds the two into one
 * compound question under the earlier one's timestamp. Nothing here can tell
 * those apart from the text — the caller knows, and says so.
 */
export function appendFragment(
  entries: readonly TranscriptEntry[],
  fragment: {
    phase: TranscriptPhase;
    speaker: TranscriptSpeaker;
    timestamp: number;
    text: string;
    startsTurn?: boolean;
  },
): TranscriptEntry[] {
  if (!fragment.text.trim()) return entries as TranscriptEntry[];

  const last = entries[entries.length - 1];
  const continuesTurn =
    !fragment.startsTurn &&
    last &&
    last.phase === fragment.phase &&
    last.speaker === fragment.speaker;

  if (continuesTurn) {
    const merged: TranscriptEntry = { ...last, text: joinFragments(last.text, fragment.text) };
    return [...entries.slice(0, -1), merged];
  }

  // Field by field rather than spread: `startsTurn` is an instruction to this
  // function, not part of a turn, and a transcript is serialised, stored and
  // graded — an entry carrying it would put the app's own bookkeeping in front
  // of the corrector.
  return [
    ...entries,
    {
      phase: fragment.phase,
      speaker: fragment.speaker,
      timestamp: fragment.timestamp,
      text: fragment.text.trim(),
    },
  ];
}

/**
 * Glue two transcription fragments. Gemini's fragments already carry their own
 * leading spaces inconsistently, so we normalise: no double space, but no
 * accidentally-welded words either ("bonjourmonsieur").
 */
function joinFragments(existing: string, addition: string): string {
  const left = existing.trimEnd();
  const right = addition.trim();
  if (!left) return right;
  if (!right) return left;
  // No space before French closing punctuation that attaches to the word.
  if (/^[,.;:!?…)\]»]/.test(right)) return `${left}${right}`;
  return `${left} ${right}`;
}

/** Only the entries for one phase, in order. */
export function entriesForPhase(
  entries: readonly TranscriptEntry[],
  phase: TranscriptPhase,
): TranscriptEntry[] {
  return entries.filter((e) => e.phase === phase);
}

/** Everything the candidate said in a phase, as one block of prose. */
export function candidateSpeech(
  entries: readonly TranscriptEntry[],
  phase?: TranscriptPhase,
): string {
  return entries
    .filter((e) => e.speaker === "candidate" && (phase ? e.phase === phase : true))
    .map((e) => e.text)
    .join(" ")
    .trim();
}

/** Rough word count of the candidate's speech — a cheap "did they actually speak" check. */
export function candidateWordCount(
  entries: readonly TranscriptEntry[],
  phase?: TranscriptPhase,
): number {
  const speech = candidateSpeech(entries, phase);
  return speech ? speech.split(/\s+/).length : 0;
}

const SPEAKER_LABELS: Record<TranscriptSpeaker, string> = {
  candidate: "CANDIDAT",
  examiner: "EXAMINATEUR",
};

/**
 * Render the transcript for the evaluator, preserving the phase split exactly as
 * the brief specifies: a MONOLOGUE block, then a DEBAT block. The evaluator is
 * told to grade the two tasks separately, so this shape is load-bearing, not
 * cosmetic — flattening it would silently change the grade.
 */
export function formatTranscript(entries: readonly TranscriptEntry[]): string {
  const sections: string[] = [];

  for (const [phase, heading] of [
    ["monologue", "MONOLOGUE"],
    ["debate", "DEBAT"],
  ] as const) {
    const phaseEntries = entriesForPhase(entries, phase);
    if (phaseEntries.length === 0) continue;
    const lines = phaseEntries.map((e) => `${SPEAKER_LABELS[e.speaker]}: ${e.text}`);
    sections.push(`${heading}\n\n${lines.join("\n")}`);
  }

  return sections.join("\n\n\n");
}

/**
 * The monologue rendered as Gemini `Content` turns, to seed the débat session's
 * history.
 *
 * This is the bridge between the two Live sessions. Gemini cannot change its
 * system instruction mid-session, so the débat necessarily runs on a fresh
 * session — which would know nothing about the monologue unless we hand it over.
 * The candidate's speech becomes a `user` turn so the examiner can quote it back
 * and challenge specific arguments, which is exactly what the DELF débat is.
 */
export function monologueAsHistory(
  entries: readonly TranscriptEntry[],
): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  const speech = candidateSpeech(entries, "monologue");
  if (!speech) return [];
  return [
    {
      role: "user",
      parts: [
        {
          text: `Voici l'intégralité de mon monologue suivi, que je viens de présenter devant vous :\n\n${speech}`,
        },
      ],
    },
    {
      role: "model",
      parts: [
        {
          text: "J'ai écouté votre exposé avec attention. Nous allons maintenant passer à la seconde partie de l'épreuve, le débat.",
        },
      ],
    },
  ];
}

/**
 * Everything a débat session must know at connect time: the monologue handover
 * above, then every débat turn already exchanged, as literal turns.
 *
 * The second half exists for the reconnect that could not resume (#133). A
 * socket that dies before its first resumption handle arrives reconnects
 * FRESH, and a fresh session seeded with the monologue alone comes back
 * believing the débat has not begun — its standing order is to open it, so the
 * candidate hears a second « first question » minutes into the exchange.
 * Seeding the turns already spoken is what lets the examiner come back
 * mid-argument: what it asked, what was answered, and whether the last
 * question is already out are all in the text. On the débat's first connect
 * the second half is empty and this is exactly the monologue seed it has
 * always been.
 */
export function debateSessionHistory(
  entries: readonly TranscriptEntry[],
): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  const exchange = entriesForPhase(entries, "debate").map((entry) => ({
    role: entry.speaker === "candidate" ? ("user" as const) : ("model" as const),
    parts: [{ text: entry.text }],
  }));
  return [...monologueAsHistory(entries), ...exchange];
}
