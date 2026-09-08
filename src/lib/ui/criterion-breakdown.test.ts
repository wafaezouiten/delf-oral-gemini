import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ORAL_CRITERIA } from "@/lib/delf/criteria";
import type { GrilleBand } from "@/lib/delf/grille";
import { scoreSitting, type DurationCharge } from "@/lib/delf/orale-rubric";
import { breakdownDeductions, scoreBreakdown } from "./criterion-breakdown";

const perfect: Record<string, GrilleBand> = {
  realisationTache: 5,
  interaction: 5,
  lexique: 5,
  morphosyntaxe: 5,
  phonologie: 5,
};

const shortMonologue = (from: GrilleBand, to: GrilleBand, seconds: number): DurationCharge => ({
  part: "monologue",
  criterion: "realisationTache",
  tier: seconds < 4 * 60 ? "strong" : "moderate",
  seconds,
  from,
  to,
  points: from - to,
});

/** What a reader adds up: the five figures actually printed on the rows. */
const printed = (lines: ReturnType<typeof scoreBreakdown>["lines"]) =>
  lines.reduce((sum, line) => sum + line.awarded, 0);

describe("the criteria and the mark, reconciled", () => {
  it("leaves a full sitting exactly as the corrector marked it", () => {
    const breakdown = scoreBreakdown({ criteria: perfect, score25: 25 });

    assert.deepEqual(
      breakdown.lines.map((line) => [line.criterion, line.earned, line.awarded, line.charged]),
      ORAL_CRITERIA.map((criterion) => [criterion, 5, 5, 0]),
    );
    assert.equal(breakdown.criteriaTotal, 25);
    assert.ok(breakdown.reconciles);
    assert.deepEqual(breakdownDeductions(breakdown), [], "nothing was taken, so nothing is listed");
  });

  it("prints every criterion, including ones the correction left out", () => {
    const breakdown = scoreBreakdown({ criteria: {}, score25: 0 });

    assert.equal(breakdown.lines.length, ORAL_CRITERIA.length);
    assert.ok(breakdown.lines.every((line) => line.earned === 0 && line.awarded === 0));
  });

  describe("a monologue that was never spoken (#203)", () => {
    // The report that opened the issue: the dev toggle submits the exposé
    // without a word of it, the rubric charges « réalisation de la tâche » two
    // bands, and the page showed 5 + 5 + 5 + 5 + 5 over a mark of 21.
    const empty = () =>
      scoreBreakdown({
        criteria: perfect,
        score25: 21,
        durationPenalty: 4,
        durationCharges: [shortMonologue(5, 1, 0)],
      });

    it("lowers the criterion the charge was priced off, and only that one", () => {
      const lines = empty().lines;
      const tache = lines.find((line) => line.criterion === "realisationTache")!;

      assert.deepEqual([tache.earned, tache.awarded, tache.charged], [5, 1, 4]);
      assert.ok(
        lines
          .filter((line) => line.criterion !== "realisationTache")
          .every((line) => line.charged === 0),
        "lexique, morphosyntaxe and phonologie are never touched by the clock",
      );
    });

    it("keeps the band the corrector's justification was written about", () => {
      // The whole reason the row shows « 5 → 1 » rather than « 1 »: the
      // paragraph inside the row praises an exposé, and #189 removed the charge
      // from the band precisely so the two could not contradict. Showing both is
      // what lets the sum work without the prose going wrong.
      assert.equal(empty().lines.find((line) => line.criterion === "realisationTache")!.earned, 5);
    });

    it("makes the five printed figures add to the mark", () => {
      const breakdown = empty();

      assert.equal(printed(breakdown.lines), 21);
      assert.equal(printed(breakdown.lines), breakdown.score25);
      assert.equal(breakdown.criteriaTotal, breakdown.score25);
      assert.ok(breakdown.reconciles);
      assert.deepEqual(breakdownDeductions(breakdown), [], "no line is left over to explain");
    });
  });

  it("charges both parts when both ran short", () => {
    const breakdown = scoreBreakdown({
      criteria: perfect,
      score25: 17,
      durationPenalty: 8,
      durationCharges: [
        shortMonologue(5, 1, 60),
        {
          part: "debate",
          criterion: "interaction",
          tier: "strong",
          seconds: 90,
          from: 5,
          to: 1,
          points: 4,
        },
      ],
    });

    assert.equal(printed(breakdown.lines), 17);
    assert.ok(breakdown.reconciles);
  });

  it("takes nothing off a criterion already at the bottom of the grille", () => {
    // `durationTier` still names the part short, but a 0 cannot step down, so
    // the charge is worth nothing and the row must not pretend otherwise.
    const criteria = { ...perfect, realisationTache: 0 as GrilleBand };
    const breakdown = scoreBreakdown({
      criteria,
      score25: 20,
      durationPenalty: 0,
      durationCharges: [shortMonologue(0, 0, 0)],
    });

    assert.equal(breakdown.lines.find((line) => line.criterion === "realisationTache")!.charged, 0);
    assert.equal(printed(breakdown.lines), 20);
    assert.ok(breakdown.reconciles);
  });
});

