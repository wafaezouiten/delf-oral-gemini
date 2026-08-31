/**
 * DELF production orale rubric → /25 mapping (pure logic, unit-tested).
 *
 * The AI evaluator returns the five official grille criteria (realisationTache/
 * interaction/lexique/morphosyntaxe/phonologie), each a 0/1/3/5 band. Their sum
 * is the DELF production orale competency score out of 25. This module keeps
 * that mapping (and the short-duration penalty) side-effect-free and testable.
 *
 * PORT NOTE: copied from the reference implementation
 * (`delf-preps@chore/240-remove-unused-series-actions`, `src/lib/orale-rubric.ts`)
 * with two changes, both mandated by the reproduction audit:
 *
 *  - `COMPETENCY_MAX` / `COMPETENCY_FLOOR` now come from `./constants` instead
 *    of `@/lib/scoring`, which would drag in the multi-épreuve scoring model.
 *  - `normalizeOralDetails()` is **dropped** ("Reproduce minus one export"): it
 *    maps pre-grille keys (contenu/vocabulaire/grammaire/prononciation) onto the
 *    official five so legacy rows still render, and this project has no legacy
 *    rows. It also typed its argument as `OralCorrectionResult["details"]` from
 *    the reference `db/schema`, which this phase deliberately does not have.
 *
 * Everything else — the clamping, the sum, the flat −3 penalty, the ≥ 5/25
 * floor — is byte-for-byte the incumbent's, so scores stay comparable.
 *
 * ---
 *
 * PHASE 7. This is now the ONLY implementation of the grading rules. A second
 * one lived in `rubric.ts` and disagreed with this file in ways that changed
 * grades — it snapped where this clamps, docked 5 or 3 where this docks a flat
 * 3, and measured a shortfall against an 8-minute sitting total where the port
 * measures each part against its own floor. It is deleted; #9 required exactly
 * one to survive and that it be this one.
 *
 * Two things were added rather than ported, and both are compositions of ported
 * pieces rather than new rules:
 *
 *  - {@link scoreSitting}, the single entry point the evaluator calls. The
 *    order — snap, sum, halve, dock, then test the floor — is a rule in itself,
 *    and a call site free to get it wrong is how a 2 reaches a column that only
 *    accepts 0, 1, 3 and 5.
 *  - {@link applySittingDurationPenalty}, which applies a **per-part** rule to a
 *    sitting that has two parts and one /25. The incumbent corrects one task per
 *    correction, so it never had to answer this; see that function for what was
 *    decided and why.
 *
 * And one signature changed: {@link applyDurationPenalty} returns the penalty it
 * applied as well as the adjusted score, so the caller can record what the
 * rubric asked for rather than reversing an answer out of two numbers.
 */

import { COMPETENCY_MAX, COMPETENCY_FLOOR, minDurationSeconds } from "./constants";
import { ORAL_CRITERIA, type OralCriterion } from "./criteria";
import { snapToBand, type GrilleBand } from "./grille";

/** The five official grille criteria (each a 0/1/3/5 band). */
export interface OralCriteriaScores {
  realisationTache: number;
  interaction: number;
  lexique: number;
  morphosyntaxe: number;
  phonologie: number;
}

export const ORAL_RUBRIC_KEYS = [
  "realisationTache",
  "interaction",
  "lexique",
  "morphosyntaxe",
  "phonologie",
] as const;

export type OralRubricKey = (typeof ORAL_RUBRIC_KEYS)[number];

/** Clamp a single criterion to the valid 0–5 integer range. */
export function clampCriterion(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(5, Math.max(0, Math.round(n)));
}

/** Normalise raw (possibly out-of-range) criteria scores to 0–5 integers. */
export function normalizeCriteria(raw: OralCriteriaScores): OralCriteriaScores {
  return {
    realisationTache: clampCriterion(raw.realisationTache),
    interaction: clampCriterion(raw.interaction),
    lexique: clampCriterion(raw.lexique),
    morphosyntaxe: clampCriterion(raw.morphosyntaxe),
    phonologie: clampCriterion(raw.phonologie),
  };
}

