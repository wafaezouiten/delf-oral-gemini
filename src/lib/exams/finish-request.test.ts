import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { postFinishRequest } from "./finish-request";

/**
 * The transport swap behind #86, held to the contract the `fetch` path set:
 * every HTTP answer resolves with its status and its best effort at a body, a
 * request that never got one rejects, and the upload's progress is reported in
 * a form a screen can draw. No browser here — the injected constructor is the
 * whole point.
 */

interface FakeProgressEvent {
  lengthComputable: boolean;
  loaded: number;
  total: number;
}

class FakeRequest {
  method = "";
  url = "";
  sent: unknown = null;
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  upload = {
    onprogress: null as ((event: FakeProgressEvent) => void) | null,
    onload: null as (() => void) | null,
  };

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  send(body: unknown): void {
    this.sent = body;
  }

  answer(status: number, text: string): void {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
}

function started(onProgress: (fraction: number | null) => void = () => {}) {
  const request = new FakeRequest();
  const answer = postFinishRequest(
    "/api/exams/1/finish",
    new FormData(),
    onProgress,
    () => request as unknown as XMLHttpRequest,
  );
  return { request, answer };
}

describe("posting the finished sitting", () => {
  it("resolves with the status and the route's own JSON", async () => {
    const { request, answer } = started();
    request.answer(200, JSON.stringify({ evaluation: { score25: 18 } }));

    assert.deepEqual(await answer, { status: 200, body: { evaluation: { score25: 18 } } });
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/exams/1/finish");
    assert.ok(request.sent instanceof FormData, "the multipart body went as it was given");
  });

  it("keeps the status when the body is not JSON, because the status decides the retry", async () => {
    // A platform 502 arrives as an HTML page. The old `fetch` path parsed it to
    // null and kept the status; this one must not do worse.
    const { request, answer } = started();
    request.answer(502, "<html>Bad Gateway</html>");

    assert.deepEqual(await answer, { status: 502, body: null });
  });

  it("reports whole percents, and says 1 only from the browser's own sent event", async () => {
    // The last progress event reports loaded === total when the bytes reach the
    // socket buffer — before they have actually left. Letting it say 1 would
    // flip the screen to « en cours de correction » with the recording still
    // draining out of the tab, so progress holds at 0.99 and the upload's
    // `load` event is the only thing that may finish the bar.
    const fractions: Array<number | null> = [];
    const { request } = started((fraction) => fractions.push(fraction));

    request.upload.onprogress?.({ lengthComputable: true, loaded: 1_200_000, total: 2_400_000 });
    request.upload.onprogress?.({ lengthComputable: true, loaded: 2_399_999, total: 2_400_000 });
    request.upload.onprogress?.({ lengthComputable: true, loaded: 2_400_000, total: 2_400_000 });
    request.upload.onload?.();

    assert.deepEqual(fractions, [0.5, 0.99, 0.99, 1]);
  });

  it("says null rather than inventing a fraction the browser did not measure", async () => {
    const fractions: Array<number | null> = [];
    const { request } = started((fraction) => fractions.push(fraction));

    request.upload.onprogress?.({ lengthComputable: false, loaded: 512, total: 0 });

    assert.deepEqual(fractions, [null]);
  });

  it("rejects only when the request never got an answer", async () => {
    const { request, answer } = started();
    request.onerror?.();

    await assert.rejects(() => answer, /never got an answer/);
  });
});
