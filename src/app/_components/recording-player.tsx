"use client";

import { useSyncExternalStore } from "react";

import { cn } from "@/lib/ui/class-names";

/**
 * One kept recording, playable where its sitting is shown (#98) — under a
 * half's heading on the correction, and on the sitting's row in the
 * historique. One component so the two never drift on the questions that
 * matter: when bytes move, and what a browser that cannot play the format is
 * told.
 *
 * `preload="none"`: the artefacts are around a megabyte each and most visits
 * are to read a grade, not to re-listen — the bytes should move when the
 * candidate presses play, not once per player on every page load. On the
 * historique, where twenty rows can carry forty players, this is the
 * difference between a list and a download.
 *
 * The `canPlayType` question is a read from an external system — the server
 * has no `<audio>` element to ask — so it goes through `useSyncExternalStore`
 * with a server snapshot of "playable": the common browsers all pass, and a
 * browser that cannot play the format (the exam's own encoding is Ogg Opus,
 * which Safari historically refuses) swaps in the honest sentence on
 * hydration instead of a control that errors on first press.
 *
 * `no-print`, both branches: the correction prints as a grade sheet (#70), a
 * player has no printed form, and the sentence about browser support is about
 * the browser rather than the épreuve.
 */

/**
 * Whether this browser can play one of the two stored formats, answered once
 * per format and remembered — `canPlayType` is a fact about the browser, not
 * about a render.
 *
 * The Ogg case is asked with its codec: bare `audio/ogg` gets "maybe" from
 * browsers that would then fail on the Opus inside. The stored types are
 * exactly the two `measureUploadedRecording` can admit.
 */
const playableTypeCache = new Map<string, boolean>();

function canPlayStoredType(mimeType: string): boolean {
  const candidate = mimeType === "audio/ogg" ? 'audio/ogg; codecs="opus"' : mimeType;
  let known = playableTypeCache.get(candidate);
  if (known === undefined) {
    known = document.createElement("audio").canPlayType(candidate) !== "";
    playableTypeCache.set(candidate, known);
  }
  return known;
}

/** The capability never changes while the page is open; the store API is used
 *  for its read semantics, not for change notifications. */
const subscribeToNothing = () => () => {};

export function RecordingPlayer({
  src,
  mimeType,
  className,
}: {
  src: string;
  mimeType: string;
  /** Sizing and spacing only — the host decides how much room a player gets. */
  className?: string;
}) {
  const supported = useSyncExternalStore(
    subscribeToNothing,
    () => canPlayStoredType(mimeType),
    () => true,
  );

  if (!supported) {
    return (
      <p className="no-print text-muted-foreground mt-1 text-xs leading-relaxed italic">
        L&apos;enregistrement est conservé, mais votre navigateur ne peut pas lire
        son format ({mimeType === "audio/ogg" ? "Ogg Opus" : mimeType}). Ouvrez
        cette page dans Chrome ou Firefox pour l&apos;écouter.
      </p>
    );
  }

  return <audio controls preload="none" src={src} className={cn("no-print", className)} />;
}
