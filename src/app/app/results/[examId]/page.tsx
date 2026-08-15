import Link from "next/link";

import { requireExamAccess, requireUserId } from "@/lib/auth/exam-guard";
import { neonSittingStore } from "@/lib/db/sittings";
import { findTopic } from "@/lib/delf/topics";
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
  const rowId = await requireExamAccess(examId);

  if (rowId === null) return <ResultsClient examId={examId} />;

  const sitting = await neonSittingStore()
    .readSitting({ examId: rowId, userId })
    .catch((error: unknown) => {
      // A results page that 500s on a database blip is worse than one that
      // renders from the copy the browser is already holding.
      console.error("[results] could not read sitting", rowId, error);
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
      model: correction.model,
      latencySeconds: correction.latencySeconds ?? 0,
      feedback: correction.feedback,
    },
    topic,
    transcript: sitting.transcript,
    // The server's measurement of the audio, which is also the number the
    // duration penalty was computed from — not the browser's clock.
    monologueSeconds: measured("monologue"),
    debateSeconds: measured("debate"),
    reconnectCount: sitting.reconnectCount,
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
    <main className="mx-auto w-full max-w-2xl px-6 py-16 text-center">
      <h1 className="text-xl font-semibold">
        {interrupted ? "Épreuve interrompue" : "Épreuve non corrigée"}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
        {interrupted
          ? "Cette épreuve n'a pas été menée à son terme, elle n'a donc pas été corrigée."
          : "Cette épreuve a bien été passée, mais sa correction n'a pas pu être enregistrée."}
      </p>
      <Link
        href="/app"
        className="border-border mt-6 inline-block rounded-lg border px-4 py-2 text-sm font-semibold"
      >
        Passer une nouvelle épreuve
      </Link>
    </main>
  );
}
