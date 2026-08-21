/**
 * POST /api/exams/:examId/finish — grade a completed exam.
 *
 * Takes multipart form data (the transcript as JSON, one recording per speaking
 * phase as files) because a 20-minute recording is megabytes and has no business
 * being base64'd into a JSON body.
 *
 * Grading runs here, on the server, well after the Live session has closed. The
 * evaluation is returned in the response as well as persisted, so the results
 * page can render even when no database is configured.
 *
 * **Where each duration comes from.** The clock — how long a phase ran, when it
 * started, when it ended — only the browser knows, so it is taken on trust and
 * stored as an audit trail. How much audio exists is a property of the bytes
 * that arrived, so it is measured HERE, out of the uploaded file, and that is
 * the number the DELF duration penalty is computed from. A client that
 * miscounts, or an upload that truncates, then produces a short recording rather
 * than a long claim.
 *
 * **What this route no longer does.** Since Phase 8 it does not write anything
 * itself. It reads the request, decides what the correction should be graded
 * from, and hands the result to `lib/exams/sitting-persistence.ts` — which owns
 * the order the writes happen in, what a second submission of the same sitting
 * costs, and how a sitting that was graded but not stored is described
 * afterwards. That move is what closed #16 and #17: the writes became one
 * batch, and the arithmetic behind them became something `node --test` can
 * reach.
 *
 * **And what it no longer throws away.** It used to hand the blobs to the
 * corrector and drop them; since #98 the `preserve` hook below files them in
 * the recording vault so the correction can play them back. Same seam as the
 * writes: this route only says HOW to keep a recording, and
 * `sitting-persistence.ts` decides WHEN — after the claim, by its winner.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import { DEV_TOOLS_ENABLED } from "@/lib/dev-tools";
import { EXAM_ACCESS_DENIALS } from "@/lib/auth/exam-access";
import { authorizeExam } from "@/lib/auth/exam-guard";
import type { OralSpeakingPhase } from "@/lib/db";
import { neonSittingStore } from "@/lib/db/sittings";
import { correctSitting, type CorrectionRow } from "@/lib/exams/sitting-persistence";
import { PARTICIPATION_WORD_FLOOR } from "@/lib/delf/orale-rubric";
import { findTopic } from "@/lib/delf/topics";
import { candidateWordCount } from "@/lib/delf/transcript";
// Lives outside this file so it can be unit-tested: nothing in a route that
// imports `server-only`, Clerk and the database client can be loaded by
// `node --test`, and the request validation is the last thing that should go
// uncovered for that reason. See `finish-payload.test.ts`.
import { finishPayloadSchema } from "@/lib/exams/finish-payload";
// The binary half of the same request, extracted for the same reason.
import {
  MAX_RECORDING_BYTES,
  MAX_REQUEST_BYTES,
  measureUploadedRecording,
} from "@/lib/exams/uploaded-recording";
import { evaluateExam, type EvaluationMode, type EvaluationResult } from "@/lib/gemini/evaluate";
// Where the recordings go to outlive this request (#98) — when a store is
// configured, which is a real branch rather than an assumption: without one,
// every row below is written transient, exactly as before.
import { recordingVault } from "@/lib/storage/recording-vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A full audio evaluation is slow; the default serverless budget is not enough. */
export const maxDuration = 300;

// The size limits live in `lib/exams/uploaded-recording.ts`, with the platform
// arithmetic that sets them. They are enforced in two places here and neither is
// airtight on its own. The `Content-Length` check runs before `formData()` and is
// the only one that can stop an oversized body being buffered at all — but the
// header is advisory and absent on a chunked request. The `Blob.size` check runs
// after, by which point the body is already in memory; what it still prevents is
// the expensive half, the `arrayBuffer()` and the upload to the Files API.
// Bounding the body itself properly means streaming it, which is a platform
// concern rather than this route's — and since #24 the platform's own limit sits
// just above ours, so an oversized request is refused either way. What ours buys
// is a refusal the candidate can read.

const SPEAKING_PHASES = ["monologue", "debate"] as const satisfies readonly OralSpeakingPhase[];

/** One uploaded artefact, with the duration read out of its own bytes. */
interface UploadedRecording {
  phase: OralSpeakingPhase;
  blob: Blob;
  /** What the bytes turned out to be, which is not what the form claimed. */
  mimeType: string;
  byteSize: number;
  durationSeconds: number;
}

