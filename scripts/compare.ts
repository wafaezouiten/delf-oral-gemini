/**
 * Grade the same sittings with both systems and record what each returned (#12).
 *
 *   pnpm compare                      # every sitting, one run each
 *   pnpm compare -- --repeats=2       # twice, so disagreement can be told from sampling
 *   pnpm compare -- --only=hors-sujet
 *   pnpm compare -- --skip-incumbent  # this system alone, no gateway spend
 *
 * WHAT IT MEASURES, AND WHAT IT CANNOT.
 *
 * Each sitting is put through each system **in that system's own unit**: one
 * correction here over the whole épreuve, two corrections over there (tâche 1 on
 * the monologue, tâche 2 on the débat), which is how a candidate on the incumbent
 * would actually sit a full B2 oral. Anything else would be a comparison of
 * harnesses. See `comparison/sittings.ts` for why the corpus is written rather
 * than borrowed.
 *
 * Both corrections are TEXT-mode. This system's audio phonology — the audit's
 * deliberate departure — cannot appear in a per-criterion comparison, because the
 * corpus is written transcripts and there is no recording of a candidate who does
 * not exist. Synthesising one would measure a text-to-speech engine's accent.
 * That departure is argued in the report from `docs/AUDIO_EVALUATION.md`, and the
 * numbers here are explicitly the text-versus-text half of the question.
 *
 * The output is a JSON run file under `docs/comparison/runs/`. `summarise.ts`
 * turns one into the tables the report quotes; nothing is interpreted here.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ORAL_CRITERIA } from "../src/lib/delf/criteria";
import { findTopic } from "../src/lib/delf/topics";
import { evaluateExam } from "../src/lib/gemini/evaluate";
import { SITTINGS, asIncumbentMessages, type SittingProfile } from "./comparison/sittings";
import type { RunFile, OurRecord, IncumbentRecord } from "./comparison/run-file";

/**
 * Where the reference checkout lives. Required, with no default: it is not in
 * this repository and there is no path that is right on more than one machine.
 * Demanded only when the incumbent is actually going to run, so `--skip-incumbent`
 * needs nothing.
 */
function incumbentRepo(): string {
  const configured = process.env.INCUMBENT_REPO;
  if (!configured) {
    throw new Error(
      "INCUMBENT_REPO is not set. Point it at the reference checkout (delf-preps) to grade\n" +
        "with the incumbent's corrector, e.g.\n\n" +
        "  INCUMBENT_REPO=/path/to/delf-audit pnpm compare\n\n" +
        "Or run `pnpm compare -- --skip-incumbent` to grade with this system alone.",
    );
  }
  return configured;
}

/**
 * The environment the foreign runner gets: what a Node process needs to start on
 * this platform, and nothing else.
 *
 * NOT `...process.env`. That would hand this repository's `GEMINI_API_KEY`,
 * `CLERK_SECRET_KEY` and `DATABASE_URL` to a script executing inside a different
 * repository — for no reason, since the runner loads the incumbent's own
 * `.env.local` and needs none of ours.
 */
const CHILD_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "windir",
  "COMSPEC",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
  "NUMBER_OF_PROCESSORS",
];

/** Windows does not agree with itself about the case of `PATH`, so match loosely. */
function childEnv(): NodeJS.ProcessEnv {
  const wanted = new Set(CHILD_ENV_KEYS.map((key) => key.toLowerCase()));
  const env: NodeJS.ProcessEnv = {
    // Carried explicitly rather than by the loop below: Next augments
    // `ProcessEnv` to require it, and pnpm and tsx both branch on it.
    NODE_ENV: process.env.NODE_ENV,
    // `server-only`, which the incumbent's corrector imports, refuses to load
    // without this condition.
    NODE_OPTIONS: "--conditions=react-server",
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (wanted.has(key.toLowerCase())) env[key] = value;
  }
  return env;
}

/** Must match `incumbent-runner.ts`; see there for why it cannot be imported. */
const RESULT_MARKER = "\n<<<DELF-COMPARE-RESULT>>>\n";

interface Flags {
  repeats: number;
  only: string | null;
  skipIncumbent: boolean;
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? null;
  const repeats = Number(get("repeats") ?? 1);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer");
  return { repeats, only: get("only"), skipIncumbent: argv.includes("--skip-incumbent") };
}

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// ------------------------------------------------------------------ this system

async function runOurs(
  sitting: SittingProfile,
  repeat: number,
): Promise<OurRecord> {
  const topic = findTopic(sitting.topicSlug);
  if (!topic) throw new Error(`${sitting.id} names topic "${sitting.topicSlug}", which is not in ORAL_TOPICS`);

  process.stdout.write(`[ours] ${sitting.id} · run ${repeat}… `);
  const startedAt = Date.now();
  try {
    const result = await evaluateExam({
      mode: "text",
      topic,
      transcript: sitting.transcript,
      monologueSeconds: sitting.monologueSeconds,
      debateSeconds: sitting.debateSeconds,
    });
    process.stdout.write(`${result.score25}/25 in ${result.latencySeconds.toFixed(1)}s\n`);
    return {
      ok: true,
      sittingId: sitting.id,
      repeat,
      model: result.model,
      promptVersion: result.promptVersion,
      criteria: result.criteria,
      rawCriteria: result.rawCriteria,
      modelTotal25: result.modelTotal25,
      rawScore25: result.rawScore25,
      score25: result.score25,
      durationPenalty: result.durationPenalty,
      shortParts: result.shortParts,
      meetsFloor: result.meetsFloor,
      phonologieNonEvaluable: result.feedback.phonologieNonEvaluable,
      justifications: result.feedback.justifications,
      appreciationGlobale: result.feedback.appreciationGlobale,
      latencySeconds: result.latencySeconds,
      usage: result.usage,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`FAILED (${message.slice(0, 80)})\n`);
    return {
      ok: false,
      sittingId: sitting.id,
      repeat,
      error: message,
      latencySeconds: (Date.now() - startedAt) / 1000,
    };
  }
}

