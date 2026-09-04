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
    // A fragment that repeats the whole turn so far, verbatim, is the turn
    // arriving twice, not the speaker saying it twice (#186): a reconnect
    // replays the audio held during the outage into the new socket, which
    // transcribes it again, and the corrector then read « Je suis d'accord… »
    // back to back and graded the repetition. Exact, whole and long, on
    // purpose. A candidate really does restart a sentence and an examiner
    // really does say « Au revoir. » twice (#85 counts on it); a fragment that
    // repeats a few words is that. Nobody re-says a whole answer word for word.
    const repeated = fragment.text.trim();
    if (repeated === last.text && repeated.length >= DUPLICATE_TURN_MIN_CHARS) {
      return entries as TranscriptEntry[];
    }
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
 * How long a repeated fragment has to be before it is a replay rather than
 * speech. Two short sentences of French; the observed replay was 170
 * characters, and a repeated « Au revoir. » or « Oui, oui. » is a person.
 */
const DUPLICATE_TURN_MIN_CHARS = 40;

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

/**
 * A directive the examiner read aloud instead of obeying (#187).
 *
 * Every instruction the app sends the examiner mid-épreuve is one bracketed
 * paragraph — the relances, the clock, the last question, the closing line,
 * and whatever a developer types into the prompt panel. They go down the same
 * text channel as everything else, and now and then the model narrates one:
 * its output transcription then carries « [Information de service, à ne
 * jamais prononcer : …] » followed by the sentence it was told to say. One such
 * turn was persisted, printed on the correction, handed to the corrector as
 * examiner speech, and — because the directive said « nous avons terminé » —
 * counted by the goodbye detector as the examiner closing early.
 *
 * An examiner never opens a square bracket, so a bracket in examiner text is
 * the app's, whatever it says. What is returned is the part that was spoken,
 * with every closed span removed, and — separately — an unterminated span cut
 * off from the point it opens. The split matters at the source: transcription
 * arrives in fragments, so the bracket that closes a directive is routinely in
 * a later fragment than the one that opened it, and the opener has to be held
 * back rather than either kept (it would leak) or dropped (the rest of the
 * span would then arrive bracket-less and leak instead). The controller holds
 * `held`, prepends it to the next fragment of the same turn, and discards it
 * when the turn completes.
 */
export function separateDirectiveEcho(text: string): { spoken: string; held: string } {
  const withoutClosed = text.replace(/\[[^\]]*\]/g, "");
  const open = withoutClosed.indexOf("[");
  if (open === -1) return { spoken: withoutClosed, held: "" };
  return { spoken: withoutClosed.slice(0, open), held: withoutClosed.slice(open) };
}

/**
 * A stored transcript with the examiner's directive echoes removed (#187).
 *
 * For the transcripts written before the controller learned to hold them
 * back: every reader that turns a record into something a person or a model
 * sees — the corrector's prompt, the correction page, the reconnect seed —
 * runs the record through this first. An examiner turn that was nothing but
 * the echo is dropped rather than kept as an empty turn. Candidate turns are
 * never touched: the bracket rule is about what the app says, and a candidate
 * who somehow pronounces one is on the record as they were.
 */
export function stripDirectiveEchoes(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.speaker !== "examiner" || !entry.text.includes("[")) {
      out.push(entry);
      continue;
    }
    const spoken = separateDirectiveEcho(entry.text).spoken.trim();
    if (spoken) out.push({ ...entry, text: spoken });
  }
  return out;
}

/**
 * The app's presence check, « Vous m'entendez ? » (#84, #101), as the
 * examiner's output transcription renders it — with or without the question
 * mark, since Gemini drops it about half the time. It is the one examiner
 * line that is not the épreuve: a fixed-wording check that the connection is
 * alive, said into ten seconds of nothing. The corrector is told so
 * (`formatTranscript`), because read as a question of the débat it looks like
 * an examiner reduced to asking whether the candidate is there, and the
 * candidate's next answer looks like a non-answer to it.
 */
export function isPresenceCheck(text: string): boolean {
  return /^\s*vous m['’]entendez\s*\??\s*$/i.test(text);
}

const SPEAKER_LABELS: Record<TranscriptSpeaker, string> = {
  candidate: "CANDIDAT",
  examiner: "EXAMINATEUR",
};

/**
 * The two part headings, worded as the main project words them
 * (`delf-preps@5170f0dd`, `formatSittingTranscript`). The corrector's prompt
 * talks about « la partie 1 » and « la partie 2 » throughout — the criteria
 * descriptions and the stage contract both pin a pragmatic criterion to one of
 * them by number — so the transcript has to number them the same way. They used
 * to read « MONOLOGUE » and « DEBAT », which named the parts without numbering
 * them (#173).
 */
const PHASE_HEADINGS: Record<TranscriptPhase, string> = {
  monologue: "=== PARTIE 1 : MONOLOGUE SUIVI (exposé du candidat, sans interruption) ===",
  debate: "=== PARTIE 2 : DÉBAT (exercice en interaction avec l'examinateur) ===",
};

/**
 * How the corrector sees a presence check (#187). Not « EXAMINATEUR », because
 * it was not the examiner's idea: the app said it, in fixed words, to find out
 * whether anyone was still on the line. Named as the app's and marked as
 * outside the épreuve, so a débat with three of them is not read as an
 * examiner who kept having to ask whether the candidate was there.
 */
const PRESENCE_CHECK_LABEL =
  "LOGICIEL (vérification technique de la connexion, hors épreuve, à ne pas évaluer)";

function lineLabel(entry: TranscriptEntry): string {
  if (entry.speaker === "examiner" && isPresenceCheck(entry.text)) return PRESENCE_CHECK_LABEL;
  return SPEAKER_LABELS[entry.speaker];
}

/**
 * Render the transcript for the evaluator, preserving the phase split exactly as
 * the brief specifies: a part 1 block, then a part 2 block. The evaluator is
 * told to grade the two tasks on their own halves, so this shape is
 * load-bearing, not cosmetic — flattening it would silently change the grade.
 *
 * A phase with nothing in it is skipped rather than printed empty: a walk-out
 * before the débat has no part 2, and « (aucune donnée) » under a heading reads
 * to a corrector as a part that happened in silence.
 */
export function formatTranscript(entries: readonly TranscriptEntry[]): string {
  const sections: string[] = [];
  const clean = stripDirectiveEchoes(entries);

  for (const phase of ["monologue", "debate"] as const) {
    const phaseEntries = entriesForPhase(clean, phase);
    if (phaseEntries.length === 0) continue;
    const lines = phaseEntries.map((e) => `${lineLabel(e)}: ${e.text}`);
    sections.push(`${PHASE_HEADINGS[phase]}\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
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
  // Scrubbed (#187): a directive the examiner once read aloud must not be
  // seeded back into a fresh session as something it said.
  const exchange = entriesForPhase(stripDirectiveEchoes(entries), "debate").map((entry) => ({
    role: entry.speaker === "candidate" ? ("user" as const) : ("model" as const),
    parts: [{ text: entry.text }],
  }));
  return [...monologueAsHistory(entries), ...exchange];
}
