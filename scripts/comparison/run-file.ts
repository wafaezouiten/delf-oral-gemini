/**
 * The shape of a recorded comparison run (#12).
 *
 * A run file is the evidence the report rests on, so it stores what each system
 * *returned* and never what the harness concluded. Two consequences worth stating
 * because they are easy to undo:
 *
 *  - **A failure is a record, not an omission.** A correction that threw is kept,
 *    with its message and how long it took to fail. "What breaks and how often"
 *    is one of the questions #12 asks, and a harness that drops failures answers
 *    it with silence.
 *  - **Absent is not zero.** Every measured number is nullable. A missing token
 *    count means the API did not report one; folding it to 0 would quietly
 *    understate a cost.
 */

import type { EvaluationUsage } from "../../src/lib/gemini/evaluation-usage";

/** The five grille criteria, as returned. Loose keys: the run file is data. */
export type CriteriaMap = Record<string, number>;

/** One correction by this system: one whole sitting, one mark. */
export type OurRecord =
  | {
      ok: true;
      sittingId: string;
      repeat: number;
      model: string;
      promptVersion: string;
      criteria: CriteriaMap;
      rawCriteria: CriteriaMap;
      modelTotal25: number;
      rawScore25: number;
      score25: number;
      durationPenalty: number;
      shortParts: string[];
      meetsFloor: boolean;
      phonologieNonEvaluable: boolean;
      justifications: Record<string, string>;
      appreciationGlobale: string;
      latencySeconds: number;
      usage: EvaluationUsage;
    }
  | {
      ok: false;
      sittingId: string;
      repeat: number;
      error: string;
      latencySeconds: number;
    };

/** One correction by the incumbent: one tâche, one mark. Two per sitting. */
export type IncumbentRecord =
  | {
      ok: true;
      sittingId: string;
      /** This repository's name for the half; `tache` is the incumbent's. */
      phase: "monologue" | "debate";
      tache: number;
      repeat: number;
      model: string;
      title: string;
      situation: string;
      durationSeconds: number;
      criteria: CriteriaMap;
      rawCriteria: CriteriaMap;
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
  | {
      ok: false;
      sittingId: string;
      phase: "monologue" | "debate";
      tache: number;
      repeat: number;
      model: string;
      title: string;
      situation: string;
      durationSeconds: number;
      error: string;
      latencySeconds: number;
    };

/** What a sitting was, recorded alongside the results so a run file stands alone. */
export interface SittingRecord {
  id: string;
  label: string;
  topicSlug: string;
  design: string;
  weakCriterion: string | null;
  monologueSeconds: number;
  debateSeconds: number;
}

export interface RunFile {
  startedAt: string;
  finishedAt: string;
  /** The commit of THIS repository the run was made from. */
  gitCommit: string;
  repeats: number;
  criteria: string[];
  sittings: SittingRecord[];
  ours: OurRecord[];
  /** Null when the run was made with `--skip-incumbent`. */
  incumbent: { model: string; results: IncumbentRecord[] } | null;
}