// -------------------------------------------------------------- the incumbent

/**
 * Run every incumbent job in one child process inside the reference checkout.
 *
 * One process for all of them, not one per job: the harness pays a TypeScript
 * compile on start-up, and folding that into each correction would inflate every
 * latency reading by several seconds of tooling.
 */
function runIncumbent(sittings: readonly SittingProfile[], repeats: number): {
  model: string;
  results: IncumbentRecord[];
} {
  const jobs = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const sitting of sittings) {
      const topic = findTopic(sitting.topicSlug)!;
      for (const [phase, tache, seconds] of [
        ["monologue", 1, sitting.monologueSeconds],
        ["debate", 2, sitting.debateSeconds],
      ] as const) {
        jobs.push({
          sittingId: sitting.id,
          phase,
          tache,
          repeat,
          title: topic.title,
          // The incumbent takes one "situation" string where this system passes a
          // titled trigger document. The document is what a candidate actually
          // read, so it is what goes across; dropping it would grade the two
          // systems on different subjects.
          situation: topic.document,
          messages: asIncumbentMessages(sitting, phase),
          durationSeconds: seconds,
        });
      }
    }
  }

  const repo = incumbentRepo();
  // Git-ignored over there, so the reference working tree stays clean.
  const dropDir = join(repo, "node_modules", ".delf-compare");
  mkdirSync(dropDir, { recursive: true });
  const runnerPath = join(dropDir, "incumbent-runner.ts");
  copyFileSync(resolve(import.meta.dirname, "comparison/incumbent-runner.ts"), runnerPath);

  try {
    const child = spawnSync(
      "pnpm",
      ["exec", "tsx", runnerPath],
      {
        cwd: repo,
        input: JSON.stringify(jobs),
        encoding: "utf8",
        shell: process.platform === "win32",
        maxBuffer: 64 * 1024 * 1024,
        env: childEnv(),
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    if (child.status !== 0) {
      throw new Error(`the incumbent runner exited ${child.status} (see stderr above)`);
    }
    // Everything before the marker is somebody else's banner — dotenv's, pnpm's,
    // tsx's. See the runner for why this is not paranoia.
    const marked = child.stdout.indexOf(RESULT_MARKER);
    if (marked === -1) {
      throw new Error(
        `the incumbent runner produced no result payload; its stdout was:\n${child.stdout.slice(0, 500)}`,
      );
    }
    return JSON.parse(child.stdout.slice(marked + RESULT_MARKER.length));
  } finally {
    // The reference checkout is a live working tree on a real branch. Leaving a
    // file in it, even an ignored one, is how a measurement starts changing what
    // it measures.
    rmSync(dropDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------- main

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const sittings = flags.only
    ? SITTINGS.filter((s) => s.id === flags.only)
    : SITTINGS;
  if (sittings.length === 0) throw new Error(`no sitting matches --only=${flags.only}`);
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");

  const startedAt = new Date().toISOString();
  console.log(
    `\nComparing ${sittings.length} sitting(s) × ${flags.repeats} run(s)` +
      `${flags.skipIncumbent ? " — this system only" : ""}\n`,
  );

  console.log("1. This system: one correction per sitting\n");
  const ours: OurRecord[] = [];
  for (let repeat = 1; repeat <= flags.repeats; repeat++) {
    for (const sitting of sittings) {
      ours.push(await runOurs(sitting, repeat));
    }
  }

  let incumbent: RunFile["incumbent"] = null;
  if (!flags.skipIncumbent) {
    console.log("\n2. The incumbent: two corrections per sitting, one per tâche\n");
    const raw = runIncumbent(sittings, flags.repeats);
    incumbent = { model: raw.model, results: raw.results };
  }

  const run: RunFile = {
    startedAt,
    finishedAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    repeats: flags.repeats,
    criteria: [...ORAL_CRITERIA],
    sittings: sittings.map((s) => ({
      id: s.id,
      label: s.label,
      topicSlug: s.topicSlug,
      design: s.design,
      weakCriterion: s.weakCriterion ?? null,
      monologueSeconds: s.monologueSeconds,
      debateSeconds: s.debateSeconds,
    })),
    ours,
    incumbent,
  };

  const outDir = resolve(import.meta.dirname, "../docs/comparison/runs");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(outPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");

  const failures = [
    ...ours.filter((r) => !r.ok),
    ...(incumbent?.results.filter((r) => !r.ok) ?? []),
  ];
  console.log(`\nRecorded ${outPath}`);
  console.log(
    failures.length === 0
      ? "Every correction returned.\n"
      : `${failures.length} correction(s) failed; they are in the run file and belong in the report.\n`,
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
