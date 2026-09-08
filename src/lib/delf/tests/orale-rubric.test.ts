import assert from "node:assert/strict";
import { test } from "node:test";

import { ORAL_CRITERIA } from "../criteria";
import { GRILLE_BANDS } from "../grille";
import {
  FULL_DEVELOPMENT_SECONDS,
  SHORT_DEVELOPMENT_SECONDS,
  applyDurationPenalty,
  applySittingDurationPenalty,
  capUnheardPhonology,
  clampCriterion,
  criteriaToScore25,
  meetsCompetencyFloor,
  normalizeCriteria,
  applyAbsentPartPenalty,
  partsAbsent,
  partsSpokenButUntranscribed,
  partsUnderFullDevelopment,
  PARTICIPATION_VOICED_FLOOR,
  PARTICIPATION_WORD_FLOOR,
  scoreSitting,
  snapCriteria,
  UNHEARD_PHONOLOGY_CEILING,
  type CriteriaBands,
  type OralCriteriaScores,
} from "../orale-rubric";

const full: OralCriteriaScores = {
  realisationTache: 5,
  interaction: 5,
  lexique: 5,
  morphosyntaxe: 5,
  phonologie: 5,
};

test("clampCriterion rounds and clamps to 0–5", () => {
  assert.equal(clampCriterion(3.4), 3);
  assert.equal(clampCriterion(3.6), 4);
  assert.equal(clampCriterion(-2), 0);
  assert.equal(clampCriterion(9), 5);
  assert.equal(clampCriterion(Number.NaN), 0);
});

test("normalizeCriteria clamps every field", () => {
  const normalized = normalizeCriteria({
    realisationTache: 7,
    interaction: -1,
    lexique: 4.5,
    morphosyntaxe: 2,
    phonologie: 100,
  });
  assert.deepEqual(normalized, {
    realisationTache: 5,
    interaction: 0,
    lexique: 5, // 4.5 rounds to 5
    morphosyntaxe: 2,
    phonologie: 5,
  });
});

test("criteriaToScore25 sums the five criteria to a /25", () => {
  assert.equal(criteriaToScore25(full), 25);
  assert.equal(
    criteriaToScore25({
      realisationTache: 3,
      interaction: 1,
      lexique: 3,
      morphosyntaxe: 3,
      phonologie: 1,
    }),
    11,
  );
  assert.equal(
    criteriaToScore25({
      realisationTache: 0,
      interaction: 0,
      lexique: 0,
      morphosyntaxe: 0,
      phonologie: 0,
    }),
    0,
  );
});

test("criteriaToScore25 clamps out-of-range input to [0,25]", () => {
  // Every field over-max would sum to 100 but must clamp to 25.
  assert.equal(
    criteriaToScore25({
      realisationTache: 20,
      interaction: 20,
      lexique: 20,
      morphosyntaxe: 20,
      phonologie: 20,
    }),
    25,
  );
});

test("applyDurationPenalty subtracts only when under the minimum", () => {
  assert.deepEqual(applyDurationPenalty(18, 120, 60), { score25: 18, penalty: 0 }); // over min
  assert.deepEqual(applyDurationPenalty(18, 30, 60), { score25: 15, penalty: 3 }); // under min
  assert.deepEqual(applyDurationPenalty(18, 60, 60), { score25: 18, penalty: 0 }); // exactly min
  assert.deepEqual(applyDurationPenalty(18, 10, 60, 5), { score25: 13, penalty: 5 }); // custom
});

test("applyDurationPenalty reports what it asked for, not what the score could absorb", () => {
  // The distinction #15's review asked for. A 2/25 docked 3 lands at 0, and the
  // record should say the rubric wanted 3 — otherwise a floored score reads as a
  // smaller penalty than the one that was actually applied.
  assert.deepEqual(applyDurationPenalty(2, 5, 60), { score25: 0, penalty: 3 });
});

test("meetsCompetencyFloor enforces the DELF ≥ 5/25 floor", () => {
  assert.equal(meetsCompetencyFloor(5), true);
  assert.equal(meetsCompetencyFloor(4), false);
  assert.equal(meetsCompetencyFloor(0), false);
  assert.equal(meetsCompetencyFloor(25), true);
});

// --------------------------------------------------------- the per-part rule

