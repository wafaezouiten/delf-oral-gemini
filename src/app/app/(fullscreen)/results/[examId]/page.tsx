import Link from "next/link";

import { Notice } from "@/app/_components/notice";
import { secondaryButton } from "@/app/_components/button-styles";
import { requireExamAccess, requireUserId } from "@/lib/auth/exam-guard";
import { neonSittingStore } from "@/lib/db/sittings";
import { applySittingDurationPenalty, partsAbsent } from "@/lib/delf/orale-rubric";
import { findTopic } from "@/lib/delf/topics";
import { candidateWordCount } from "@/lib/delf/transcript";
import type { StoredSitting } from "@/lib/exams/sitting-persistence";
import { ResultsClient, type StoredResult } from "./results-client";

/**
 * Results, read back from Neon when there is a row, and from the browser when
 * there is not.
 *
 * Before Phase 8 there was only the second source: the finish response, stashed
 * in `sessionStorage`, which meant a correction survived exactly as long as the
 * tab that produced it. Now the stored sitting is the primary source and the
 * stash is the fallback — for a sitting that was never persisted (no database, a
 * degraded `local-…` id) or one whose write failed, both of which are states the
 * candidate should still see their grade in.
 *
 * The ownership check has been here since Phase 3, guarding a page whose data
 * happened to come from the visitor's own browser. This is the read it was put
 * in place for: `requireExamAccess` hands back the row id, and hands it back
 * only when ownership is proven, so the query below has no way to address a
 * sitting it did not earn.
 */
export default async function ResultsPage({ params }: PageProps<"/app/results/[examId]">) {
  const { examId } = await params;
  // One id, one owner, and both are needed: the store scopes every statement to
  // the owner rather than trusting the row id on its own. `auth()` is memoised
  // per request, so this is not a second round trip to Clerk.
  const userId = await requireUserId();
  const owned = await requireExamAccess(examId);

  if (owned === null) return <ResultsClient examId={examId} />;

  // The subject comes back with the gate now, and this page still does not use
  // it: `readSitting` reads the whole sitting anyway, and the slug it returns is
  // from the same statement as everything else it renders.
  const sitting = await neonSittingStore()
    .readSitting({ examId: owned.examId, userId })
    .catch((error: unknown) => {
      // A results page that 500s on a database blip is worse than one that
      // renders from the copy the browser is already holding.
      console.error("[results] could not read sitting", owned.examId, error);
      return null;
    });

  if (!sitting) return <ResultsClient examId={examId} />;

  // The correction is what `corrected` means, so the branch is written on the
  // thing itself rather than on the label derived from it — one fact, and the
  // compiler gets to see it is present below.
  const correction = sitting.correction;
  if (!correction) return <UnfinishedSitting sitting={sitting} />;

  const topic = findTopic(sitting.topicSlug);
  // The subject is stored as a slug and the prose lives in code, so a sitting
  // taken on a subject since removed from the catalogue has a correction and no
  // document to show it against. Rare, and the browser's copy carries the topic
  // whole — so fall back rather than render a result with a blank subject.
  if (!topic) return <ResultsClient examId={examId} />;

  /**
   * How long a part lasted, as the correction on this page was graded on.
   *
   * `oral_exam_phases.spoken_seconds`, not the recording row: the finish route
   * resolves ONE duration per part and writes it to both the corrector and this
   * column, so reading it here is what keeps the number printed beside the mark
   * the number the mark was computed from. On every real sitting the two are the
   * same measurement; they part company only under the development time-skip
   * (#203), where the recording is the eight minutes that were spoken and this
   * is the ten the épreuve's clock reached.
   *
   * Falls back to the recording for a sitting whose phase rows are missing —
   * nothing writes a recording without its phase report, but a row is cheaper to
   * fall back from than to assume.
   */
  const measured = (phase: "monologue" | "debate") =>
    sitting.phases.find((row) => row.phase === phase)?.spokenSeconds ??
    sitting.recordings.find((row) => row.phase === phase)?.durationSeconds ??
    0;

  // The recordings whose bytes were kept (#98): a uri to serve and no purge
  // stamp. Everything else — pre-#98 sittings, vaultless deployments, uploads
  // that failed — renders exactly as before, a duration with nothing to play,
  // which is the honest sentence for a recording that existed and is gone.
  const playable = sitting.recordings
    .filter((row) => row.uri !== null && row.deletedAt === null)
    .map((row) => ({
      phase: row.phase,
      mimeType: row.mimeType,
      // From the row, so the player can print « 0:00 / 1:38 » before a single
      // byte has moved — its file stays unfetched until play is pressed.
      durationSeconds: row.durationSeconds,
    }));

  const initial: StoredResult = {
    evaluation: {
      mode: correction.mode,
      criteria: correction.criteria,
      rawScore25: correction.rawScore25,
      score25: correction.score25,
      durationPenalty: correction.durationPenalty,
      // No `shortParts`: which half ran short is the corrector's working and has
      // no column. The client already treats it as optional, because a stored
      // correction was always going to be the other thing it renders.
      absencePenalty: correction.absencePenalty,
      // `absentParts` has no column either, but unlike `shortParts` it can be
      // recovered exactly: it was read off the transcript, and the transcript
      // is stored. This is the rubric's own `partsAbsent`, over the same input
      // it saw at grading time — not a second copy of the rule.
      //
      // Guarded on the penalty so a row written before the halving existed
      // (`absence_penalty` defaults to 0) is never labelled with a charge it
      // did not take.
      //
      // And minus the débat the examiner closed early (#92), exactly as the
      // rubric dropped it at grading time: a positive count means the waiver
      // was live (the column and the waiver shipped together, and old rows
      // read 0), so a silent débat here was excused, not charged — leaving it
      // in would caption a monologue-only halving as « aucune des deux
      // parties ».
      absentParts:
        correction.absencePenalty > 0
          ? partsAbsent({
              monologueWords: candidateWordCount(sitting.transcript, "monologue"),
              debateWords: candidateWordCount(sitting.transcript, "debate"),
            }).filter((part) => part !== "debate" || sitting.earlyClosingCount === 0)
          : [],
      // `durationCharges` has no column either, and is recovered the way
      // `absentParts` above is: by re-running the rubric's own function over
      // the same inputs it saw at grading time — the stored bands, and the
      // server's measurement of the recordings. Not a second copy of the rule.
      //
      // The score handed in is the stored raw: only `charges` is read from the
      // result, and those depend on the bands and the durations, never on the
      // running total.
      //
      // `excluded` has to be reconstructed too, or the sentence would name a
      // part the rubric never charged: an absent part is dropped (the halving
      // already answered for it) and so is a débat the examiner closed early.
      // Both are the same reconstructions used just above.
      durationCharges:
        correction.durationPenalty > 0
          ? applySittingDurationPenalty(
              correction.rawScore25,
              correction.criteria,
              { monologueSeconds: measured("monologue"), debateSeconds: measured("debate") },
              [
                ...(correction.absencePenalty > 0
                  ? partsAbsent({
                      monologueWords: candidateWordCount(sitting.transcript, "monologue"),
                      debateWords: candidateWordCount(sitting.transcript, "debate"),
                    })
                  : []),
                ...(sitting.earlyClosingCount > 0 ? (["debate"] as const) : []),
              ],
            ).charges
          : [],
      model: correction.model,
      latencySeconds: correction.latencySeconds,
      feedback: correction.feedback,
    },
    topic,
    transcript: sitting.transcript,
    // The number the duration penalty was computed from — see `measured`.
    monologueSeconds: measured("monologue"),
    debateSeconds: measured("debate"),
    reconnectCount: sitting.reconnectCount,
    // The examiner's early goodbyes (#92) — unlike `reconnectCount` above,
    // something actually renders this: the note explaining that the fault was
    // not held against the candidate.
    earlyClosingCount: sitting.earlyClosingCount,
    playable,
    // Which model spoke (#99) — the counterpart of `evaluation.model`, which
    // names the one that graded. Null on sittings from before the column, and
    // shown as nothing rather than guessed: today's default is not evidence
    // about which examiner an old sitting heard.
    examinerModel: sitting.examinerModel,
  };

  return <ResultsClient examId={examId} initial={initial} />;
}

