/**
 * POST /api/live-token — mint a Gemini Live credential scoped to one exam phase.
 *
 * The architecture the brief asks for:
 *
 *     Browser -> our server -> ephemeral token -> Gemini Live
 *
 * The permanent `GEMINI_API_KEY` never reaches the browser. What makes this
 * stronger than a bare token is `liveConnectConstraints`: the server builds the
 * WHOLE session config here — including the examiner's system instruction — and
 * pins it into the token. Two consequences, both verified by connecting rather
 * than assumed:
 *
 *  1. **The examiner prompt never leaves the server.** Not in the client bundle,
 *     not over the wire. The browser connects with `responseModalities` alone
 *     and the pinned config is what actually governs the session.
 *  2. **A leaked token is worth almost nothing.** It is single-use, expires in
 *     minutes, and can only ever open the exact session it was minted for.
 *
 * Sharp edge, found the hard way: a constraint carrying ONLY `{ model }` makes
 * the server accept the socket and then kill it with code 1011 "Internal error
 * encountered" — no useful diagnostic. The constraint must carry the config too.
 *
 * **Scope**, which is what Phase 4 added. Being signed in used to be the whole
 * check, and the browser named its own subject. Now the request carries the
 * `examId`, the same ownership module every other exam route uses answers for
 * it, and the subject is read off the sitting. So a token is bound to a phase,
 * a subject, a caller AND a sitting that caller owns — and a candidate can no
 * longer sit subject A on a row that says subject B.
 *
 * The route stays a binding: validation and the mint/deny decision are pure
 * functions in `lib/gemini/live-token-request.ts`, where they can be tested.
 * This file cannot be — it transitively imports `server-only`.
 */

import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";

import { authorizeExam } from "@/lib/auth/exam-guard";
import { findSittingTopicSlug } from "@/lib/db/sittings";
import { findTopic } from "@/lib/delf/topics";
import { LIVE_MODEL } from "@/lib/gemini/constants";
import { liveConfigForPhase } from "@/lib/gemini/live-config";
import { gateLiveToken, parseLiveTokenRequest } from "@/lib/gemini/live-token-request";

export const runtime = "nodejs";
/** Tokens are per-request secrets; nothing here may be cached. */
export const dynamic = "force-dynamic";

/** How long a minted token stays valid. */
const TOKEN_TTL_MINUTES = 15;
/** How long the client has to actually open a session with it. */
const NEW_SESSION_WINDOW_MINUTES = 2;

export async function POST(request: Request) {
  const parsed = parseLiveTokenRequest(await request.json().catch(() => null));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }
  const { phase, examId, requestedTopicSlug, resumptionHandle } = parsed.request;

  const access = await authorizeExam(examId);
  const sittingTopicSlug =
    access.status === "owned" ? await findSittingTopicSlug(access.examId) : undefined;

  const gate = gateLiveToken({ access, sittingTopicSlug, requestedTopicSlug });
  if (gate.decision === "deny") {
    return NextResponse.json({ error: gate.error }, { status: gate.status });
  }

  // The gate hands back a slug, never a topic: it is pure, and the catalogue
  // lookup belongs on this side of the seam. A sitting could in principle name a
  // subject that has since left the catalogue, which is a 404 rather than a
  // silent fallback to something the candidate did not prepare.
  const topic = findTopic(gate.topicSlug);
  if (!topic) {
    console.error("[live-token] sitting names an unknown subject:", gate.topicSlug);
    return NextResponse.json({ error: "Sujet inconnu" }, { status: 404 });
  }
  if (gate.source === "request") {
    // The subject is whatever the browser said. Two very different reasons land
    // here and the log has to tell them apart, because one is routine and the
    // other is an incident: no sitting at all is expected in local development
    // and on the degraded `local-…` ids, whereas an OWNED row whose subject
    // could not be joined means a persisted sitting is broken. Reading
    // "minting for the requested subject" and having to guess which is not a
    // position to put an on-call in.
    const why =
      access.status === "owned"
        ? "owned sitting has no readable subject"
        : `no sitting to read (${access.reason})`;
    console.warn(`[live-token] minting for the requested subject, ${why}:`, examId);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[live-token] GEMINI_API_KEY is not set");
    return NextResponse.json(
      { error: "Le service vocal n'est pas configuré sur le serveur" },
      { status: 500 },
    );
  }

  try {
    const client = new GoogleGenAI({ apiKey });
    const now = Date.now();

    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + TOKEN_TTL_MINUTES * 60_000).toISOString(),
        newSessionExpireTime: new Date(now + NEW_SESSION_WINDOW_MINUTES * 60_000).toISOString(),
        liveConnectConstraints: {
          model: LIVE_MODEL,
          // Both fields are required. Model alone => 1011 on connect.
          config: liveConfigForPhase(phase, { topic, resumptionHandle }),
        },
      },
    });

    if (!token.name) {
      throw new Error("authTokens.create returned no token name");
    }

    return NextResponse.json({ token: token.name });
  } catch (error) {
    // The message can carry the API key in some failure modes — log server-side,
    // return something generic.
    console.error("[live-token] failed to mint ephemeral token:", error);
    return NextResponse.json(
      { error: "Impossible d'ouvrir une session vocale pour le moment" },
      { status: 502 },
    );
  }
}
