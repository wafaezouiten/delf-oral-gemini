"use client";

import { useSyncExternalStore } from "react";

import {
  PauseIcon,
  PlayIcon,
  SkipBack15Icon,
  SkipForward15Icon,
  TrashIcon,
  VolumeIcon,
  VolumeMutedIcon,
} from "@/app/_components/po/icons";
import { formatClock } from "@/lib/delf/phases";
import { cn } from "@/lib/ui/class-names";
import {
  formatName,
  playableCandidate,
  playbackProgress,
  seekKeyOffset,
  type DeletionState,
} from "@/lib/ui/recording-player";
import { useAudioPlayback, type AudioPlayback } from "./use-audio-playback";
import { useRecordingDeletion } from "./use-recording-deletion";

/**
 * One kept recording, playable under its half's heading on the correction
 * (#98). That is the one surface: #98 also put a pair of these on every
 * corrected historique row, and #116 took them off again — the list stopped
 * scanning as a record — so the historique now links to the correction
 * instead of duplicating it. The component stays in `_components` all the
 * same, one implementation for whatever surface earns a player next, because
 * the questions it answers must not drift: when bytes move, what a browser
 * that cannot play the format is told, and what deleting a voice costs.
 *
 * PORT NOTE: the reference's player card, on this project's palette — the
 * ±15 s skips, the round primary play button, the seekable progress bar, the
 * elapsed/total clock, the mute toggle and « Supprimer ». Drawn with this
 * project's own stroke icons rather than the reference's icon packages, for
 * the reason `po/icons.tsx` gives.
 *
 * **The bytes move on play, not on render.** The `<audio>` element is
 * `preload="none"` and the total duration comes from the row
 * (`oral_recordings.duration_seconds`, measured at upload) rather than from
 * the file's metadata, which is what lets the card print « 0:00 / 1:38 »
 * without fetching anything: rendering a correction must not cost the two
 * downloads its players describe. Once the file actually loads, its own
 * metadata wins — the two only disagree by rounding, and the file is the one
 * being scrubbed.
 *
 * **« Supprimer » is permanent and says so.** One press arms it, a second
 * press confirms — an inline two-step rather than a dialog, because the
 * danger is one small action on one row, not a page-level decision like
 * « Repartir de zéro ». The DELETE stamps `deleted_at` before the store is
 * cleared (the order `decidePlayback` already trusts), the row keeps its
 * duration as the honest record a disposed recording has always had, and the
 * card is replaced by the sentence saying so.
 *
 * The `canPlayType` question is a read from an external system — the server
 * has no `<audio>` element to ask — so it goes through `useSyncExternalStore`
 * with a server snapshot of "playable": the common browsers all pass, and a
 * browser that cannot play the format (the exam's own encoding is Ogg Opus,
 * which Safari historically refuses) swaps in the honest sentence on
 * hydration instead of a control that errors on first press.
 *
 * `no-print`, every branch: the correction prints as a grade sheet (#70), a
 * player has no printed form, and the sentences about the browser or a
 * deletion are about this screen rather than the épreuve.
 */

/**
 * Whether this browser can play one of the two stored formats, answered once
 * per format and remembered — `canPlayType` is a fact about the browser, not
 * about a render. The type asked about is `playableCandidate`'s.
 */
const playableTypeCache = new Map<string, boolean>();