/** Five 5s, as bands. The whole duration matrix lives in `duration-tiers.test.ts`;
 *  these cases are about how the rule composes with the rest of the file. */
const TOP_BANDS: CriteriaBands = {
  realisationTache: 5,
  interaction: 5,
  lexique: 5,
  morphosyntaxe: 5,
  phonologie: 5,
};

test("each part has its own full-development time, and one shared floor", () => {
  // #189's figures as corrected by the user: eight minutes for the debat, and
  // for the exposé its own announced maximum, because seven is the longest it
  // can run. They replaced 168 s and 312 s (40 % of each part's expected time).
  // The whole argument is on `FULL_DEVELOPMENT_SECONDS`; the matrix that
  // exercises it is in `duration-tiers.test.ts`.
  assert.equal(FULL_DEVELOPMENT_SECONDS.monologue, 420);
  assert.equal(FULL_DEVELOPMENT_SECONDS.debate, 600);
  assert.equal(SHORT_DEVELOPMENT_SECONDS, 240);
});

test("a part under the full threshold is short even when the other one is not", () => {
  // Eight minutes of monologue and nothing else. The rule is per part, so the
  // débat is charged and the monologue is not.
  const lopsided = { monologueSeconds: 480, debateSeconds: 0 };

  assert.deepEqual(partsUnderFullDevelopment(lopsided), ["debate"]);
  const charged = applySittingDurationPenalty(20, TOP_BANDS, lopsided);
  assert.equal(charged.penalty, 4, "strong: interaction 5 → 1");
  assert.equal(charged.score25, 16);
  assert.deepEqual(charged.shortParts, ["debate"]);
  assert.deepEqual(charged.charges, [
    {
      part: "debate",
      criterion: "interaction",
      tier: "strong",
      seconds: 0,
      from: 5,
      to: 1,
      points: 4,
    },
  ]);
});

test("a full sitting is not penalised", () => {
  const full = { monologueSeconds: 500, debateSeconds: 700 };

  assert.deepEqual(partsUnderFullDevelopment(full), []);
  assert.deepEqual(applySittingDurationPenalty(20, TOP_BANDS, full), {
    score25: 20,
    penalty: 0,
    shortParts: [],
    tiers: { monologue: "full", debate: "full" },
    charges: [],
  });
});

test("both parts short are both charged, on their own criteria", () => {
  // Where #189 parted company with the port. The old rule fired ONCE at a flat
  // −3 however many parts fell short, because the incumbent grades one task per
  // correction and can never produce a −6. A tier charged to a criterion has no
  // such constraint: each part answers for its own half.
  const nothing = { monologueSeconds: 0, debateSeconds: 0 };

  assert.deepEqual(partsUnderFullDevelopment(nothing), ["monologue", "debate"]);
  const charged = applySittingDurationPenalty(20, TOP_BANDS, nothing);
  assert.equal(charged.penalty, 8, "4 off réalisation de la tâche, 4 off interaction");
  assert.equal(charged.score25, 12);
  assert.deepEqual(
    charged.charges.map((charge) => charge.criterion),
    ["realisationTache", "interaction"],
  );
});

test("exactly at its own full threshold is not short, part by part", () => {
  // Each part against its own ceiling: the exposé's announced 420 s and the
  // debat's 480 s. A single number here would pass by accident on one of them.
  assert.deepEqual(
    partsUnderFullDevelopment({
      monologueSeconds: FULL_DEVELOPMENT_SECONDS.monologue,
      debateSeconds: FULL_DEVELOPMENT_SECONDS.debate,
    }),
    [],
  );
  assert.deepEqual(
    partsUnderFullDevelopment({
      monologueSeconds: FULL_DEVELOPMENT_SECONDS.monologue - 1,
      debateSeconds: FULL_DEVELOPMENT_SECONDS.debate - 1,
    }),
    ["monologue", "debate"],
  );
});

// ------------------------------------------------------------ the whole rule

/**
 * A candidate who was present in both parts, in words — and an examiner who
 * behaved.
 *
 * Spread into every `scoreSitting` case that is about something else, because
 * participation is now a precondition of the ordinary scoring path: without it
 * every one of these fixtures would silently become a walk-out and be halved,
 * and the tests would still pass while measuring the wrong rule.
 * `examinerClosedEarly: false` rides along for the mirrored reason: true would
 * silently excuse the débat from both penalties (#92), and the walk-out cases
 * below would measure the waiver instead of the charge.
 */
