"use client";

import { useReducer } from "react";

import { DELETION_IDLE, deletionReducer, type DeletionState } from "@/lib/ui/recording-player";

/**
 * « Supprimer » in two presses, against the DELETE endpoint. The steps are
 * `deletionReducer`'s, tested; this sends the request. The DELETE stamps
 * `deleted_at` before the store is cleared (the order `decidePlayback` already
 * trusts), so a success here is a recording that is gone.
 */
export function useRecordingDeletion(
  deleteHref: string | undefined,
  beforeDelete: () => void,
): { state: DeletionState; arm: () => void; cancel: () => void; confirm: () => void } {
  const [state, dispatch] = useReducer(deletionReducer, DELETION_IDLE);

  const confirm = async () => {
    if (!deleteHref) return;
    dispatch("start");
    try {
      beforeDelete();
      const response = await fetch(deleteHref, { method: "DELETE" });
      if (!response.ok) throw new Error(`DELETE ${response.status}`);
      dispatch("ok");
    } catch {
      dispatch("fail");
    }
  };

  return {
    state,
    arm: () => dispatch("arm"),
    cancel: () => dispatch("cancel"),
    confirm: () => void confirm(),
  };
}
