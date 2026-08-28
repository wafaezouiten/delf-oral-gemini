"use client";

/**
 * Where a saved examiner prompt actually lives (#166).
 *
 * The untestable half of `dev-examiner-prompt.ts`: that file holds the key, the
 * record and what makes one stale, and `node --test` checks all of it; this one
 * touches `localStorage` and nothing else, so there is as little of it as the
 * job allows.
 *
 * **Why `localStorage`.** The tool 404s off a production build, so a server
 * store would be a route that must never exist there — one more surface holding
 * the same property `/api/dev/examiner-prompt` already holds. Per browser is
 * also the right SCOPE: a saved prompt is one developer's experiment in
 * progress, not a setting their machine's other profiles should inherit.
 *
 * **Why an external store rather than component state.** The prompt has to
 * reach the controller before the débat's first token is minted, which is long
 * before anybody opens the panel — so the read cannot belong to the panel. And
 * it has to survive a StrictMode remount, which is the failure #166 is largely
 * about. `useSyncExternalStore` over this is what the correction page already
 * does for its own stashed payload, and it is the pattern that reads browser
 * storage without a hydration mismatch: the server snapshot is simply null.
 *
 * Every access is wrapped. `localStorage` throws rather than returning null in
 * a browser configured to block site data, and a dev tool must not be the thing
 * that takes the épreuve down.
 */

import {
  parseSavedPrompt,
  savedPromptKey,
  serialiseSavedPrompt,
  type SavedExaminerPrompt,
} from "./dev-examiner-prompt";

const listeners = new Set<() => void>();

/**
 * The parsed record per sujet, so `getSnapshot` can hand React the SAME object
 * every time it is asked between two writes.
 *
 * Not an optimisation: `useSyncExternalStore` compares snapshots by identity
 * and re-renders until two agree, so a `getSnapshot` that parsed the JSON afresh
 * on every call would return a new object each time and loop forever.
 */
const cache = new Map<string, SavedExaminerPrompt | null>();

function read(topicSlug: string): SavedExaminerPrompt | null {
  try {
    return parseSavedPrompt(localStorage.getItem(savedPromptKey(topicSlug)));
  } catch {
    return null;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

/** For `useSyncExternalStore`. Any write notifies every subscriber; a page has
 *  one sujet open, so there is nothing finer to be gained by keying this. */
export function subscribeSavedPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The saved prompt for a sujet, read through the cache. */
export function savedPromptSnapshot(topicSlug: string): SavedExaminerPrompt | null {
  if (!cache.has(topicSlug)) cache.set(topicSlug, read(topicSlug));
  return cache.get(topicSlug) ?? null;
}

/** There is no `localStorage` while this renders on the server. */
export function savedPromptServerSnapshot(): SavedExaminerPrompt | null {
  return null;
}

/**
 * Write, or refuse quietly.
 *
 * `version` is what `/api/dev/examiner-prompt` reported for the text this was
 * edited from — see `SavedExaminerPrompt.version` for why it cannot simply be
 * imported. The record is read straight back out of `parseSavedPrompt` rather
 * than assumed, so what the cache holds is exactly what a later reload will
 * see, including the cases the parser refuses.
 */
export function saveExaminerPrompt(topicSlug: string, prompt: string, version: string): void {
  const serialised = serialiseSavedPrompt(prompt, version);
  try {
    localStorage.setItem(savedPromptKey(topicSlug), serialised);
  } catch {
    // Full, or blocked. The prompt is still in force for this sitting — only
    // the promise that it outlives it is broken, and the panel's own note is
    // the only thing that would then be lying. Left as a console line rather
    // than a thrown error for the reason the whole file is wrapped.
    console.warn("[dev] the examiner prompt could not be saved");
  }
  cache.set(topicSlug, parseSavedPrompt(serialised));
  notify();
}

/** « Réinitialiser » — the only way back to the shipped instruction. */
export function clearSavedExaminerPrompt(topicSlug: string): void {
  try {
    localStorage.removeItem(savedPromptKey(topicSlug));
  } catch {
    // Nothing to do about it, and nothing worth saying: the next read will
    // find whatever is still there and the panel will say a prompt is saved,
    // which will be true.
  }
  cache.set(topicSlug, null);
  notify();
}
