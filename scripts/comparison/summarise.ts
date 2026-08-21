/**
 * Turn a recorded run into the tables the report quotes (#12).
 *
 *   pnpm compare:summarise                     # the most recent run
 *   pnpm compare:summarise -- <path/to/run.json>
 *
 * Every number printed is read out of the run file or computed from it here.
 * Nothing is judged: "these two disagree by two bands" is arithmetic and belongs
 * here; "they disagree because the incumbent never sees the débat" is an argument
 * and belongs in `docs/COMPARISON_REPORT.md`, where it can be disputed.
 *
 * THE ONE JOIN THAT NEEDS DEFENDING. This system returns five criteria for a
 * sitting; the incumbent returns five criteria twice, once per tâche. To compare
 * criterion by criterion, the incumbent's ten numbers have to become five, and
 * the rule used is this system's own attribution (`evaluate.ts`, TASK_ATTRIBUTION):
 *
 *   realisationTache ← the incumbent's tâche 1 (the monologue)
 *   interaction      ← the incumbent's tâche 2 (the débat)
 *   lexique, morphosyntaxe, phonologie ← both, so both are shown
 *
 * That is a choice, and a generous one: it hands the incumbent the half of the
 * sitting where each pragmatic criterion is most likely to be earned. The
 * alternative — averaging the two corrections — would invent bands the grille has
 * no value for (the mean of 1 and 5 is 3, a legal-looking band nobody awarded).
 * Where the incumbent's two runs disagree on a shared criterion, the spread is
 * printed rather than resolved, because that spread is itself a finding.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  ELEVENLABS_AGENT_PER_MINUTE,
  GEMINI_3_6_FLASH,
  OPENAI_GPT_5_4,
  tokenCost,
  usd,
} from "./pricing";
import { billedOutputTokens } from "../../src/lib/gemini/evaluation-usage";
import type { IncumbentRecord, OurRecord, RunFile } from "./run-file";

const RUNS_DIR = resolve(import.meta.dirname, "../../docs/comparison/runs");

/**
 * The most recent COMPARISON run in the runs directory.
 *
 * The directory also holds `live-*.json` from `measure:live`, which is a
 * different measurement with a different shape. Selected by reading each file's
 * shape rather than by its name: sorting the names alphabetically put `live-…`
 * last, and the summariser confidently tried to draw grille tables from a
 * recording of a Live session.
 */
function latestRun(): string {
  const candidates = readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
  for (const file of candidates) {
    const path = join(RUNS_DIR, file);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed?.ours) && Array.isArray(parsed?.sittings)) return path;
    } catch {
      // Not JSON, or not a run file. Keep looking.
    }
  }
  throw new Error(`no comparison run file in ${RUNS_DIR}`);
}

// --------------------------------------------------------------- small stats

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Every distinct value across repeats, as `3` or `1/3` — never averaged. */
function bands(values: number[]): string {
  const distinct = [...new Set(values)].sort((a, b) => a - b);
  return distinct.join("/");
}

/** Whether repeats of the same correction agreed with each other. */
function stable(values: number[]): boolean {
  return new Set(values).size === 1;
}

// ------------------------------------------------------------------ the join

type Ok<T> = Extract<T, { ok: true }>;

function oursFor(run: RunFile, sittingId: string): Array<Ok<OurRecord>> {
  return run.ours.filter((r): r is Ok<OurRecord> => r.ok && r.sittingId === sittingId);
}

function incumbentFor(run: RunFile, sittingId: string, tache: number): Array<Ok<IncumbentRecord>> {
  return (run.incumbent?.results ?? []).filter(
    (r): r is Ok<IncumbentRecord> => r.ok && r.sittingId === sittingId && r.tache === tache,
  );
}

/** Which of the incumbent's corrections a criterion is read from. */
const ATTRIBUTION: Record<string, 1 | 2 | "both"> = {
  realisationTache: 1,
  interaction: 2,
  lexique: "both",
  morphosyntaxe: "both",
  phonologie: "both",
};

// ------------------------------------------------------------------- tables

