/**
 * What the examiner *says* at each boundary of the épreuve (#37).
 *
 * On the day, a DELF examiner reads the consigne aloud: how long the préparation
 * runs, what the monologue asks for, when to begin, when it is over. This product
 * only ever wrote it down. These four scripts are the spoken half, and this file
 * is the only place they exist — the clip in `public/announcements/` is generated
 * from the text below and nothing prints it (#59). There is no second copy to
 * drift, and since the card was replaced by a « Passer » button there is no
 * written copy at all: what the candidate gets is the voice.
 *
 * Three properties are deliberate, and each one comes from a constraint the rest
 * of the codebase had already decided:
 *
 *  - **The clips are static, not model turns.** `phaseUsesLiveSession()` returns
 *    false for `preparation` on purpose: there is no examiner in the room while
 *    the candidate writes their notes, and holding a Live socket open for thirty
 *    minutes would burn the connection limit before the exam started. So the
 *    préparation could never have had a spoken model turn. The other three could,
 *    and are static anyway, for a better reason: an examiner *reads* a consigne,
 *    they do not improvise one. Every candidate must hear the same words, and a
 *    socket that is down at the moment a phase turns over must not be able to
 *    swallow the instruction.
 *
 *  - **The durations are derived, never restated.** `PHASE_DURATIONS` is the one
 *    source for how long a phase lasts, and it is what the clock counts. Writing
 *    "trente minutes" into the préparation script as a literal would create a
 *    second source of truth that speaks with an examiner's authority, and the
 *    first person to change a phase's length would be told one number by the
 *    voice and shown another by the timer. `spokenMinutes` reads them off the
 *    same constant the timer ring does.
 *
 *  - **A changed script cannot keep an old clip.** The generated manifest carries
 *    {@link announcementDigest} of the text each clip was made from, and
 *    `announcements.test.ts` fails when the two disagree. Audio is the one kind
 *    of copy a reviewer cannot proofread in a diff, so the test is what stops a
 *    reworded consigne shipping in silence, still spoken the old way.
 *
 * @see scripts/generate-announcements.ts — how the clips are made
 * @see src/lib/audio/announcer.ts — how one is played
 */

import { PHASE_DURATIONS } from "./phases";

/**
 * The four moments, named for the phase each one *opens*.
 *
 * There are four rather than five because the monologue's end and the débat's
 * beginning are one moment, not two: the examiner thanks the candidate and moves
 * them on in the same breath, which is what `debate` says. Two clips played back
 * to back at the same instant would be a handover narrated twice.
 */
export type AnnouncementId = "preparation" | "monologue" | "debate" | "finished";

export const ANNOUNCEMENT_IDS: readonly AnnouncementId[] = [
  "preparation",
  "monologue",
  "debate",
  "finished",
] as const;

export interface Announcement {
  id: AnnouncementId;
  /**
   * Exactly what is spoken, and the only form it takes.
   *
   * It used to be printed under the player as well, so that a candidate who
   * never heard a word of it — muted, refused by the browser's autoplay policy,
   * sitting in a library — read the same sentences. #59 removed the card that
   * printed it, deliberately: what is left is a « Passer » button, and a
   * candidate who cannot hear the consigne now misses it. `announcement-control.ts`
   * records that trade.
   */
  text: string;
  /** The generated clip, under `public/`. */
  src: string;
}

/**
 * French for a count of minutes, so a derived duration can be *said* rather than
 * spelled out as digits.
 *
 * The table stops where the épreuve's plausible clocks stop. The fallback is
 * digits, which the TTS voice reads correctly — so an unlisted duration is
 * slightly less controlled prosody, never a broken sentence.
 */
const MINUTE_WORDS: Record<number, string> = {
  1: "une",
  2: "deux",
  3: "trois",
  4: "quatre",
  5: "cinq",
  6: "six",
  7: "sept",
  8: "huit",
  9: "neuf",
  10: "dix",
  11: "onze",
  12: "douze",
  13: "treize",
  14: "quatorze",
  15: "quinze",
  20: "vingt",
  25: "vingt-cinq",
  30: "trente",
};

/** "trente" from 1800, "treize" from 780. Rounded, because a consigne is spoken
 *  in whole minutes and no phase is defined in anything else. */
export function spokenMinutes(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return MINUTE_WORDS[minutes] ?? String(minutes);
}

