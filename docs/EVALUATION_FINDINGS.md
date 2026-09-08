# The /25 corrector, as measured

Reproduce with `pnpm verify:eval` (11 checks, all passing).

## What is verified

Three transcripts are graded through the real model: a strong B2 performance, a
weak one, and — the important one — an **uneven** performance with rich, well
defended argumentation carried by conspicuously broken grammar.

| Fixture                              | Score | réal. | inter. | lex. | morph. | phon. |
| ------------------------------------ | ----- | ----- | ------ | ---- | ------ | ----- |
| Strong                               | 25/25 | 5     | 5      | 5    | 5      | 5     |
| Mixed (ideas strong, grammar broken) | 23/25 | 5     | 5      | 5    | **3**  | 5     |
| Weak                                 | 5/25  | 1     | 1      | 1    | 1      | 1     |

Confirmed by this:

- **Every criterion lands on a legal band.** No 2s or 4s reach a stored score.
- **The /25 is ours, not the model's.** We recompute it from the snapped bands;
  the model's own total is captured for comparison and otherwise discarded.
- **It discriminates.** A 20-point gap between the strong and weak fixtures.
- **Criteria are scored independently.** This is what the mixed fixture is for.
  A corrector that forms one global impression and stamps it across all five
  would score it uniformly; instead morphosyntaxe alone dropped to 3 while
  argumentation stayed at 5. Without that case, "strong scores high, weak scores
  low" would be equally consistent with the model just measuring overall vibe.
- **The audio path works.** A 267 KB WAV uploads through the Files API and grades
  end to end, at roughly 28 s versus 13 s for text.
- **The duration rule is the rubric's, and it is applied.** The same strong
  transcript graded over a 40-second débat comes back docked: penalty 3, short
  part named `debate` against its 312 s floor, `25 − 3 = 22/25`. The model is
  never told the rule — it returns five bands and prose — so this is the
  evaluation layer's arithmetic being observed end to end, not an instruction
  being followed.

## Where the rules live, since Phase 7

Two implementations of the grading rules used to disagree on `develop`, and the
disagreement changed grades: one snapped a model's 2 down to 1 where the other
clamped it to 2, one docked 5 or 3 where the other docked a flat 3, and one
measured the shortfall against an 8-minute sitting total where the port measures
each part against its own floor. `rubric.ts` is deleted. What survives is the
port:

| Rule                                                                 | Lives in               |
| -------------------------------------------------------------------- | ---------------------- |
| The five criteria, their prose, the band scale, the evaluation rules | `delf/criteria.ts`     |
| The bands 0/1/3/5, their labels, snapping a raw number onto one      | `delf/grille.ts`       |
| The /25 ceiling, the ≥ 5/25 floor, the per-part duration floors      | `delf/constants.ts`    |
| The sum, the penalty, the floor test, and the order they happen in   | `delf/orale-rubric.ts` |

The evaluator calls `scoreSitting` and nothing else. That matters more than it
looks: the order — snap, sum, dock, then test the floor — is itself a rule. Test
the floor before the penalty and a candidate the rubric has just failed comes
back passed.

**The one decision the port could not make.** The reference implementation
corrects one task per correction, so a per-part floor needs no composition over
there. Here both tasks are one sitting and one mark, and the rule fires **once,
if either part is short**, for a flat −3. Docking per short part would invent a
−6 that no correction in the incumbent can produce; measuring the total against
the sum of the floors (480 s) would pass a candidate who talks for eight minutes
in the monologue and says nothing in the débat, which is exactly the shortfall
the rule exists to catch.

**The penalty on the record is the nominal one.** `applyDurationPenalty` now
returns what it asked for alongside the adjusted score, so a 2/25 docked 3 stores
a penalty of 3 and a score of 0 — "the rubric wanted 3, the score could absorb 2".
Rows written before this record the smaller figure, and only below 3/25.

## What the model is no longer asked

The corrector's prompt states the band scale and stops. It does not restate the
sum, the duration penalty or the competency floor, because a prompt that did
would be a second implementation of the rubric written in French, unversioned and
untestable. And the reply is now checked rather than read: the evaluator used to
take scores with `Number(entry?.score ?? 0)`, so a response missing `phonologie`
— a truncated generation, a refusal, a schema quietly ignored — scored that
criterion 0 and graded the candidate anyway. A breach of the contract throws
(`gemini/evaluation-response.ts`), and the caller can retry.

A 2 or a 4 is deliberately _not_ a breach. The grille has no such band and the
prompt forbids it, but `snapToBand` is the ported net underneath exactly that
mistake, and failing a whole sitting over a band the rubric knows how to read
would throw away a correction for nothing.

## What is NOT verified, and a calibration concern

**The corrector is generous, and this should be treated as unresolved.**

25/25 is a perfect score. 23/25 for a candidate producing _"les salariés ils
gagne"_, _"elles peut accéder"_ and _"les jeunes qui commence, ils apprend"_ —
pervasive subject-verb agreement failure across every single turn — is defensible
under the band scale (3 = "au niveau B2 with limitations") but sits at the very
top of plausible. A real examiner might well give 1 there.

Two things push in this direction, and both were deliberate choices worth
revisiting:

1. The prompt tells the model to use the whole scale and not to default to 3,
   because the opposite failure — everything scores 3 and the report says nothing
   — is the more common and more useless one.
2. The default model is `gemini-3.6-flash`, chosen because `gemini-3.1-pro` has a
   free-tier quota of zero. A pro model is very likely a stricter and better
   corrector. Set `GEMINI_EVAL_MODEL` on a billed key.

**Nothing here validates the scores against human DELF examiners.** The fixtures
establish that the pipeline is sound, legal and discriminating. They do not
establish that a 23 from this corrector means what a 23 from France Éducation
international means. Doing that needs real candidate performances with official
marks, and until someone runs that comparison the scores should be presented to
learners as indicative feedback, not as a predicted exam result.

That is also why `evaluations` is its own table with a `mode`, a `model` and a
`promptVersion` column: re-scoring the same exam under a different corrector has
to be possible, or calibration can never be measured at all.

## Model availability, the hard way

Two failures worth remembering, both from guessing model ids:

- `gemini-3-pro-preview` → **404, already retired.**
- `gemini-3.1-pro-preview` → exists, but **free-tier quota is 0**, so it 429s on
  the first call rather than degrading.

`pnpm models` lists what the configured key can actually reach. Use it instead of
guessing when these shift again, which they will.
