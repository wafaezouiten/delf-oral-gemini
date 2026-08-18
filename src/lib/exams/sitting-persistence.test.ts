import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

import { ORAL_CRITERIA, type OralCriterion } from "@/lib/delf/criteria";
import { ORAL_PHASES, type OralPhase } from "@/lib/delf/phases";
import type { EvaluationFeedback } from "@/lib/db/schema";
import type { TranscriptEntry } from "@/lib/delf/transcript";

import {
  correctSitting,
  deriveCorrectionWrite,
  sittingOutcome,
  type CorrectionRow,
  type CorrectionWrite,
  type FinalisedPhase,
  type SittingRef,
  type SittingStore,
  type StoredCorrection,
  type StoredSitting,
} from "./sitting-persistence";

/**
 * These tests run against an in-memory store rather than Postgres, so read them
 * for what they can prove and not for what they cannot.
 *
 * What they prove is the part this phase actually owns: the order the finish
 * path does things in, what a second submission costs, and which of the row
 * values are derived from the audio rather than from the browser. The fake
 * below is written to fail the same way the real statements do — the same
 * ownership predicate, the same phase ordering, the same "no correction yet"
 * claim — so a change in the orchestration that would break against Neon breaks
 * here first.
 *
 * What they cannot prove is that `db/sittings.ts` really expresses those
 * conditions in SQL. That is what `pnpm verify:db` is for: it runs this same
 * round trip against a real Neon database and deletes what it wrote.
 */

const OWNER = "user_owner";
const INTRUDER = "user_intruder";
const EXAM_ID = 41;
const REF: SittingRef = { examId: EXAM_ID, userId: OWNER };

const BANDS = Object.fromEntries(ORAL_CRITERIA.map((c) => [c, 3])) as CorrectionRow["criteria"];

const FEEDBACK: EvaluationFeedback = {
  justifications: Object.fromEntries(ORAL_CRITERIA.map((c) => [c, `${c} : correct`])) as Record<
    OralCriterion,
    string
  >,
  appreciationGlobale: "Une prestation honnête.",
  pointsForts: ["Plan clair"],
  axesPrioritaires: ["Articuler les connecteurs"],
  conseil: "Travaillez la relance.",
  phonologieNonEvaluable: false,
};

function correction(overrides: Partial<CorrectionRow> = {}): CorrectionRow {
  return {
    mode: "audio",
    criteria: BANDS,
    rawScore25: 15,
    absencePenalty: 0,
    durationPenalty: 0,
    score25: 15,
    meetsFloor: true,
    feedback: FEEDBACK,
    model: "gemini-3.6-flash",
    promptVersion: "2026-08-15.0",
    latencySeconds: 12.5,
    ...overrides,
  };
}

function turn(phase: "monologue" | "debate", text: string, timestamp: number): TranscriptEntry {
  return { phase, speaker: "candidate", timestamp, text };
}

const MONOLOGUE: FinalisedPhase = {
  phase: "monologue",
  entries: [turn("monologue", "Je défendrai l'idée que le télétravail est un progrès.", 1_000)],
  startedAt: new Date("2026-08-15T10:00:00Z"),
  endedAt: new Date("2026-08-15T10:07:00Z"),
};

const DEBATE: FinalisedPhase = {
  phase: "debate",
  entries: [turn("debate", "Je maintiens mon point de vue, et voici pourquoi.", 500_000)],
  startedAt: new Date("2026-08-15T10:07:00Z"),
  endedAt: new Date("2026-08-15T10:20:00Z"),
};

// =====================================================
// THE FAKE
// =====================================================

interface ExamRow {
  id: number;
  userId: string;
  topicSlug: string;
  phase: OralPhase;
  transcript: TranscriptEntry[];
  reconnectCount: number;
  startedAt: Date;
  finishedAt: Date | null;
  abandonedAt: Date | null;
}

/** `oral_phase` is declared in exam order and Postgres compares enums by
 *  declaration, which is what the real guard leans on. Same thing here: the
 *  reported phase must be the sitting's next step, so the stored phase has to
 *  sit between the reported one's predecessor and the reported one. */
