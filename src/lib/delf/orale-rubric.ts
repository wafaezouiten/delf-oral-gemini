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
 * Not to be confused with `phases.ts`'s `MONOLOGUE_MIN_SECONDS` (300 s), which
 * is how long the candidate must stay in the monologue before the UI lets them
 * advance. That one is a clock the candidate watches; these are floors the
 * *recording* is measured against afterwards, and the two answer different
 * questions — a phase can run its full 300 s and record 40 s of audio.
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
 */
export const PARTICIPATION_WORD_FLOOR = 20;

/** Which parts the candidate did not actually produce, in exam order. */
export function partsAbsent(
  participation: SittingParticipation,
): Array<"monologue" | "debate"> {
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
 *     a mark for none of an épreuve, which is a magnitude no rule here produces
 *     and a sitting the finish route refuses to grade in the first place.
 *
 * `absentParts` comes back for the reason `shortParts` does: "halved" and
 * "halved because you answered nothing in the débat" are different records.
 */
export function applyAbsentPartPenalty(
  score25: number,
  participation: SittingParticipation,
): AbsencePenalty {
  const absentParts = partsAbsent(participation);
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
 * `absent` names the parts {@link applyAbsentPartPenalty} has already charged
 * for, and they are dropped from consideration entirely — not merely excused
 * the −3, but removed from `shortParts` too. A part that never happened is
 * necessarily under its floor, so leaving it in would dock a candidate twice
 * for one absence and then report the second charge under the wrong reason. The
 * rule still fires on the *other* part: an abandoned débat after a
 * ninety-second monologue is halved, and then docked 3 for the monologue.
 */
export function applySittingDurationPenalty(
  score25: number,
  durations: SittingDurations,
  absent: readonly ("monologue" | "debate")[] = [],
): SittingDurationPenalty {
  const shortParts = partsUnderFloor(durations).filter((part) => !absent.includes(part));
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

  // Halve first, dock second. The order is the decision: a candidate who
  // produced half an épreuve is marked on half the scale, and the shortfall
  // rule then applies to what is left. Reversing it would charge the flat 3
  // against the full mark and then halve the remainder, which quietly makes the
  // duration penalty worth 1.5 points on exactly the sittings that earned it.
  const absence = applyAbsentPartPenalty(rawScore25, conditions);
  const { score25, penalty, shortParts } = applySittingDurationPenalty(
    absence.score25,
    conditions,
    absence.absentParts,
  );

  return {
    criteria,
    rawScore25,
    absencePenalty: absence.penalty,
    absentParts: absence.absentParts,
    durationPenalty: penalty,
    shortParts,
    phonologyCapped: criteria.phonologie !== snapped.phonologie,
    score25,
    meetsFloor: meetsCompetencyFloor(score25),
  };
}
