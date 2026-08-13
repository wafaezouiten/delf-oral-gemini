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
type ExamAccessDenial = "unauthenticated" | "not-found";

/**
 * Why the request is legal but addresses no verified sitting.
 *
 * The three are told apart because {@link pageGate} acts on the difference:
 * `no-database` and `unpersisted-id` mean no sitting exists to own, while
 * `lookup-failed` means the question went unanswered — which is not the same
 * thing and must not be treated as if it were.
 */
type NoSittingReason =
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
  } catch {
    // An outage must not be an authorisation bypass. What to do about it is the
    // caller's call — an API route degrades to "persist nothing", a page refuses
    // to render — and so is the log line, which only the caller can attach to a
    // request. This module does no I/O, which is what keeps it testable.
    return { status: "no-sitting", userId, reason: "lookup-failed" };
  }

  if (!row || row.userId !== userId) return { status: "denied", reason: "not-found" };

  return { status: "owned", userId, examId: row.id };
}

/** What a page should do with an outcome. */
export type PageGate = "render" | "sign-in" | "not-found" | "unverifiable";

/**
 * The page-side policy, kept here rather than in the guard so it can be tested.
 *
 * The interesting case is `lookup-failed`, and it is `"unverifiable"` — refuse —
 * rather than `"render"`. Both `/app/oral/[examId]` and `/app/results/[examId]`
 * render nothing owned by anybody today, so rendering would leak nothing; the
 * reason to refuse anyway is that these gates exist for the read path that is
 * coming, and a gate that opens whenever the database hiccups is not a gate. An
 * attacker who can exhaust connections would otherwise get to choose when it
 * opens.
 *
 * Note this is the opposite call from the one the finish route makes on the same
 * outcome, and deliberately so: that route degrades to "grade, persist nothing",
 * which touches no row and loses no work. A page has no equivalent — it either
 * renders a sitting or it does not.
 */
export function pageGate(access: ExamAccess): PageGate {
  if (access.status === "owned") return "render";
  if (access.status === "denied") {
    return access.reason === "unauthenticated" ? "sign-in" : "not-found";
  }
  return access.reason === "lookup-failed" ? "unverifiable" : "render";
}
