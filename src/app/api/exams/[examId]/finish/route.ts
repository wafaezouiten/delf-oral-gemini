/**
 * POST /api/exams/:examId/finish — grade a completed exam.
 *
 * Takes multipart form data (the transcript as JSON, one recording per speaking
 * phase as files) because a 20-minute recording is megabytes and has no business
 * being base64'd into a JSON body.
 *
 * Grading runs here, on the server, well after the Live session has closed —
 * and since #86, BEHIND the response on every persisted sitting: the route
 * answers 202 the moment the sitting is claimed, its rows are written and the
 * vault holds the bytes, and the correction attaches in `after()` while the
 * finished screen polls `/status`. Only the degraded path (no database, a
 * `local-…` id) still grades synchronously and returns the evaluation in the
 * body, because it has no row for a poll to find.
 *
 * **Where each duration comes from.** The clock — how long a phase ran, when it
 * started, when it ended — only the browser knows, so it is taken on trust and
 * stored as an audit trail. How much audio exists is a property of the bytes
 * that arrived, so it is measured HERE, out of the uploaded file, and that is
 * the number the DELF duration penalty is computed from. A client that
 * miscounts, or an upload that truncates, then produces a short recording rather
 * than a long claim. One deliberate exception since #92: a payload can EXCUSE
 * the débat from that penalty by reporting the examiner closed the épreuve
 * early, and the report rests on the client-authored transcript — a forgeable
 * claim, accepted knowingly because the browser is the only witness this
 * architecture has and the only mark at stake is the sender's own. The
 * decision, and what the clamp on it does and does not buy, live on
 * `resolveEarlyClosingCount`.
 *
 * **What this route no longer does.** Since Phase 8 it does not write anything
 * itself. It reads the request, decides what the correction should be graded
 * from, and hands the result to `lib/exams/sitting-persistence.ts` — which owns
 * the order the writes happen in, what a second submission of the same sitting
 * costs, and how a sitting that was graded but not stored is described
 * afterwards. That move is what closed #16 and #17: the writes became one
 * batch, and the arithmetic behind them became something `node --test` can
 * reach. Since #86 that module's finish path is two halves — `acceptSitting`
 * before the response, `attachCorrection` behind it — and the ordering
 * argument lives there.
 *
 * **And what it no longer throws away.** It used to hand the blobs to the
 * corrector and drop them; since #98 the `preserve` hook below files them in
 * the recording vault so the correction can play them back. Same seam as the
 * writes: this route only says HOW to keep a recording, and
 * `sitting-persistence.ts` decides WHEN — after the claim, by its winner.
 */

import { NextResponse, after } from "next/server";
import { z } from "zod";

