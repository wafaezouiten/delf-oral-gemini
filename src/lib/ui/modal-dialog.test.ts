import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { syncModal, type ModalLike } from "./modal-dialog";

function fake(open: boolean): ModalLike & { calls: string[] } {
  return {
    open,
    calls: [],
    showModal() {
      if (this.open) throw new Error("InvalidStateError: already open");
      this.calls.push("showModal");
    },
    close() {
      this.calls.push("close");
    },
  };
}

describe("keeping a <dialog> in line with its state", () => {
  it("opens a closed dialog and closes an open one", () => {
    const closed = fake(false);
    syncModal(closed, true);
    assert.deepEqual(closed.calls, ["showModal"]);

    const opened = fake(true);
    syncModal(opened, false);
    assert.deepEqual(opened.calls, ["close"]);
  });

  it("touches nothing when the dialog already agrees, and nothing when there is none", () => {
    const opened = fake(true);
    syncModal(opened, true);
    const closed = fake(false);
    syncModal(closed, false);
    assert.deepEqual([opened.calls, closed.calls], [[], []]);
    assert.doesNotThrow(() => syncModal(null, true));
  });
});
