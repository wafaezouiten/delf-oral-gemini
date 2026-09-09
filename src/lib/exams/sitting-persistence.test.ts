import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

import { ORAL_CRITERIA, type OralCriterion } from "@/lib/delf/criteria";
import { ORAL_PHASES, type OralPhase } from "@/lib/delf/phases";
import type { EvaluationFeedback, OralSpeakingPhase } from "@/lib/db/schema";
import type { TranscriptEntry } from "@/lib/delf/transcript";

import {
  CORRECTION_CLAIM_HOLD_SECONDS,
  acceptSitting,
  attachCorrection,
  deriveCorrectionWrite,
  sittingOutcome,
  type AcceptSittingInput,
  type ArtefactRows,
  type AttachCorrectionInput,
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
  earlyClosingCount: number;
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
      earlyClosingCount: 0,
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

  async claimForCorrection(
    ref: SittingRef,
    claim: Parameters<SittingStore["claimForCorrection"]>[1],
  ) {
    const exam = this.owned(ref);
    if (!exam) return false;
    if (this.evaluations.some((row) => row.examId === ref.examId)) return false;
    // The claim hold (#86), as the SQL applies it — a previous claim younger
    // than the grading budget most likely has a model call behind it. The
    // fake's clock is the claim's own timestamp, matching the injected `now`.
    if (
      exam.finishedAt !== null &&
      +claim.finishedAt - +exam.finishedAt < CORRECTION_CLAIM_HOLD_SECONDS * 1000
    ) {
      return false;
    }

    exam.phase = "finished";
    exam.transcript = claim.transcript;
    exam.reconnectCount = claim.reconnectCount;
    exam.earlyClosingCount = claim.earlyClosingCount;
    exam.finishedAt = claim.finishedAt;
    return true;
  }

  async releaseClaim(ref: SittingRef): Promise<void> {
    const exam = this.owned(ref);
    if (!exam) return;
    if (this.evaluations.some((row) => row.examId === ref.examId)) return;
    exam.finishedAt = null;
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

  /** The artefact upserts both write methods share, exactly as the SQL does:
   *  phases update their measured seconds, recordings are insert-if-absent —
   *  which is the clause that lets the attach's second pass never overwrite
   *  the uris the accept's rows carry (#98, #86). */
  private upsertArtefacts(ref: SittingRef, rows: ArtefactRows): void {
    for (const row of rows.phases) {
      const existing = this.phases.find((p) => p.examId === ref.examId && p.phase === row.phase);
      if (existing) {
        existing.spokenSeconds = row.spokenSeconds;
        existing.endedAt = row.endedAt ?? existing.endedAt;
      } else {
        this.phases.push({ ...row, examId: ref.examId });
      }
    }
    for (const row of rows.recordings) {
      if (!this.recordings.some((r) => r.examId === ref.examId && r.phase === row.phase)) {
        this.recordings.push({ ...row, examId: ref.examId });
      }
    }
  }

  /** Set to make the next `writeArtefacts` reject, like a failed batch. */
  failNextArtefactWrite = false;

  async writeArtefacts(ref: SittingRef, artefacts: ArtefactRows): Promise<void> {
    if (this.failNextArtefactWrite) {
      this.failNextArtefactWrite = false;
      throw new Error("batch rejected");
    }
    this.upsertArtefacts(ref, artefacts);
  }

  async writeCorrection(ref: SittingRef, write: CorrectionWrite): Promise<StoredCorrection> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("batch rejected");
    }

    this.upsertArtefacts(ref, write);

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
      earlyClosingCount: exam.earlyClosingCount,
      examinerModel: null,
      startedAt: exam.startedAt,
      finishedAt: exam.finishedAt,
      phases: this.phases.filter((row) => row.examId === ref.examId),
      recordings: this.recordings.filter((row) => row.examId === ref.examId),
      correction,
    };
  }
}

