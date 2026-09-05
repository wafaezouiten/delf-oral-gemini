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

/** Comfortably inside each tier, so no case is decided by a boundary. */
const EIGHT_MINUTES = 9 * 60;
const SIX_MINUTES = 6 * 60;
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
  it("puts eight minutes and over in the full tier", () => {
    assert.equal(durationTier(FULL_DEVELOPMENT_SECONDS), "full");
    assert.equal(durationTier(EIGHT_MINUTES), "full");
    assert.equal(durationTier(60 * 60), "full");
  });

  it("puts four to eight minutes in the moderate tier", () => {
    assert.equal(durationTier(SHORT_DEVELOPMENT_SECONDS), "moderate");
    assert.equal(durationTier(SIX_MINUTES), "moderate");
    assert.equal(durationTier(FULL_DEVELOPMENT_SECONDS - 1), "moderate");
  });

  it("puts under four minutes in the strong tier", () => {
    assert.equal(durationTier(SHORT_DEVELOPMENT_SECONDS - 1), "strong");
    assert.equal(durationTier(TWO_MINUTES), "strong");
    assert.equal(durationTier(0), "strong");
  });

  it("reads both parts independently", () => {
    assert.deepEqual(sittingDurationTiers({ monologueSeconds: 600, debateSeconds: 60 }), {
      monologue: "full",
      debate: "strong",
    });
  });

  it("puts the épreuve's OWN announced monologue one tier short of full", () => {
    // Surfaced here rather than left implicit. Every other fixture in this
    // repository that is about some other rule was moved past
    // `FULL_DEVELOPMENT_SECONDS` so it measures one rule at a time, which is
    // right for those tests and would leave nothing in the suite stating the
    // thing a reader most needs to know: #189's thresholds are absolute, and
    // the exam's own are not the same numbers.
    //
    // `ORAL_PARTS_B2` announces the monologue to the candidate as 5 to 7
    // minutes and the débat as 10 to 13. So a candidate who does exactly what
    // the épreuve asks of them is charged one band of « réalisation de la
    // tâche » for the exposé, and nothing for the débat. That asymmetry is the
    // open question on #189, and it is asserted AS IT STANDS: changing either
    // constant to follow the announced duration fails this test, which is the
    // point. It should be a decision, not a drift.
    const monologue = ORAL_PARTS_B2.find((part) => part.type === "monologue");
    const debate = ORAL_PARTS_B2.find((part) => part.type === "debat");

    assert.equal(monologue?.durationSeconds, 420, "the announced exposé, in seconds");
    assert.equal(durationTier(420), "moderate", "and it is not a full development");

    assert.equal(debate?.durationSeconds, 780, "the announced débat");
    assert.equal(durationTier(780), "full", "which the same threshold does clear");
  });
});

describe("where the penalty lands", () => {
  it("charges the monologue's shortfall to réalisation de la tâche", () => {
    const scored = score(TWO_MINUTES, EIGHT_MINUTES);

    assert.deepEqual(scored.durationCharges, [
      {
        part: "monologue",
        criterion: "realisationTache",
        tier: "strong",
        from: 5,
        to: 1,
        points: 4,
      },
    ]);
  });

  it("charges the débat's shortfall to interaction", () => {
    const scored = score(EIGHT_MINUTES, TWO_MINUTES);

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
      monologue: EIGHT_MINUTES,
      debate: EIGHT_MINUTES,
      penalty: 0,
      charged: [],
    },
    {
      name: "monologue 4–8 min, débat 4–8 min — both moderate",
      monologue: SIX_MINUTES,
      debate: SIX_MINUTES,
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
      debate: SIX_MINUTES,
      penalty: 6,
      charged: ["realisationTache", "interaction"],
    },
    {
      name: "monologue < 4 min, débat ≥ 8 min — the monologue alone",
      monologue: TWO_MINUTES,
      debate: EIGHT_MINUTES,
      penalty: 4,
      charged: ["realisationTache"],
    },
    {
      name: "monologue 4–8 min, débat < 4 min — the débat carries the strong charge",
      monologue: SIX_MINUTES,
      debate: TWO_MINUTES,
      penalty: 6,
      charged: ["realisationTache", "interaction"],
    },
    {
      name: "monologue ≥ 8 min, débat < 4 min — the débat alone",
      monologue: EIGHT_MINUTES,
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
    const scored = score(EIGHT_MINUTES, TWO_MINUTES);

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
      monologueSeconds: SIX_MINUTES,
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
