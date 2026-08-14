/**
 * POST /api/exams/:examId/finish — grade a completed exam.
 *
 * Takes multipart form data (the transcript as JSON, one WAV per speaking phase
 * as files) because a 20-minute recording is tens of megabytes and has no
 * business being base64'd into a JSON body.
 *
 * Grading runs here, on the server, well after the Live session has closed. The
 * evaluation is returned in the response as well as persisted, so the results
 * page can render even when no database is configured.
 *
 * **Where each duration comes from.** The clock — how long a phase ran, when it
 * started, when it ended — only the browser knows, so it is taken on trust and
 * stored as an audit trail. How much audio exists is a property of the bytes
 * that arrived, so it is measured HERE, out of the uploaded WAV, and that is the
 * number the DELF duration penalty is computed from. A client that miscounts, or
 * an upload that truncates, then produces a short recording rather than a long
 * claim.
 */

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { checkWavFormat, readWavFormat } from "@/lib/audio/pcm";
import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import { EXAM_ACCESS_DENIALS } from "@/lib/auth/exam-access";
import { authorizeExam } from "@/lib/auth/exam-guard";
import {
  evaluations,
  getDb,
  oralExamPhases,
  oralExams,
  oralRecordings,
  type OralSpeakingPhase,
} from "@/lib/db";
// The floor is the one rule the two rubric copies on `develop` agree on, so
// reading it from the ported module settles nothing that Phase 2 shouldn't.
import { meetsCompetencyFloor } from "@/lib/delf/orale-rubric";
import { findTopic } from "@/lib/delf/topics";
import { candidateWordCount, type TranscriptEntry } from "@/lib/delf/transcript";
import { evaluateExam, type EvaluationMode } from "@/lib/gemini/evaluate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A full audio evaluation is slow; the default serverless budget is not enough. */
export const maxDuration = 300;

/**
 * The client's payload, validated rather than asserted.
 *
 * These numbers end up in NOT NULL integer columns with `>= 0` constraints, so a
 * missing field used to travel as far as `Math.round(undefined)` → NaN and fail
 * at the INSERT — after a paid model call had already run, and inside a catch
 * that only logs. Failing here costs nothing and says what was wrong.
 *
 * `z.number()` rejects NaN and Infinity on its own in Zod 4; the explicit checks
 * below are the domain's, not the format's.
 */
const transcriptEntrySchema = z.object({
  phase: z.enum(["monologue", "debate"]),
  speaker: z.enum(["candidate", "examiner"]),
  timestamp: z.number(),
  text: z.string(),
}) satisfies z.ZodType<TranscriptEntry>;

/**
 * One phase, as the browser saw it. Deliberately carries no recorded duration:
 * the recording's length is measured from the recording, below, and a second
 * copy of it here would be a number that can disagree with the file it
 * describes.
 */
const phaseReportSchema = z
  .object({
    phase: z.enum(["monologue", "debate"]),
    /**
     * Wall clock. What the candidate watched count down.
     *
     * Bounded because it is the one number here the server cannot check against
     * anything: it decides nothing (the penalty is computed from the measured
     * recording below), but it is written to an audit column, and an audit trail
     * that will accept a four-figure hour count is decoration rather than
     * evidence. Four hours is absurd for a 13-minute task and still far outside
     * anything a stalled tab's clock could plausibly produce.
     */
    elapsedSeconds: z.number().nonnegative().max(4 * 60 * 60),
    /** Epoch ms. Null when the phase was entered but never left — an abandoned
     *  sitting that reached the finish handler another way. */
    startedAt: z.number().int().nonnegative().nullable(),
    endedAt: z.number().int().nonnegative().nullable(),
  })
  .refine(
    (report) => report.startedAt === null || report.endedAt === null || report.endedAt >= report.startedAt,
    "a phase cannot end before it started",
  );