const phaseRank = (phase: OralPhase) => ORAL_PHASES.indexOf(phase);
const isNextStep = (stored: OralPhase, reported: "monologue" | "debate") =>
  phaseRank(stored) >= phaseRank(reported) - 1 && phaseRank(stored) <= phaseRank(reported);
const phaseAfter = (phase: "monologue" | "debate"): OralPhase =>
  phase === "monologue" ? "debate" : "finished";

class MemoryStore implements SittingStore {
  exams: ExamRow[] = [];
  phases: Array<{ examId: number } & StoredSitting["phases"][number]> = [];
  recordings: Array<{ examId: number } & StoredSitting["recordings"][number]> = [];
  evaluations: Array<{ examId: number } & StoredCorrection> = [];
  /** Set to make the next `writeCorrection` reject, like a failed batch. */
  failNextWrite = false;

  private nextId = 1;

  createSitting(userId: string, id: number): void {
    this.exams.push({
      id,
      userId,
      topicSlug: "teletravail",
      phase: "preparation",
      transcript: [],
      reconnectCount: 0,
      startedAt: new Date("2026-08-15T09:30:00Z"),
      finishedAt: null,
      abandonedAt: null,
    });
  }

  /** The ownership predicate, in one place, exactly as the SQL repeats it. */
  private owned(ref: SittingRef): ExamRow | undefined {
    return this.exams.find((row) => row.id === ref.examId && row.userId === ref.userId);
  }

  async appendFinalisedPhase(ref: SittingRef, phase: FinalisedPhase): Promise<boolean> {
    const exam = this.owned(ref);
    if (!exam || exam.finishedAt !== null) return false;
    if (!isNextStep(exam.phase, phase.phase)) return false;

    exam.phase = phaseAfter(phase.phase);
    exam.transcript = [...exam.transcript, ...phase.entries];

    if (!this.phases.some((row) => row.examId === ref.examId && row.phase === phase.phase)) {
      this.phases.push({
        examId: ref.examId,
        phase: phase.phase,
        spokenSeconds: 0,
        startedAt: phase.startedAt,
        endedAt: phase.endedAt,
      });
    }
    return true;
  }

  async claimForCorrection(ref: SittingRef, claim: Parameters<SittingStore["claimForCorrection"]>[1]) {
    const exam = this.owned(ref);
    if (!exam) return false;
    if (this.evaluations.some((row) => row.examId === ref.examId)) return false;

    exam.phase = "finished";
    exam.transcript = claim.transcript;
    exam.reconnectCount = claim.reconnectCount;
    exam.finishedAt = claim.finishedAt;
    return true;
  }

  async abandonSitting(ref: SittingRef, abandonedAt: Date): Promise<boolean> {
    const exam = this.owned(ref);
    if (!exam) return false;
    // The same three refusals the SQL encodes: already gone, or already graded.
    if (exam.abandonedAt !== null) return false;
    if (this.evaluations.some((row) => row.examId === ref.examId)) return false;

    exam.abandonedAt = abandonedAt;
    return true;
  }

  async writeCorrection(ref: SittingRef, write: CorrectionWrite): Promise<StoredCorrection> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("batch rejected");
    }

    for (const row of write.phases) {
      const existing = this.phases.find((p) => p.examId === ref.examId && p.phase === row.phase);
      if (existing) {
        existing.spokenSeconds = row.spokenSeconds;
        existing.endedAt = row.endedAt ?? existing.endedAt;
      } else {
        this.phases.push({ ...row, examId: ref.examId });
      }
    }
    for (const row of write.recordings) {
      if (!this.recordings.some((r) => r.examId === ref.examId && r.phase === row.phase)) {
        this.recordings.push({ ...row, examId: ref.examId });
      }
    }

    const stored: { examId: number } & StoredCorrection = {
      ...write.correction,
      examId: ref.examId,
      id: this.nextId++,
      createdAt: new Date("2026-08-15T10:21:00Z"),
    };
    this.evaluations.push(stored);
    return stored;
  }

  async findCorrection(ref: SittingRef): Promise<StoredCorrection | null> {
    if (!this.owned(ref)) return null;
    const rows = this.evaluations.filter((row) => row.examId === ref.examId);
    return rows[rows.length - 1] ?? null;
  }

  async readSitting(ref: SittingRef): Promise<StoredSitting | null> {
    const exam = this.owned(ref);
    if (!exam) return null;
    const correction = await this.findCorrection(ref);
    return {
      examId: exam.id,
      topicSlug: exam.topicSlug,
      phase: exam.phase,
      outcome: sittingOutcome({ finishedAt: exam.finishedAt, correction }),
      transcript: exam.transcript,
      reconnectCount: exam.reconnectCount,
      startedAt: exam.startedAt,
      finishedAt: exam.finishedAt,
      phases: this.phases.filter((row) => row.examId === ref.examId),
      recordings: this.recordings.filter((row) => row.examId === ref.examId),
      correction,
    };
  }
}