/**
 * Sum the five criteria into the DELF /25 competency score. Input is normalised
 * first, and the result is clamped to [0, 25].
 */
export function criteriaToScore25(raw: OralCriteriaScores): number {
  const c = normalizeCriteria(raw);
  const sum = c.realisationTache + c.interaction + c.lexique + c.morphosyntaxe + c.phonologie;
  return Math.min(COMPETENCY_MAX, Math.max(0, sum));
}

/** What the duration rule did: the adjusted score, and the points it asked for. */
export interface DurationPenalty {
  /** The /25 after the penalty, floored at 0. */
  score25: number;
  /**
   * The penalty the rubric **nominally** applied — not necessarily the points
   * the score lost, because the score floors at 0. A 2/25 docked 3 records a
   * penalty of 3 and a score of 0.
   *
   * Returned rather than left to be reversed out of the two scores: a caller
   * computing `raw − adjusted` gets the *effective* figure, which quietly
   * understates the rubric on any score below the penalty, and `evaluations`
   * stores this column. (Raised in review of #15, settled here — see #9.)
   */
  penalty: number;
}

/**
 * Apply a short-duration penalty: if the candidate spoke for less than the
 * expected minimum, subtract `penalty` points (default 3) from the /25 score,
 * floored at 0.
 */
export function applyDurationPenalty(
  score25: number,
  actualSeconds: number,
  minSeconds: number,
  penalty = 3,
): DurationPenalty {
  if (actualSeconds >= minSeconds) return { score25, penalty: 0 };
  return { score25: Math.max(0, score25 - penalty), penalty };
}

/** The two parts of a B2 sitting, as `tache` numbers (`constants.ts`). */
const MONOLOGUE_TACHE = 1;
const DEBATE_TACHE = 2;

/**
 * The minimum each part must produce before the duration penalty fires: 40 % of
 * the part's expected speaking time, floored at 30 s. 168 s of monologue and
 * 312 s of débat.
 *
 * These are the only floors left, and since #171 they are the only ones the
 * candidate can meet or miss. `phases.ts` used to hold a second, unrelated one —
 * how long they had to stay in the monologue before the UI let them advance —
 * and the two were forever being read as the same rule. They never were: that
 * one was a clock the candidate watched, these are measured against the
 * *recording* afterwards, and a phase can run its full seven minutes with 40 s
 * of audio on it.
 */
export const MONOLOGUE_FLOOR_SECONDS = minDurationSeconds(MONOLOGUE_TACHE);
export const DEBATE_FLOOR_SECONDS = minDurationSeconds(DEBATE_TACHE);

/** Measured speaking time per part, from the recordings rather than the clock. */
export interface SittingDurations {
  monologueSeconds: number;
  debateSeconds: number;
}

/** How much the candidate actually said in each part, in words. */
export interface SittingParticipation {
  monologueWords: number;
  debateWords: number;
}

/** Which parts of the sitting fell under their own floor, in exam order. */
export function partsUnderFloor(durations: SittingDurations): Array<"monologue" | "debate"> {
  const short: Array<"monologue" | "debate"> = [];
  if (durations.monologueSeconds < MONOLOGUE_FLOOR_SECONDS) short.push("monologue");
  if (durations.debateSeconds < DEBATE_FLOOR_SECONDS) short.push("debate");
  return short;
}

/**
 * How much the candidate must say in a part before it counts as having happened
 * at all, in words.
 *
 * The same figure the finish route already applies to a whole sitting — a
 * transcript with fewer than 20 candidate words is refused outright there, on
 * the grounds that a model handed silence will still confidently return five
 * scores. This is that judgement made per part, which is where it was missing:
 * a sitting whose monologue runs 400 words and whose débat runs none clears the
 * route's gate comfortably.
 *
 * Deliberately not zero. "Answered nothing" in practice looks like « euh… non,
 * ça va, merci », and a rule that a single « oui » defeats is a rule that
 * rewards saying one word over saying none.
 *
 * **Replayed against history — change it knowing that (#77).** The results
 * page recovers which parts a STORED correction was docked for by re-running
 * {@link partsAbsent} over the stored transcript with today's floor and
 * today's `candidateWordCount` tokenisation, not the ones in force when the
 * correction was charged. The mark itself cannot move — that comes from the
 * stored `absence_penalty` — but moving this figure can make an old
 * correction name a different part than the one it was actually docked for.
 */
