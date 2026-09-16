"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { requestExaminerChoice } from "@/lib/exams/examiner-choice";
import { LIVE_MODEL } from "@/lib/gemini/constants";

/**
 * Which examiner the candidate chose for this sitting (#99).
 *
 * Seeded from the row, defaulting to the allow-list's default; changed only
 * once the server has recorded the choice, so the socket the controller opens
 * and the row the token is minted against cannot disagree. `ref` is the same
 * value for a callback that must read it without re-subscribing — the finish
 * handler, which stashes it for the results page's provenance line.
 */
export function useExaminerChoice(examId: string, stored: string | null) {
  const [model, setModel] = useState(stored ?? LIVE_MODEL);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const ref = useRef(model);
  useEffect(() => {
    ref.current = model;
  }, [model]);

  const choose = useCallback(
    async (next: string) => {
      if (saving || next === model) return;
      setSaving(true);
      setFailed(false);
      const outcome = await requestExaminerChoice(examId, next);
      if (outcome.applied) setModel(next);
      else setFailed(true);
      setSaving(false);
    },
    [examId, saving, model],
  );

  return { model, ref, saving, failed, choose };
}