/**
 * The largest recording this endpoint will read.
 *
 * A full 20-minute sitting at 16 kHz mono PCM is about 38 MB, and the longest
 * single task — the ~13-minute débat — about 25 MB. 64 MB is well clear of both
 * and well under anything worth spending a 5-minute serverless budget on.
 *
 * The cap exists because this is an authenticated endpoint that reads a body
 * into memory and forwards it to a metered upload API, and the browser recorder
 * is not the only thing that can reach it.
 *
 * It is enforced in two places and neither is airtight on its own. The
 * `Content-Length` check runs before `formData()` and is the only one that can
 * stop an oversized body being buffered at all — but the header is advisory and
 * absent on a chunked request. The `Blob.size` check runs after, by which point
 * the body is already in memory; what it still prevents is the expensive half,
 * the `arrayBuffer()` and the upload to the Files API. Bounding the body itself
 * properly means streaming it, which is a platform concern rather than this
 * route's.
 */
const MAX_RECORDING_BYTES = 64 * 1024 * 1024;
/** Both recordings, plus the transcript JSON and multipart overhead. */
const MAX_REQUEST_BYTES = 2 * MAX_RECORDING_BYTES + 8 * 1024 * 1024;

const finishPayloadSchema = z.object({
  topicSlug: z.string().min(1),
  transcript: z.array(transcriptEntrySchema),
  /** At most one entry per phase, and only for phases actually entered. */
  phases: z
    .array(phaseReportSchema)
    .max(2)
    .refine(
      (reports) => new Set(reports.map((report) => report.phase)).size === reports.length,
      "a phase cannot be reported twice",
    ),
  reconnectCount: z.number().int().nonnegative(),
});

const SPEAKING_PHASES = ["monologue", "debate"] as const satisfies readonly OralSpeakingPhase[];

