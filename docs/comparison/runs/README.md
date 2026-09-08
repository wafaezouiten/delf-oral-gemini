# Recorded comparison runs

Evidence for [`docs/COMPARISON_REPORT.md`](../../COMPARISON_REPORT.md). Committed
rather than gitignored: a report whose numbers cannot be traced back to the calls
that produced them is an assertion, and #12 asked for the runs to be recorded.

Two shapes live here, and `pnpm compare:summarise` tells them apart by their
contents rather than their names:

| Pattern                     | Produced by         | Contains                                                                                                                                                                                                                                             |
| --------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<iso-timestamp>.json`      | `pnpm compare`      | every correction both systems returned for every sitting, including the ones that failed                                                                                                                                                             |
| `live-<iso-timestamp>.json` | `pnpm measure:live` | one real Gemini Live session's `usageMetadata`, turn by turn, plus per-turn reply latency (#100): `turnLatencies`, the `vadSilenceDurationMs` the session was opened with, and `derived.medianFirstAudioChunkMs` / `derived.medianModelAndNetworkMs` |

Reproducing a run:

```bash
INCUMBENT_REPO=/path/to/delf-audit pnpm compare -- --repeats=2
```

`INCUMBENT_REPO` is the reference checkout (`delf-preps`) on disk. It is required
and has no default — there is no path that is correct on more than one machine,
and a default that resolves on exactly one laptop fails confusingly everywhere
else. See `scripts/comparison/incumbent-runner.ts` for why that corrector has to
be invoked in its own tree rather than reimplemented in this one.

A run spends money on two accounts — this repository's `GEMINI_API_KEY` and the
reference checkout's `AI_GATEWAY_API_KEY` — so it is not part of any gate and is
never run in CI. `--skip-incumbent` runs this system alone: it needs no
`INCUMBENT_REPO` and spends nothing on the gateway.

The child process that runs the incumbent's corrector is given only the
environment variables Node needs to start, never this repository's. It reads the
incumbent's own `.env.local` and has no business seeing our keys.

**A run file records what was returned, never what was concluded.** Failures are
kept with their error and how long they took to fail, and every measured number is
nullable so that "the API reported nothing" stays distinguishable from "zero".
