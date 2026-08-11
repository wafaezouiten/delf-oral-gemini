# Does audio actually improve DELF evaluation?

## The question

Four of the five DELF grille criteria are legible in a transcript. One is not.

**Phonologie** — "la prononciation, l'intonation et le rythme sont clairs et
naturels ; l'écoute ne demande pas d'effort à l'interlocuteur" — is a claim about
sound. Grading it from text means grading something else and calling it
phonologie.

The reference implementation is candid about this in its own prompt. Its
instruction reads, in substance: you are working from a transcription, without
the sound; infer fluency from the number of fillers, false starts,
self-corrections and abandoned utterances. That is a reasonable proxy, and it is
still a proxy. It cannot distinguish:

- a candidate with a strong L1 accent but fluent, confident delivery, from
- a candidate with clean phonemes and a halting, effortful rhythm,

and those are genuinely different DELF profiles that deserve different bands.

## The hypothesis

Giving the evaluator the candidate's actual recording alongside the transcript
should:

1. **widen the spread** of phonologie bands across contrasting performances — the
   text evaluator's failure mode is scoring everything 3;
2. **change the justifications** from textual evidence ("beaucoup de « euh »") to
   acoustic evidence (specific sounds, stress placement, rhythm);
3. **leave the other four criteria roughly unchanged**, since they were already
   fully legible in the transcript. A large movement in lexique or morphosyntaxe
   would be a warning sign that the audio is changing the model's overall
   impression rather than informing one criterion.

Prediction 3 is the interesting one: it is the control. If audio moves everything
equally, the effect is a general leniency or severity shift, not better phonology
assessment.

## The harness

```bash
pnpm exp:audio
```

`experiments/audio-vs-text.ts` scores the same performance twice through
`evaluateExam` — once with `mode: "text"`, once with `mode: "audio"` — and prints
a per-criterion comparison, both phonologie justifications side by side, and the
spread of phonologie bands under each mode.

The two runs are identical except for the audio part and one paragraph of the
prompt (`phonologyInstruction`), so the comparison isolates the variable.
Temperature is pinned at 0.2 so the difference is the audio, not sampling.

Samples live in `experiments/samples/` as `<name>.wav` + `<name>.json` pairs.

## A caveat that has to be stated up front

**Use real learner speech.** Synthesised French is a weak substitute here,
because TTS does not reproduce the L2 phenomena phonologie is meant to measure:
L1 transfer, misplaced tonic stress, uncertain liaison, vowel approximations,
the particular rhythm of someone assembling a sentence while speaking it. An
experiment run on synthetic audio measures the synthesiser, not the grille, and
any conclusion drawn from it must be labelled as such.

Aim for contrast across at least three or four samples: a strong B2, a weak
B2 with heavy hesitation, and a candidate whose accent is strong but whose
delivery is fluent. That third one is the whole point — it is the case where text
and audio should disagree most.

## Results

**Not yet run.** This requires a `GEMINI_API_KEY` and recorded samples, neither
of which was available when the harness was written.

The table below is to be filled in from a real run. Nothing should be claimed
about Gemini's DELF scoring reliability until it is — a plausible-sounding
justification is not evidence that the band is right.

| Sample | Phonologie (text) | Phonologie (audio) | Other criteria moved? |
| --- | --- | --- | --- |
| _to be filled_ | | | |

### Interpreting it honestly

A wider audio spread is **necessary but not sufficient**. A model can also
produce more varied scores by being more random. Before concluding that audio
helps, read the justifications and check they describe something you can actually
hear in the recording. If the audio justification is generic ("la prononciation
est globalement claire") while the text one cited specific hesitations, the audio
run is *worse* despite a wider spread.