const NOW = new Date("2026-08-15T10:20:30Z");

function finishInput(overrides: Partial<Parameters<typeof correctSitting>[2]> = {}) {
  return {
    transcript: [...MONOLOGUE.entries, ...DEBATE.entries],
    reconnectCount: 1,
    phases: [
      { phase: "monologue" as const, startedAt: +MONOLOGUE.startedAt, endedAt: +MONOLOGUE.endedAt! },
      { phase: "debate" as const, startedAt: +DEBATE.startedAt, endedAt: +DEBATE.endedAt! },
    ],
    recordings: [
      { phase: "monologue" as const, mimeType: "audio/ogg", byteSize: 210_000, durationSeconds: 402.6 },
      { phase: "debate" as const, mimeType: "audio/ogg", byteSize: 640_000, durationSeconds: 761.2 },
    ],
    evaluate: async () => correction(),
    now: () => NOW,
    ...overrides,
  };
}

// =====================================================
// TESTS
// =====================================================

describe("sitting outcome", () => {
  const graded = { id: 1, createdAt: NOW, ...correction() } satisfies StoredCorrection;

  it("calls an unfinished sitting in progress", () => {
    assert.equal(sittingOutcome({ finishedAt: null, correction: null }), "in-progress");
  });

  it("calls a finished sitting with no correction uncorrected, not completed", () => {
    // The state the crash window leaves behind. It must never read as a
    // completed exam, which is the whole reason the outcome is not a boolean.
    assert.equal(sittingOutcome({ finishedAt: NOW, correction: null }), "uncorrected");
  });

  it("calls a corrected sitting corrected", () => {
    assert.equal(sittingOutcome({ finishedAt: NOW, correction: graded }), "corrected");
  });

  it("trusts the correction over the stamp", () => {
    // A correction without a `finished_at` should not exist, and if it somehow
    // does, the sitting has visibly been graded — reporting it as in-progress
    // would hide a result somebody is entitled to.
    assert.equal(sittingOutcome({ finishedAt: null, correction: graded }), "corrected");
  });
});

