"use client";

import { useEffect, useRef } from "react";

import { Kicker } from "@/app/_components/po/tag";
import { cn } from "@/lib/ui/class-names";
import { entriesForPhase, type TranscriptEntry } from "@/lib/delf/transcript";
import {
  DEBATE_CONVERSATION_COPY,
  isNearBottom,
  speakerLabel,
  turnKey,
} from "@/lib/ui/debate-conversation";

/**
 * The débat's exchange, as a conversation (#48, #60).
 *
 * **Turns, not a document.** The exchange used to be set like the results page's
 * transcript — speaker label in small caps over a paragraph — on the argument
 * that one exchange printed twice should not be printed two different ways. It
 * reads differently here on purpose: after the sitting it is a record to be
 * studied, and during the sitting it is a conversation happening now, so the
 * examiner's turns sit left and the candidate's right, each in its own bubble.
 * The names stay the results page's — « Vous » and « Examinateur » — because
 * *who* said something must not change between the two.
 *
 * **Why the débat and not the exposé.** The monologue runs on manual VAD: the
 * candidate's activity is opened and never closed, and during a manual-VAD
 * activity Gemini transcribes nothing — the whole exposé arrives in one fragment
 * when the floor is released (`exam-controller.ts`). A feed there would sit empty
 * for seven minutes and then print everything at the moment the phase ends. The
 * débat runs on automatic VAD, so both sides stream turn by turn and there is
 * something to render continuously.
 *
 * **It is not a live region, and that is not an oversight.** The scene above
 * announces turn changes politely and exists to. Marking this live as well would
 * recite every partial fragment over the examiner and double up with that
 * announcement. It is a named, focusable scroll region instead: reachable, and
 * silent until it is read.
 */
export function DebateConversation({
  transcript,
  hint,
}: {
  /** The whole exam transcript; the débat's turns are filtered out of it here. */
  transcript: readonly TranscriptEntry[];
  /**
   * What the status card would have said, shown until the first turn arrives.
   *
   * The guidance it carried — « répondez aux objections… », or that the examiner
   * is still connecting — is worth reading at exactly one moment: before anybody
   * has said anything. Once the exchange exists, the exchange is the better thing
   * to be looking at.
   */
  hint: string;
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
    <div className="border-border bg-card flex min-h-0 flex-1 flex-col rounded-lg border">
      <div className="border-border shrink-0 border-b px-4 py-2">
        <Kicker>{DEBATE_CONVERSATION_COPY.title}</Kicker>
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
        aria-label={DEBATE_CONVERSATION_COPY.title}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3.5"
      >
        {turns.length === 0 ? (
          <div className="text-muted-foreground space-y-1.5 text-xs leading-relaxed">
            <p>{DEBATE_CONVERSATION_COPY.empty}</p>
            <p>{hint}</p>
          </div>
        ) : (
          turns.map((turn, index) => {
            const mine = turn.speaker === "candidate";
            return (
              <div
                key={turnKey(turn, index)}
                className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}
              >
                {/* Named as well as placed. Side and colour carry the speaker
                    for anyone who can see them; the label is what carries it
                    into a screen reader reading this region, and into a
                    screenshot of a conversation with one turn in it. */}
                <span className="text-muted-foreground text-[0.625rem] font-semibold tracking-[0.16em] uppercase">
                  {speakerLabel(turn.speaker)}
                </span>
                <p
                  className={cn(
                    "max-w-[85%] rounded-2xl px-3.5 py-2 text-[0.8125rem] leading-relaxed",
                    mine
                      ? "bg-primary-subtle text-foreground rounded-br-sm"
                      : "border-border bg-muted/50 text-foreground/90 rounded-bl-sm border",
                  )}
                >
                  {turn.text}
                </p>
              </div>
            );
          })
        )}
      </div>

      <p className="border-border text-muted-foreground shrink-0 border-t px-4 py-1.5 text-[0.625rem] leading-snug">
        {DEBATE_CONVERSATION_COPY.footnote}
      </p>
    </div>
  );
}