function canPlayStoredType(mimeType: string): boolean {
  const candidate = playableCandidate(mimeType);
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

const SKIP_SECONDS = 15;

const SENTENCE = "no-print text-muted-foreground text-xs leading-relaxed italic";

export function RecordingPlayer({
  src,
  mimeType,
  durationSeconds,
  deleteHref,
  className,
}: {
  src: string;
  mimeType: string;
  /** From the row, measured at upload — what the clock shows before any byte
   *  has moved. */
  durationSeconds: number;
  /** The DELETE endpoint for this recording. Absent, the card has no
   *  « Supprimer ». */
  deleteHref?: string;
  /** Spacing and width only — the host decides how much room a player gets. */
  className?: string;
}) {
  const [audioRef, playback] = useAudioPlayback(durationSeconds);
  const deletion = useRecordingDeletion(deleteHref, playback.pause);

  const supported = useSyncExternalStore(
    subscribeToNothing,
    () => canPlayStoredType(mimeType),
    () => true,
  );

  if (deletion.state.stage === "deleted") {
    return <p className={cn(SENTENCE, className)}>Enregistrement supprimé.</p>;
  }

  if (!supported) {
    return (
      <p className={cn(SENTENCE, className)}>
        L&apos;enregistrement est conservé, mais votre navigateur ne peut pas lire son format (
        {formatName(mimeType)}). Ouvrez cette page dans Chrome ou Firefox pour l&apos;écouter.
      </p>
    );
  }

  return (
    <div className={cn("no-print", className)}>
      {/* `flex-wrap`: on a 375 px screen the full transport does not fit one
          line inside the transcript sheet's padding, and a card that scrolls
          sideways inside a printed page's replica is the one layout this
          product never ships. The bar keeps `flex-1`, so when the row folds
          it is the bar that takes the whole second line. */}
      <div className="border-border bg-card flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg border px-3 py-2">
        <audio ref={audioRef} src={src} preload="none" hidden {...playback.audioProps} />
        <Transport playback={playback} />
        <Track playback={playback} />
        <span className="text-muted-foreground tabular shrink-0 text-[0.6875rem]">
          {formatClock(playback.time)} / {formatClock(playback.duration)}
        </span>
        <MuteButton muted={playback.muted} onToggle={playback.toggleMute} />
        {deleteHref && <DeleteControl {...deletion} />}
      </div>
      <DeletionNotes state={deletion.state} />
    </div>
  );
}

/** ±15 s around the round play button. */
function Transport({ playback }: { playback: AudioPlayback }) {
  const { time, playing, seekTo, togglePlay } = playback;
  return (
    <>
      <button
        type="button"
        onClick={() => seekTo(time - SKIP_SECONDS)}
        aria-label={`Reculer de ${SKIP_SECONDS} secondes`}
        className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
      >
        <SkipBack15Icon className="size-[1.125rem]" />
      </button>

      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? "Mettre en pause" : "Écouter l'enregistrement"}
        className="bg-primary text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-90"
      >
        {playing ? (
          <PauseIcon className="size-4" />
        ) : (
          // Nudged right so the triangle reads centred: its optical centre
          // is left of its box's.
          <PlayIcon className="ml-0.5 size-4" />
        )}
      </button>

      <button
        type="button"
        onClick={() => seekTo(time + SKIP_SECONDS)}
        aria-label={`Avancer de ${SKIP_SECONDS} secondes`}
        className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
      >
        <SkipForward15Icon className="size-[1.125rem]" />
      </button>
    </>
  );
}

/**
 * The seekable bar. The track is the touch target, taller than the 6 px bar
 * it draws.
 *
 * A scrub before anything has loaded is legal: with `readyState` at
 * HAVE_NOTHING, assigning `currentTime` sets the media element's default
 * playback start position (HTML spec, "seeking"), so play then begins from
 * the scrubbed point — the bar previews it immediately, and nothing is
 * fetched until play is pressed.
 */
function Track({ playback }: { playback: AudioPlayback }) {
  const { time, duration, seekTo } = playback;
  const onScrub = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / rect.width;
    seekTo(fraction * duration);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const offset = seekKeyOffset(event.key);
    if (offset !== null) seekTo(time + offset);
  };

  return (
    <div
      role="slider"
      aria-label="Position dans l'enregistrement"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={`${formatClock(time)} sur ${formatClock(duration)}`}
      tabIndex={0}
      onPointerDown={onScrub}
      onKeyDown={onKeyDown}
      className="group flex h-5 min-w-16 flex-1 cursor-pointer items-center"
    >
      <div className="bg-primary/15 h-1.5 w-full overflow-hidden rounded-full">
        <div
          className="bg-primary h-full rounded-full"
          style={{ width: `${playbackProgress(time, duration) * 100}%` }}
        />
      </div>
    </div>
  );
}

function MuteButton({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={muted ? "Rétablir le son" : "Couper le son"}
      className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
    >
      {muted ? (
        <VolumeMutedIcon className="size-[1.125rem]" />
      ) : (
        <VolumeIcon className="size-[1.125rem]" />
      )}
    </button>
  );
}

/** « Supprimer », then « Confirmer » / « Annuler » once armed. */
function DeleteControl({
  state,
  arm,
  cancel,
  confirm,
}: {
  state: DeletionState;
  arm: () => void;
  cancel: () => void;
  confirm: () => void;
}) {
  if (state.stage === "idle") {
    return (
      <button
        type="button"
        onClick={arm}
        className="text-muted-foreground hover:text-danger flex shrink-0 items-center gap-1 text-xs transition-colors"
      >
        <TrashIcon className="size-3.5" />
        Supprimer
      </button>
    );
  }
  const deleting = state.stage === "deleting";
  return (
    <span className="flex shrink-0 items-center gap-2 text-xs">
      <button
        type="button"
        onClick={confirm}
        disabled={deleting}
        className="text-danger font-semibold hover:underline disabled:opacity-60"
      >
        {deleting ? "Suppression…" : "Confirmer"}
      </button>
      <button
        type="button"
        onClick={cancel}
        disabled={deleting}
        className="text-muted-foreground hover:text-foreground"
      >
        Annuler
      </button>
    </span>
  );
}

/** The warning while armed, and the sentence after a failure. */
function DeletionNotes({ state }: { state: DeletionState }) {
  return (
    <>
      {state.stage === "confirming" && (
        <p className="text-danger mt-1 text-[0.6875rem] leading-snug">
          Suppression définitive : cet enregistrement ne pourra pas être récupéré.
        </p>
      )}
      {state.failed && (
        <p className="text-danger mt-1 text-[0.6875rem] leading-snug">
          La suppression a échoué. Réessayez dans un instant.
        </p>
      )}
    </>
  );
}