describe("deriving the rows", () => {
  const disposedAt = new Date("2026-08-15T10:21:00Z");

  it("stores the measured audio length, not the wall clock", () => {
    // The monologue's clock says seven minutes; the recording is 402.6 seconds.
    // `spoken_seconds` feeds the duration penalty, so it must be the second.
    const write = deriveCorrectionWrite({
      phases: [{ phase: "monologue", startedAt: +MONOLOGUE.startedAt, endedAt: +MONOLOGUE.endedAt! }],
      recordings: [
        { phase: "monologue", mimeType: "audio/ogg", byteSize: 210_000, durationSeconds: 402.6 },
      ],
      correction: correction(),
      disposedAt,
    });
    assert.equal(write.phases[0].spokenSeconds, 403);
    assert.deepEqual(write.phases[0].startedAt, MONOLOGUE.startedAt);
    assert.deepEqual(write.phases[0].endedAt, MONOLOGUE.endedAt);
  });

  it("gives a phase with no recording zero seconds rather than the clock's", () => {
    // A candidate who talked for seven minutes into a dead microphone has not
    // been shown to have produced the épreuve, and the penalty should say so.
    const write = deriveCorrectionWrite({
      phases: [{ phase: "debate", startedAt: +DEBATE.startedAt, endedAt: +DEBATE.endedAt! }],
      recordings: [],
      correction: correction(),
      disposedAt,
    });
    assert.equal(write.phases[0].spokenSeconds, 0);
    assert.equal(write.recordings.length, 0);
  });

  it("writes no row for a phase the candidate never entered", () => {
    const write = deriveCorrectionWrite({
      phases: [{ phase: "monologue", startedAt: +MONOLOGUE.startedAt, endedAt: null }],
      recordings: [],
      correction: correction(),
      disposedAt,
    });
    assert.deepEqual(
      write.phases.map((row) => row.phase),
      ["monologue"],
    );
    assert.equal(write.phases[0].endedAt, null);
  });

  it("records every recording as already disposed of, with no uri", () => {
    // Retention is forbidden; the row outlives the bytes on purpose.
    const write = deriveCorrectionWrite({
      phases: [],
      recordings: [
        { phase: "monologue", mimeType: "audio/ogg", byteSize: 210_000, durationSeconds: 402.6 },
      ],
      correction: correction(),
      disposedAt,
    });
    assert.equal(write.recordings[0].uri, null);
    assert.deepEqual(write.recordings[0].deletedAt, disposedAt);
    assert.equal(write.recordings[0].durationSeconds, 403);
  });

  it("produces integers the schema's own check constraints accept", () => {
    const write = deriveCorrectionWrite({
      phases: [{ phase: "debate", startedAt: +DEBATE.startedAt, endedAt: +DEBATE.endedAt! }],
      recordings: [
        { phase: "debate", mimeType: "audio/ogg", byteSize: 1, durationSeconds: 0.4 },
      ],
      correction: correction({ rawScore25: 2, durationPenalty: 3, score25: 0, meetsFloor: false }),
      disposedAt,
    });
    // oral_exam_phases_spoken_seconds_check and oral_recordings_duration_check.
    assert.ok(Number.isInteger(write.phases[0].spokenSeconds));
    assert.ok(write.phases[0].spokenSeconds >= 0);
    assert.ok(Number.isInteger(write.recordings[0].durationSeconds));
    assert.ok(write.recordings[0].durationSeconds >= 0);
    // evaluations_score_25_check: the penalty stored is the one the rubric
    // asked for, and the score is what could absorb it. The route does not
    // recompute either, and this is the pairing the constraint accepts.
    const { rawScore25, durationPenalty, score25 } = write.correction;
    assert.equal(score25, Math.max(rawScore25 - durationPenalty, 0));
  });
});

