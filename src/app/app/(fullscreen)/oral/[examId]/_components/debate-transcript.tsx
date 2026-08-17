"use client";

import { useEffect, useRef } from "react";

import { Kicker } from "@/app/_components/po/tag";
import { cn } from "@/lib/ui/class-names";
import { entriesForPhase, type TranscriptEntry } from "@/lib/delf/transcript";
import {
  DEBATE_TRANSCRIPT_COPY,
  isNearBottom,
  speakerLabel,
  turnKey,
} from "@/lib/ui/debate-transcript";

/**
 * The débat's exchange, printed while it happens (#48).
 *
 * **Why the débat and not the exposé.** The monologue runs on manual VAD: the
 * candidate's activity is opened and never closed, and during a manual-VAD
 * activity Gemini transcribes nothing — the whole exposé arrives in one fragment
 * when the floor is released (`exam-controller.ts`). A feed there would sit
 * empty for seven minutes and then print everything at the moment the phase
 * ends. The débat runs on automatic VAD, so both sides stream turn by turn and
 * there is something to render continuously. The caller renders this in the
 * débat only, for that reason and no other.
 *
 * **The turns look like the results page, deliberately.** Speaker label in small
 * caps over a paragraph, « Vous » / « Examinateur » — `TranscriptColumn` in
 * `results-client.tsx`, and its reasoning applies twice over here: a transcript
 * of a DELF oral is a document, and chat bubbles would make the passation read
 * as a messaging app, which is the one thing this screen refuses to look like.
 *
 * **It is not a live region, and that is not an oversight.** The scene above
 * already announces turn changes politely, and it exists precisely because the
 * screen used to carry no transcript. Marking this live as well would recite
 * every partial fragment over the examiner and double up with that
 * announcement. It is a named, focusable scroll region instead: reachable, and
 * silent until it is read.
 */
export function DebateTranscript({
  transcript,
  hint,
  onHide,
}: {
  /** The whole exam transcript; the débat's turns are filtered out of it here. */
  transcript: readonly TranscriptEntry[];
  /**
   * What the status card would have said, shown until the first turn arrives.
   *
   * The feed takes that card's place rather than sitting under it — there is one
   * viewport and the scene has to stay in it — so the guidance it carried («
   * répondez aux objections… », or that the examiner is still connecting) would
   * otherwise be lost at the one moment it is worth reading: before anybody has
   * said anything. Once the exchange exists, the exchange is the better thing to
   * be looking at.
   */
  hint: string;
  onHide: () => void;
}) {
  const turns = entriesForPhase(transcript, "debate");
  const scroller = useRef<HTMLDivElement>(null);
  /**
   * Whether the feed is still following the conversation.
   *
   * A ref rather than state: it is written from a scroll handler on every frame
   * of a drag and read once per new fragment, and nothing renders differently
   * for it. As state it would re-render the feed while the candidate scrolls,
   * which is the one moment it should be doing nothing.
   */
  const following = useRef(true);

  // Deliberately keyed on the tail's *length* as well as the count of turns: a
  // fragment usually merges into the last entry rather than adding one
  // (`appendFragment`), so a dependency on `turns.length` alone would stop
  // following in the middle of the examiner's sentence.
  const lastTurn = turns[turns.length - 1];
  useEffect(() => {
    const element = scroller.current;
    if (!element || !following.current) return;
    element.scrollTop = element.scrollHeight;
  }, [turns.length, lastTurn?.text.length]);

  return (
    // A plain box, not a `<section>`: the scroller inside is the named region,
    // and a nameless landmark wrapped around a named one is two entries in the
    // landmark list where the épreuve has one thing to offer.
    <div className="border-border bg-card flex max-h-[min(20rem,38vh)] min-h-0 flex-col rounded-lg border">
      <div className="border-border flex shrink-0 items-center gap-3 border-b px-4 py-2">
        <Kicker>{DEBATE_TRANSCRIPT_COPY.title}</Kicker>
        <button
          type="button"
          onClick={onHide}
          className="text-muted-foreground hover:text-foreground hover:bg-muted ml-auto shrink-0 rounded-md px-2 py-1 text-[0.6875rem] font-semibold transition-colors"
        >
          {DEBATE_TRANSCRIPT_COPY.hide}
        </button>
      </div>

      <div
        ref={scroller}
        onScroll={(event) => {
          following.current = isNearBottom(event.currentTarget);
        }}
        // Focusable and named because it scrolls: a region with its own
        // scrollbar has to be reachable from the keyboard, and the name is what
        // says which region was reached.
        tabIndex={0}
        role="region"
        aria-label={DEBATE_TRANSCRIPT_COPY.title}
        className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 py-3"
      >
        {turns.length === 0 ? (
          <div className="text-muted-foreground space-y-1.5 text-xs leading-relaxed">
            <p>{DEBATE_TRANSCRIPT_COPY.empty}</p>
            <p>{hint}</p>
          </div>
        ) : (
          turns.map((turn, index) => (
            <p key={turnKey(turn, index)} className="text-[0.8125rem] leading-relaxed">
              <span
                className={cn(
                  "block text-[0.625rem] font-semibold tracking-[0.16em] uppercase",
                  turn.speaker === "candidate" ? "text-primary" : "text-muted-foreground",
                )}
              >
                {speakerLabel(turn.speaker)}
              </span>
              {turn.text}
            </p>
          ))
        )}
      </div>

      <p className="border-border text-muted-foreground shrink-0 border-t px-4 py-1.5 text-[0.625rem] leading-snug">
        {DEBATE_TRANSCRIPT_COPY.footnote}
      </p>
    </div>
  );
}
