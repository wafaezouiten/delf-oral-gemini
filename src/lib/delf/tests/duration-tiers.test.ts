/**
 * The duration matrix (#189): three tiers per part, charged to the criterion
 * that part is graded on, and the six combinations of them the issue names.
 *
 * Its own file rather than more of `orale-rubric.test.ts`, which is already the
 * longest suite here and is about the composition of every rule. This one is
 * about one rule and reads as a table — the issue's table, case by case, so
 * that a reader can check the code against the spec by scrolling.
 *
 * The band fixtures are deliberately uniform (every criterion on the same
 * band): what is under test is which criteria MOVE and by how much, and a
 * fixture whose five bands already differ makes an unchanged criterion
 * indistinguishable from a lucky coincidence.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ORAL_PARTS_B2 } from "../constants";
import { ORAL_CRITERIA } from "../criteria";
import {
  FULL_DEVELOPMENT_SECONDS,
  SHORT_DEVELOPMENT_SECONDS,
  durationTier,
  scoreSitting,
  sittingDurationTiers,
  type SittingScore,
} from "../orale-rubric";

/**
 * Comfortably inside each tier for BOTH parts, so no case is decided by a
 * boundary, and none by the two parts' different ceilings either. The
 * monologue's full-development time is its announced maximum (7 min) and the
 * debat's is the bottom of its own announced range (10 min), so `DEVELOPED`
 * clears the higher of the two and `HALF_WAY` is under the lower of them.
 */
const DEVELOPED = 11 * 60;
const HALF_WAY = 6 * 60;
const TWO_MINUTES = 2 * 60;

const bands = (value: number) =>
  Object.fromEntries(ORAL_CRITERIA.map((criterion) => [criterion, value])) as Record<
    (typeof ORAL_CRITERIA)[number],
    number
  >;

/** A candidate who spoke in both parts, so nothing here measures the halving. */
function score(
  monologueSeconds: number,
  debateSeconds: number,
  band: 0 | 1 | 3 | 5 = 5,
): SittingScore {
  return scoreSitting(bands(band), {
    monologueSeconds,
    debateSeconds,
    monologueWords: 400,
    debateWords: 300,
    phonologyHeard: true,
    examinerClosedEarly: false,
  });
}