export const PARTICIPATION_WORD_FLOOR = 20;

/**
 * How much VOICED audio a part must carry before an empty transcript for it is
 * read as the app's failure rather than the candidate's silence, in seconds.
 *
 * The counterpart to {@link PARTICIPATION_WORD_FLOOR}, and deliberately sized
 * against it rather than picked round: fifteen seconds of continuous voiced
 * speech is roughly forty words of unhurried French, comfortably past the
 * twenty the word floor asks for. So the two cannot both be satisfied by the
 * same honest sitting — a candidate whose entire contribution was « euh… non,
 * ça va, merci » produces neither twenty words NOR fifteen seconds of voice,
 * and is still absent. What clears this bar and fails that one is a part where
 * somebody spoke at length and the transcript does not show it.
 *
 * Note this is VOICED seconds, not recorded ones. A recording's length is how
 * long the part ran and a silent candidate's is just as long as anybody's;
 * `audio/voice-activity.ts` is what makes this a claim about a person.
 */
export const PARTICIPATION_VOICED_FLOOR = 15;

/** Seconds of voiced audio measured per part, from the microphone. */
export interface SittingVoicedSpeech {
  monologueSeconds: number;
  debateSeconds: number;
}

/**
 * Parts the microphone heard at length and the transcript does not contain.
 *
 * A contradiction with exactly one plausible owner. The transcript is Gemini's
 * and arrives over a socket that can die; the voiced measure is the browser's
 * own, taken from samples that never left the tab. When they disagree this
 * hard, the words were lost in transit — and the monologue has a documented
 * way of losing all of them at once, since it is transcribed in a single
 * fragment emitted at `activityEnd` (`docs/GEMINI_LIVE_FINDINGS.md` §6) and a
 * session that dies before that boundary takes the whole exposé with it.
 *
 * This exists because the alternative reading was the one the app shipped: with
 * the transcript as the only witness, {@link partsAbsent} called such a part
 * absent, {@link applyAbsentPartPenalty} halved the mark, and the correction
 * page told a candidate who had spoken for seven minutes that they had not
 * presented their monologue. That sentence was false, and it was the app's
 * fault being read aloud as the candidate's.
 *
 * Deliberately NOT wired into `excused`. Excusing would keep the halving off a
 * mark that is still computed from a transcript missing half the épreuve, which
 * trades a false accusation for a fabricated grade. The finish route refuses
 * instead: no mark at all is the only honest output when half the evidence is
 * gone, and it is the same judgement the route already makes about a transcript
 * that is empty outright.
 */
export function partsSpokenButUntranscribed(
  participation: SittingParticipation,
  voiced: SittingVoicedSpeech,
): Array<"monologue" | "debate"> {
  const lost: Array<"monologue" | "debate"> = [];
  if (
    participation.monologueWords < PARTICIPATION_WORD_FLOOR &&
    voiced.monologueSeconds >= PARTICIPATION_VOICED_FLOOR
  ) {
    lost.push("monologue");
  }
  if (
    participation.debateWords < PARTICIPATION_WORD_FLOOR &&
    voiced.debateSeconds >= PARTICIPATION_VOICED_FLOOR
  ) {
    lost.push("debate");
  }
  return lost;
}

/** Which parts the candidate did not actually produce, in exam order. */
export function partsAbsent(participation: SittingParticipation): Array<"monologue" | "debate"> {
  const absent: Array<"monologue" | "debate"> = [];
  if (participation.monologueWords < PARTICIPATION_WORD_FLOOR) absent.push("monologue");
  if (participation.debateWords < PARTICIPATION_WORD_FLOOR) absent.push("debate");
  return absent;
}