/**
 * A sitting that exists and has no correction.
 *
 * The two cases are told apart because they are genuinely different, and because
 * telling them apart is what "interrupted sittings are distinguishable from
 * completed ones" means in practice. `in-progress` is an épreuve that stopped
 * before it was submitted — a closed tab, a lost connection — and nothing was
 * ever graded. `uncorrected` is one that was submitted, whose correction is not
 * attached — which, since #86, is most often a correction still UNDER WAY: the
 * finish answers as soon as the sitting is safe and grades behind the response,
 * so a candidate who closed the tab and clicked straight here can land minutes
 * ahead of their own mark. The copy says to refresh before it says anything is
 * wrong, and only then that the tab that took the épreuve can re-send it.
 */
function UnfinishedSitting({ sitting }: { sitting: StoredSitting }) {
  const interrupted = sitting.outcome === "in-progress";

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-5 px-6 py-16">
      <div className="space-y-2 text-center">
        <p className="text-primary text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
          DELF B2 · Production orale
        </p>
        <h1 className="font-serif text-2xl font-semibold">
          {interrupted ? "Épreuve interrompue" : "Épreuve non corrigée"}
        </h1>
      </div>

      <Notice tone="warning" title={interrupted ? "Aucune note" : "Correction en attente"}>
        {interrupted
          ? "Cette épreuve n'a pas été menée à son terme — l'onglet a été fermé, ou la connexion a été perdue avant la fin. Rien n'a été corrigé, et il n'y a pas de note à afficher."
          : "Cette épreuve a bien été passée ; sa correction n'est pas encore enregistrée. Elle est peut-être encore en cours — attendez un instant, puis actualisez cette page. Si rien n'arrive, l'onglet où vous avez passé l'épreuve, s'il est encore ouvert, peut réessayer l'envoi."}
      </Notice>

      <div className="flex justify-center">
        <Link href="/app" className={secondaryButton}>
          Passer une nouvelle épreuve
        </Link>
      </div>
    </main>
  );
}