describe("the subtractions no band can carry", () => {
  it("lists the halving on its own line", () => {
    // Half a mark is not a band, so there is no set of five 0/1/3/5 figures
    // that adds to it. The rows stay whole and the halving is printed under
    // them.
    const breakdown = scoreBreakdown({ criteria: perfect, score25: 12, absencePenalty: 13 });

    assert.equal(breakdown.criteriaTotal, 25);
    assert.deepEqual(breakdownDeductions(breakdown), [
      { key: "absence", label: "Partie non réalisée", points: 13 },
    ]);
    assert.ok(breakdown.reconciles);
  });

  it("charges the surviving part while the halving keeps its own line", () => {
    const breakdown = scoreBreakdown({
      criteria: perfect,
      score25: 10,
      absencePenalty: 13,
      durationPenalty: 2,
      durationCharges: [shortMonologue(5, 3, 5 * 60)],
    });

    assert.equal(printed(breakdown.lines), 23, "the row carries the duration charge");
    assert.deepEqual(breakdownDeductions(breakdown), [
      { key: "absence", label: "Partie non réalisée", points: 13 },
    ]);
    assert.ok(breakdown.reconciles);
  });

  it("lists a penalty whose charges were never written down", () => {
    // A correction stored before #189: `duration_penalty` is a column and the
    // charges are not, so the points are real and unattributable. They belong
    // under the rows rather than nowhere.
    const breakdown = scoreBreakdown({ criteria: perfect, score25: 21, durationPenalty: 4 });

    assert.ok(
      breakdown.lines.every((line) => line.charged === 0),
      "nothing is guessed onto a row",
    );
    assert.deepEqual(breakdownDeductions(breakdown), [
      { key: "duration", label: "Durée de l'épreuve", points: 4 },
    ]);
    assert.ok(breakdown.reconciles);
  });
});

describe("charges that are not about this correction", () => {
  // `durationCharges` has no column: on a stored sitting the page rebuilds them
  // by re-running the rubric over the durations it can still see. When those are
  // not the durations the mark was graded on — the development time-skip is the
  // live example — the rebuilt charge is about a different sitting, and its
  // figures must not be written onto a row.
  const mismatched = () =>
    scoreBreakdown({
      criteria: perfect,
      score25: 23,
      durationPenalty: 2,
      durationCharges: [shortMonologue(5, 1, 0)],
    });

  it("refuses a charge that does not cost what was actually docked", () => {
    const breakdown = mismatched();

    assert.ok(breakdown.lines.every((line) => line.charged === 0));
    assert.equal(
      breakdown.unattributedDuration,
      2,
      "the stored column is believed, not the charge",
    );
  });

  it("still adds up, using the penalty the column recorded", () => {
    const breakdown = mismatched();

    assert.ok(breakdown.reconciles);
    assert.equal(breakdown.criteriaTotal - breakdown.unattributedDuration, breakdown.score25);
    assert.deepEqual(breakdownDeductions(breakdown), [
      { key: "duration", label: "Durée de l'épreuve", points: 2 },
    ]);
  });

  it("refuses a charge priced off a band this correction does not have", () => {
    const breakdown = scoreBreakdown({
      criteria: { ...perfect, realisationTache: 3 },
      score25: 19,
      durationPenalty: 4,
      durationCharges: [shortMonologue(5, 1, 0)],
    });

    assert.equal(breakdown.lines.find((line) => line.criterion === "realisationTache")!.awarded, 3);
    assert.equal(breakdown.unattributedDuration, 4);
  });

  it("says so, and shows the corrector's bands, when nothing can be made to add up", () => {
    const breakdown = scoreBreakdown({ criteria: perfect, score25: 23 });

    assert.equal(breakdown.reconciles, false);
    assert.ok(breakdown.lines.every((line) => line.charged === 0));
    assert.equal(breakdown.criteriaTotal, 25, "the rows are the corrector's, unedited");
  });
});