describe("appending a phase as it finalises", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
    store.createSitting(OWNER, EXAM_ID);
  });

  it("appends the phase's turns and moves the sitting on", async () => {
    assert.equal(await store.appendFinalisedPhase(REF, MONOLOGUE), true);
    const sitting = await store.readSitting(REF);
    assert.deepEqual(sitting?.transcript, MONOLOGUE.entries);
    assert.equal(sitting?.phase, "debate");
    assert.equal(sitting?.outcome, "in-progress");
  });

  it("does nothing at all the second time", async () => {
    await store.appendFinalisedPhase(REF, MONOLOGUE);
    assert.equal(await store.appendFinalisedPhase(REF, MONOLOGUE), false);
    const sitting = await store.readSitting(REF);
    assert.equal(sitting?.transcript.length, 1, "the monologue is stored once, not twice");
  });

  it("accumulates across phases", async () => {
    await store.appendFinalisedPhase(REF, MONOLOGUE);
    await store.appendFinalisedPhase(REF, DEBATE);
    const sitting = await store.readSitting(REF);
    assert.deepEqual(sitting?.transcript, [...MONOLOGUE.entries, ...DEBATE.entries]);
    assert.deepEqual(
      sitting?.phases.map((row) => row.phase),
      ["monologue", "debate"],
    );
  });

  it("refuses a phase that would skip the one before it", async () => {
    // Not reachable through the controller, which reports phases in order — but
    // reachable by hand-crafting a request for your own sitting, and `phase` is
    // the column that claims to record how far the candidate got. A sitting
    // still in preparation has not reached the débat.
    assert.equal(await store.appendFinalisedPhase(REF, DEBATE), false);

    const sitting = await store.readSitting(REF);
    assert.deepEqual(sitting?.transcript, [], "and nothing was appended");
    assert.equal(sitting?.phase, "preparation", "nor did the sitting move");
  });

  it("accepts the same phase once the one before it has been reported", async () => {
    // The other half of the same rule: exactly one step, never two, never none.
    await store.appendFinalisedPhase(REF, MONOLOGUE);
    assert.equal(await store.appendFinalisedPhase(REF, DEBATE), true);
    assert.equal((await store.readSitting(REF))?.phase, "finished");
    // …and `finished` here is the machine's position, not a grade. The stamp and
    // the correction are what decide that, and neither exists.
    assert.equal((await store.readSitting(REF))?.outcome, "in-progress");
  });

  it("refuses a sitting belonging to someone else", async () => {
    const foreign: SittingRef = { examId: EXAM_ID, userId: INTRUDER };
    assert.equal(await store.appendFinalisedPhase(foreign, MONOLOGUE), false);
    assert.deepEqual((await store.readSitting(REF))?.transcript, []);
  });

  it("cannot reopen a sitting that has been finished", async () => {
    await correctSitting(store, REF, finishInput());
    assert.equal(await store.appendFinalisedPhase(REF, DEBATE), false);
  });
});

describe("correcting a sitting", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
    store.createSitting(OWNER, EXAM_ID);
    store.createSitting(INTRUDER, 42);
  });

  it("round-trips: transcript, phases, recordings and correction come back", async () => {
    await store.appendFinalisedPhase(REF, MONOLOGUE);

    const outcome = await correctSitting(store, REF, finishInput());
    assert.equal(outcome.status, "stored");

    const sitting = await store.readSitting(REF);
    assert.ok(sitting);
    assert.equal(sitting.outcome, "corrected");
    assert.deepEqual(sitting.finishedAt, NOW);
    assert.equal(sitting.reconnectCount, 1);
    assert.deepEqual(sitting.transcript, [...MONOLOGUE.entries, ...DEBATE.entries]);

    assert.deepEqual(
      sitting.phases.map((row) => [row.phase, row.spokenSeconds]),
      [
        ["monologue", 403],
        ["debate", 761],
      ],
      "the phase the progress route already opened keeps its stamps and gains its measured seconds",
    );
    assert.deepEqual(
      sitting.recordings.map((row) => [row.phase, row.byteSize, row.uri]),
      [
        ["monologue", 210_000, null],
        ["debate", 640_000, null],
      ],
    );
    assert.equal(sitting.correction?.score25, 15);
    assert.deepEqual(sitting.correction?.criteria, BANDS);
    assert.deepEqual(sitting.correction?.feedback, FEEDBACK);
  });

  it("finishing twice produces one correction and never grades again", async () => {
    const first = await correctSitting(store, REF, finishInput());
    assert.equal(first.status, "stored");

    const evaluate = mock.fn(async () => correction({ score25: 25, rawScore25: 25 }));
    const second = await correctSitting(store, REF, finishInput({ evaluate }));

    assert.equal(second.status, "already-corrected");
    assert.equal(evaluate.mock.callCount(), 0, "a duplicate submit must not pay for a model call");
    assert.equal(store.evaluations.length, 1);
    // And what comes back is the correction that exists, not the one this call
    // would have produced.
    assert.equal(second.correction.score25, 15);
  });

  it("returns the winner's correction when the claim is lost mid-flight", async () => {
    // The narrow race the claim exists for: something else corrects the sitting
    // while this call is inside the model.
    const outcome = await correctSitting(
      store,
      REF,
      finishInput({
        evaluate: async () => {
          await store.claimForCorrection(REF, {
            transcript: [],
            reconnectCount: 0,
            finishedAt: NOW,
          });
          await store.writeCorrection(REF, {
            phases: [],
            recordings: [],
            correction: correction({ score25: 20, rawScore25: 20 }),
          });
          return correction();
        },
      }),
    );

    assert.equal(outcome.status, "already-corrected");
    assert.equal(outcome.correction.score25, 20);
    assert.equal(store.evaluations.length, 1);
  });

  it("leaves a sitting uncorrected — not completed — when the write fails", async () => {
    store.failNextWrite = true;
    const outcome = await correctSitting(store, REF, finishInput());

    assert.equal(outcome.status, "graded-not-stored");
    // The candidate still has their grade in the response.
    assert.equal(outcome.status === "graded-not-stored" && outcome.correction.score25, 15);

    const sitting = await store.readSitting(REF);
    assert.equal(sitting?.outcome, "uncorrected", "a half-written sitting must not read as completed");
    assert.equal(sitting?.correction, null);
  });

  it("repairs an uncorrected sitting when it is finished again", async () => {
    // The claim asks about corrections, not about `finished_at`, precisely so
    // this is possible. Keying on the stamp would strand the sitting.
    store.failNextWrite = true;
    await correctSitting(store, REF, finishInput());

    const retry = await correctSitting(store, REF, finishInput());
    assert.equal(retry.status, "stored");
    assert.equal((await store.readSitting(REF))?.outcome, "corrected");
    assert.equal(store.evaluations.length, 1);
  });

  it("cannot correct, or read, a neighbouring user's sitting", async () => {
    const neighbour: SittingRef = { examId: 42, userId: OWNER };
    const evaluate = mock.fn(async () => correction());

    const outcome = await correctSitting(store, neighbour, finishInput({ evaluate }));
    assert.equal(outcome.status, "graded-not-stored");
    assert.equal(store.evaluations.length, 0);
    assert.equal(await store.readSitting(neighbour), null);

    // And the sitting it addresses is untouched.
    assert.equal(store.exams.find((row) => row.id === 42)?.finishedAt, null);
  });
});