const SPOKE = { monologueWords: 400, debateWords: 300, examinerClosedEarly: false };

const bands = (value: number) =>
  Object.fromEntries(ORAL_CRITERIA.map((criterion) => [criterion, value])) as Record<
    (typeof ORAL_CRITERIA)[number],
    number
  >;

test("snapCriteria puts every criterion on a legal band", () => {
  // 2 and 4 are not bands; the grille's tie rule rounds them down.
  assert.deepEqual(snapCriteria(bands(2)), bands(1));
  assert.deepEqual(snapCriteria(bands(4)), bands(3));
  assert.deepEqual(snapCriteria(bands(99)), bands(5));
  assert.deepEqual(snapCriteria(bands(Number.NaN)), bands(0));
});

test("scoreSitting snaps before it sums", () => {
  // The order is the rule. Summing first would give 25 for five 5s and 10 for
  // five 2s; snapping first gives 5, because a 2 is a 1 on this grille.
  const scored = scoreSitting(bands(2), {
    monologueSeconds: 500,
    debateSeconds: 700,
    ...SPOKE,
    phonologyHeard: true,
  });

  assert.deepEqual(scored.criteria, bands(1));
  assert.equal(scored.rawScore25, 5);
  assert.equal(scored.score25, 5);
});

test("scoreSitting docks before it tests the floor", () => {
  // 5/25 clears the floor and 3/25 does not, so a sitting that is short lands on
  // the other side of it. Testing the floor against the pre-penalty score would
  // pass a candidate the rubric has just failed.
  const scored = scoreSitting(bands(1), {
    monologueSeconds: 400,
    debateSeconds: 10,
    ...SPOKE,
    phonologyHeard: true,
  });

  assert.equal(scored.rawScore25, 5);
  // One point off each pragmatic criterion: both were on band 1, and a step
  // down from 1 is 0 whether the tier asks for one step or two.
  assert.equal(scored.durationPenalty, 2);
  assert.equal(scored.score25, 3);
  assert.equal(scored.meetsFloor, false);
  assert.deepEqual(scored.shortParts, ["monologue", "debate"]);
});

test("scoreSitting keeps the nominal penalty when the score cannot absorb it", () => {
  // Reachable only once the halving has been through first: the charge is
  // priced off two of the five bands, so it can only outrun a score that
  // something else has already taken half of. A strong exposé, an abandoned
  // débat, and nothing else on the grille.
  const scored = scoreSitting(
    { ...bands(0), realisationTache: 5 },
    {
      monologueSeconds: 60,
      debateSeconds: 0,
      monologueWords: 400,
      debateWords: 0,
      examinerClosedEarly: false,
      phonologyHeard: true,
    },
  );

  assert.equal(scored.rawScore25, 5);
  assert.equal(scored.absencePenalty, 3, "5 halved to 2");
  assert.equal(scored.durationPenalty, 4, "what the rubric asked for");
  assert.equal(scored.score25, 0, "what the score could absorb");
});

// ------------------------------------------- phonologie without the sound (#29)

test("a correction that heard nothing cannot award the top phonologie band", () => {
  // The measured failure #29 records: a transcript with no « euh » in it read as
  // remarkable fluency, and five points were awarded for the absence of evidence.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 400,
    debateSeconds: 700,
    ...SPOKE,
    phonologyHeard: false,
  });

  assert.equal(scored.criteria.phonologie, UNHEARD_PHONOLOGY_CEILING);
  assert.equal(scored.phonologyCapped, true);
  // Two points, off a criterion worth five, on every text-mode sitting a strong
  // candidate produces.
  assert.equal(scored.rawScore25, 23);
});

test("the ceiling touches phonologie and nothing else", () => {
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 400,
    debateSeconds: 700,
    ...SPOKE,
    phonologyHeard: false,
  });

  for (const criterion of ORAL_CRITERIA) {
    if (criterion === "phonologie") continue;
    assert.equal(scored.criteria[criterion], 5, `${criterion} must be untouched`);
  }
});

test("a correction that heard the candidate may award the top band", () => {
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 400,
    debateSeconds: 700,
    ...SPOKE,
    phonologyHeard: true,
  });

  assert.equal(scored.criteria.phonologie, 5);
  assert.equal(scored.phonologyCapped, false);
  assert.equal(scored.rawScore25, 25);
});

