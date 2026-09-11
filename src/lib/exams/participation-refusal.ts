/**
 * Why a finished épreuve cannot be graded, when the reason is that nobody
 * hears the candidate in it — and, more delicately, WHICH of the two reasons
 * to give.
 *
 * Both refusals already existed in the finish route, in the order they were
 * written rather than in the order they have to be asked. The blanket one —
 * fewer than twenty candidate words in the whole sitting — came first, so it
 * answered every case where the transcript was empty, including the case the
 * per-part one exists for. A candidate whose monologue was spoken at length
 * and lost in transcription, and who then left the débat, has zero words: they
 * were told « la transcription ne contient presque aucune parole du candidat »
 * and, because a 422 is not retryable, that trying again would change nothing.
 * That is the app's own failure, reported as theirs, with the door closed
 * behind it.
 *
 * So the evidence is consulted before the count. Voiced seconds come from the
 * recording, not the socket, so they are the one thing in the payload that can
 * contradict an empty transcript — and where they do, the sitting is the app's
 * fault and says so.
 *
 * Extracted from the route so the ORDER is a thing a test can hold, which is
 * the only part of this that was ever wrong.
 */

import {
  PARTICIPATION_WORD_FLOOR,
  partsSpokenButUntranscribed,
  type SittingVoicedSpeech,
} from "@/lib/delf/orale-rubric";
import { candidateWordCount, type TranscriptEntry } from "@/lib/delf/transcript";

export interface ParticipationRefusal {
  /** `transcription` is the app's failure; `absent` is a sitting that did not
   *  happen. Sent on the wire only for the first, which the screen distinguishes. */
  reason: "transcription" | "absent";
  /** Candidate-facing French, shown as it arrives (`describeFinishFailure`). */
  message: string;
  /** Which parts were spoken and not transcribed. Empty for `absent`. */
  parts: Array<"monologue" | "debate">;
}

/** Which parts the microphone heard at length under a transcript that has
 *  almost none of them, named for the candidate. */
function namedParts(parts: Array<"monologue" | "debate">): string {
  if (parts.length === 2) return "des deux parties de l'épreuve";
  return parts[0] === "monologue" ? "de votre monologue" : "de votre débat";
}

/**
 * The refusal this sitting earns, or `null` to grade it.
 *
 * `voiced` all zeroes is a client that predates the field, which has no
 * evidence to offer either way: the first question is then asked of zeroes and
 * answers with nothing, and such a sitting behaves exactly as it did before
 * any of this existed.
 *
 * What « heard at length » means is entirely `partsSpokenButUntranscribed`'s
 * business, and it is not one comparison any more — the seconds are measured
 * with the examiner silent, and they are weighed both absolutely and against
 * the time the candidate actually had. This module owns the ORDER of the two
 * refusals and nothing else, which is the only part of it that was ever wrong.
 */
export function participationRefusal(
  transcript: readonly TranscriptEntry[],
  voiced: SittingVoicedSpeech,
): ParticipationRefusal | null {
  const participation = {
    monologueWords: candidateWordCount(transcript, "monologue"),
    debateWords: candidateWordCount(transcript, "debate"),
  };

  // FIRST. See the module comment: this is the question the count would
  // otherwise answer wrongly, and answering it wrongly blames the candidate.
  const untranscribed = partsSpokenButUntranscribed(participation, voiced);
  if (untranscribed.length > 0) {
    return {
      reason: "transcription",
      parts: untranscribed,
      message:
        `La transcription ${namedParts(untranscribed)} n'a pas été enregistrée correctement : ` +
        `le microphone vous a bien entendu, mais vos paroles ne sont pas parvenues jusqu'au ` +
        `correcteur. L'épreuve ne peut pas être évaluée, et ce n'est pas de votre fait.`,
    };
  }

  // Refuse to invent a grade for an exam that never happened. A model handed an
  // empty transcript will still confidently return five scores.
  //
  // The same floor the rubric applies per part, imported rather than written
  // twice: this gate and the halving are the same judgement about what counts
  // as having spoken, asked at two scopes, and a bare 20 here would let them
  // drift apart silently.
  if (candidateWordCount(transcript) < PARTICIPATION_WORD_FLOOR) {
    return {
      reason: "absent",
      parts: [],
      message:
        "La transcription ne contient presque aucune parole du candidat. " +
        "L'épreuve ne peut pas être évaluée.",
    };
  }

  return null;
}
