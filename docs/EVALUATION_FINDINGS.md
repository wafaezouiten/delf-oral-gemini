# The /25 corrector, as measured

Reproduce with `pnpm verify:eval` (8 checks, all passing).

## What is verified

Three transcripts are graded through the real model: a strong B2 performance, a
weak one, and — the important one — an **uneven** performance with rich, well
defended argumentation carried by conspicuously broken grammar.

| Fixture | Score | réal. | inter. | lex. | morph. | phon. |
| --- | --- | --- | --- | --- | --- | --- |
| Strong | 25/25 | 5 | 5 | 5 | 5 | 5 |
| Mixed (ideas strong, grammar broken) | 23/25 | 5 | 5 | 5 | **3** | 5 |
| Weak | 5/25 | 1 | 1 | 1 | 1 | 1 |

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
- **The audio path works.** A 254 KB WAV uploads through the Files API and grades
  end to end, at roughly 15 s versus 11 s for text.

## What is NOT verified, and a calibration concern

**The corrector is generous, and this should be treated as unresolved.**

25/25 is a perfect score. 23/25 for a candidate producing *"les salariés ils
gagne"*, *"elles peut accéder"* and *"les jeunes qui commence, ils apprend"* —
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