/**
 * Pull the per-phase recordings out of the form and measure each one.
 *
 * A phase with no file is simply absent: a candidate whose microphone was
 * refused, or died during the débat, has audio for some phases and not others,
 * and that is a state to report rather than to paper over with a zero-length
 * placeholder.
 *
 * A file that is *present but unmeasurable* is a different thing entirely and is
 * refused — see `measureUploadedRecording`, which decides the format from the
 * bytes rather than from what the form said they were.
 *
 * One pass over the two phases, and the size check happens inside it — before
 * the `arrayBuffer()` that is the expensive half. Two loops reading the same two
 * form fields is one edit away from being two loops in the wrong order.
 */
type RecordingRejection = { rejected: OralSpeakingPhase; reason: "too-large" | "unreadable" };

async function readRecordings(
  form: FormData,
): Promise<{ recordings: UploadedRecording[] } | RecordingRejection> {
  const recordings: UploadedRecording[] = [];
  for (const phase of SPEAKING_PHASES) {
    const file = form.get(`audio-${phase}`);
    if (!(file instanceof Blob) || file.size === 0) continue;
    if (file.size > MAX_RECORDING_BYTES) return { rejected: phase, reason: "too-large" };

    const measured = measureUploadedRecording(await file.arrayBuffer(), INPUT_SAMPLE_RATE);
    if (!measured) return { rejected: phase, reason: "unreadable" };

    recordings.push({
      phase,
      blob: file,
      mimeType: measured.mimeType,
      byteSize: file.size,
      durationSeconds: measured.durationSeconds,
    });
  }
  return { recordings };
}

