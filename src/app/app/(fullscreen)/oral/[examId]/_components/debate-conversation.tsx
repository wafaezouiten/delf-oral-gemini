"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
 * The débat's exchange, as a conversation (#48, #60, #88).
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
 * **It owns a scroller again (#88), and the argument that took the last one away
 * is still true.** The panel had no scrollbar of its own on purpose: a boxed
 * feed under a fixed head meant the screen had two scrollbars and the
 * conversation read itself through a letterbox, so the whole column was made to
 * scroll as one document instead. What that traded away only shows up a few
 * turns in — the two faces are the one thing on this screen answering « whose
 * turn is it », and they scrolled off the top exactly when the exchange got long
 * enough to need them. A second scrollbar is the smaller loss, so the head is
 * pinned and the exchange scrolls under it.
 *
 * The letterbox is answered by height rather than by refusing the box: the feed
 * takes every pixel the screen has left (`flex-1`) instead of the 20rem the #48
 * version was given, and stops shrinking at `min-h`, under which the column
 * above starts scrolling again and the head unpins itself — a head pinned over
 * three lines of exchange is not worth its room.
 *
 * That brings the autoscroll back down here: the panel drives its own box —
 * following the newest turn while the candidate is at the bottom, and holding
 * still the moment they scroll up to re-read an objection. The hold now says so
 * (« Reprendre le fil »), which it did not have to while scrolling back down was
 * the same gesture as scrolling the page.
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
  const feed = useRef<HTMLDivElement>(null);
  /**
   * Whether the feed is still following the conversation.
   *
   * A ref rather than state: it is written from a scroll handler on every frame
   * of a drag and read once per new fragment, and no turn renders differently
   * for it. As state it would re-render the whole exchange while the candidate
   * scrolls, which is the one moment it should be doing nothing.
   */
  const following = useRef(true);
  /**
   * The same fact a second time, because one thing does render for it.
   *
   * « Reprendre le fil » exists only while the feed is held, so it needs a
   * render. Set from the boolean rather than from the raw position on purpose:
   * that changes twice across a scroll up and back, not once a frame, and React
   * drops a `setState` to the value already held.
   */
  const [held, setHeld] = useState(false);

  const stickToBottom = useCallback(() => {
    const element = feed.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    following.current = true;
    setHeld(false);
  }, []);

  useEffect(() => {
    const element = feed.current;
    if (!element) return;
    const onScroll = () => {
      const near = isNearBottom(element);
      following.current = near;
      setHeld(!near);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  // Deliberately keyed on the tail's *length* as well as the count of turns: a
  // fragment usually merges into the last entry rather than adding one
  // (`appendFragment`), so a dependency on `turns.length` alone would stop
  // following in the middle of the examiner's sentence.
  const lastTurn = turns[turns.length - 1]?.entry;
  useEffect(() => {
    const element = feed.current;
    if (!element || !following.current) return;
    element.scrollTop = element.scrollHeight;
  }, [turns.length, lastTurn?.text.length]);

  return (
    // `min-h-0` is what lets a flex child be shorter than its content, and every
    // ancestor from `<main>` down carries it — without it the box grows to fit
    // the exchange instead of scrolling it, the failure this project has already
    // paid for once (#35). Leaving it off here does not work either, and it is
    // worth saying why it was tried: a scroller's intrinsic height is still its
    // content, so a panel left on `min-height: auto` asks for the height of every
    // turn said so far and takes the column with it.
    //
    // Hence the floor as a number on this element rather than on the feed. It is
    // the head, the footnote and about five lines of exchange, and it is what
    // decides which of the two scrollers is in charge: while the screen can
    // afford it the head above stays put and only the exchange moves; when it
    // cannot, this panel refuses to shrink, the column above overflows and goes
    // back to scrolling as one document — which is the #48 arrangement, and the
    // right one at a height where a pinned head would leave three lines to read.
    <div className="border-border bg-card flex min-h-[15rem] flex-1 flex-col rounded-lg border">
      <div className="border-border shrink-0 border-b px-4 py-2">
        <Kicker>{DEBATE_CONVERSATION_COPY.title}</Kicker>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Focusable, and named because it is. A box that scrolls and cannot be
            reached from the keyboard is content a keyboard user cannot read at
            all — which the panel got away with while the page was the scroller
            and the page keeps its own key bindings. `region` and the name give
            the tab stop something to announce itself as, rather than landing a
            screen reader on an unlabelled group mid-épreuve. */}
        <div
          ref={feed}
          role="region"
          aria-label={DEBATE_CONVERSATION_COPY.title}
          tabIndex={0}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3.5"
        >
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

        {/* Over the newest turn rather than after it: it belongs to the feed's
            bottom edge, and a button inside the scroller would be one more thing
            to have to scroll to. It exists only while the feed is held — it is
            not a control the candidate is looking for, it is the way back to the
            one thing they stopped being shown. */}
        {held && (
          <button
            type="button"
            onClick={stickToBottom}
            className="border-border bg-card text-foreground hover:bg-muted absolute inset-x-0 bottom-2.5 mx-auto flex w-max items-center gap-1.5 rounded-full border px-3 py-1 text-[0.6875rem] font-semibold shadow-sm transition-colors"
          >
            <span aria-hidden>↓</span>
            {DEBATE_CONVERSATION_COPY.resume}
          </button>
        )}
      </div>
      <p className="border-border text-muted-foreground shrink-0 border-t px-4 py-1.5 text-[0.625rem] leading-snug">
        {DEBATE_CONVERSATION_COPY.footnote}
      </p>
    </div>
  );
}