const NOW = new Date("2026-08-15T10:20:30Z");

const REPORTED_PHASES = [
  {
    phase: "monologue" as const,
    startedAt: +MONOLOGUE.startedAt,
    endedAt: +MONOLOGUE.endedAt!,
  },
  { phase: "debate" as const, startedAt: +DEBATE.startedAt, endedAt: +DEBATE.endedAt! },
];

const MEASURED_RECORDINGS = [
  {
    phase: "monologue" as const,
    mimeType: "audio/ogg",
    byteSize: 210_000,
    durationSeconds: 402.6,
  },
  {
    phase: "debate" as const,
    mimeType: "audio/ogg",
    byteSize: 640_000,
    durationSeconds: 761.2,
  },
];

function acceptInput(overrides: Partial<AcceptSittingInput> = {}): AcceptSittingInput {
  return {
    transcript: [...MONOLOGUE.entries, ...DEBATE.entries],
    reconnectCount: 1,
    // Distinct from `reconnectCount` on purpose, so the assertion below can
    // tell a claim that wrote the wrong number into the right column (#92).
    earlyClosingCount: 2,
    phases: REPORTED_PHASES,
    recordings: MEASURED_RECORDINGS,
    now: () => NOW,
    ...overrides,
  };
}

function attachInput(overrides: Partial<AttachCorrectionInput> = {}): AttachCorrectionInput {
  return {
    phases: REPORTED_PHASES,
    recordings: MEASURED_RECORDINGS,
    evaluate: async () => correction(),
    now: () => NOW,
    ...overrides,
  };
}