function criterionTable(run: RunFile): string {
  const lines = [
    "| Sitting | Criterion | This system | Incumbent (t1 · monologue) | Incumbent (t2 · débat) | Δ |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const sitting of run.sittings) {
    const ours = oursFor(run, sitting.id);
    const t1 = incumbentFor(run, sitting.id, 1);
    const t2 = incumbentFor(run, sitting.id, 2);
    if (ours.length === 0) continue;

    for (const criterion of run.criteria) {
      const ourValues = ours.map((r) => r.criteria[criterion]);
      const t1Values = t1.map((r) => r.criteria[criterion]);
      const t2Values = t2.map((r) => r.criteria[criterion]);

      // The comparable incumbent value, per the attribution documented above.
      const source = ATTRIBUTION[criterion];
      const theirs = source === 1 ? t1Values : source === 2 ? t2Values : [...t1Values, ...t2Values];

      const delta =
        theirs.length === 0
          ? "—"
          : (() => {
              const d = mean(ourValues) - mean(theirs);
              return d === 0 ? "0" : `${d > 0 ? "+" : ""}${d.toFixed(1)}`;
            })();

      const mark = (values: number[], attributed: boolean) =>
        values.length === 0
          ? "—"
          : `${bands(values)}${attributed ? " ←" : ""}${stable(values) ? "" : " ~"}`;

      lines.push(
        `| ${sitting.id} | ${criterion} | ${bands(ourValues)}${stable(ourValues) ? "" : " ~"} ` +
          `| ${mark(t1Values, source === 1)} | ${mark(t2Values, source === 2)} | ${delta} |`,
      );
    }
  }

  lines.push("");
  lines.push(
    "`←` marks the correction the Δ is taken against. `~` marks a criterion whose repeats disagreed with each other, which is sampling rather than divergence. `a/b` lists every distinct band the repeats produced.",
  );
  return lines.join("\n");
}

function totalsTable(run: RunFile): string {
  const lines = [
    "| Sitting | Design | Ours /25 | Incumbent t1 /25 | Incumbent t2 /25 | Ours: penalty | Ours: floor |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const sitting of run.sittings) {
    const ours = oursFor(run, sitting.id);
    if (ours.length === 0) continue;
    const t1 = incumbentFor(run, sitting.id, 1);
    const t2 = incumbentFor(run, sitting.id, 2);
    const scores = (rs: Array<{ score25: number }>) =>
      rs.length === 0 ? "—" : bands(rs.map((r) => r.score25));
    lines.push(
      `| ${sitting.id} | ${sitting.weakCriterion ?? "control"} | ${scores(ours)} ` +
        `| ${scores(t1)} | ${scores(t2)} ` +
        `| ${bands(ours.map((r) => r.durationPenalty))}` +
        `${ours[0].shortParts.length ? ` (${ours[0].shortParts.join(", ")})` : ""} ` +
        `| ${ours.every((r) => r.meetsFloor) ? "clears" : "below"} |`,
    );
  }
  return lines.join("\n");
}

function costTable(run: RunFile): string {
  const ours = run.ours.filter((r): r is Ok<OurRecord> => r.ok);
  const theirs = (run.incumbent?.results ?? []).filter((r): r is Ok<IncumbentRecord> => r.ok);

  // `billedOutputTokens` adds the reasoning to the answer; see there for why
  // comparing bare `responseTokens` against the incumbent's `outputTokens` would
  // flatter this system by the larger part of its own bill.
  const ourCosts = ours.map((r) =>
    tokenCost(GEMINI_3_6_FLASH, {
      input: r.usage.promptTokens,
      output: billedOutputTokens(r.usage),
    }),
  );
  const theirCosts = theirs.map((r) =>
    tokenCost(OPENAI_GPT_5_4, { input: r.inputTokens, output: r.outputTokens }),
  );

  // A sitting costs ONE correction here and TWO over there. That is the unit the
  // report has to compare, so it is the unit computed.
  const sittingCount = run.sittings.length * run.repeats;
  const ourPerSitting = ourCosts.reduce((a, b) => a + b, 0) / Math.max(ours.length, 1);
  const theirPerSitting = (theirCosts.reduce((a, b) => a + b, 0) / Math.max(theirs.length, 1)) * 2;

  const row = (
    label: string,
    calls: number,
    latencies: number[],
    input: number,
    output: number,
    cost: number,
  ) =>
    `| ${label} | ${calls} | ${median(latencies).toFixed(1)}s | ${Math.max(...latencies).toFixed(1)}s ` +
    `| ${Math.round(input)} | ${Math.round(output)} | ${usd(cost)} |`;

  const lines = [
    "| Correction | Calls | Median latency | Slowest | Mean input tok | Mean output tok | Cost per sitting |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    row(
      "This system (1 call/sitting)",
      ours.length,
      ours.map((r) => r.latencySeconds),
      mean(ours.map((r) => r.usage.promptTokens ?? 0)),
      mean(ours.map((r) => billedOutputTokens(r.usage) ?? 0)),
      ourPerSitting,
    ),
  ];
  if (theirs.length > 0) {
    lines.push(
      row(
        "Incumbent (2 calls/sitting)",
        theirs.length,
        theirs.map((r) => r.latencySeconds),
        mean(theirs.map((r) => r.inputTokens ?? 0)),
        mean(theirs.map((r) => r.outputTokens ?? 0)),
        theirPerSitting,
      ),
    );
  }
  lines.push("");
  lines.push(
    `Latency is per call. A sitting on the incumbent waits for both of its corrections, so its wall-clock is the sum: median ${
      theirs.length ? (median(theirs.map((r) => r.latencySeconds)) * 2).toFixed(1) : "—"
    }s against ${median(ours.map((r) => r.latencySeconds)).toFixed(1)}s here.`,
  );
  lines.push("");
  lines.push(
    `Sample: ${sittingCount} sitting-runs. Rates: ${GEMINI_3_6_FLASH.source} and ${OPENAI_GPT_5_4.source}, read 2026-08-16. Token counts are measured; the price of a token is quoted.`,
  );
  return lines.join("\n");
}

