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
 * The client chooses only the phase, the topic slug and (on a reconnect) its
 * resumption handle. All three are validated here; the prompt is assembled from
 * server-owned source, so a client cannot inject examiner instructions.
 */

import { auth } from "@clerk/nextjs/server";
import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";

import { LIVE_MODEL } from "@/lib/gemini/constants";
import { liveConfigForPhase } from "@/lib/gemini/live-config";
import { findTopic } from "@/lib/delf/topics";

export const runtime = "nodejs";
/** Tokens are per-request secrets; nothing here may be cached. */
export const dynamic = "force-dynamic";

/** How long a minted token stays valid. */
const TOKEN_TTL_MINUTES = 15;
/** How long the client has to actually open a session with it. */
const NEW_SESSION_WINDOW_MINUTES = 2;

interface TokenRequest {
  phase?: unknown;
  topicSlug?: unknown;
  resumptionHandle?: unknown;
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[live-token] GEMINI_API_KEY is not set");
    return NextResponse.json(
      { error: "Le service vocal n'est pas configuré sur le serveur" },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as TokenRequest;

  const phase = body.phase;
  if (phase !== "monologue" && phase !== "debate") {
    return NextResponse.json({ error: "Phase invalide" }, { status: 400 });
  }

  const topic = typeof body.topicSlug === "string" ? findTopic(body.topicSlug) : undefined;
  if (!topic) {
    return NextResponse.json({ error: "Sujet inconnu" }, { status: 400 });
  }

  // A handle is opaque to us, but it is client-supplied, so bound its size
  // rather than forwarding an arbitrary string to Google.
  const resumptionHandle =
    typeof body.resumptionHandle === "string" && body.resumptionHandle.length <= 4096
      ? body.resumptionHandle
      : undefined;

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