/** What the absence rule did: the halved score, the points it cost, and why. */
export interface AbsencePenalty extends DurationPenalty {
  absentParts: Array<"monologue" | "debate">;
}

/**
 * Halve the mark for a sitting where one of the two parts never happened.
 *
 * THIS PROJECT'S RULE, and the second one in this file that is neither the
 * grille's nor the incumbent's (see {@link UNHEARD_PHONOLOGY_CEILING} for the
 * first, and for the same reasoning about where such a rule belongs). The
 * grille has no notion of it because a real jury does not grade an épreuve half
 * of which the candidate declined to sit; they would not produce a mark at all.
 * We have to produce one, so it has to be defined.
 *
 * What it replaces: nothing but {@link applySittingDurationPenalty}'s flat −3,
 * which is all that used to happen here. That rule measures a *shortfall* — six
 * minutes of débat instead of thirteen — and −3 is a fair price for it. It was
 * also the entire price of walking out of the débat without answering a single
 * question, because the penalty fires once at one magnitude whichever way a
 * part falls short. A candidate could produce half the épreuve and keep 22/25.
 *
 * Three decisions, all of which change marks:
 *
 *   - **Halved, not capped.** `floor(score / 2)`, so a 25 becomes 12 and a 14
 *     becomes 7. A cap at 12 would leave every walk-out below 12 untouched —
 *     the weakest candidates would be the ones the rule never reached — and it
 *     would flatten the ranking of everyone above it.
 *   - **Measured in words, not seconds.** The duration rule already asks the
 *     recording how long a part ran; this asks the transcript whether the
 *     candidate was in it. They are different questions and a microphone that
 *     dies answers only the first. See {@link PARTICIPATION_WORD_FLOOR}.
 *   - **It halves once, not per part.** Both parts absent would be a quarter of
 *     a mark for none of an épreuve, and a quarter is a magnitude no rule here
 *     produces. Note that this branch is reachable in production rather than
 *     merely defensive: the finish route's own gate counts the WHOLE transcript
 *     against {@link PARTICIPATION_WORD_FLOOR}, so 10 candidate words in the
 *     monologue and 15 in the débat total 25, clear that gate, and fall under
 *     the per-part floor twice.
 *
 * `absentParts` comes back for the reason `shortParts` does: "halved" and
 * "halved because you answered nothing in the débat" are different records.
 *
 * `excused` names the parts whose absence is not the candidate's to pay for
 * (#92): a débat the examiner closed early is not a débat the candidate walked
 * out of. Excused parts are removed from `absentParts` entirely rather than
 * merely spared the halving — the array explains a charge, and a part listed in
 * it while the penalty reads 0 would be an explanation of nothing.
 */
export function applyAbsentPartPenalty(
  score25: number,
  participation: SittingParticipation,
  excused: readonly ("monologue" | "debate")[] = [],
): AbsencePenalty {
  const absentParts = partsAbsent(participation).filter((part) => !excused.includes(part));
  if (absentParts.length === 0) return { score25, penalty: 0, absentParts };

  const halved = Math.floor(score25 / 2);
  return { score25: halved, penalty: score25 - halved, absentParts };
}

/** The duration rule over a whole sitting, and which parts triggered it. */
export interface SittingDurationPenalty extends DurationPenalty {
  shortParts: Array<"monologue" | "debate">;
}