function failureTable(run: RunFile): string {
  const ourFailures = run.ours.filter((r) => !r.ok);
  const theirFailures = (run.incumbent?.results ?? []).filter((r) => !r.ok);
  const total = run.ours.length + (run.incumbent?.results.length ?? 0);
  if (ourFailures.length + theirFailures.length === 0) {
    return `No correction failed: ${total}/${total} calls returned a parseable, legal grille score.`;
  }
  return [
    `${ourFailures.length + theirFailures.length} of ${total} calls failed.`,
    "",
    "| System | Sitting | Error | Failed after |",
    "| --- | --- | --- | --- |",
    ...ourFailures.map(
      (r) =>
        `| ours | ${r.sittingId} | ${"error" in r ? r.error.slice(0, 120) : ""} | ${r.latencySeconds.toFixed(1)}s |`,
    ),
    ...theirFailures.map(
      (r) =>
        `| incumbent t${r.tache} | ${r.sittingId} | ${"error" in r ? r.error.slice(0, 120) : ""} | ${r.latencySeconds.toFixed(1)}s |`,
    ),
  ].join("\n");
}

/** Repeats of the same correction that landed on different bands. */
function stabilityTable(run: RunFile): string {
  if (run.repeats < 2) return "Single run: nothing to say about stability.";
  const rows: string[] = [];
  for (const sitting of run.sittings) {
    for (const criterion of run.criteria) {
      const ourValues = oursFor(run, sitting.id).map((r) => r.criteria[criterion]);
      if (ourValues.length > 1 && !stable(ourValues)) {
        rows.push(`| ours | ${sitting.id} | ${criterion} | ${ourValues.join(" then ")} |`);
      }
      for (const tache of [1, 2] as const) {
        const values = incumbentFor(run, sitting.id, tache).map((r) => r.criteria[criterion]);
        if (values.length > 1 && !stable(values)) {
          rows.push(
            `| incumbent t${tache} | ${sitting.id} | ${criterion} | ${values.join(" then ")} |`,
          );
        }
      }
    }
  }
  if (rows.length === 0) {
    return `Every criterion returned the same band across all ${run.repeats} runs, in both systems.`;
  }
  return [
    `${rows.length} criterion-level readings moved between runs of the same correction. A divergence no larger than these is sampling, not disagreement.`,
    "",
    "| System | Sitting | Criterion | Bands across runs |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

// --------------------------------------------------------------------- main

function main() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const path = arg ? resolve(arg) : latestRun();
  const run: RunFile = JSON.parse(readFileSync(path, "utf8"));

  const out = [
    `<!-- generated by \`pnpm compare:summarise\` from ${path.split(/[\\/]/).pop()} -->`,
    "",
    `Run: ${run.startedAt} · commit \`${run.gitCommit.slice(0, 8)}\` · ${run.sittings.length} sittings × ${run.repeats} run(s)`,
    run.incumbent ? `Incumbent model: \`${run.incumbent.model}\`` : "Incumbent: not run.",
    "",
    "## Criterion by criterion",
    "",
    criterionTable(run),
    "",
    "## Totals, penalties and the floor",
    "",
    totalsTable(run),
    "",
    "## Cost and latency",
    "",
    costTable(run),
    "",
    `The conversation leg is not in this table. It is measured separately by \`pnpm measure:live\`; the incumbent's ElevenLabs agent is billed at ${usd(ELEVENLABS_AGENT_PER_MINUTE.typical)}/min and is **unmeasured** — ${ELEVENLABS_AGENT_PER_MINUTE.note}`,
    "",
    "## Failures",
    "",
    failureTable(run),
    "",
    "## Run-to-run stability",
    "",
    stabilityTable(run),
    "",
  ].join("\n");

  console.log(out);
}

main();
