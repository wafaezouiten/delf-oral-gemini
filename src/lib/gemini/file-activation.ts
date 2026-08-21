/**
 * Waiting for an uploaded file to become usable (#73).
 *
 * `ai.files.upload` returning is not the same fact as the file being ready: the
 * Files API answers with the file in `PROCESSING`, and it becomes `ACTIVE` some
 * time later — or ends `FAILED` and never does. A file referenced by
 * `generateContent` before it is `ACTIVE` is refused, and the evaluator used to
 * reference it the moment the upload call resolved. Whether the correction
 * succeeded therefore depended on processing winning a race nobody was
 * refereeing, which is exactly the shape of the "sometimes" in #73.
 *
 * So: read the state the upload came back with, and poll `files.get` until it
 * is `ACTIVE`, for a bounded time. A file that ends `FAILED` fails *with its
 * own status* rather than as whatever `generateContent` would have said about
 * it — the difference between a bug report that says which file died and one
 * that says the corrector was mysterious.
 *
 * The poll is bounded because the finish route is: `maxDuration` is 300 s and
 * one grading attempt can already spend most of it, so the budget here is the
 * same argument `RetryOptions.attempts` makes in `transient.ts`. The defaults
 * below allow 30 s per file, and the files are polled concurrently (the upload
 * fan-out is bounded at the two speaking phases), so the worst case adds one
 * poll window to the wait, not one per file.
 *
 * Kept apart from `evaluate.ts` so `node --test` can reach it without a
 * network or an API key — the getter and the sleeper are both injected.
 */

/** The slice of `@google/genai`'s `File` this decision reads. `state` is the
 *  string enum `FileState`: `PROCESSING | ACTIVE | FAILED`, or absent. */
export interface UploadedFileSnapshot {
  /** The resource name `files.get` wants, e.g. `files/abc-123`. */
  name?: string;
  state?: string;
  /** Set by the service when processing failed — the file's own account of why. */
  error?: { message?: string };
}

export interface FileActivationOptions {
  /** How many polls before giving up. Polls, not attempts: a file already
   *  `ACTIVE` costs zero. */
  polls?: number;
  /** Flat wait between polls. Flat rather than doubling because this is not
   *  backoff — the service is not overloaded, the file is simply not ready yet,
   *  and the goal is to notice promptly when it is. */
  delayMs?: number;
  /** Injectable so the tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each wait, so the caller can log what it is waiting on. */
  onPoll?: (state: string, poll: number) => void;
}

/** 15 × 2 s = 30 s of patience per file, inside a 300 s route budget most of
 *  which one model call can spend. A sitting's Opus is ~2.4 MB total; observed
 *  processing is seconds, so this is headroom rather than an expectation. */
export const ACTIVATION_POLLS = 15;
export const ACTIVATION_DELAY_MS = 2000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Return the file once it is `ACTIVE`, or throw with the file's own state.
 *
 * A snapshot with **no state at all** is returned as-is: that is what the
 * pre-#73 code assumed about every upload, and refusing it would turn an SDK
 * that stopped reporting state into an evaluator that stopped working. The
 * final snapshot is what is returned — `files.get` is the fresher read, and
 * the caller takes `uri` and `mimeType` from it.
 */
export async function waitForFileActive<T extends UploadedFileSnapshot>(
  uploaded: T,
  get: (name: string) => Promise<T>,
  options: FileActivationOptions = {},
): Promise<T> {
  const polls = options.polls ?? ACTIVATION_POLLS;
  const delayMs = options.delayMs ?? ACTIVATION_DELAY_MS;
  const sleep = options.sleep ?? wait;

  let file = uploaded;
  for (let poll = 0; ; poll++) {
    if (file.state === undefined || file.state === "ACTIVE") return file;
    if (file.state === "FAILED") {
      // The file's own account, not a guess about it.
      const detail = file.error?.message ? `: ${file.error.message}` : "";
      throw new Error(`The uploaded file came back FAILED${detail}`);
    }
    if (!file.name) {
      // PROCESSING with nothing to poll is unrecoverable here, and waiting the
      // whole budget to say so would only delay the same answer.
      throw new Error(`The uploaded file is ${file.state} and carries no name to poll`);
    }
    if (poll >= polls) {
      throw new Error(
        `The uploaded file was still ${file.state} after ${polls} polls (${(polls * delayMs) / 1000}s)`,
      );
    }

    options.onPoll?.(file.state, poll + 1);
    await sleep(delayMs);
    file = await get(file.name);
  }
}