/**
 * The per-part duration rule, applied to a sitting that has one /25.
 *
 * The port measures **each part against its own floor**, because the incumbent
 * corrects one task per correction and each correction carries its own score.
 * Here both tasks are one sitting and one mark, so the rule has to be composed,
 * and the composition is a decision the port cannot make for us:
 *
 *   - **The penalty fires once, if either part is short.** A flat −3, which is
 *     the only magnitude the incumbent's rule can produce. Docking 3 per short
 *     part would invent a −6 that no correction over there has ever produced.
 *   - **The floors stay per part.** Measuring the sitting total against their
 *     sum (480 s) is what the deleted copy did, and it passes a candidate who
 *     talks for eight minutes in the monologue and says nothing in the débat —
 *     which is precisely the shortfall the rule exists to catch.
 *
 * `shortParts` comes back so the reason is legible afterwards: "docked 3" and
 * "docked 3 because the débat produced 40 seconds" are different records, and
 * only one of them can be argued with.
 *
 * `excluded` names the parts this rule may not consider, and they are dropped
 * entirely — not merely excused the −3, but removed from `shortParts` too,
 * because the array explains the charge and must not name a part that was not
 * charged. Two kinds of part land in it, for two different reasons:
 *
 *   - **Parts {@link applyAbsentPartPenalty} has already charged for.** A part
 *     that never happened is necessarily under its floor, so leaving it in
 *     would dock a candidate twice for one absence and then report the second
 *     charge under the wrong reason. The rule still fires on the *other* part:
 *     an abandoned débat after a ninety-second monologue is halved, and then
 *     docked 3 for the monologue.
 *   - **Parts the examiner cut short (#92).** A débat that ran four minutes
 *     because the examiner dismissed the candidate at four minutes is a
 *     shortfall, but not the candidate's.
 */
export function applySittingDurationPenalty(
  score25: number,
  durations: SittingDurations,
  excluded: readonly ("monologue" | "debate")[] = [],
): SittingDurationPenalty {
  const shortParts = partsUnderFloor(durations).filter((part) => !excluded.includes(part));
  if (shortParts.length === 0) return { score25, penalty: 0, shortParts };

  // Delegated with the first short part's own measurement against its own floor
  // — real numbers, not a pair invented to force the branch — so the subtraction
  // and the floor at 0 stay in the ported function and are not written twice.
  const first =
    shortParts[0] === "monologue"
      ? { seconds: durations.monologueSeconds, floor: MONOLOGUE_FLOOR_SECONDS }
      : { seconds: durations.debateSeconds, floor: DEBATE_FLOOR_SECONDS };

  return { ...applyDurationPenalty(score25, first.seconds, first.floor), shortParts };
}

// ------------------------------------------------- phonologie without the sound

/**
 * The highest band « phonologie » may reach when the corrector never heard the
 * candidate — i.e. when a sitting is graded from its transcript alone.
 *
 * 3 is « au niveau ciblé B2 », and it is the honest ceiling for a criterion whose
 * definition is a claim about sound. A transcript can show that a candidate
 * hesitated; it cannot show that they were *remarkable*, and 5 (« niveau ciblé
 * supérieur B2+ ») is a claim nobody reading text is in a position to make.
 *
 * THIS PROJECT'S RULE, not the incumbent's and not the grille's. The grille has
 * no notion of a correction that cannot hear, because a real jury always can. The
 * incumbent has the notion and handles it in its prompt, asking the model to be
 * prudent; the reproduction audit deliberately dropped that wording (see
 * `criteria.ts`) because this project's justification is real audio. What the
 * audit did not settle is what the *fallback* does, and #12 measured the answer:
 * graded on text, this corrector set `phonologieNonEvaluable` on 2 of 11
 * corrections and awarded 5/5 on seven, including to a candidate whose French is
 * conspicuously agrammatical. The incumbent, on the same six transcripts, flagged
 * 24 of 24 and never went above 3.
 *
 * So the ceiling lives here rather than in the prompt. A prompt can be ignored by
 * the model — that is precisely what #29 recorded it doing — and a rule that
 * changes a candidate's mark belongs somewhere it can be tested.
 */
export const UNHEARD_PHONOLOGY_CEILING = 3;

/**
 * Hold « phonologie » to {@link UNHEARD_PHONOLOGY_CEILING} when the correction
 * had no audio. A no-op when it did, and a no-op for bands already at or below
 * the ceiling — every result is still a legal grille band, because 0, 1 and 3
 * pass through and only 5 moves.
 */