/**
 * The scripts.
 *
 * Register and house style are the examiner's, and the same rules the system
 * instruction carries apply here for the same reasons: standard French, no em
 * dash (it reads as machine-written, and this text is both spoken and printed),
 * no evaluation, no offer of help. What is different is that these are consignes
 * rather than conversation — they say what happens next and nothing about how the
 * candidate is doing.
 */
export const ANNOUNCEMENTS: Record<AnnouncementId, Announcement> = {
  preparation: {
    id: "preparation",
    text: `Bonjour, et bienvenue à l'épreuve de production orale du DELF B2. Vous entrez maintenant dans le temps de préparation. Vous disposez de ${spokenMinutes(PHASE_DURATIONS.preparation)} minutes. Lisez le document qui vous a été remis, puis dégagez le thème qu'il soulève. Vous pouvez prendre des notes : elles resteront à votre disposition pendant toute l'épreuve. Vous présenterez ensuite votre point de vue de façon construite, seul, puis nous en discuterons ensemble. Si vous êtes prêt avant la fin du temps imparti, vous pouvez commencer sans attendre.`,
    src: "/announcements/preparation.wav",
  },
  monologue: {
    id: "monologue",
    // Replaces the greeting the Live examiner used to speak at this boundary.
    // Two things are gained. The wording is now the same at every sitting, which
    // a consigne must be; and it is spoken BEFORE the microphone starts
    // recording, so the instruction no longer lands inside the performance it is
    // introducing. See `ExamController.advance`.
    text: `Le temps de préparation est terminé. Nous commençons la première partie de l'épreuve, le monologue suivi. Vous disposez de ${spokenMinutes(PHASE_DURATIONS.monologue)} minutes pour présenter votre point de vue de façon construite. Je ne vous interromprai pas : prenez le temps d'introduire votre sujet, de développer vos arguments et de conclure. Je vous écoute.`,
    src: "/announcements/monologue.wav",
  },
  debate: {
    id: "debate",
    // Cut from five sentences to two (#167). This is the one consigne that
    // lands on a candidate who has just finished speaking for ten minutes, and
    // it made them wait, mute, through twenty-two seconds of instruction. What
    // was cut is what was already said elsewhere: the coaching sentence
    // (« défendez, nuancez, donnez des exemples ») repeats the préparation's
    // « vous présenterez ensuite votre point de vue … puis nous en discuterons
    // ensemble », and the turn-taking sentence explained a rule the examiner's
    // first question demonstrates a second later.
    //
    // What could not go: the handover, the part's name, and its duration. The
    // last of those is said HERE and nowhere else — the préparation announces
    // two parts without timing the second, and the monologue clip times only
    // its own — so dropping the minutes to save a second would be the one cut
    // that took a fact away rather than a repetition.
    text: `Je vous remercie, votre exposé est terminé. Nous passons au débat : pendant ${spokenMinutes(PHASE_DURATIONS.debate)} minutes, je contesterai vos arguments, à vous de les défendre.`,
    src: "/announcements/debate.wav",
  },
  finished: {
    id: "finished",
    text: `L'épreuve de production orale est terminée. Je vous remercie de votre participation. Votre prestation est maintenant transmise pour correction : ne fermez pas cet onglet avant l'affichage de vos résultats.`,
    src: "/announcements/finished.wav",
  },
};

/**
 * A stable fingerprint of one script, for the generated manifest.
 *
 * FNV-1a, written out rather than taken from `node:crypto`, because this has to
 * be computable in the three places that need it: the generation script, the
 * unit test, and — should it ever be wanted — the browser. It is a drift
 * detector, not a security primitive; the only attack it has to survive is
 * somebody editing a sentence and forgetting to regenerate the audio.
 */
export function announcementDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // Multiply by the FNV prime (16777619) in 32-bit arithmetic. `Math.imul` is
    // what keeps this exact: `hash * 16777619` overflows a double's integer
    // range and would round.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** What `public/announcements/manifest.json` holds, so the test can read it back
 *  and the generator can write it. */
export interface AnnouncementManifest {
  /** The TTS model that spoke these, for the record. */
  model: string;
  /** The prebuilt voice, which must be the examiner's own. See the generator. */
  voice: string;
  clips: Record<
    AnnouncementId,
    {
      file: string;
      /** {@link announcementDigest} of the script this clip was spoken from. */
      digest: string;
      bytes: number;
      seconds: number;
    }
  >;
}
