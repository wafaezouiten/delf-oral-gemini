import "server-only";

import { NextResponse } from "next/server";

import { examRoute } from "@/lib/auth/exam-route";

import type { ExitFlag } from "./exit-request";
import type { SittingRef } from "./sitting-persistence";

/**
 * The server side of `requestExitStamp`: the one shape both ways of leaving an
 * épreuve early answer with.
 *
 * `abandon` and `leave` back different promises — a zero the dialog announced,
 * and the absence of one — and each route's header says which. What they do
 * not differ on is the mechanics, which is what this builds:
 *
 *  - **200 for every legal request, including the ones that wrote nothing.**
 *    The stamp answers `false` for a sitting already stamped, already past the
 *    point, or outranked by a correction that landed while the dialog was open;
 *    none of those is an error the departing candidate could act on, and a
 *    client leaving the page cannot retry anyway. The body flag is what
 *    decides, which is why the client reads it rather than the status.
 *  - **No row to stamp is not a failure either.** No database, a degraded
 *    `local-…` id, or an ownership question the database could not answer:
 *    `persisted: false`, and the candidate still leaves.
 *  - **A thrown write is logged and answered 503.** The candidate is already
 *    leaving; the cost is the record of the exit, never anything they can fix.
 */
export interface ExitStampRoute {
  /** The body key the client reads — `abandoned` or `archived`. */
  flag: ExitFlag;
  /** The one statement that stamps the row, `false` when its guard refused. */
  stamp: (ref: SittingRef, at: Date) => Promise<boolean>;
  /** What to log when the statement throws, for the exam id as requested. */
  failure: (examId: string) => string;
  /** The 503's body. */
  failureBody: string;
}

export function exitStampRoute({ flag, stamp, failure, failureBody }: ExitStampRoute) {
  return examRoute(async (_request, { access, params }) => {
    if (access.status !== "owned") {
      return NextResponse.json({ [flag]: false, persisted: false });
    }

    try {
      const stamped = await stamp({ examId: access.examId, userId: access.userId }, new Date());
      return NextResponse.json({ [flag]: stamped, persisted: true });
    } catch (error) {
      console.error(failure(params.examId), error);
      return NextResponse.json({ error: failureBody }, { status: 503 });
    }
  });
}