export function capUnheardPhonology(
  criteria: CriteriaBands,
  phonologyHeard: boolean,
): CriteriaBands {
  if (phonologyHeard || criteria.phonologie <= UNHEARD_PHONOLOGY_CEILING) return criteria;
  return { ...criteria, phonologie: UNHEARD_PHONOLOGY_CEILING };
}

/**
 * Whether a /25 score meets the DELF per-competency floor (≥ 5). A sub-floor
 * production orale score is éliminatoire regardless of other competencies.
 */
export function meetsCompetencyFloor(score25: number): boolean {
  return score25 >= COMPETENCY_FLOOR;
}

// ------------------------------------------------------------- the whole rule

/** The five criteria as the grille allows them to be: 0, 1, 3 or 5. */
export type CriteriaBands = Record<OralCriterion, GrilleBand>;

/**
 * Snap all five of a model's raw numbers onto legal bands.
 *
 * The snapping itself is `grille.ts`'s, which is the ported source of truth for
 * it and says so; this is only the five-at-once shape. Note what it is NOT:
 * {@link normalizeCriteria} clamps to 0–5 and will happily return a 2, which the
 * grille has no band for and `evaluations_bands_check` rejects outright. Both
 * behaviours are the incumbent's — over there the clamp sits behind a model
 * instructed to emit bands only — and this is the one the pipeline uses.
 */
export function snapCriteria(raw: Record<OralCriterion, number>): CriteriaBands {
  return Object.fromEntries(
    ORAL_CRITERIA.map((criterion) => [criterion, snapToBand(raw[criterion])]),
  ) as CriteriaBands;
}

/**
 * The conditions a sitting was produced and corrected under: how long each part
 * ran, and whether the corrector could hear it.
 *
 * `phonologyHeard` is deliberately a fact about the épreuve rather than the
 * `evaluations.mode` enum it will usually be derived from. This module is pure
 * DELF logic and must not learn the shape of a storage column to apply a rule.
 *
 * The word counts arrive as numbers for the same reason: `transcript.ts` knows
 * how to count what a candidate said in a phase, and this module needs the
 * answer without learning the shape of a transcript entry to get it.
 */
export interface SittingConditions extends SittingDurations, SittingParticipation {
  /**
   * Whether the correction actually had the candidate's recording. Required, with
   * no default: defaulting it true reinstates #29 for any caller who forgets, and
   * defaulting it false silently caps corrections that did hear the candidate.
   */
  phonologyHeard: boolean;
  /**
   * Whether the examiner tried to end the épreuve mid-débat (#92) — a goodbye
   * heard outside any closing handshake the app opened. When true, the débat is
   * excused from both penalties: a candidate told they may leave the room stops
   * talking, and the halving and the −3 exist to charge a candidate's own
   * shortfall, not the examiner's.
   *
   * Required, with no default, for {@link phonologyHeard}'s reason: defaulting
   * it false reinstates exactly the charge #92 exists to lift for any caller
   * who forgets, and defaulting it true waives real walk-outs. Like the word
   * counts, it arrives as a fact about the épreuve rather than as the stored
   * count it is derived from — this module must not learn a column's shape to
   * apply a rule.
   */
  examinerClosedEarly: boolean;
}

