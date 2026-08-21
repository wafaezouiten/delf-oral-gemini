import Link from "next/link";

import { Notice } from "@/app/_components/notice";
import { secondaryButton } from "@/app/_components/button-styles";
import { requireExamAccess, requireUserId } from "@/lib/auth/exam-guard";
import { neonSittingStore } from "@/lib/db/sittings";
import { partsAbsent } from "@/lib/delf/orale-rubric";
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

  const measured = (phase: "monologue" | "debate") =>
    sitting.recordings.find((row) => row.phase === phase)?.durationSeconds ?? 0;

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
      model: correction.model,
      latencySeconds: correction.latencySeconds,
      feedback: correction.feedback,
    },
    topic,
    transcript: sitting.transcript,
    // The server's measurement of the audio, which is also the number the
    // duration penalty was computed from — not the browser's clock.
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
 * ever graded. `uncorrected` is one that was submitted and graded, where the row
 * did not survive the write; finishing it again re-runs the whole path, which is
 * why the copy says the result may still be in the tab it was taken in.
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

      <Notice tone="warning" title={interrupted ? "Aucune note" : "Correction perdue"}>
        {interrupted
          ? "Cette épreuve n'a pas été menée à son terme — l'onglet a été fermé, ou la connexion a été perdue avant la fin. Rien n'a été corrigé, et il n'y a pas de note à afficher."
          : "Cette épreuve a bien été passée et corrigée, mais sa correction n'a pas pu être enregistrée. Si l'onglet où vous l'avez passée est encore ouvert, la note s'y trouve peut-être encore."}
      </Notice>

      <div className="flex justify-center">
        <Link href="/app" className={secondaryButton}>
          Passer une nouvelle épreuve
        </Link>
      </div>
    </main>
  );
}
