import "server-only";

import { del, get, put } from "@vercel/blob";

import type { OralSpeakingPhase } from "@/lib/db/schema";

/**
 * Where the candidate's recordings live once the sitting is over (#98).
 *
 * Until this existed, the finish route handed the two artefacts to the
 * corrector and dropped them — `oral_recordings.uri` stayed null by design,
 * because the audit's schema sketch forbade retention. #98 reverses that
 * decision: the recording is the one thing a candidate re-listens to, and a
 * correction that can say "your phonologie was heard" ought to be able to let
 * them hear it. The schema was already the right shape for the change of mind
 * (`uri`, `deleted_at`); this module is the place the bytes actually go.
 *
 * **A private object store, read back only through our own routes.** The store
 * is Vercel Blob with `access: 'private'`, and the URL it returns goes into
 * `oral_recordings.uri` and nowhere else — never into a page, a response body
 * or a log. Playback is `GET /api/exams/:examId/recordings/:phase`, which runs
 * `authorizeExam` first and streams the bytes itself, because a guessable link
 * to a stranger's voice would be a worse leak than a guessable score. The
 * alternative — `bytea` rows in Neon — would put a 2.4 MB row per sitting on a
 * database sized for text.
 *
 * **Unconfigured is a real state, not an error.** The vault needs Blob
 * credentials (OIDC on Vercel, or a read-write token elsewhere), and a
 * deployment without them keeps exactly the pre-#98 behaviour: the sitting is
 * graded, the row records that a recording existed, `uri` stays null and
 * `deleted_at` is stamped. Every caller asks {@link recordingVault} and gets
 * `null` rather than an adapter that throws on first use.
 *
 * **How long the bytes are kept.** Until the row that points at them says
 * otherwise. There is no expiry window: « Repartir de zéro » archives the
 * record rather than deleting it (#69), an archived correction stays openable,
 * and a playback that works on the correction must keep working after a reset.
 * `deleted_at` remains the mechanism any future purge would speak through.
 */

/** One stored artefact, opened for playback. */
export interface OpenedRecording {
  stream: ReadableStream<Uint8Array>;
  /** What the store believes it is holding — set from the measured mime type
   *  at upload, so it agrees with `oral_recordings.mime_type`. */
  contentType: string;
  byteSize: number;
}

/**
 * The port. Small on purpose: store, open, and nothing about listing or
 * browsing — every read is addressed by a uri that came out of a row the
 * caller already proved the visitor owns.
 */
export interface RecordingVault {
  /**
   * Keep one phase's artefact durably. Returns the uri to write into
   * `oral_recordings.uri` — opaque to everything but {@link open}.
   */
  store(examId: number, phase: OralSpeakingPhase, bytes: Blob, mimeType: string): Promise<string>;

  /** The bytes back, or null when the store no longer has them. */
  open(uri: string): Promise<OpenedRecording | null>;

  /**
   * Drop one artefact. Nothing on the finish path calls this today — it exists
   * so that whatever decides a purge (a retention window, a per-recording
   * delete button) has the verb ready, and so tests can prove the port whole.
   */
  discard(uri: string): Promise<void>;
}

/**
 * Whether this deployment can keep bytes at all.
 *
 * The same two credential shapes the SDK itself resolves, checked here so the
 * decision can be made — and surfaced to the playback route — without a call
 * that throws: OIDC (automatic on Vercel deployments, paired with the store
 * id) or a static read-write token.
 */
export function isRecordingVaultConfigured(): boolean {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
      (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID),
  );
}

/** File extension by measured mime type — the two formats
 *  `measureUploadedRecording` can accept, and no others. */
const EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/wav": "wav",
};

/** The store's Vercel Blob binding, or null where no store is configured. */
export function recordingVault(): RecordingVault | null {
  if (!isRecordingVaultConfigured()) return null;

  return {
    async store(examId, phase, bytes, mimeType) {
      const extension = EXTENSIONS[mimeType] ?? "bin";
      const stored = await put(`recordings/${examId}/${phase}.${extension}`, bytes, {
        access: "private",
        contentType: mimeType,
        // A repaired finish — one whose first write failed after the upload —
        // stores the same phase again rather than colliding with the orphan
        // its predecessor left behind. Only the uri written to the row is ever
        // read back, so the orphan costs storage, not correctness.
        addRandomSuffix: true,
      });
      return stored.url;
    },

    async open(uri) {
      const found = await get(uri, { access: "private" });
      // 304 is unreachable — nothing here sends `ifNoneMatch` — but the type
      // carries it, and "no stream" must read as "no recording" rather than
      // crash the playback route.
      if (!found || found.stream === null) return null;
      return {
        stream: found.stream,
        contentType: found.blob.contentType,
        byteSize: found.blob.size,
      };
    },

    async discard(uri) {
      await del(uri);
    },
  };
}