describe("what the rubric produces always reconciles", () => {
  // The sweep the whole module rests on: every mark this project can actually
  // produce is fed through `scoreSitting` and then through the breakdown, and
  // the figures the page would print have to reach the mark the rubric returned.
  const bands: GrilleBand[] = [0, 1, 3, 5];
  const durations = [0, 90, 5 * 60, 7 * 60, 11 * 60];

  it("holds over every band, duration and participation the rubric accepts", () => {
    let checked = 0;

    for (const band of bands) {
      for (const other of bands) {
        for (const monologueSeconds of durations) {
          for (const debateSeconds of durations) {
            for (const spoke of [true, false]) {
              const raw = {
                realisationTache: band,
                interaction: other,
                lexique: band,
                morphosyntaxe: other,
                phonologie: band,
              };
              const scored = scoreSitting(raw, {
                monologueSeconds,
                debateSeconds,
                monologueWords: spoke ? 200 : 0,
                debateWords: 200,
                phonologyHeard: true,
                examinerClosedEarly: false,
              });

              const breakdown = scoreBreakdown({
                criteria: scored.criteria,
                score25: scored.score25,
                durationPenalty: scored.durationPenalty,
                durationCharges: scored.durationCharges,
                absencePenalty: scored.absencePenalty,
              });

              assert.ok(
                breakdown.reconciles,
                `did not reconcile: bands ${band}/${other}, ${monologueSeconds}s + ${debateSeconds}s`,
              );

              const deducted = breakdownDeductions(breakdown).reduce(
                (sum, line) => sum + line.points,
                0,
              );
              assert.equal(
                Math.max(0, printed(breakdown.lines) - deducted),
                scored.score25,
                `figures did not reach the mark: bands ${band}/${other}, ${monologueSeconds}s + ${debateSeconds}s`,
              );

              // Every band printed is still one of the grille's four: the
              // adjustment is a step down its own ladder, never a subtraction
              // that could land between them.
              assert.ok(breakdown.lines.every((line) => bands.includes(line.awarded)));

              checked += 1;
            }
          }
        }
      }
    }

    assert.ok(checked > 100, `the sweep must actually sweep (checked ${checked})`);
  });

  it("never leaves a duration penalty unattributed on a fresh correction", () => {
    // The stored-row path can lose the charges; the path straight out of
    // `scoreSitting` cannot, and this is what says so. A regression here would
    // move a real charge off its criterion and into the footer without anyone
    // noticing the rows had stopped explaining it.
    const scored = scoreSitting(
      {
        realisationTache: 5,
        interaction: 5,
        lexique: 5,
        morphosyntaxe: 5,
        phonologie: 5,
      },
      {
        monologueSeconds: 0,
        debateSeconds: 11 * 60,
        monologueWords: 200,
        debateWords: 200,
        phonologyHeard: true,
        examinerClosedEarly: false,
      },
    );

    const breakdown = scoreBreakdown({
      criteria: scored.criteria,
      score25: scored.score25,
      durationPenalty: scored.durationPenalty,
      durationCharges: scored.durationCharges,
      absencePenalty: scored.absencePenalty,
    });

    assert.equal(breakdown.unattributedDuration, 0);
    assert.equal(printed(breakdown.lines), scored.score25);
  });
});