/** One uploaded artefact, with the duration read out of its own bytes. */
interface UploadedRecording {
  phase: OralSpeakingPhase;
  blob: Blob;
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
 * refused. This endpoint grades on duration, `pcm16ToWav` is the only thing that
 * writes these files, and a WAV that is not mono 16-bit at the capture rate did
 * not come from it — so the choice is between rejecting it and quietly grading
 * against a length someone else chose. The upper bound on that length is the
 * upload cap, not a separate check: at 32 kB a second, {@link
 * MAX_RECORDING_BYTES} cannot express more than about 35 minutes.
 */
async function readRecordings(
  form: FormData,
): Promise<{ recordings: UploadedRecording[] } | { rejected: OralSpeakingPhase }> {
  const recordings: UploadedRecording[] = [];
  for (const phase of SPEAKING_PHASES) {
    const file = form.get(`audio-${phase}`);
    if (!(file instanceof Blob) || file.size === 0) continue;

    const format = readWavFormat(await file.arrayBuffer());
    if (!format || !checkWavFormat(format, INPUT_SAMPLE_RATE)) return { rejected: phase };

    recordings.push({
      phase,
      blob: file,
      byteSize: file.size,
      durationSeconds: format.durationSeconds,
    });
  }
  return { recordings };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ examId: string }> },
) {
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
  if (candidateWordCount(payload.transcript) < 20) {
    return NextResponse.json(
      {
        error:
          "La transcription ne contient presque aucune parole du candidat. L'épreuve ne peut pas être évaluée.",
      },
      { status: 422 },
    );
  }

  const oversized = SPEAKING_PHASES.find((phase) => {
    const file = form.get(`audio-${phase}`);
    return file instanceof Blob && file.size > MAX_RECORDING_BYTES;
  });
  if (oversized) {
    return NextResponse.json(
      { error: `L'enregistrement du ${oversized} est trop volumineux.` },
      { status: 413 },
    );
  }

  // In exam order, because that is what the evaluator's prompt promises the
  // model about the files it is being handed.
  const read = await readRecordings(form);
  if ("rejected" in read) {
    return NextResponse.json(
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

  const monologueSeconds = measuredSeconds("monologue");
  const debateSeconds = measuredSeconds("debate");

  // Audio-aware grading whenever we actually have a recording; the text path is
  // the documented fallback, and the experiment harness can force either.
  const requestedMode = form.get("mode");
  const mode: EvaluationMode =
    requestedMode === "text" || recordings.length === 0 ? "text" : "audio";

  try {
    const result = await evaluateExam({
      mode,
      topic,
      transcript: payload.transcript,
      monologueSeconds,
      debateSeconds,
      // Labelled, not just ordered: when only one phase recorded — a microphone
      // denied before the monologue, a headset unplugged mid-débat — the
      // corrector has to be told which task it is listening to, or it assumes
      // the file covers the épreuve and grades the half it cannot hear.
      audio: recordings.map((recording) => ({
        phase: recording.phase,
        blob: recording.blob,
      })),
    });

    if (persistedExamId !== null) {
      // The four writes below are not atomic, and cannot be as written: this
      // driver is `neon-http`, whose `db.transaction()` throws. A failure after
      // the UPDATE leaves a sitting marked finished with no correction attached,
      // or — since Phase 6 — with phase rows and no recording rows beside them.
      // `db.batch()` — which neon-http implements as a real transaction — is the
      // fix, and belongs with the read path that would expose the inconsistency
      // in the first place. See #16.
      try {
        const db = getDb();
        const id = persistedExamId;

        await db
          .update(oralExams)
          .set({
            phase: "finished",
            reconnectCount: payload.reconnectCount,
            transcript: payload.transcript,
            finishedAt: new Date(),
          })
          // The ownership predicate is repeated here on purpose: the check above
          // is what makes the request legal, this is what keeps the statement
          // itself safe if the two ever drift apart.
          .where(and(eq(oralExams.id, id), eq(oralExams.userId, userId)));

        // Per-phase speaking time is a row per phase, not a column pair on the
        // sitting. `doNothing` because a repeated finish must not rewrite how
        // long the candidate spoke; the real duplicate guard is Phase 11.
        //
        // Only the phases the candidate actually entered get a row. A sitting
        // abandoned during the monologue has no débat, and a débat row claiming
        // zero seconds would be a record of a task that never happened.
        if (payload.phases.length > 0) {
          await db
            .insert(oralExamPhases)
            .values(
              payload.phases.map((report) => ({
                examId: id,
                phase: report.phase,
                // Measured from the audio, not from `report.elapsedSeconds`.
                // This column feeds the duration penalty; the clock is the two
                // timestamps beside it.
                spokenSeconds: Math.round(measuredSeconds(report.phase)),
                startedAt: report.startedAt === null ? null : new Date(report.startedAt),
                endedAt: report.endedAt === null ? null : new Date(report.endedAt),
              })),
            )
            .onConflictDoNothing();
        }

        // One row per artefact. `uri` stays null and `deletedAt` is stamped:
        // nothing durably stores the bytes — the schema's header is explicit
        // that retention is forbidden — so what survives is the honest record
        // that a recording of this length and this size existed and is gone.
        // The upload to the Files API inside `evaluateExam` is the transient
        // copy, and it is not ours to reference from here.
        if (recordings.length > 0) {
          const now = new Date();
          await db
            .insert(oralRecordings)
            .values(
              recordings.map((recording) => ({
                examId: id,
                phase: recording.phase,
                uri: null,
                mimeType: "audio/wav",
                byteSize: recording.byteSize,
                durationSeconds: Math.round(recording.durationSeconds),
                deletedAt: now,
              })),
            )
            .onConflictDoNothing();
        }

        await db.insert(evaluations).values({
          examId: id,
          // Deliberately no `recordingId`. The correction listened to BOTH
          // artefacts, and a single FK can name only one of them; naming either
          // would be a smaller lie than null but still a lie. The recordings are
          // attributable through `exam_id`, and the column stays as Phase 2 left
          // it until something reconciles it with a per-phase recording.
          mode: result.mode,
          // The five bands are columns; `criteria` is keyed by the same five
          // criterion names, so it spreads straight in.
          ...result.criteria,
          rawScore25: result.rawScore25,
          durationPenalty: result.rawScore25 - result.score25,
          score25: result.score25,
          meetsFloor: meetsCompetencyFloor(result.score25),
          feedback: result.feedback,
          model: result.model,
          promptVersion: result.promptVersion,
          latencySeconds: result.latencySeconds,
        });
      } catch (error) {
        // The candidate has their grade; losing the row is a logging problem,
        // not a reason to show them an error.
        console.error("[finish] evaluation succeeded but persistence failed:", error);
      }
    }

    return NextResponse.json({ evaluation: result });
  } catch (error) {
    console.error("[finish] evaluation failed:", error);
    return NextResponse.json(
      { error: "L'évaluation a échoué. Réessayez dans un instant." },
      { status: 502 },
    );
  }
}