export async function POST(request: Request, context: { params: Promise<{ examId: string }> }) {
  const { examId } = await context.params;

  /**
   * Authentication and ownership, before anything else this route does.
   *
   * Exam ids are sequential serials, so without the second check any signed-in
   * user could finish — and overwrite the transcript of — a neighbouring id's
   * exam. It runs first rather than after validation for two reasons: a caller
   * who does not own the sitting learns nothing about the payload it would have
   * accepted, and the (paid, minutes-long) model call has not started yet.
   *
   * `no-sitting` is not a refusal. The request is legal, it just addresses no
   * row we can verify — no database, a degraded `local-…` id, or a lookup that
   * failed — so the exam is graded and nothing is written. That is the same
   * bargain the route has always made with a missing `DATABASE_URL`.
   */
  const access = await authorizeExam(examId);
  if (access.status === "denied") {
    const { status, error } = EXAM_ACCESS_DENIALS[access.reason];
    return NextResponse.json({ error }, { status });
  }
  const { userId } = access;
  const persistedExamId = access.status === "owned" ? access.examId : null;

  // Before the body is buffered, which is the only point at which refusing it
  // is free. Advisory — see MAX_REQUEST_BYTES — but the cheap half of the guard.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "Requête trop volumineuse" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Requête illisible" }, { status: 400 });
  }

  const payloadRaw = form.get("payload");
  if (typeof payloadRaw !== "string") {
    return NextResponse.json({ error: "payload manquant" }, { status: 400 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(payloadRaw);
  } catch {
    return NextResponse.json({ error: "payload invalide" }, { status: 400 });
  }

  const parsed = finishPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "payload invalide", details: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }
  const payload = parsed.data;

  const topic = findTopic(payload.topicSlug);
  if (!topic) return NextResponse.json({ error: "Sujet inconnu" }, { status: 404 });

  // Refuse to invent a grade for an exam that never happened. A model handed an
  // empty transcript will still confidently return five scores.
  //
  // The same floor the rubric now applies per part, imported rather than
  // written twice: this gate and the halving are the same judgement about what
  // counts as having spoken, asked at two scopes, and a bare 20 here would let
  // them drift apart silently.
  if (candidateWordCount(payload.transcript) < PARTICIPATION_WORD_FLOOR) {
    return NextResponse.json(
      {
        error:
          "La transcription ne contient presque aucune parole du candidat. L'épreuve ne peut pas être évaluée.",
      },
      { status: 422 },
    );
  }

  // In exam order, because that is what the evaluator's prompt promises the
  // model about the files it is being handed.
  const read = await readRecordings(form);
  if ("rejected" in read) {
    return read.reason === "too-large"
      ? NextResponse.json(
          { error: `L'enregistrement du ${read.rejected} est trop volumineux.` },
          { status: 413 },
        )
      : NextResponse.json(
          {
            error: `L'enregistrement du ${read.rejected} n'est pas exploitable. Réessayez depuis l'application.`,
          },
          { status: 400 },
        );
  }
  const { recordings } = read;

  // The two tables tell one story, so they are not allowed to disagree about
  // which phases happened. A recording for a phase the client did not report is
  // a row in `oral_recordings` with nothing beside it in `oral_exam_phases`, and
  // "which half ran short?" stops being answerable from either.
  const reportedPhases = new Set(payload.phases.map((report) => report.phase));
  const unreported = recordings.find((recording) => !reportedPhases.has(recording.phase));
  if (unreported) {
    return NextResponse.json(
      { error: `Un enregistrement a été envoyé pour une phase absente du récapitulatif.` },
      { status: 400 },
    );
  }

  /**
   * The measured length of a phase's recording, in seconds.
   *
   * Zero for a phase with no audio, and that is the intended answer rather than
   * a gap: the duration penalty exists to dock a candidate for not producing the
   * épreuve, and a phase nobody has a recording of has not been shown to have
   * been produced. The wall clock in `payload.phases` is stored beside it, so
   * the difference between "spoke for ninety seconds" and "spoke for seven
   * minutes into a dead microphone" stays readable afterwards.
   */
  const measuredSeconds = (phase: OralSpeakingPhase): number =>
    recordings.find((recording) => recording.phase === phase)?.durationSeconds ?? 0;

  /**
   * DEVELOPMENT ONLY — the duration a typed phase claims (#36).
   *
   * Three conditions, and each removes a different way this could become the
   * client-claimed duration the rest of this file exists to refuse:
   *
   *  1. **Only where the dev tooling is switched on.** Off by default, vetoed
   *     outright on a production deployment, and granted elsewhere only by
   *     `NEXT_PUBLIC_DEV_TOOLS=1` on that specific environment. See
   *     `lib/dev-tools.ts` — and note this is the same flag the panel that
   *     produces the claim is gated on, so the two cannot disagree.
   *  2. **Only with no recording for that phase.** Audio present always wins, so
   *     a real sitting cannot have its measured duration talked upwards.
   *  3. **Bounded by the schema**, like every other number the browser sends.
   *
   * What it buys: a typed sitting measures zero seconds and would otherwise take
   * the short-duration penalty every single time, which makes the threshold —
   * the rubric's one piece of arithmetic that changes a mark — untestable
   * without twenty minutes of speaking French.
   */
  const devSeconds = (phase: OralSpeakingPhase): number | null => {
    if (!DEV_TOOLS_ENABLED) return null;
    if (!payload.devSeconds) return null;
    if (recordings.some((recording) => recording.phase === phase)) return null;
    return payload.devSeconds[phase];
  };

  const monologueSeconds = devSeconds("monologue") ?? measuredSeconds("monologue");
  const debateSeconds = devSeconds("debate") ?? measuredSeconds("debate");

  /**
   * Audio-aware grading whenever we actually have a recording; the text path is
   * the fallback for a sitting that produced none.
   *
   * The caller does NOT get a say. This route used to honour a `mode=text` form
   * field, described as an escape hatch for the experiment harness — but the
   * harness has never used it (`experiments/audio-vs-text.ts` and
   * `scripts/verify-eval.ts` both call `evaluateExam` directly, which is the
   * right way to run an experiment: no auth, no route, no sitting). So the field
   * was reachable only by a candidate hand-crafting a request for their own
   * exam, and the two modes grade phonologie differently — one listens, one
   * infers fluency from counting hesitations in the transcript. Letting the
   * graded party pick which is not an escape hatch, it is a choice of mark.
   */
  const mode: EvaluationMode = recordings.length === 0 ? "text" : "audio";

  const grade = () =>
    evaluateExam({
      mode,
      topic,
      transcript: payload.transcript,
      monologueSeconds,
      debateSeconds,
      // The examiner's early goodbyes, as the controller counted them (#92).
      // Positive, this adds the incident paragraph to the prompt and excuses
      // the débat from both penalties — taken on trust like the transcript,
      // and bounded the same way (see `finish-payload.ts`).
      earlyClosingCount: payload.earlyClosingCount,
      // Labelled, not just ordered: when only one phase recorded — a microphone
      // denied before the monologue, a headset unplugged mid-débat — the
      // corrector has to be told which task it is listening to, or it assumes
      // the file covers the épreuve and grades the half it cannot hear.
      audio: recordings.map((recording) => ({
        phase: recording.phase,
        blob: recording.blob,
        // The type the bytes turned out to be. The Files API is told what it is
        // being handed, and being handed `audio/wav` for an Opus stream is a
        // upload that succeeds and a correction that hears nothing.
        mimeType: recording.mimeType,
      })),
    });

  try {
    // No sitting to write to — no database, a degraded `local-…` id, or an
    // ownership question that went unanswered. Grade and hand it straight back;
    // the results page renders from the response either way.
    if (persistedExamId === null) {
      return NextResponse.json({ evaluation: await grade(), persisted: false });
    }

    /**
     * Grade and persist, at most once per sitting.
     *
     * Everything about the ordering — the duplicate check before the paid call,
     * the claim after it, the three writes in one batch — lives in
     * `lib/exams/sitting-persistence.ts`, which is where it can be tested. This
     * route's remaining job is to decide what the candidate sees.
     */
    let graded: EvaluationResult | null = null;
    const outcome = await correctSitting(
      neonSittingStore(),
      { examId: persistedExamId, userId },
      {
        transcript: payload.transcript,
        reconnectCount: payload.reconnectCount,
        earlyClosingCount: payload.earlyClosingCount,
        phases: payload.phases,
        recordings: recordings.map((recording) => ({
          phase: recording.phase,
          mimeType: recording.mimeType,
          byteSize: recording.byteSize,
          durationSeconds: recording.durationSeconds,
        })),
        evaluate: async () => {
          graded = await grade();
          return toCorrectionRow(graded);
        },
        /**
         * Keep the bytes the rows will point at (#98). Called by the winner of
         * the claim, after grading — see `sitting-persistence.ts` for why that
         * ordering — and best-effort per artefact: a phase the vault refuses is
         * logged and written transient, because losing the copy must cost the
         * candidate a replay button, never their correction. On a deployment
         * with no vault this returns the empty map and nothing changes.
         */
        preserve: async () => {
          const kept = new Map<OralSpeakingPhase, string>();
          const vault = recordingVault();
          if (!vault) return kept;
          for (const recording of recordings) {
            try {
              kept.set(
                recording.phase,
                await vault.store(
                  persistedExamId,
                  recording.phase,
                  recording.blob,
                  recording.mimeType,
                ),
              );
            } catch (error) {
              console.error(`[finish] could not keep the ${recording.phase} recording:`, error);
            }
          }
          return kept;
        },
        now: () => new Date(),
      },
    );

    if (outcome.status === "graded-not-stored") {
      // The candidate has their grade; losing the row is a logging problem, not
      // a reason to show them an error. The sitting reads as `uncorrected`
      // until it is finished again, which re-runs this whole path.
      console.error("[finish] evaluation succeeded but persistence failed:", outcome.error);
    }

    /**
     * A second submission returns the correction that already exists rather
     * than the one this request would have produced — there is one grade per
     * sitting, and it is the stored one.
     *
     * It is slightly thinner than a fresh result: `shortParts` and the pre-snap
     * bands are the corrector's working, which has no columns and is not worth
     * inventing them for. The results page treats both as optional (see
     * `results-client.tsx`) precisely because a stored correction is the other
     * thing it can be rendering.
     */
    return NextResponse.json({
      evaluation: graded ?? outcome.correction,
      persisted: outcome.status !== "graded-not-stored",
    });
  } catch (error) {
    console.error("[finish] evaluation failed:", error);
    return NextResponse.json(
      { error: "L'évaluation a échoué. Réessayez dans un instant." },
      { status: 502 },
    );
  }
}

/** The stored subset of a correction. The rest is diagnostic, not a column. */
function toCorrectionRow(result: EvaluationResult): CorrectionRow {
  return {
    mode: result.mode,
    criteria: result.criteria,
    rawScore25: result.rawScore25,
    // The penalty the rubric asked for, not the points the score happened to
    // lose. They differ only below 3/25, where the score floors at 0 first — and
    // "docked 3, could only absorb 2" is the truer record. The route computes
    // neither: since #9 both numbers, and the floor verdict beside them, come
    // back from the one rubric.
    durationPenalty: result.durationPenalty,
    // The other half of the arithmetic, and on a walk-out the larger half: what
    // the halving took off for a part that never happened. Stored beside the
    // duration penalty rather than folded into it — see `evaluations`.
    absencePenalty: result.absencePenalty,
    score25: result.score25,
    meetsFloor: result.meetsFloor,
    feedback: result.feedback,
    model: result.model,
    promptVersion: result.promptVersion,
    latencySeconds: result.latencySeconds,
  };
}
