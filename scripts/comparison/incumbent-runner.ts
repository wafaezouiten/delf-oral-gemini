/**
 * Grade sittings with the INCUMBENT corrector, in the incumbent's own repository.
 *
 * This file is source in *this* repository but it never runs here. `compare.ts`
 * copies it into `<incumbent>/node_modules/.delf-compare/` and executes it with
 * the incumbent as its working directory, because there is no other way to call
 * that corrector honestly:
 *
 *  - it imports `ai@7`, `zod` and `server-only`, which are the incumbent's
 *    dependencies and are not installed here — Node resolves bare specifiers
 *    from the importing file's directory upward, so the file has to physically
 *    sit inside their tree;
 *  - it imports `@/lib/...`, which only resolves against the incumbent's
 *    `tsconfig.json` paths;
 *  - and the point of the exercise is to run *their* prompt, *their* model id and
 *    *their* rubric, not a reimplementation of them. Copying the pipeline over
 *    here would compare this repository against its own reading of the incumbent,
 *    which is precisely the comparison nobody needs.
 *
 * `node_modules/` is the drop site because it is git-ignored over there: the
 * reference checkout is a real working tree on a real branch, and a harness that
 * leaves a modification in it would corrupt the thing being measured. The copy
 * is removed when the run finishes.
 *
 * Consequence, and it is a real cost: this file is **excluded from this
 * repository's `tsconfig.json`**, because every import below resolves to modules
 * that exist only in the incumbent's tree and `pnpm typecheck` would fail on all
 * of them. It is therefore type-checked where it actually runs and nowhere else.
 * A rename or a signature change over there surfaces as a failed comparison run,
 * not as a red build here — which is the trade this file's whole existence buys.
 *
 * Protocol: a JSON job on stdin, a JSON result on stdout after {@link RESULT_MARKER},
 * diagnostics on stderr. The marker is not belt-and-braces: `dotenv` announces
 * itself on stdout, `tsx` and `pnpm` are entitled to as well, and a harness that
 * assumed a clean stream would parse a banner and report the incumbent as broken.
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { evaluateOralPerformance, ORAL_EVAL_MODEL } from "../../src/lib/ai/orale-evaluation";
import { minDurationSeconds } from "../../src/lib/constants/orale";

/**
 * Everything after this marker on stdout is the result payload. Duplicated as a
 * literal in `compare.ts` rather than imported: that file runs in this
 * repository and this one runs in the incumbent's, so there is no module they
 * can share. Change one and the run fails loudly on the next call.
 */
const RESULT_MARKER = "\n<<<DELF-COMPARE-RESULT>>>\n";

/** One correction the incumbent is asked to perform: exactly one tâche. */
interface IncumbentJob {
  /** The sitting this half came from, so results can be re-joined. */
  sittingId: string;
  /** Which half of the sitting it is, in this repository's vocabulary. */
  phase: "monologue" | "debate";
  /** The incumbent's own unit: 1 = monologue suivi, 2 = débat. */
  tache: number;
  title: string;
  situation: string;
  messages: Array<{ role: string; content: string }>;
  durationSeconds: number;
  /** Which repeat of this job this is, 1-based. */
  repeat: number;
}

interface IncumbentResult extends Omit<IncumbentJob, "messages"> {
  ok: true;
  model: string;
  criteria: Record<string, number>;
  rawCriteria: Record<string, number>;
  modelTotal25: number;
  rawScore25: number;
  score25: number;
  durationPenalty: number;
  minDurationSeconds: number;
  phonologieNonEvaluable: boolean;
  justifications: Record<string, string>;
  appreciationGlobale: string;
  latencySeconds: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

interface IncumbentFailure extends Omit<IncumbentJob, "messages"> {
  ok: false;
  model: string;
  error: string;
  latencySeconds: number;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function runJob(job: IncumbentJob): Promise<IncumbentResult | IncumbentFailure> {
  const { messages, ...meta } = job;
  const startedAt = Date.now();
  try {
    const result = await evaluateOralPerformance({
      level: "B2",
      tache: job.tache,
      title: job.title,
      situation: job.situation,
      messages,
      durationSeconds: job.durationSeconds,
    });
    const latencySeconds = (Date.now() - startedAt) / 1000;

    return {
      ...meta,
      ok: true,
      model: ORAL_EVAL_MODEL,
      criteria: result.details,
      rawCriteria: result.rawCriteria,
      modelTotal25: result.modelTotal25,
      rawScore25: result.rawScore25,
      score25: result.score25,
      // The incumbent returns the adjusted score and the floor it used, not the
      // penalty. Recovered here rather than assumed: below 3/25 the difference
      // understates the rule, and the report says which figure it is quoting.
      durationPenalty: result.rawScore25 - result.score25,
      minDurationSeconds: result.minDurationSeconds,
      phonologieNonEvaluable: result.report.phonologieNonEvaluable,
      justifications: result.report.justifications as unknown as Record<string, string>,
      appreciationGlobale: result.report.appreciationGlobale,
      latencySeconds,
      inputTokens: result.usage.inputTokens ?? null,
      outputTokens: result.usage.outputTokens ?? null,
    };
  } catch (error) {
    return {
      ...meta,
      ok: false,
      model: ORAL_EVAL_MODEL,
      error: error instanceof Error ? error.message : String(error),
      latencySeconds: (Date.now() - startedAt) / 1000,
    };
  }
}

async function main() {
  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new Error(
      "AI_GATEWAY_API_KEY is not set in the incumbent's .env.local — its corrector cannot run",
    );
  }

  const jobs: IncumbentJob[] = JSON.parse(await readStdin());
  const results: Array<IncumbentResult | IncumbentFailure> = [];

  // Sequential. The gateway would take these concurrently, but latency is one of
  // the numbers being measured and concurrent calls contend for the same rate
  // limit, which would make every reading a measurement of the harness.
  for (const [index, job] of jobs.entries()) {
    process.stderr.write(
      `[incumbent ${index + 1}/${jobs.length}] ${job.sittingId} · tâche ${job.tache} · run ${job.repeat}… `,
    );
    const result = await runJob(job);
    process.stderr.write(
      result.ok
        ? `${result.score25}/25 in ${result.latencySeconds.toFixed(1)}s\n`
        : `FAILED (${result.error.slice(0, 80)})\n`,
    );
    results.push(result);
  }

  process.stdout.write(
    RESULT_MARKER +
      JSON.stringify({
        model: ORAL_EVAL_MODEL,
        floors: { tache1: minDurationSeconds("B2", 1), tache2: minDurationSeconds("B2", 2) },
        results,
      }),
  );
}

void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
