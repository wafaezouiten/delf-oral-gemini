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
 * The letterbox is answered by height and by width, and neither number was
 * invented here. PORT NOTE: `components/po/po-preparation-screen.tsx:77` and
 * `po-briefing-screen.tsx:196` — the reference locks its frame and hands each
 * panel its own scroller at `lg`, and lets the whole page scroll below it
 * (`overflow-y-auto … lg:overflow-hidden`, then `lg:min-h-0 lg:overflow-y-auto`
 * on the panels). This screen now does exactly that: from `lg` up the head is
 * pinned and the exchange takes the pixels the screen has left, which is a good
 * deal more than the 20rem the #48 version was squeezed into; below it the
 * column scrolls as one document and the head goes with it, which is the #48
 * arrangement and the honest answer for a phone — a pinned head, a control bar
 * and a footer over three lines of exchange is not worth its room.
 *
 * So *which* box scrolls is a media query's business, and this panel asks the
 * DOM rather than repeating the breakpoint in JavaScript: `scrollerFrom` starts
 * at the feed and walks up until something has `overflow-y`, which is the feed
 * itself at `lg` and the screen's column below it. The autoscroll drives
 * whichever it is — following the newest turn while the candidate is at the
 * bottom, holding still the moment they scroll up to re-read an objection.
 *
 * « Reprendre le fil » belongs to the pinned arrangement only. When the page is
 * the scroller, scrolling back down is the same gesture as scrolling anything
 * else and needs no button; when the exchange is a box under a fixed head, a
 * candidate who has scrolled up in it has no other cue that it has moved on.
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
   * The two facts that do render, so they are state and the position is not.
   *
   * `owns` is whether the feed is the scroller — true from `lg` up, where the
   * screen's frame is locked and this panel takes its own — and `held` whether
   * that scroller has been left behind. « Reprendre le fil » needs both, and
   * needs a render to appear. Set from booleans rather than from the raw
   * position on purpose: they change when the arrangement changes and when the
   * candidate scrolls back and forth, not once a frame, and React drops a
   * `setState` to the value already held.
   */
  const [owns, setOwns] = useState(false);
  const [held, setHeld] = useState(false);

  /** The newest turn, in whichever box is currently the scroller. */
  const pin = useCallback(() => {
    const element = scrollerFrom(feed.current);
    if (element) element.scrollTop = element.scrollHeight;
  }, []);

  const stickToBottom = useCallback(() => {
    pin();
    following.current = true;
    setHeld(false);
  }, [pin]);

  // Which box scrolls is decided in CSS and can change under the candidate —
  // a rotated phone crosses `lg` mid-épreuve — so the listener follows it.
  useEffect(() => {
    let bound: HTMLElement | null = null;
    const onScroll = () => {
      if (!bound) return;
      const near = isNearBottom(bound);
      following.current = near;
      setHeld(!near);
    };
    const bind = () => {
      const next = scrollerFrom(feed.current);
      if (next === bound) return;
      bound?.removeEventListener("scroll", onScroll);
      bound = next;
      bound?.addEventListener("scroll", onScroll, { passive: true });
      setOwns(bound !== null && bound === feed.current);
      // The exchange has just moved from one box into another, and a position
      // measured in the old one says nothing about the new one. Follow again,
      // and let the effect below put the newest turn back on screen.
      following.current = true;
      setHeld(false);
    };
    // A resize is not only a possible handover: the same turns rewrap at a new
    // width, so the newest one moves even when the box does not change. Follow
    // it if we were following — measured on a rotation, where the exchange grew
    // 483px taller and left the reader that far short of the last word.
    const onResize = () => {
      bind();
      if (following.current) pin();
    };
    bind();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      bound?.removeEventListener("scroll", onScroll);
    };
  }, [pin]);

  // Deliberately keyed on the tail's *length* as well as the count of turns: a
  // fragment usually merges into the last entry rather than adding one
  // (`appendFragment`), so a dependency on `turns.length` alone would stop
  // following in the middle of the examiner's sentence. `owns` joins them so a
  // change of scroller re-pins the newest turn instead of leaving the candidate
  // wherever the other box happened to be.
  const lastTurn = turns[turns.length - 1]?.entry;
  useEffect(() => {
    if (following.current) pin();
  }, [pin, owns, turns.length, lastTurn?.text.length]);

  return (
    // Every `lg:` here is one half of the reference's pair, and neither half
    // works alone: the screen's column is `lg:overflow-hidden`, so from `lg` up
    // this panel is the only thing left that can scroll and must be allowed to
    // be shorter than the exchange (`lg:min-h-0`, the #35 failure again). Below
    // `lg` the whole set reverts — the panel is as tall as its turns and the
    // column scrolls it, exactly as it did before #88.
    <div className="border-border bg-card flex flex-1 flex-col rounded-lg border lg:min-h-0">
      <div className="border-border shrink-0 border-b px-4 py-2">
        <Kicker>{DEBATE_CONVERSATION_COPY.title}</Kicker>
      </div>

      <div className="relative flex flex-1 flex-col lg:min-h-0">
        {/* Focusable where it scrolls, and named because it is. A box that
            scrolls and cannot be reached from the keyboard is content a keyboard
            user cannot read at all. Below `lg` it is not a box and not a
            scroller, and a tab stop that does nothing is worse than none — the
            page's own keys already move the exchange there. */}
        <div
          ref={feed}
          role="region"
          aria-label={DEBATE_CONVERSATION_COPY.title}
          tabIndex={owns ? 0 : undefined}
          className="space-y-3 px-4 py-3.5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
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
            to have to scroll to. It exists only while this panel owns the
            scroller and has been left behind — it is not a control the candidate
            is looking for, it is the way back to the one thing they stopped
            being shown, and below `lg` that way back is the page's own. */}
        {owns && held && (
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

/**
 * The box the exchange actually scrolls in: this feed from `lg` up, the screen's
 * column below it.
 *
 * Asked of the DOM rather than of `matchMedia`, and starting at the feed itself
 * rather than at its parent — that one difference from the #48 version of this
 * helper is what lets the same walk answer both arrangements. The check is
 * `overflow-y`, so the breakpoint stays written once, in the class list, where
 * the layout it decides is also written. A `matchMedia("(min-width: 64rem)")`
 * here would be Tailwind's `lg` copied into JavaScript, free to drift from it.
 */
function scrollerFrom(from: HTMLElement | null): HTMLElement | null {
  let node = from;
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}
