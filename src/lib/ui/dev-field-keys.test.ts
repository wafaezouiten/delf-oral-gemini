import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { devFieldKeyDown, type FieldKeyEvent } from "./dev-field-keys";

function press(key: string, modifiers: Partial<Pick<FieldKeyEvent, "metaKey" | "ctrlKey">> = {}) {
  const calls = { prevented: 0, submitted: 0, closed: 0 };
  const event: FieldKeyEvent = {
    key,
    metaKey: modifiers.metaKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    preventDefault: () => void calls.prevented++,
    currentTarget: { form: { requestSubmit: () => void calls.submitted++ } },
  };
  devFieldKeyDown(() => void calls.closed++)(event);
  return calls;
}

describe("the dev panel field's keys", () => {
  it("submits on Ctrl+Enter and on Cmd+Enter, and swallows the newline", () => {
    assert.deepEqual(press("Enter", { ctrlKey: true }), { prevented: 1, submitted: 1, closed: 0 });
    assert.deepEqual(press("Enter", { metaKey: true }), { prevented: 1, submitted: 1, closed: 0 });
  });

  it("lets a plain Enter break the line", () => {
    assert.deepEqual(press("Enter"), { prevented: 0, submitted: 0, closed: 0 });
  });

  it("closes on Escape without submitting", () => {
    assert.deepEqual(press("Escape"), { prevented: 0, submitted: 0, closed: 1 });
  });

  it("does nothing for a field outside any form", () => {
    let closed = 0;
    devFieldKeyDown(() => void closed++)({
      key: "Enter",
      metaKey: true,
      ctrlKey: false,
      preventDefault: () => {},
      currentTarget: { form: null },
    });
    assert.equal(closed, 0);
  });
});