import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import { DEV_TOOLS_ENABLED } from "@/lib/dev-tools";
import { EXAM_ACCESS_DENIALS } from "@/lib/auth/exam-access";
import { authorizeExam } from "@/lib/auth/exam-guard";
import type { OralSpeakingPhase } from "@/lib/db";
import { neonSittingStore } from "@/lib/db/sittings";
import {
  acceptSitting,
  attachCorrection,
  type CorrectionRow,
} from "@/lib/exams/sitting-persistence";
import { resolveEarlyClosingCount } from "@/lib/delf/early-closing";
import { findTopic } from "@/lib/delf/topics";
// Lives outside this file so it can be unit-tested: nothing in a route that
// imports `server-only`, Clerk and the database client can be loaded by
// `node --test`, and the request validation is the last thing that should go
// uncovered for that reason. See `finish-payload.test.ts`.
import { finishPayloadSchema } from "@/lib/exams/finish-payload";
// The rule that settles one part's duration, extracted for the same reason —
// it is the arithmetic that decides a mark, and #203 gave it a second input.
import { gradedPhaseSeconds } from "@/lib/exams/graded-duration";
// The two refusals a sitting nobody can be heard in earns, and the order
// between them — extracted so a test can hold the order. See its module comment.
import { participationRefusal } from "@/lib/exams/participation-refusal";
// The binary half of the same request, extracted for the same reason.
import {
  MAX_RECORDING_BYTES,
  MAX_REQUEST_BYTES,
  MIN_RECORDING_SECONDS,
  measureUploadedRecording,
} from "@/lib/exams/uploaded-recording";
import { evaluateExam, type EvaluationMode, type EvaluationResult } from "@/lib/gemini/evaluate";
// Which part of the grading died, read off the tagged throw (#73).
import { evaluationFailureReason } from "@/lib/gemini/evaluation-failure";
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
 * And a file that measures under `MIN_RECORDING_SECONDS` is folded into the
 * first case (#73): a stub of seconds is treated as the absence it effectively
 * is, everywhere downstream at once — the grading mode, the corrector's
 * attachments, the stored rows and the vault all see one consistent answer.
 * The constant's own comment is where the threshold is argued for.
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

    // A measurable stub is treated as absence, not refused (#73): a skipped
    // débat or a typed exposé (#51) legitimately produces one, so a 400 here
    // would fail sittings that are fine. Logged because a silent drop would
    // read as "no file arrived" to anyone chasing the very reports this serves.
    if (measured.durationSeconds < MIN_RECORDING_SECONDS) {
      console.info(
        `[finish] dropping the ${phase} recording: ` +
          `${measured.durationSeconds.toFixed(1)}s is under the ${MIN_RECORDING_SECONDS}s floor`,
      );
      continue;
    }

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
  // When the request reached this function, so the wait #86 is about can be
  // read off the logs as its segments rather than argued about as one blur.
  const receivedAt = Date.now();
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

  // Timed because it can be more than parsing: `formData()` consumes the body,
  // so where the platform streams the request to the function, this segment is
  // the candidate's upload arriving. A platform that buffers the body before
  // invoking the handler books that time before `receivedAt` instead — read
  // the number with the deployment in mind, not as the upload by definition.
  const formReadStartedAt = Date.now();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Requête illisible" }, { status: 400 });
  }
  const formReadSeconds = (Date.now() - formReadStartedAt) / 1000;

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

  /**
   * Refuse to grade a sitting nobody can be heard in — and say whose failure it
   * was, in that order.
   *
   * Both halves and, more importantly, the order between them live in
   * `participation-refusal.ts`. Asked here rather than after `readRecordings`
   * so a refusal is decided without spending the upload, and long before
   * anything paid is called.
   *
   * The evidence is `soloVoicedSeconds` over `soloSeconds` — voiced audio with
   * the examiner silent, against the time the candidate had to produce it —
   * and the numerator falls back to its predecessor only for a page loaded
   * before that field existed. What arrives decides whether a candidate who sat
   * out the débat is graded on half a mark or refused a mark at all; the
   * schema's own comments carry the argument, and the rule itself is
   * `partsSpokenButUntranscribed`.
   */
  const voiced = payload.soloVoicedSeconds ?? payload.voicedSeconds;
  const refusal = participationRefusal(payload.transcript, {
    monologue: {
      voicedSeconds: voiced?.monologue ?? 0,
      soloSeconds: payload.soloSeconds?.monologue,
    },
    debate: {
      voicedSeconds: voiced?.debate ?? 0,
      soloSeconds: payload.soloSeconds?.debate,
    },
  });
  if (refusal) {
    return NextResponse.json(
      // `reason` and `parts` only where they mean something: an absent sitting
      // has no part to name, and the screen reads the message either way.
      refusal.reason === "transcription"
        ? { error: refusal.message, reason: refusal.reason, parts: refusal.parts }
        : { error: refusal.message },
      { status: 422 },
    );
  }

  // In exam order, because that is what the evaluator's prompt promises the
  // model about the files it is being handed.
  const measureStartedAt = Date.now();
  const read = await readRecordings(form);
  const measureSeconds = (Date.now() - measureStartedAt) / 1000;
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
   * The duration of a part, as everything downstream of this route sees it.
   *
   * ONE number per part, and that is the point: it is what the rubric's tiers
   * and duration penalty are computed from, what the corrector is told, and
   * what `oral_exam_phases.spoken_seconds` stores — so the row a results page
   * renders cannot disagree with the correction beside it (#17). On a real
   * sitting it is the measured audio and nothing else; the two development
   * claims below are the only things that can move it, `gradedPhaseSeconds`
   * owns what each of them is allowed to do, and neither is read at all in a
   * production build.
   *
   * NOT `oral_recordings.duration_seconds`, which stays the length of the bytes
   * it describes — that column is what the playback route serves and what the
   * player prints before it has fetched a single frame.
   */
  const gradedSeconds = (phase: OralSpeakingPhase): number =>
    gradedPhaseSeconds({
      measuredSeconds: measuredSeconds(phase),
      hasRecording: recordings.some((recording) => recording.phase === phase),
      devClaimedSeconds: payload.devSeconds?.[phase],
      devSkippedSeconds: payload.devSkippedSeconds?.[phase],
      devToolsEnabled: DEV_TOOLS_ENABLED,
    });

  const monologueSeconds = gradedSeconds("monologue");
  const debateSeconds = gradedSeconds("debate");

  /**
   * The phase rows, carrying that same duration to the writer (#203).
   *
   * Resolved here rather than in `deriveArtefactRows` because this is where the
   * decision about what a client may claim lives, and the derivation stays a
   * pure mapping of what it was handed.
   */
  const phaseReports = payload.phases.map((report) => ({
    ...report,
    gradedSeconds: gradedSeconds(report.phase),
  }));

  /**
   * The examiner's early goodbyes (#92) — the client's count, clamped to what
   * the transcript beside it shows. NOT an anti-forgery check: the transcript
   * arrives in the same request, so the clamp bounds an incoherent or buggy
   * claim, never a fabricated one — see the header above for why that trust
   * is accepted, and `resolveEarlyClosingCount` for the whole decision, where
   * `node --test` can reach it; this route only owes it the payload.
   *
   * Resolved ONCE, here, for every consumer downstream — the corrector's
   * paragraph, the rubric's waiver, the stored column and the note the
   * results page keys on it — because a count stored as 2 while the penalties
   * stood would put « n'a pas été retenue contre vous » above a mark it was
   * retained against.
   */
  const earlyClosingCount = resolveEarlyClosingCount(payload.earlyClosingCount, payload.transcript);

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

  /**
   * The candidate's wait, as its segments (#86): the upload arriving
   * (`formReadSeconds`), the bytes being measured, the Files API uploads and
   * the corrector (from the evaluation, split there for the same reason), and
   * the whole route. One line per finish, so the argument about which lever to
   * pull next is an argument about numbers read off a deployment's logs.
   * `null` segments mean no fresh grading ran — a duplicate submission returns
   * the stored correction and pays neither the uploads nor the model, and a
   * grading that threw died before it could report its split. The `mode` is
   * carried so a text sitting's honest `uploadSeconds: 0` is not read as a
   * measurement of uploads that never happened.
   */
  const logTimings = (evaluation: EvaluationResult | null) => {
    const seconds = (value: number) => Number(value.toFixed(2));
    console.info(
      "[finish] timings",
      JSON.stringify({
        mode,
        formReadSeconds: seconds(formReadSeconds),
        measureSeconds: seconds(measureSeconds),
        uploadSeconds: evaluation ? seconds(evaluation.uploadSeconds) : null,
        modelSeconds: evaluation ? seconds(evaluation.modelSeconds) : null,
        totalSeconds: seconds((Date.now() - receivedAt) / 1000),
        recordings: recordings.map((recording) => ({
          phase: recording.phase,
          bytes: recording.byteSize,
        })),
      }),
    );
  };

  const grade = () =>
    evaluateExam({
      mode,
      topic,
      transcript: payload.transcript,
      monologueSeconds,
      debateSeconds,
      // The examiner's early goodbyes, as the controller counted them and the
      // transcript corroborated them — see the derivation above (#92).
      // Positive, this adds the incident paragraph to the prompt and excuses
      // the débat from both penalties.
      earlyClosingCount,
      // How many times the Live session dropped and was reopened mid-épreuve
      // (#189). Passed straight from the payload, unlike the goodbyes above,
      // and deliberately unclamped: there is nothing in the transcript that
      // corroborates a reconnect, and nothing this number can buy — it reaches
      // the prompt and no penalty, so the worst a wrong one does is ask the
      // corrector to be charitable about gaps in a transcript that has none.
      reconnectCount: payload.reconnectCount,
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

  // Hoisted above the try so the catch can hand it to `logTimings`: a grading
  // that succeeded before persistence failed still has a split worth logging,
  // and one that threw reports null segments beside the route's own.
  let graded: EvaluationResult | null = null;

  try {
    // No sitting to write to — no database, a degraded `local-…` id, or an
    // ownership question that went unanswered. Grade and hand it straight back;
    // the results page renders from the response either way. Synchronous on
    // purpose, #86 notwithstanding: with no row to poll and no store to attach
    // to, "come back for it" has nowhere to point.
    if (persistedExamId === null) {
      graded = await grade();
      logTimings(graded);
      return NextResponse.json({ evaluation: graded, persisted: false });
    }

    const store = neonSittingStore();
    const ref = { examId: persistedExamId, userId };
    const measuredRecordings = recordings.map((recording) => ({
      phase: recording.phase,
      mimeType: recording.mimeType,
      byteSize: recording.byteSize,
      durationSeconds: recording.durationSeconds,
    }));

    /**
     * Accept, answer, then grade — in that order (#86).
     *
     * The candidate's wait used to contain the whole correction: thirty to
     * sixty seconds of model call after the upload was already safe. Now the
     * response goes out the moment the sitting is claimed, its artefact rows
     * are written and the vault has the bytes; the grading runs behind it in
     * `after()`, and the finished screen polls the status route until the
     * correction lands. The ordering argument this reverses, and what the
     * reversal costs, live on `acceptSitting`.
     */
    const accepted = await acceptSitting(store, ref, {
      transcript: payload.transcript,
      reconnectCount: payload.reconnectCount,
      // The corroborated figure, not the raw claim — the stored count is
      // what the results page keys the « not held against you » note on,
      // so it must be the number the grading actually honoured.
      earlyClosingCount,
      phases: phaseReports,
      recordings: measuredRecordings,
      /**
       * Keep the bytes the rows will point at (#98). Called by the winner of
       * the claim, before the response — the whole point of the accept is
       * that the audio is SAFE when the candidate is told they may leave —
       * and best-effort per artefact: a phase the vault refuses is logged and
       * written transient, because losing the copy must cost the candidate a
       * replay button, never their finish. On a deployment with no vault this
       * returns the empty map and nothing changes.
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
    });

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
    if (accepted.status === "already-corrected") {
      logTimings(null);
      return NextResponse.json({ evaluation: accepted.correction, persisted: true });
    }

    if (accepted.status === "not-stored") {
      // Nothing about the sitting is safe, so this is a refusal, not an
      // acceptance with a caveat: the tab still holds the only good copy, and
      // the 502 is what puts « Réessayer l'envoi » in front of it. `store` is
      // #73's word for this, spoken here because this path never reaches the
      // catch below.
      console.error(
        `[finish] the sitting could not be accepted (reason=store, exam=${examId}):`,
        accepted.error,
      );
      logTimings(null);
      return NextResponse.json(
        { error: "L'évaluation a échoué. Réessayez dans un instant.", reason: "store" },
        { status: 502 },
      );
    }

    /**
     * Accepted: the response below ends the candidate's wait, and the grading
     * runs after it on the same invocation — `after()` keeps the function
     * alive inside the same `maxDuration` budget, and the recording blobs are
     * still in scope, so nothing needs re-reading from anywhere.
     *
     * Every failure in here can only be logged: the response is gone, and the
     * candidate's recovery is the poll timing out into « Réessayer l'envoi » —
     * which re-runs this whole path, finds the sitting uncorrected, re-claims
     * and grades again. The reasons are #73's, so the log still names which
     * part died.
     */
    after(async () => {
      try {
        const outcome = await attachCorrection(store, ref, {
          phases: phaseReports,
          recordings: measuredRecordings,
          evaluate: async () => {
            graded = await grade();
            return toCorrectionRow(graded);
          },
          now: () => new Date(),
        });
        if (outcome.status === "graded-not-stored") {
          console.error(
            `[finish] evaluation succeeded but persistence failed (reason=store, exam=${examId}):`,
            outcome.error,
          );
        }
        logTimings(graded);
      } catch (error) {
        const reason = evaluationFailureReason(error) ?? "unknown";
        console.error(
          `[finish] background correction failed (reason=${reason}, exam=${examId}):`,
          error,
        );
        logTimings(graded);
      }
    });

    // 202, not 200: accepted, not corrected. The body carries no evaluation —
    // the finished screen polls the status route and navigates when the
    // correction exists, and the results page reads it from the database.
    return NextResponse.json({ persisted: true, pending: true }, { status: 202 });
  } catch (error) {
    // Which part of the grading died, or `unknown` for a throw nothing tagged
    // (#73). The reason and the exam id go to the log AND onto the response:
    // the French sentence below is what the candidate should read, and it is
    // also all a bug report used to be able to quote — five different failures
    // arrived here identically. The sentence stays exactly as it was.
    const reason = evaluationFailureReason(error) ?? "unknown";
    console.error(`[finish] evaluation failed (reason=${reason}, exam=${examId}):`, error);
    // The failures are the finishes most worth explaining (#86): the segments
    // say how far the request got before it died. A grading that never
    // finished shows null for its halves; the route's own segments are real.
    logTimings(graded);
    return NextResponse.json(
      { error: "L'évaluation a échoué. Réessayez dans un instant.", reason },
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
