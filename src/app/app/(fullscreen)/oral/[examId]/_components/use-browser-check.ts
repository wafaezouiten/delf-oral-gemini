"use client";

import { useEffect, useState } from "react";

import { isOpusEncodingSupported } from "@/lib/audio/opus-encoder";

/**
 * How long the préparation waits for the browser to say whether it can encode.
 *
 * `AudioEncoder.isConfigSupported` answers in milliseconds; this is only here so
 * that one that never answers costs the candidate three seconds rather than the
 * épreuve.
 */
export const BROWSER_CHECK_TIMEOUT_MS = 3_000;

/**
 * Whether this browser can compress the recording, asked once at mount.
 *
 * `canEncode` is `null` until the browser has answered — and stays `null` if
 * it never does, which is not a no: the notice that tells the candidate to
 * change browser is for a definite refusal. `checking` is what the
 * préparation's checklist shows while the answer is pending.
 */
export function useBrowserCheck() {
  const [canEncode, setCanEncode] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let live = true;
    const settle = (supported: boolean | null) => {
      if (!live) return;
      if (supported !== null) setCanEncode(supported);
      setChecking(false);
    };

    void isOpusEncodingSupported().then(settle);
    const timer = setTimeout(() => settle(null), BROWSER_CHECK_TIMEOUT_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  return { canEncode, checking };
}
