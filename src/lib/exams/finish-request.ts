/**
 * The finish request itself, sent in a way that can say how far it has got.
 *
 * `fetch` cannot report upload progress, and the upload is the one segment of
 * the candidate's wait whose length the client can actually see (#86): a
 * sitting is ~2.4 MB of Opus, and on hotel wifi those megabytes are most of the
 * minute the screen used to spend behind one undifferentiated spinner. So this
 * request goes over `XMLHttpRequest`, whose upload half emits progress events,
 * and the screen can separate « your recording is still leaving this tab » from
 * « the corrector has it ».
 *
 * The interface deliberately mirrors what the `fetch` path gave the caller: a
 * status and a parsed-if-possible body on any HTTP answer, and a rejection only
 * when the request never got one — offline, DNS, a dropped connection. The
 * finish flow's whole failure vocabulary (`describeFinishFailure`) is built on
 * that split, and this changes the transport without touching it.
 *
 * The constructor is injected so `node --test` can drive the progress events
 * without a browser; nothing else about the request is configurable.
 */

/** How far the upload has got, as a fraction of its bytes — or null while the
 *  browser cannot say. Reported as exactly 1 once the body has fully left,
 *  computable or not, which is the signal the screen changes sentence on. */
export type UploadProgress = (fraction: number | null) => void;

export interface FinishAnswer {
  status: number;
  /** The route's JSON, or null when the body was not JSON — a platform error
   *  arrives as an HTML page, and losing the status with it would lose the half
   *  that decides whether a retry is worth offering. */
  body: { evaluation?: unknown; error?: unknown } | null;
}

export function postFinishRequest(
  url: string,
  form: FormData,
  onUploadProgress: UploadProgress,
  createRequest: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<FinishAnswer> {
  return new Promise((resolve, reject) => {
    const request = createRequest();
    request.open("POST", url);

    request.upload.onprogress = (event) => {
      // `lengthComputable` should always hold here — the body is a FormData the
      // browser measured itself — but a null is honest where a made-up fraction
      // would draw a progress bar that lies.
      onUploadProgress(
        event.lengthComputable && event.total > 0 ? Math.min(event.loaded / event.total, 1) : null,
      );
    };
    // `load` on the upload, not `loadend`: it fires only when the body has
    // actually been sent in full, whereas `loadend` also fires on the way into
    // an error — and a screen that said « en cours de correction » over a
    // request that was failing would be announcing the wrong thing.
    request.upload.onload = () => onUploadProgress(1);

    request.onload = () => {
      let body: FinishAnswer["body"] = null;
      try {
        body = JSON.parse(request.responseText) as FinishAnswer["body"];
      } catch {
        body = null;
      }
      resolve({ status: request.status, body });
    };
    // Both are "the request never got an answer": nothing was refused, so the
    // caller's retry path is the honest one. Same contract as a thrown `fetch`.
    request.onerror = () => reject(new Error("the finish request never got an answer"));
    request.onabort = () => reject(new Error("the finish request was aborted"));

    request.send(form);
  });
}