test("a band already under the ceiling is left alone, and not reported as capped", () => {
  // The distinction the flag exists for: 1/5 from a hesitant transcript is the
  // corrector's judgement, not the rubric's intervention, and a candidate told
  // "we could not hear you" about it would be told something false.
  for (const band of [0, 1, 3] as const) {
    const scored = scoreSitting(
      { ...bands(5), phonologie: band },
      { monologueSeconds: 400, debateSeconds: 700, ...SPOKE, phonologyHeard: false },
    );

    assert.equal(scored.criteria.phonologie, band);
    assert.equal(scored.phonologyCapped, false, `band ${band} was not moved`);
  }
});

test("capUnheardPhonology only ever returns a legal grille band", () => {
  for (const band of GRILLE_BANDS) {
    // `snapCriteria` rather than `bands(3)`: this function takes bands that are
    // already legal, and the type says so.
    const capped = capUnheardPhonology({ ...snapCriteria(bands(3)), phonologie: band }, false);
    assert.ok(
      (GRILLE_BANDS as readonly number[]).includes(capped.phonologie),
      `${band} capped to ${capped.phonologie}, which no column accepts`,
    );
  }
});

test("the ceiling is applied after snapping, so an illegal 4 becomes 3 either way", () => {
  // A model emitting 4 is snapped to 3, which is already at the ceiling. The
  // result must be the same whether or not the correction heard anything —
  // otherwise the two orders would disagree and the mark would depend on one.
  const heard = scoreSitting(
    { ...bands(3), phonologie: 4 },
    {
      monologueSeconds: 400,
      debateSeconds: 700,
      ...SPOKE,
      phonologyHeard: true,
    },
  );
  const unheard = scoreSitting(
    { ...bands(3), phonologie: 4 },
    {
      monologueSeconds: 400,
      debateSeconds: 700,
      ...SPOKE,
      phonologyHeard: false,
    },
  );

  assert.equal(heard.criteria.phonologie, 3);
  assert.equal(unheard.criteria.phonologie, 3);
  assert.equal(unheard.phonologyCapped, false, "snapping moved it, not the ceiling");
});

test("the duration penalty still applies on top of a capped phonologie", () => {
  // Two independent rules, and a sitting can earn both. Neither is allowed to
  // swallow the other.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 400,
    debateSeconds: 10,
    ...SPOKE,
    phonologyHeard: false,
  });

  assert.equal(scored.rawScore25, 23, "capped before the sum");
  // 400 s of monologue is now the middle tier (one band off réalisation de la
  // tâche, 5 → 3) and 10 s of débat the bottom one (interaction 5 → 1).
  assert.equal(scored.durationPenalty, 6);
  assert.equal(scored.score25, 17);
  assert.deepEqual(scored.shortParts, ["monologue", "debate"]);
  assert.equal(scored.phonologyCapped, true);
  // And the cap is not what paid for the shortfall: phonologie is left where
  // the ceiling put it, which is the whole point of charging by criterion.
  assert.equal(scored.criteria.phonologie, 3);
  assert.deepEqual(
    scored.durationCharges.map((charge) => charge.criterion),
    ["realisationTache", "interaction"],
  );
});

// ----------------------------------------------- a part that never happened

test("partsAbsent reads the word floor, not silence", () => {
  // « oui » is not a débat. The floor is what stops one syllable buying back
  // half a mark, and it is the same 20 the finish route already applies to a
  // whole transcript.
  assert.deepEqual(partsAbsent({ monologueWords: 400, debateWords: 0 }), ["debate"]);
  assert.deepEqual(partsAbsent({ monologueWords: 400, debateWords: 1 }), ["debate"]);
  assert.deepEqual(
    partsAbsent({ monologueWords: 400, debateWords: PARTICIPATION_WORD_FLOOR - 1 }),
    ["debate"],
  );
  assert.deepEqual(
    partsAbsent({ monologueWords: 400, debateWords: PARTICIPATION_WORD_FLOOR }),
    [],
    "at the floor the part happened",
  );
  assert.deepEqual(partsAbsent({ monologueWords: 0, debateWords: 300 }), ["monologue"]);
});

// -------------------------------------- a part that happened and was not heard

