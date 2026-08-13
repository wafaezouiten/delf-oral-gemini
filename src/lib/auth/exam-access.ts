/**
 * Who may touch a sitting.
 *
 * Being signed in decides nothing here. Exam ids are `serial` (see
 * `oral_exams.id`), so they are guessable by construction: id 41 exists if id 42
 * does, and it belongs to somebody else. Every route that accepts an `examId`
 * therefore has to ask a second question — *is this sitting the caller's?* — and
 * this module is the single place that answers it.
 *
 * It is deliberately free of Clerk, Drizzle and Next: the caller supplies the
 * user id and a lookup, so the decision can be exercised in a unit test with a
 * fake database and two users. `exam-guard.ts` is the thin binding that wires
 * the real ones in.
 *
 * The one invariant, and the only thing the rest of the codebase should rely on:
 * **`owned` is returned when, and only when, the row exists and its `user_id`
 * equals the caller's.** Every other path returns `no-sitting` or `denied`, and
 * neither of those permits reading or writing a persisted sitting.
 */

/** A sitting reduced to the two columns an ownership decision needs. */
export interface ExamOwnerRow {
  id: number;
  userId: string;
}

/** Reads one sitting by id, or nothing. Rejects if the database cannot answer. */
export type ExamOwnerLookup = (examId: number) => Promise<ExamOwnerRow | undefined>;

/** Why the request is refused outright. */
export type ExamAccessDenial = "unauthenticated" | "not-found";

/**
 * Why the request is legal but addresses no verified sitting.
 *
 * All three mean the same thing to a caller — touch no row — but they are
 * distinguished because they are worth different log lines, and because
 * `lookup-failed` is the one that should page somebody.
 */
export type NoSittingReason =
  /** No `DATABASE_URL`; the exam loop runs anyway and persists nothing. */
  | "no-database"
  /** An id no row can have — the `local-…` ids `/api/exams` hands out when it degrades. */
  | "unpersisted-id"
  /** The database was asked and could not answer. Never a reason to proceed as if owned. */
  | "lookup-failed";

export type ExamAccess =
  | { status: "owned"; userId: string; examId: number }
  | { status: "no-sitting"; userId: string; reason: NoSittingReason }
  | { status: "denied"; reason: ExamAccessDenial };

/**
 * What a denial looks like over HTTP.
 *
 * `not-found` is 404 rather than 403 on purpose: 403 would confirm that the
 * sitting exists, which is precisely the fact a caller who does not own it has
 * no business learning. A missing exam and someone else's exam are the same
 * response, deliberately indistinguishable.
 */
export const EXAM_ACCESS_DENIALS = {
  unauthenticated: { status: 401, error: "Non authentifié" },
  "not-found": { status: 404, error: "Épreuve introuvable" },
} as const satisfies Record<ExamAccessDenial, { status: number; error: string }>;

/**
 * The id as a row id, or null when it cannot be one.
 *
 * Route params are strings and arrive from the URL bar, so this is the only
 * place that decides what a persisted id looks like: digits, positive, and
 * inside the range where `Number` is still exact. A 30-digit id would otherwise
 * survive `/^\d+$/`, round to a neighbouring float, and be looked up as a
 * different sitting than the one that was asked for.
 */
export function parsePersistedExamId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export interface ExamAccessQuery {
  /** The caller, straight from Clerk. Null when signed out. */
  userId: string | null;
  /** The `examId` route param, unvalidated. */
  examId: string;
  /** Whether persistence exists at all. */
  databaseConfigured: boolean;
  lookup: ExamOwnerLookup;
}

export async function resolveExamAccess({
  userId,
  examId,
  databaseConfigured,
  lookup,
}: ExamAccessQuery): Promise<ExamAccess> {
  if (!userId) return { status: "denied", reason: "unauthenticated" };

  if (!databaseConfigured) return { status: "no-sitting", userId, reason: "no-database" };

  const id = parsePersistedExamId(examId);
  if (id === null) return { status: "no-sitting", userId, reason: "unpersisted-id" };

  let row: ExamOwnerRow | undefined;
  try {
    row = await lookup(id);
  } catch (error) {
    // An outage must not be an authorisation bypass. The caller degrades to
    // "persist nothing", which is what a request with no database already does.
    console.error("[exam-access] could not verify ownership of exam", id, error);
    return { status: "no-sitting", userId, reason: "lookup-failed" };
  }

  if (!row || row.userId !== userId) return { status: "denied", reason: "not-found" };

  return { status: "owned", userId, examId: row.id };
}