describe("the three tiers", () => {
  it("is asked which part, because the ceiling is not the same for both", () => {
    // The user's correction to #189: the expose cannot run eight minutes, so
    // its full-development time is its own announced maximum. Pinned here as
    // the two numbers a reader needs before any other case makes sense.
    assert.equal(FULL_DEVELOPMENT_SECONDS.monologue, 7 * 60, "the expose's announced maximum");
    assert.equal(FULL_DEVELOPMENT_SECONDS.debate, 10 * 60, "the bottom of the débat's range");
    assert.equal(SHORT_DEVELOPMENT_SECONDS, 4 * 60, "the same floor for both");
  });

  it("puts a part at or over its own ceiling in the full tier", () => {
    assert.equal(durationTier("monologue", FULL_DEVELOPMENT_SECONDS.monologue), "full");
    assert.equal(durationTier("debate", FULL_DEVELOPMENT_SECONDS.debate), "full");
    assert.equal(durationTier("monologue", DEVELOPED), "full");
    assert.equal(durationTier("debate", 60 * 60), "full");
  });

  it("puts four minutes to that ceiling in the moderate tier", () => {
    assert.equal(durationTier("monologue", SHORT_DEVELOPMENT_SECONDS), "moderate");
    assert.equal(durationTier("debate", HALF_WAY), "moderate");
    assert.equal(durationTier("monologue", FULL_DEVELOPMENT_SECONDS.monologue - 1), "moderate");
    assert.equal(durationTier("debate", FULL_DEVELOPMENT_SECONDS.debate - 1), "moderate");
  });

  it("puts under four minutes in the strong tier", () => {
    assert.equal(durationTier("monologue", SHORT_DEVELOPMENT_SECONDS - 1), "strong");
    assert.equal(durationTier("debate", TWO_MINUTES), "strong");
    assert.equal(durationTier("monologue", 0), "strong");
  });

  it("answers `full` for a measurement that is not a number at all", () => {
    // The direction to fail in, pinned because nothing else states it. A NaN
    // reaching here means the app could not measure the recording; charging
    // two bands of « réalisation de la tâche » for that would bill the
    // candidate for the app's failure, which is the one thing every other
    // rule in this file refuses to do. `durationTier`'s negated comparison is
    // what makes it fall this way, so a "tidying" rewrite to `>=` fails here.
    assert.equal(durationTier("monologue", Number.NaN), "full");
    assert.equal(durationTier("debate", Number.NaN), "full");
  });

  it("reads both parts independently", () => {
    assert.deepEqual(sittingDurationTiers({ monologueSeconds: 600, debateSeconds: 60 }), {
      monologue: "full",
      debate: "strong",
    });
  });

  it("asks the exposé for no more than the épreuve itself asks of it", () => {
    // THE CORRECTION, pinned. #189 specified eight minutes for both parts;
    // `ORAL_PARTS_B2` announces the monologue as five to SEVEN, so under a
    // single 8-minute ceiling every candidate who did exactly what they were
    // told was charged a band of « réalisation de la tâche », with no length
    // available to them that would have avoided it. A rule nobody can satisfy
    // is not a rule about the candidate.
    //
    // So the exposé's ceiling IS its announced duration, read off the part
    // rather than copied beside it: this asserts they are the same number, and
    // fails if either moves without the other.
    const monologue = ORAL_PARTS_B2.find((part) => part.type === "monologue");
    const debate = ORAL_PARTS_B2.find((part) => part.type === "debat");

    assert.equal(monologue?.durationSeconds, 420, "the announced exposé, in seconds");
    assert.equal(FULL_DEVELOPMENT_SECONDS.monologue, monologue?.durationSeconds);
    assert.equal(durationTier("monologue", 420), "full", "and it is now a full development");

    // The débat is measured against the other edge of its own range. The spec
    // carries 780 s, the TOP of an announced ten to thirteen, and the user's
    // rule is that anywhere in that range is a débat fully carried out — so ten
    // is where the charge stops. Asking for the maximum would charge nearly
    // every real sitting, which is the mistake the monologue's eight minutes
    // made once already.
    assert.equal(debate?.durationSeconds, 780, "the announced débat, at its top");
    assert.equal(FULL_DEVELOPMENT_SECONDS.debate, 10 * 60);
    assert.ok(
      FULL_DEVELOPMENT_SECONDS.debate < (debate?.durationSeconds ?? 0),
      "the bottom of the range is below its top",
    );
    assert.equal(durationTier("debate", 10 * 60), "full", "ten minutes is enough");
    assert.equal(durationTier("debate", 780), "full", "and so is thirteen");
    assert.equal(durationTier("debate", 9 * 60), "moderate", "nine is not");
  });

  it("still charges an exposé that stops short of what it was asked for", () => {
    // The correction lifts the impossible case, not the rule. Five minutes is
    // inside the announced range and under the ceiling, so it stays « moderate »
    // — development insuffisant, which is what #189 asks that tier to mean.
    assert.equal(durationTier("monologue", 5 * 60), "moderate");
    assert.equal(durationTier("monologue", 419), "moderate", "one second short of the exposé");
  });
});

describe("where the penalty lands", () => {
  it("charges the monologue's shortfall to réalisation de la tâche", () => {
    const scored = score(TWO_MINUTES, DEVELOPED);

    assert.deepEqual(scored.durationCharges, [
      {
        part: "monologue",
        criterion: "realisationTache",
        tier: "strong",
        seconds: TWO_MINUTES,
        from: 5,
        to: 1,
        points: 4,
      },
    ]);
  });

  it("charges the débat's shortfall to interaction", () => {
    const scored = score(DEVELOPED, TWO_MINUTES);

    assert.deepEqual(
      scored.durationCharges.map((charge) => [charge.part, charge.criterion]),
      [["debate", "interaction"]],
    );
  });

  it("never charges lexique, morphosyntaxe or phonologie", () => {
    // #189 §3, and the reason the rule was rewritten at all: the flat −3 came
    // off the /25, which is to say off all five criteria at once. A candidate
    // whose French is precise must not pay for a short épreuve out of the three
    // criteria the clock says nothing about.
    const scored = score(TWO_MINUTES, TWO_MINUTES);
    const charged = scored.durationCharges.map((charge) => charge.criterion);

    for (const criterion of ["lexique", "morphosyntaxe", "phonologie"] as const) {
      assert.ok(!charged.includes(criterion), `${criterion} was charged for the clock`);
    }
    assert.equal(scored.durationPenalty, 8, "4 + 4, and no more");
    assert.equal(scored.score25, 17, "the three language criteria keep their 15");
  });

  it("leaves the five bands the candidate reads exactly as the corrector set them", () => {
    // The charge is PRICED from the bands, never written back onto them. Each
    // band is printed beside the corrector's own justification of it, and a
    // « réalisation de la tâche » quietly rewritten from 5 to 1 under a
    // paragraph praising the exposé is a page that contradicts itself.
    const scored = score(TWO_MINUTES, TWO_MINUTES);

    assert.deepEqual(scored.criteria, bands(5));
    assert.equal(scored.rawScore25, 25);
  });

  it("takes less from a weak candidate than from a strong one, for the same silence", () => {
    // The property that makes "duration alone must NEVER determine the entire
    // score" true by construction rather than by a clamp: the charge is a step
    // down a ladder, so it is bounded by what the criterion was worth.
    assert.equal(score(TWO_MINUTES, TWO_MINUTES, 5).durationPenalty, 8, "5 → 1, twice");
    assert.equal(score(TWO_MINUTES, TWO_MINUTES, 3).durationPenalty, 6, "3 → 0, twice");
    assert.equal(score(TWO_MINUTES, TWO_MINUTES, 1).durationPenalty, 2, "1 → 0, twice");
    assert.equal(score(TWO_MINUTES, TWO_MINUTES, 0).durationPenalty, 0, "nothing left to take");
  });

  it("never drives a mark to zero on the clock alone", () => {
    // Explicitly promised by #189: « speaking for less than 4 or 8 minutes does
    // not automatically mean 0/25 ». The worst case is two minutes of each part
    // from a candidate the corrector scored perfect.
    const worst = score(0, 0, 5);

    assert.ok(worst.score25 > 0);
    assert.equal(worst.score25, 17);
    assert.ok(worst.meetsFloor, "and it still clears the ≥ 5/25 competency floor");
  });
});