/**
 * The other reading of an empty part, and the one the app had no way to reach.
 *
 * `partsAbsent` asks the transcript and the transcript alone, which is right
 * until the transcript is the thing that failed. The monologue is emitted in a
 * single fragment at `activityEnd`, so one dropped socket loses seven minutes
 * of exposé at once — and every downstream rule then agreed the candidate had
 * not presented it, halved their mark, and printed a sentence saying so.
 */
test("a part the microphone heard at length is not an absence", () => {
  const spoke = { monologueSeconds: 300, debateSeconds: 400 };

  // The failure this exists for: a full sitting, and one part's words gone.
  assert.deepEqual(partsSpokenButUntranscribed({ monologueWords: 0, debateWords: 300 }, spoke), [
    "monologue",
  ]);
  assert.deepEqual(partsSpokenButUntranscribed({ monologueWords: 400, debateWords: 3 }, spoke), [
    "debate",
  ]);
  assert.deepEqual(
    partsSpokenButUntranscribed({ monologueWords: 0, debateWords: 0 }, spoke),
    ["monologue", "debate"],
    "in exam order, like every other part list here",
  );
});

test("a candidate who said nothing is still absent, whatever the room did", () => {
  // The rule only ever excuses, so the one thing it must never do is excuse
  // silence. A part is contradicted by its own audio or it is not contradicted
  // at all: a transcript at the word floor is a part that happened, and voiced
  // seconds below their floor are not evidence that anything was said.
  assert.deepEqual(
    partsSpokenButUntranscribed(
      { monologueWords: 400, debateWords: 2 },
      { monologueSeconds: 300, debateSeconds: PARTICIPATION_VOICED_FLOOR - 1 },
    ),
    [],
    "« euh… non, ça va » clears neither floor",
  );
  assert.deepEqual(
    partsSpokenButUntranscribed(
      { monologueWords: 400, debateWords: PARTICIPATION_WORD_FLOOR },
      { monologueSeconds: 300, debateSeconds: 400 },
    ),
    [],
    "at the word floor the part happened and there is nothing to explain",
  );
  assert.deepEqual(
    partsSpokenButUntranscribed(
      { monologueWords: 0, debateWords: 0 },
      { monologueSeconds: 0, debateSeconds: 0 },
    ),
    [],
    "no microphone is no evidence, and no evidence never accuses either way",
  );
});

test("the two floors cannot both be satisfied by one honest sitting", () => {
  // The sizing argument, pinned. Fifteen seconds of continuous voiced French is
  // comfortably more than twenty words takes to say, so a part can be under the
  // word floor and over the voiced floor only when something was lost.
  assert.ok(
    PARTICIPATION_VOICED_FLOOR * 2 > PARTICIPATION_WORD_FLOOR / 2,
    "roughly two words a second is the speech this is sized against",
  );
});

test("walking out of the débat halves the mark", () => {
  // The case this rule exists for: a full exposé, then « Terminer » before
  // answering a single question. Under the duration penalty alone this was 25 −
  // 3 = 22/25 — a near-perfect mark for half an épreuve.
  //
  // The monologue runs past `FULL_DEVELOPMENT_SECONDS` here, and in the cases
  // below, so that what is measured is the halving alone (#189): a
  // seven-minute exposé is now charged a band as well, and every one of these
  // numbers would otherwise be answering two rules at once.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 500,
    debateSeconds: 0,
    monologueWords: 400,
    debateWords: 0,
    phonologyHeard: true,
    examinerClosedEarly: false,
  });

  assert.equal(scored.rawScore25, 25);
  assert.equal(scored.absencePenalty, 13);
  assert.deepEqual(scored.absentParts, ["debate"]);
  assert.equal(scored.score25, 12);
});

test("the halving is proportional, so a weak walk-out is not spared", () => {
  // What a cap at 12 would have missed entirely: every one of these is below it
  // to begin with, and a cap would have left all three untouched.
  const halved = (band: 0 | 1 | 3 | 5) =>
    scoreSitting(bands(band), {
      monologueSeconds: 500,
      debateSeconds: 0,
      monologueWords: 400,
      debateWords: 0,
      phonologyHeard: true,
      examinerClosedEarly: false,
    });

  assert.equal(halved(3).rawScore25, 15);
  assert.equal(halved(3).score25, 7, "floor(15 / 2)");
  assert.equal(halved(1).score25, 2, "floor(5 / 2) — and now under the floor");
  assert.equal(halved(1).meetsFloor, false);
  assert.equal(halved(0).score25, 0);
  assert.equal(halved(0).absencePenalty, 0, "nothing to halve");
});

