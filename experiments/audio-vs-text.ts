/**
 * §20 — Does real audio improve DELF evaluation, particularly phonologie?
 *
 * The reference implementation grades phonologie from a transcript. Its own
 * prompt admits the problem: it tells the model to infer fluency from the number
 * of "euh"s, because it has no sound. That is a proxy, not a measurement — it
 * cannot tell a candidate with a strong accent but fluent delivery from one with
 * clean phonemes and a halting rhythm, and those are different DELF profiles.
 *
 * This harness scores the SAME performance twice — transcript only, then
 * transcript plus the candidate's recording — and prints the difference.
 *
 *   pnpm exp:audio                 # every sample in experiments/samples
 *   pnpm exp:audio -- --sample x   # one sample
 *
 * A sample is a pair of files in experiments/samples/:
 *   <name>.wav   the candidate's audio
 *   <name>.json  { "topicSlug": "...", "transcript": [ ...TranscriptEntry ] }
 *
 * Record real learner speech if you possibly can. Synthetic speech is a weak
 * substitute here: TTS does not reproduce the L2 phenomena — transfer errors,
 * misplaced stress, uncertain liaison — that phonologie is supposed to measure,
 * so a result derived from it says more about the synthesiser than about the
 * grille. Any conclusion drawn from synthetic input must be labelled as such.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";

config({ path: ".env.local" });

import { ORAL_CRITERIA, type OralCriterion } from "../src/lib/delf/criteria";
import { findTopic } from "../src/lib/delf/topics";
import type { TranscriptEntry } from "../src/lib/delf/transcript";
import { evaluateExam, type EvaluationResult } from "../src/lib/gemini/evaluate";

const SAMPLES_DIR = path.join(process.cwd(), "experiments", "samples");
const RESULTS_FILE = path.join(process.cwd(), "experiments", "results.json");

interface SampleMeta {
  topicSlug: string;
  transcript: TranscriptEntry[];
  monologueSeconds?: number;
  debateSeconds?: number;
  /** Free-text note: who recorded it, real or synthetic, expected level. */
  note?: string;
}

interface Comparison {
  sample: string;
  note?: string;
  text: EvaluationResult;
  audio: EvaluationResult;
}

async function loadSamples(only?: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(SAMPLES_DIR);
  } catch {
    console.error(
      `No samples directory. Create ${SAMPLES_DIR} and add <name>.wav + <name>.json pairs.`,
    );
    process.exit(1);
  }
  const names = entries
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""))
    .filter((name) => !only || name === only);

  if (names.length === 0) {
    console.error(only ? `No sample named "${only}".` : "No samples found.");
    process.exit(1);
  }
  return names.sort();
}

async function evaluateBothWays(name: string): Promise<Comparison> {
  const meta = JSON.parse(
    await readFile(path.join(SAMPLES_DIR, `${name}.json`), "utf8"),
  ) as SampleMeta;

  const topic = findTopic(meta.topicSlug);
  if (!topic) throw new Error(`Sample "${name}" references unknown topic "${meta.topicSlug}"`);

  const wav = await readFile(path.join(SAMPLES_DIR, `${name}.wav`));
  const audio = new Blob([new Uint8Array(wav)], { type: "audio/wav" });

  const shared = {
    topic,
    transcript: meta.transcript,
    monologueSeconds: meta.monologueSeconds ?? 360,
    debateSeconds: meta.debateSeconds ?? 600,
  };

  console.log(`\n  ${name} — grading from the transcript alone…`);
  const textResult = await evaluateExam({ ...shared, mode: "text" });

  console.log(`  ${name} — grading from the audio…`);
  const audioResult = await evaluateExam({ ...shared, mode: "audio", audio });

  return { sample: name, note: meta.note, text: textResult, audio: audioResult };
}

function table(comparisons: Comparison[]): void {
  const pad = (value: string, width: number) => value.padEnd(width);

  console.log("\n\nPER-CRITERION SCORES  (text -> audio)\n");
  console.log(
    `  ${pad("sample", 20)}${ORAL_CRITERIA.map((c) => pad(c.slice(0, 12), 14)).join("")}total`,
  );

  for (const c of comparisons) {
    const cells = ORAL_CRITERIA.map((key: OralCriterion) => {
      const before = c.text.criteria[key];
      const after = c.audio.criteria[key];
      const arrow = before === after ? "=" : "->";
      return pad(before === after ? `${before} ${arrow}` : `${before} ${arrow} ${after}`, 14);
    }).join("");
    console.log(
      `  ${pad(c.sample.slice(0, 19), 20)}${cells}${c.text.score25} -> ${c.audio.score25}`,
    );
  }

  console.log("\n\nPHONOLOGIE — the criterion the experiment is actually about\n");
  for (const c of comparisons) {
    console.log(`  ${c.sample}${c.note ? `  (${c.note})` : ""}`);
    console.log(`    text  ${c.text.criteria.phonologie}/5 — ${c.text.feedback.justifications.phonologie}`);
    console.log(`    audio ${c.audio.criteria.phonologie}/5 — ${c.audio.feedback.justifications.phonologie}`);
    console.log(
      `    latency: ${c.text.latencySeconds.toFixed(1)}s text vs ${c.audio.latencySeconds.toFixed(1)}s audio\n`,
    );
  }

  const moved = comparisons.filter(
    (c) => c.text.criteria.phonologie !== c.audio.criteria.phonologie,
  );
  const spread = (values: number[]) =>
    values.length < 2 ? 0 : Math.max(...values) - Math.min(...values);

  console.log("SUMMARY\n");
  console.log(`  samples:                      ${comparisons.length}`);
  console.log(`  phonologie band changed:      ${moved.length}/${comparisons.length}`);
  console.log(
    `  phonologie spread, text:      ${spread(comparisons.map((c) => c.text.criteria.phonologie))}`,
  );
  console.log(
    `  phonologie spread, audio:     ${spread(comparisons.map((c) => c.audio.criteria.phonologie))}`,
  );
  console.log(
    "\n  A WIDER spread under audio means the audio evaluator discriminates between",
  );
  console.log("  performances that the text evaluator scored identically. A wider spread is");
  console.log("  necessary evidence, not sufficient: read the justifications and check they");
  console.log("  describe what you can actually hear.\n");
}

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set. Add it to .env.local.");
    process.exit(1);
  }

  const onlyIndex = process.argv.indexOf("--sample");
  const only = onlyIndex === -1 ? undefined : process.argv[onlyIndex + 1];

  const names = await loadSamples(only);
  console.log(`Comparing text-only and audio-aware evaluation on ${names.length} sample(s).`);

  const comparisons: Comparison[] = [];
  for (const name of names) {
    try {
      comparisons.push(await evaluateBothWays(name));
    } catch (error) {
      console.error(`  ${name} FAILED: ${String(error)}`);
    }
  }

  if (comparisons.length === 0) {
    console.error("\nEvery sample failed. Nothing to compare.");
    process.exit(1);
  }

  table(comparisons);

  await writeFile(RESULTS_FILE, JSON.stringify(comparisons, null, 2), "utf8");
  console.log(`Full results written to ${RESULTS_FILE}\n`);
}

void main();
