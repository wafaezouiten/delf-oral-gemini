"use client";

import { useCallback, useEffect, useRef } from "react";

import { Kicker } from "@/app/_components/po/tag";
import { cn } from "@/lib/ui/class-names";
import { type TranscriptEntry } from "@/lib/delf/transcript";
import {
  DEBATE_CONVERSATION_COPY,
  debateTurns,
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
 * **The stamps do change between the two, and that is the exception that proves
 * it.** *When* a turn was said is measured against whatever the reader can see:
 * here, the scene's clock directly above this feed, so the anchor is the phase
 * clock; on the correction, the section's own first turn, because nothing there
 * says when the part opened. The reasoning is in `debateTurns`.
 *
 * **It has no scrollbar of its own, and that is the point.** It was a boxed feed
 * with its own scroller under a fixed head, which meant the screen had two
 * scrollbars and the conversation was reading itself through a letterbox. The
 * whole page scrolls instead: the sujet's title, the two faces and every turn
 * are one column that grows, and a candidate scrolls back through it the way
 * they would scroll back through anything else.
 *
 * That moves the autoscroll a level up. This panel does not own the scroller any
 * more, so it finds the one it is inside and drives that — following the newest
 * turn while the candidate is at the bottom, and holding still the moment they
 * scroll up to re-read an objection.
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
 * announcement.
 */
export function DebateConversation({
  transcript,
  phaseStartedAt,
  hint,
}: {
  /** The whole exam transcript; the débat's turns are filtered out of it here. */
  transcript: readonly TranscriptEntry[];
  /**
   * The débat's start in the transcript's own time base, so each turn can be
   * stamped with the count the scene's clock above is showing. Null until the
   * phase's clock starts — see `debateTurns`, which falls back rather than
   * printing an exam-length figure.
   */
  phaseStartedAt: number | null;
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
  const turns = debateTurns(transcript, phaseStartedAt);
  const root = useRef<HTMLDivElement>(null);
  /**
   * Whether the page is still following the conversation.
   *
   * A ref rather than state: it is written from a scroll handler on every frame
   * of a drag and read once per new fragment, and nothing renders differently
   * for it. As state it would re-render the panel while the candidate scrolls,
   * which is the one moment it should be doing nothing.
   */
  const following = useRef(true);

  const scroller = useCallback(() => findScroller(root.current), []);

  // The scroller belongs to the screen, not to this panel, so the listener has
  // to be attached by hand rather than declared as an `onScroll` prop.
  useEffect(() => {
    const element = scroller();
    if (!element) return;
    const onScroll = () => {
      following.current = isNearBottom(element);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [scroller]);

  // Deliberately keyed on the tail's *length* as well as the count of turns: a
  // fragment usually merges into the last entry rather than adding one
  // (`appendFragment`), so a dependency on `turns.length` alone would stop
  // following in the middle of the examiner's sentence.
  const lastTurn = turns[turns.length - 1]?.entry;
  useEffect(() => {
    const element = scroller();
    if (!element || !following.current) return;
    element.scrollTop = element.scrollHeight;
  }, [scroller, turns.length, lastTurn?.text.length]);

  return (
    <div ref={root} className="border-border bg-card rounded-lg border">
      <div className="border-border border-b px-4 py-2">
        <Kicker>{DEBATE_CONVERSATION_COPY.title}</Kicker>
      </div>

      <div className="space-y-3 px-4 py-3.5">
        {turns.length === 0 ? (
          <div className="text-muted-foreground space-y-1.5 text-xs leading-relaxed">
            <p>{DEBATE_CONVERSATION_COPY.empty}</p>
            <p>{hint}</p>
          </div>
        ) : (
          turns.map(({ entry, timeLabel }, index) => {
            const mine = entry.speaker === "candidate";
            return (
              <div
                key={turnKey(entry, index)}
                className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}
              >
                {/* Named as well as placed. Side and colour carry the speaker
                    for anyone who can see them; the label is what carries it
                    into a screen reader, and into a screenshot of a
                    conversation with one turn in it.

                    The stamp joins that line rather than taking one of its own,
                    and sits on the outside of the label — away from the bubble
                    on both sides, so the two columns of stamps run down the
                    outer edges instead of meeting in the middle. */}
                <span
                  className={cn(
                    "flex items-baseline gap-2 text-[0.625rem] font-semibold tracking-[0.16em] uppercase",
                    mine && "flex-row-reverse",
                  )}
                >
                  <span className="text-muted-foreground">{speakerLabel(entry.speaker)}</span>
                  <span className="text-muted-foreground/70 tabular tracking-normal">
                    {timeLabel}
                  </span>
                </span>
                <p
                  className={cn(
                    "max-w-[85%] rounded-2xl px-3.5 py-2 text-[0.8125rem] leading-relaxed",
                    mine
                      ? "bg-primary-subtle text-foreground rounded-br-sm"
                      : "border-border bg-muted/50 text-foreground/90 rounded-bl-sm border",
                  )}
                >
                  {entry.text}
                </p>
              </div>
            );
          })
        )}
      </div>

      <p className="border-border text-muted-foreground border-t px-4 py-1.5 text-[0.625rem] leading-snug">
        {DEBATE_CONVERSATION_COPY.footnote}
      </p>
    </div>
  );
}

/**
 * The scrolling ancestor this panel lives in, or null if nothing scrolls.
 *
 * Walked rather than passed down as a ref: the screen above owns the scroller
 * and could reasonably move it — the exposé and the débat already lay out
 * differently — and a panel that asks the DOM which box it is inside keeps
 * working when it does. The check is `overflow-y`, not a class name, so it
 * cannot go stale against Tailwind.
 */
function findScroller(from: HTMLElement | null): HTMLElement | null {
  let node = from?.parentElement ?? null;
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}