test("an absent part is not also charged for being short", () => {
  // A part nobody produced is necessarily under both thresholds. Charging its
  // tier as well would be two prices for one absence, and `shortParts` would
  // name the débat as the reason for a penalty the halving had already covered.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 500,
    debateSeconds: 0,
    monologueWords: 400,
    debateWords: 0,
    phonologyHeard: true,
    examinerClosedEarly: false,
  });

  assert.equal(scored.durationPenalty, 0);
  assert.deepEqual(scored.shortParts, []);
  assert.deepEqual(scored.durationCharges, []);
  assert.equal(scored.score25, 12, "12, not 8");
});

test("the other part is still charged for being short", () => {
  // The two rules are independent and a sitting can earn both: a ninety-second
  // monologue followed by an abandoned débat is halved *and* charged the
  // monologue's own tier.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 90,
    debateSeconds: 0,
    monologueWords: 120,
    debateWords: 0,
    phonologyHeard: true,
    examinerClosedEarly: false,
  });

  assert.equal(scored.absencePenalty, 13);
  assert.deepEqual(scored.absentParts, ["debate"]);
  assert.equal(scored.durationPenalty, 4, "strong: réalisation de la tâche 5 → 1");
  assert.deepEqual(scored.shortParts, ["monologue"]);
  assert.equal(scored.score25, 8, "25 → 12 → 8");
});

test("halving happens before the duration penalty, not after", () => {
  // The order is the rule, and #189 did not move it. Docking first would give
  // floor((25 − 4) / 2) = 10, which makes the duration charge worth half on
  // exactly the sittings that earned it.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 90,
    debateSeconds: 0,
    monologueWords: 120,
    debateWords: 0,
    phonologyHeard: true,
    examinerClosedEarly: false,
  });

  assert.equal(scored.score25, 8);
  assert.notEqual(scored.score25, 10);
});

test("a sitting where both parts happened is untouched by the rule", () => {
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 500,
    debateSeconds: 700,
    ...SPOKE,
    phonologyHeard: true,
  });

  assert.equal(scored.absencePenalty, 0);
  assert.deepEqual(scored.absentParts, []);
  assert.equal(scored.score25, 25);
});

test("the halving fires once, even when neither part happened", () => {
  // A quarter of a mark is a magnitude no rule here produces. And this is not
  // a defensive case: the finish route's gate counts the WHOLE transcript, so
  // 10 candidate words in the monologue and 15 in the débat clear it at 25 and
  // fall under the per-part word floor twice.
  const { score25, penalty, absentParts } = applyAbsentPartPenalty(25, {
    monologueWords: 0,
    debateWords: 0,
  });

  assert.deepEqual(absentParts, ["monologue", "debate"]);
  assert.equal(score25, 12);
  assert.equal(penalty, 13);
});

// ------------------------------------- a débat the examiner ended early (#92)

test("a débat the examiner closed is not halved as a walk-out", () => {
  // The case the waiver exists for: a full monologue, an examiner that said
  // « vous pouvez quitter la salle » mid-débat, and a candidate who obeyed.
  // Without the flag this is the 12/25 walk-out above; with it the silence in
  // the débat is the examiner's to answer for.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 500,
    debateSeconds: 0,
    monologueWords: 400,
    debateWords: 0,
    phonologyHeard: true,
    examinerClosedEarly: true,
  });

  assert.equal(scored.absencePenalty, 0);
  assert.deepEqual(scored.absentParts, []);
  assert.deepEqual(scored.excusedParts, ["debate"]);
  assert.equal(scored.score25, 25);
});

test("a débat the examiner cut short is not charged its tier either", () => {
  // Both rules point at the débat, and the waiver has to silence both: excusing
  // the halving and then charging the tier would price the examiner's fault at
  // exactly the penalty the issue says the candidate must not pay.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 500,
    debateSeconds: 240,
    monologueWords: 400,
    debateWords: 180,
    phonologyHeard: true,
    examinerClosedEarly: true,
  });

  assert.equal(scored.durationPenalty, 0);
  assert.deepEqual(scored.shortParts, []);
  assert.deepEqual(scored.excusedParts, ["debate"]);
  assert.equal(scored.score25, 25);
});