/** Everything the rubric has to say about one sitting. */
export interface SittingScore {
  /** The five bands, snapped — and capped, where the corrector could not hear. */
  criteria: CriteriaBands;
  /** Their sum, before any penalty. */
  rawScore25: number;
  /**
   * The points the halving took off for a part the candidate never produced —
   * 0 when both parts happened. See {@link applyAbsentPartPenalty}.
   */
  absencePenalty: number;
  /** Which parts never happened, so the halving can be explained. */
  absentParts: Array<"monologue" | "debate">;
  /** What the rubric asked to dock, nominal. See {@link DurationPenalty}. */
  durationPenalty: number;
  /**
   * Which parts were short, so the penalty can be explained. Never includes a
   * part listed in {@link absentParts} — absence supersedes shortfall.
   */
  shortParts: Array<"monologue" | "debate">;
  /**
   * Which parts a penalty would have reached and did not, because the examiner
   * closed the épreuve early (#92). Empty on the ordinary sitting — including
   * the recovered one, where the examiner said goodbye, was contradicted, and
   * the candidate talked the débat to its full length: nothing fell short
   * there, so nothing was excused. Reported for {@link shortParts}'s reason: a
   * full mark over a four-minute débat is a record someone will ask about.
   */
  excusedParts: Array<"monologue" | "debate">;
  /**
   * Whether « phonologie » was held down because the correction had no audio —
   * true only when the band actually moved. Reported for the same reason as
   * {@link shortParts}: "3 in phonologie" and "3 in phonologie because nobody
   * heard you" are different records, and only one of them can be argued with.
   */
  phonologyCapped: boolean;
  /** What the candidate is shown. */
  score25: number;
  /** Whether that clears the ≥ 5/25 competency floor. */
  meetsFloor: boolean;
}

/**
 * Score one sitting: the whole rule, in the order it has to happen.
 *
 * The evaluator calls this and nothing else. Every step below is a rule that
 * changes a grade, and each was, at some point in this repository, also written
 * somewhere else — the snapping in `rubric.ts`, the floor in the finish route,
 * the penalty in two different shapes. Composing them here is what makes
 * "exactly one implementation survives" true of the *sequence* and not just of
 * the functions: a caller cannot sum before snapping, halve after docking, or
 * ask about the floor before both penalties have been taken off.
 *
 * Nothing here is asked of the model. It returns five numbers and prose; the
 * arithmetic that turns those into a mark is the rubric's, and a prompt that
 * restated it would be a second implementation written in French.
 */
export function scoreSitting(
  raw: Record<OralCriterion, number>,
  conditions: SittingConditions,
): SittingScore {
  // Snap, then cap. Both orders give the same band here, but only this one is
  // honest about what each step does: snapping turns a model's number into a
  // legal band, and the ceiling is then applied to a band rather than to
  // whatever the model happened to emit.
  const snapped = snapCriteria(raw);
  const criteria = capUnheardPhonology(snapped, conditions.phonologyHeard);
  const rawScore25 = criteriaToScore25(criteria);

  // The examiner's fault, taken off the table before either penalty looks
  // (#92). Only the débat can be excused: the goodbye is only ever detected
  // mid-débat, so the monologue's penalties are the candidate's whatever the
  // examiner did afterwards.
  const excused: Array<"monologue" | "debate"> = conditions.examinerClosedEarly ? ["debate"] : [];

  // Halve first, dock second. The order is the decision: a candidate who
  // produced half an épreuve is marked on half the scale, and the shortfall
  // rule then applies to what is left. Reversing it would charge the flat 3
  // against the full mark and then halve the remainder, which quietly makes the
  // duration penalty worth 1.5 points on exactly the sittings that earned it.
  const absence = applyAbsentPartPenalty(rawScore25, conditions, excused);
  const { score25, penalty, shortParts } = applySittingDurationPenalty(
    absence.score25,
    conditions,
    [...absence.absentParts, ...excused],
  );

  return {
    criteria,
    rawScore25,
    absencePenalty: absence.penalty,
    absentParts: absence.absentParts,
    durationPenalty: penalty,
    shortParts,
    // Excused, in the reported sense: a penalty would actually have reached it.
    // `excused` above is broader — it silences the rules whether or not they
    // had anything to say — and reporting that would label every recovered
    // sitting with a waiver that changed nothing.
    excusedParts: excused.filter(
      (part) =>
        partsAbsent(conditions).includes(part) || partsUnderFloor(conditions).includes(part),
    ),
    phonologyCapped: criteria.phonologie !== snapped.phonologie,
    score25,
    meetsFloor: meetsCompetencyFloor(score25),
  };
}