describe("abandoning a sitting", () => {
  let store: MemoryStore;
  const OTHER = "user_other";

  beforeEach(() => {
    store = new MemoryStore();
    store.createSitting(OWNER, REF.examId);
    store.createSitting(OTHER, 42);
  });

  it("records the walk-out", async () => {
    const at = new Date("2026-08-16T11:00:00Z");
    assert.equal(await store.abandonSitting(REF, at), true);
    assert.deepEqual(store.exams.find((row) => row.id === REF.examId)?.abandonedAt, at);
  });

  it("does not touch the phase or finished_at", async () => {
    // Both mean "this épreuve ran its course", and the whole point of the row
    // is that it did not: `phase` has to keep saying where the candidate
    // stopped, because that is what the historique prints beside the zero.
    await store.abandonSitting(REF, new Date());
    const exam = store.exams.find((row) => row.id === REF.examId);
    assert.equal(exam?.phase, "preparation");
    assert.equal(exam?.finishedAt, null);
  });

  it("keeps the first stamp when the exit button is double-clicked", async () => {
    const first = new Date("2026-08-16T11:00:00Z");
    await store.abandonSitting(REF, first);
    assert.equal(await store.abandonSitting(REF, new Date("2026-08-16T11:00:05Z")), false);
    assert.deepEqual(store.exams.find((row) => row.id === REF.examId)?.abandonedAt, first);
  });

  it("refuses once a correction exists: a graded sitting outranks a walk-out", async () => {
    // The real race, not a theoretical one. The finish request is in flight
    // while the candidate reads the exit dialog, so "I gave up on the upload"
    // and "the upload succeeded" can arrive in either order.
    await correctSitting(store, REF, finishInput());
    assert.equal(await store.abandonSitting(REF, new Date()), false);
    assert.equal(store.exams.find((row) => row.id === REF.examId)?.abandonedAt, null);
  });

  it("cannot mark a neighbouring user's sitting", async () => {
    // This writes a zero onto somebody's record, and exam ids are sequential.
    assert.equal(await store.abandonSitting({ examId: 42, userId: OWNER }, new Date()), false);
    assert.equal(store.exams.find((row) => row.id === 42)?.abandonedAt, null);
  });
});
