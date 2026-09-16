"use client";

import { useRef, useState, type RefObject } from "react";

import { clampSeek } from "@/lib/ui/recording-player";

export interface AudioPlayback {
  playing: boolean;
  muted: boolean;
  time: number;
  /** The file's own metadata once it loads; the row's measure until then. */
  duration: number;
  seekTo: (seconds: number) => void;
  togglePlay: () => void;
  toggleMute: () => void;
  pause: () => void;
  /** The `<audio>` element's listeners: the one source of truth for the state above. */
  audioProps: {
    onPlay: () => void;
    onPause: () => void;
    onEnded: () => void;
    onTimeUpdate: (event: React.SyntheticEvent<HTMLAudioElement>) => void;
    onLoadedMetadata: (event: React.SyntheticEvent<HTMLAudioElement>) => void;
  };
}

/**
 * One `<audio>` element and what the card reads of it. The total duration
 * comes from the row (measured at upload) until the file's own metadata
 * arrives — the two only disagree by rounding, and the file is the one being
 * scrubbed.
 *
 * The ref comes back beside the state rather than inside it, so the element
 * is the only thing that reads it: everything the card prints is state.
 */
export function useAudioPlayback(
  durationSeconds: number,
): [RefObject<HTMLAudioElement | null>, AudioPlayback] {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [loadedDuration, setLoadedDuration] = useState<number | null>(null);
  const duration = loadedDuration ?? durationSeconds;

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const clamped = clampSeek(seconds, duration);
    audio.currentTime = clamped;
    setTime(clamped);
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      // The promise is not awaited: `onPlay`/`onPause` are the one source of
      // truth for the button, so a refused autoplay or a slow first fetch
      // cannot leave the glyph claiming a playback that never started.
      void audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    if (audio) audio.muted = !muted;
    setMuted(!muted);
  };

  const playback: AudioPlayback = {
    playing,
    muted,
    time,
    duration,
    seekTo,
    togglePlay,
    toggleMute,
    pause: () => audioRef.current?.pause(),
    audioProps: {
      onPlay: () => setPlaying(true),
      onPause: () => setPlaying(false),
      onEnded: () => setTime(0),
      onTimeUpdate: (event) => setTime(event.currentTarget.currentTime),
      onLoadedMetadata: (event) => {
        const measured = event.currentTarget.duration;
        if (Number.isFinite(measured)) setLoadedDuration(measured);
      },
    },
  };
  return [audioRef, playback];
}