test("the monologue's penalties are untouched by the examiner's goodbye", () => {
  // The goodbye is only ever heard mid-débat, after the monologue is over —
  // whatever the examiner did later, a ninety-second monologue was the
  // candidate's own shortfall and is still docked.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 90,
    debateSeconds: 0,
    monologueWords: 120,
    debateWords: 0,
    phonologyHeard: true,
    examinerClosedEarly: true,
  });

  assert.equal(scored.absencePenalty, 0, "the absent débat is excused");
  assert.equal(scored.durationPenalty, 4, "the short monologue is not");
  assert.deepEqual(scored.shortParts, ["monologue"]);
  assert.deepEqual(scored.excusedParts, ["debate"]);
  assert.equal(scored.score25, 21);
});

test("an absent monologue is still halved when only the débat is excused", () => {
  // The waiver names one part; it must not become a general amnesty. A
  // candidate who sat silent through the monologue and was then dismissed from
  // the débat is still halved for the half that was theirs to produce.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 0,
    debateSeconds: 0,
    monologueWords: 0,
    debateWords: 0,
    phonologyHeard: true,
    examinerClosedEarly: true,
  });

  assert.equal(scored.absencePenalty, 13);
  assert.deepEqual(scored.absentParts, ["monologue"]);
  assert.deepEqual(scored.excusedParts, ["debate"]);
});

test("a recovered sitting reports no waiver, because nothing needed one", () => {
  // The examiner said goodbye, was contradicted, and the candidate talked the
  // débat to its full length. No rule had anything to charge, so nothing was
  // excused — `excusedParts` explains a penalty that did not fire, and a full
  // sitting labelled with one would be an explanation of nothing.
  const scored = scoreSitting(bands(5), {
    monologueSeconds: 500,
    debateSeconds: 700,
    monologueWords: 400,
    debateWords: 300,
    phonologyHeard: true,
    examinerClosedEarly: true,
  });

  assert.equal(scored.absencePenalty, 0);
  assert.equal(scored.durationPenalty, 0);
  assert.deepEqual(scored.excusedParts, []);
  assert.equal(scored.score25, 25);
});

test("the excused débat never appears in absentParts or shortParts", () => {
  // The arrays explain charges. A part listed beside a penalty of 0 would send
  // the results page hunting for points nobody took — which is exactly the
  // corner `applyAbsentPartPenalty`'s `excused` filter exists to close.
  const excusedAbsent = applyAbsentPartPenalty(25, { monologueWords: 400, debateWords: 0 }, [
    "debate",
  ]);
  assert.deepEqual(excusedAbsent, { score25: 25, penalty: 0, absentParts: [] });

  const excusedShort = applySittingDurationPenalty(
    25,
    TOP_BANDS,
    { monologueSeconds: 500, debateSeconds: 60 },
    ["debate"],
  );
  assert.equal(excusedShort.penalty, 0);
  assert.deepEqual(excusedShort.shortParts, []);
  assert.deepEqual(excusedShort.charges, []);
  assert.equal(excusedShort.tiers.debate, "strong", "reported, not charged");
});

test("the two penalties always reconstruct the score, as the CHECK constraint asserts", () => {
  // `evaluations_score_25_check` is `score_25 = greatest(raw − absence −
  // duration, 0)`. It is written as a sum, while `scoreSitting` applies the two
  // in sequence; this is the sweep that says the two readings never disagree.
  for (const band of [0, 1, 3, 5] as const) {
    for (const debateWords of [0, 300]) {
      for (const monologueSeconds of [90, 400, 500]) {
        for (const examinerClosedEarly of [false, true]) {
          const scored = scoreSitting(bands(band), {
            monologueSeconds,
            debateSeconds: debateWords === 0 ? 0 : 700,
            monologueWords: 400,
            debateWords,
            phonologyHeard: true,
            examinerClosedEarly,
          });

          assert.equal(
            scored.score25,
            Math.max(scored.rawScore25 - scored.absencePenalty - scored.durationPenalty, 0),
            `band ${band}, débat ${debateWords} words, monologue ${monologueSeconds}s, ` +
              `examiner ${examinerClosedEarly ? "closed early" : "behaved"}`,
          );
        }
      }
    }
  }
});