describe("the combined cases, as #189 tabulates them", () => {
  const cases: Array<{
    name: string;
    monologue: number;
    debate: number;
    penalty: number;
    charged: Array<"realisationTache" | "interaction">;
  }> = [
    {
      name: "monologue ≥ 8 min, débat ≥ 8 min — no duration penalty",
      monologue: DEVELOPED,
      debate: DEVELOPED,
      penalty: 0,
      charged: [],
    },
    {
      name: "monologue 4–8 min, débat 4–8 min — both moderate",
      monologue: HALF_WAY,
      debate: HALF_WAY,
      penalty: 4,
      charged: ["realisationTache", "interaction"],
    },
    {
      name: "monologue < 4 min, débat < 4 min — strong overall",
      monologue: TWO_MINUTES,
      debate: TWO_MINUTES,
      penalty: 8,
      charged: ["realisationTache", "interaction"],
    },
    {
      name: "monologue < 4 min, débat 4–8 min — strong monologue, moderate débat",
      monologue: TWO_MINUTES,
      debate: HALF_WAY,
      penalty: 6,
      charged: ["realisationTache", "interaction"],
    },
    {
      name: "monologue < 4 min, débat ≥ 8 min — the monologue alone",
      monologue: TWO_MINUTES,
      debate: DEVELOPED,
      penalty: 4,
      charged: ["realisationTache"],
    },
    {
      name: "monologue 4–8 min, débat < 4 min — the débat carries the strong charge",
      monologue: HALF_WAY,
      debate: TWO_MINUTES,
      penalty: 6,
      charged: ["realisationTache", "interaction"],
    },
    {
      name: "monologue ≥ 8 min, débat < 4 min — the débat alone",
      monologue: DEVELOPED,
      debate: TWO_MINUTES,
      penalty: 4,
      charged: ["interaction"],
    },
  ];

  for (const one of cases) {
    it(one.name, () => {
      const scored = score(one.monologue, one.debate);

      assert.equal(scored.durationPenalty, one.penalty);
      assert.deepEqual(
        scored.durationCharges.map((charge) => charge.criterion),
        one.charged,
      );
      assert.equal(scored.score25, 25 - one.penalty);
    });
  }

  it("reports both tiers even where only one was charged", () => {
    const scored = score(DEVELOPED, TWO_MINUTES);

    assert.deepEqual(scored.durationTiers, { monologue: "full", debate: "strong" });
    assert.deepEqual(scored.shortParts, ["debate"]);
  });
});

describe("a part with no speech in it is not a short part", () => {
  it("is halved rather than charged a tier, and the other part is charged normally", () => {
    // #189 lists « no speech » outside the three tiers, and answers it « score
    // only what was actually demonstrated ». Here that is the halving (#71),
    // which is charged in WORDS out of the transcript — a rule about whether
    // the candidate was in the part at all, where the tiers are about how much
    // of it they filled.
    const scored = scoreSitting(bands(5), {
      monologueSeconds: HALF_WAY,
      debateSeconds: 30,
      monologueWords: 400,
      debateWords: 0,
      phonologyHeard: true,
      examinerClosedEarly: false,
    });

    assert.deepEqual(scored.absentParts, ["debate"]);
    assert.deepEqual(scored.shortParts, ["monologue"], "the débat is not charged twice");
    assert.equal(scored.durationPenalty, 2, "moderate: réalisation de la tâche 5 → 3");
    assert.equal(scored.score25, 10, "25 → 12 → 10");
  });
});
