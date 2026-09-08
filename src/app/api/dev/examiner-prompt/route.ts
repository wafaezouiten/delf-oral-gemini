/**
 * GET /api/dev/examiner-prompt — read the examiner's system instruction (#152).
 *
 * DEVELOPMENT ONLY, and a route rather than an import for one reason: the
 * instruction must not be in the client bundle. `buildExaminerInstruction` is a
 * pure function with no `server-only` marker, so a panel could import it
 * directly — and the whole text would then ship to every production browser,
 * losing the property `/api/live-token` is built around. Serving it from a
 * route that refuses off a development build keeps it server-side where it
 * belongs, and the editor still gets the real thing rather than a copy that can
 * drift.
 *
 * It answers with the CURRENT default for a phase and subject — the same call
 * the token route makes when no override is in force — so the editor always
 * opens on the text the examiner is actually running under.
 *
 * Read-only. Applying a prompt is not done here: it travels with the next token
 * mint, which is the only place a system instruction can enter a session.
 */

import { NextResponse } from "next/server";

import { DEV_TOOLS_ENABLED } from "@/lib/dev-tools";
import { buildExaminerInstruction, EXAMINER_PROMPT_VERSION } from "@/lib/delf/examiner-prompt";
import { findTopic } from "@/lib/delf/topics";

export const runtime = "nodejs";
/** The answer depends on the build's own gate; nothing here may be cached. */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // First and unconditional, exactly as `devToolsEnabled` is. A production
  // deployment answers 404 — not 403, because the honest statement is that this
  // route does not exist there rather than that the caller may not use it.
  if (!DEV_TOOLS_ENABLED) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const phase = url.searchParams.get("phase");
  if (phase !== "monologue" && phase !== "debate") {
    return NextResponse.json({ error: "Phase invalide" }, { status: 400 });
  }

  const topic = findTopic(url.searchParams.get("topicSlug") ?? "");
  if (!topic) {
    return NextResponse.json({ error: "Sujet inconnu" }, { status: 404 });
  }

  // No ownership check, deliberately. This returns the shipped instruction for
  // a catalogue subject — the same text for every caller, carrying nothing
  // about any sitting — and it cannot be reached at all on a build where marks
  // are real. An `authorizeExam` here would suggest it guards something it does
  // not.
  return NextResponse.json({
    prompt: buildExaminerInstruction(phase, topic),
    version: EXAMINER_PROMPT_VERSION,
  });
}
