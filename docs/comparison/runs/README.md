# Recorded comparison runs

Evidence for [`docs/COMPARISON_REPORT.md`](../../COMPARISON_REPORT.md). Committed
rather than gitignored: a report whose numbers cannot be traced back to the calls
that produced them is an assertion, and #12 asked for the runs to be recorded.

Two shapes live here, and `pnpm compare:summarise` tells them apart by their
contents rather than their names:

| Pattern | Produced by | Contains |
| --- | --- | --- |
| `<iso-timestamp>.json` | `pnpm compare` | every correction both systems returned for every sitting, including the ones that failed |
| `live-<iso-timestamp>.json` | `pnpm measure:live` | one real Gemini Live session's `usageMetadata`, turn by turn |

Reproducing a run:

```bash
pnpm compare -- --repeats=2
```

That spends money on two accounts — this repository's `GEMINI_API_KEY` and the
reference checkout's `AI_GATEWAY_API_KEY` — so it is not part of any gate and is
never run in CI. `--skip-incumbent` runs this system alone and spends nothing on
the gateway.

The incumbent half needs the reference checkout on disk. It defaults to
`C:/Users/lenovo/Desktop/delf-audit`; point `INCUMBENT_REPO` elsewhere if yours
lives somewhere else. See `scripts/comparison/incumbent-runner.ts` for why that
corrector has to be invoked in its own tree rather than reimplemented in this one.

**A run file records what was returned, never what was concluded.** Failures are
kept with their error and how long they took to fail, and every measured number is
nullable so that "the API reported nothing" stays distinguishable from "zero".