/** The route's whole finish, as one call: accept, and attach when it took. */
async function finishSitting(
  store: SittingStore,
  overrides: { accept?: Partial<AcceptSittingInput>; attach?: Partial<AttachCorrectionInput> } = {},
) {
  const accepted = await acceptSitting(store, REF, acceptInput(overrides.accept));
  if (accepted.status !== "accepted") return accepted;
  return attachCorrection(store, REF, attachInput(overrides.attach));
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
      phases: [
        { phase: "monologue", startedAt: +MONOLOGUE.startedAt, endedAt: +MONOLOGUE.endedAt! },
      ],
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

  it("stores the duration the correction was graded on when the route resolved one", () => {
    // The route's `gradedSeconds` (#203): the measurement plus whatever the
    // development time-skip added to it. The row has to follow the grade rather
    // than the file, or the results page prints a duration the mark beside it
    // was never computed from.
    const write = deriveCorrectionWrite({
      phases: [
        {
          phase: "monologue",
          startedAt: +MONOLOGUE.startedAt,
          endedAt: +MONOLOGUE.endedAt!,
          gradedSeconds: 522.6,
        },
      ],
      recordings: [
        { phase: "monologue", mimeType: "audio/ogg", byteSize: 210_000, durationSeconds: 402.6 },
      ],
      correction: correction(),
      disposedAt,
    });
    assert.equal(write.phases[0].spokenSeconds, 523, "the graded duration, rounded");
    assert.equal(
      write.recordings[0].durationSeconds,
      403,
      "and the recording still describes its own bytes",
    );
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

  it("records a recording nothing kept as disposed of, with no uri", () => {
    // No vault, or an upload that failed: the row outlives the bytes, which is
    // every row this function wrote before #98 and must keep meaning the same.
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

  it("points a kept recording at its uri, and only a kept one (#98)", () => {
    // One sitting, both artefacts uploaded, one of the two kept — the state a
    // vault outage mid-preserve leaves. Each row must speak only for itself:
    // the kept one is live, the lost one is honestly disposed.
    const write = deriveCorrectionWrite({
      phases: [],
      recordings: [
        { phase: "monologue", mimeType: "audio/ogg", byteSize: 210_000, durationSeconds: 402.6 },
        { phase: "debate", mimeType: "audio/ogg", byteSize: 640_000, durationSeconds: 761.2 },
      ],
      correction: correction(),
      kept: new Map<OralSpeakingPhase, string>([
        ["monologue", "https://store.example/recordings/41/monologue.ogg"],
      ]),
      disposedAt,
    });
    assert.deepEqual(
      write.recordings.map((row) => [row.phase, row.uri, row.deletedAt]),
      [
        ["monologue", "https://store.example/recordings/41/monologue.ogg", null],
        ["debate", null, disposedAt],
      ],
    );
  });

  it("produces integers the schema's own check constraints accept", () => {
    const write = deriveCorrectionWrite({
      phases: [{ phase: "debate", startedAt: +DEBATE.startedAt, endedAt: +DEBATE.endedAt! }],
      recordings: [{ phase: "debate", mimeType: "audio/ogg", byteSize: 1, durationSeconds: 0.4 }],
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
    // The accept alone is enough to close the door (#86): the claim stamps
    // `finished_at`, and nothing may append to a sitting past it — least of
    // all while its correction is still being attached behind the response.
    await acceptSitting(store, REF, acceptInput());
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

  it("accepts the sitting whole before any grading has run (#86)", async () => {
    // The state the candidate is released on: claimed, artefacts written,
    // nothing graded. Everything the response promises — "your sitting is
    // safe" — has to be readable here, and the outcome has to be the
    // recoverable `uncorrected`, because this is also what a crashed grading
    // leaves behind.
    const outcome = await acceptSitting(store, REF, acceptInput());
    assert.equal(outcome.status, "accepted");

    const sitting = await store.readSitting(REF);
    assert.ok(sitting);
    assert.equal(sitting.outcome, "uncorrected");
    assert.deepEqual(sitting.finishedAt, NOW);
    assert.deepEqual(
      sitting.phases.map((row) => [row.phase, row.spokenSeconds]),
      [
        ["monologue", 403],
        ["debate", 761],
      ],
      "the measured seconds are on the rows before the corrector has said a word",
    );
    assert.equal(sitting.recordings.length, 2);
    assert.equal(sitting.correction, null);
  });

  it("round-trips: transcript, phases, recordings and correction come back", async () => {
    await store.appendFinalisedPhase(REF, MONOLOGUE);

    const outcome = await finishSitting(store);
    assert.equal(outcome.status, "stored");

    const sitting = await store.readSitting(REF);
    assert.ok(sitting);
    assert.equal(sitting.outcome, "corrected");
    assert.deepEqual(sitting.finishedAt, NOW);
    assert.equal(sitting.reconnectCount, 1);
    assert.equal(sitting.earlyClosingCount, 2, "the examiner's goodbyes survive the tab (#92)");
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
    const first = await finishSitting(store);
    assert.equal(first.status, "stored");

    // The duplicate is refused at the ACCEPT, before anything is claimed or
    // written — the attach never runs, so its model call is never paid for.
    const second = await acceptSitting(store, REF, acceptInput());
    assert.equal(second.status, "already-corrected");
    assert.equal(store.evaluations.length, 1);
    // And what comes back is the correction that exists, not a fresh one.
    assert.equal(second.status === "already-corrected" && second.correction.score25, 15);
  });

  it("a late attach on a corrected sitting returns the stored grade, ungraded twice", async () => {
    // The retry-after-timeout shape (#86): the first finish's background
    // grading landed AFTER the candidate gave up waiting and re-finished. The
    // second attach must find the row and never ask the corrector.
    await finishSitting(store);

    const evaluate = mock.fn(async () => correction({ score25: 25, rawScore25: 25 }));
    const outcome = await attachCorrection(store, REF, attachInput({ evaluate }));

    assert.equal(outcome.status, "already-corrected");
    assert.equal(evaluate.mock.callCount(), 0, "a duplicate attach must not pay for a model call");
    assert.equal(outcome.correction.score25, 15);
    assert.equal(store.evaluations.length, 1);
  });

  it("returns the winner's correction when the claim is lost mid-flight", async () => {
    // The narrow race the claim exists for: a rival finish corrects the
    // sitting between this accept's pre-check and its claim.
    const originalClaim = store.claimForCorrection.bind(store);
    store.claimForCorrection = async (ref, claim) => {
      await store.writeCorrection(REF, {
        phases: [],
        recordings: [],
        correction: correction({ score25: 20, rawScore25: 20 }),
      });
      return originalClaim(ref, claim);
    };

    const preserve = mock.fn(async () => new Map<OralSpeakingPhase, string>());
    const outcome = await acceptSitting(store, REF, acceptInput({ preserve }));

    assert.equal(outcome.status, "already-corrected");
    assert.equal(outcome.status === "already-corrected" && outcome.correction.score25, 20);
    assert.equal(store.evaluations.length, 1);
    // The loser's rows are never written, so the loser's bytes must never
    // land — the same discipline as the model call.
    assert.equal(preserve.mock.callCount(), 0);
  });

  it("leaves a sitting uncorrected — not completed — when the correction write fails", async () => {
    const accepted = await acceptSitting(store, REF, acceptInput());
    assert.equal(accepted.status, "accepted");

    store.failNextWrite = true;
    const outcome = await attachCorrection(store, REF, attachInput());

    assert.equal(outcome.status, "graded-not-stored");
    // The grade exists for whoever can still show it — behind an answered
    // response, that is the log.
    assert.equal(outcome.status === "graded-not-stored" && outcome.correction.score25, 15);

    const sitting = await store.readSitting(REF);
    assert.equal(
      sitting?.outcome,
      "uncorrected",
      "a half-written sitting must not read as completed",
    );
    assert.equal(sitting?.correction, null);
  });

  it("refuses the finish when the artefact write fails, gives the claim back, and strands nothing", async () => {
    // The accept's own failure: claimed, but the rows did not land. Nothing is
    // safe, so the caller must refuse — and because nothing here will grade,
    // the claim is RELEASED, so the immediate retry is not held out for a
    // grading budget nobody is spending.
    store.failNextArtefactWrite = true;
    const failed = await acceptSitting(store, REF, acceptInput());
    assert.equal(failed.status, "not-stored");
    assert.equal(
      store.exams.find((row) => row.id === EXAM_ID)?.finishedAt,
      null,
      "the failed accept does not sit on the claim",
    );

    const retry = await acceptSitting(store, REF, acceptInput());
    assert.equal(retry.status, "accepted", "the re-claim repairs what the failure left, at once");
  });

  it("refuses a second finish while the first's grading may still be in flight (#86)", async () => {
    // The review's finding on this PR: the fast 202 made stacking submits
    // cheap, and each accepted one would have paid for its own model call.
    // Within the grading budget, claimed-and-uncorrected reads as "being
    // graded" and the second finish gets a retryable refusal instead.
    const first = await acceptSitting(store, REF, acceptInput());
    assert.equal(first.status, "accepted");

    const preserve = mock.fn(async () => new Map<OralSpeakingPhase, string>());
    const second = await acceptSitting(store, REF, acceptInput({ preserve }));

    assert.equal(second.status, "not-stored");
    assert.equal(preserve.mock.callCount(), 0, "and it never stored a second copy of the voice");
    assert.equal(store.evaluations.length, 0);
  });

  it("repairs an uncorrected sitting when it is finished again, past the hold", async () => {
    // The claim asks about corrections, not about `finished_at`, precisely so
    // this is possible — once the grading budget has certainly expired, which
    // is when the finished screen offers the retry (`CORRECTION_WAIT_LIMIT_MS`
    // sits above the hold). Keying on the stamp would strand the sitting.
    const accepted = await acceptSitting(store, REF, acceptInput());
    assert.equal(accepted.status, "accepted");
    store.failNextWrite = true;
    await attachCorrection(store, REF, attachInput());

    const afterHold = () => new Date(+NOW + (CORRECTION_CLAIM_HOLD_SECONDS + 1) * 1000);
    const retry = await finishSitting(store, {
      accept: { now: afterHold },
      attach: { now: afterHold },
    });
    assert.equal(retry.status, "stored");
    assert.equal((await store.readSitting(REF))?.outcome, "corrected");
    assert.equal(store.evaluations.length, 1);
  });

  it("writes the uris the preserve hook kept, and the attach never overwrites them (#98)", async () => {
    const preserve = mock.fn(
      async () =>
        new Map<OralSpeakingPhase, string>([["monologue", "https://store.example/m.ogg"]]),
    );
    const accepted = await acceptSitting(store, REF, acceptInput({ preserve }));
    assert.equal(accepted.status, "accepted");
    assert.equal(preserve.mock.callCount(), 1);

    const kept = () =>
      store.recordings
        .filter((row) => row.examId === EXAM_ID)
        .map((row) => [row.phase, row.uri, row.deletedAt]);
    assert.deepEqual(
      kept(),
      [
        ["monologue", "https://store.example/m.ogg", null],
        ["debate", null, NOW],
      ],
      "the kept half plays back; the lost half is honestly disposed",
    );

    // The attach re-runs the artefact statements with no kept map at all (#86);
    // insert-if-absent is what keeps that second pass from disposing the copy
    // the accept filed.
    const outcome = await attachCorrection(store, REF, attachInput());
    assert.equal(outcome.status, "stored");
    assert.deepEqual(kept()[0], ["monologue", "https://store.example/m.ogg", null]);
  });

  it("never stores bytes for a sitting that is already corrected", async () => {
    // A duplicate finish must not file a second copy of somebody's voice next
    // to rows it will never write — the same discipline as the model call.
    await finishSitting(store);

    const preserve = mock.fn(async () => new Map<OralSpeakingPhase, string>());
    const second = await acceptSitting(store, REF, acceptInput({ preserve }));

    assert.equal(second.status, "already-corrected");
    assert.equal(preserve.mock.callCount(), 0);
  });

  it("a preserve that throws costs the copies, never the finish", async () => {
    // The hook's contract is not to throw; the second net exists because an
    // upload failure must cost the candidate a replay button, never their
    // épreuve's acceptance.
    const preserve = mock.fn(async (): Promise<ReadonlyMap<OralSpeakingPhase, string>> => {
      throw new Error("vault down");
    });
    const accepted = await acceptSitting(store, REF, acceptInput({ preserve }));
    assert.equal(accepted.status, "accepted");

    const outcome = await attachCorrection(store, REF, attachInput());
    assert.equal(outcome.status, "stored");
    const sitting = await store.readSitting(REF);
    assert.equal(sitting?.outcome, "corrected");
    assert.deepEqual(
      sitting?.recordings.map((row) => [row.uri, row.deletedAt]),
      [
        [null, NOW],
        [null, NOW],
      ],
      "every recording reads as disposed, exactly as on a deployment with no vault",
    );
  });

  it("cannot accept, correct, or read a neighbouring user's sitting", async () => {
    const neighbour: SittingRef = { examId: 42, userId: OWNER };

    const outcome = await acceptSitting(store, neighbour, acceptInput());
    assert.equal(outcome.status, "not-stored");
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
    await finishSitting(store);
    assert.equal(await store.abandonSitting(REF, new Date()), false);
    assert.equal(store.exams.find((row) => row.id === REF.examId)?.abandonedAt, null);
  });

  it("cannot mark a neighbouring user's sitting", async () => {
    // This writes a zero onto somebody's record, and exam ids are sequential.
    assert.equal(await store.abandonSitting({ examId: 42, userId: OWNER }, new Date()), false);
    assert.equal(store.exams.find((row) => row.id === 42)?.abandonedAt, null);
  });
});
