/**
 * POST /api/live-token — mint a short-lived Gemini Live credential.
 *
 * The permanent `GEMINI_API_KEY` never reaches the browser. Instead the client
 * asks this route for an ephemeral token, which is scoped, single-use and
 * expires in minutes. That is the architecture the brief asks for:
 *
 *     Browser -> our server -> ephemeral token -> Gemini Live
 *
 * Called on every connect INCLUDING reconnects, because `uses: 1` means a token
 * is spent the moment a session opens and a resumed session is a new session.
 *
 * Clerk-gated by `src/proxy.ts`; the explicit `auth()` check here is defence in
 * depth, since a matcher typo is a quiet way to hand out API credits.
 */

import { auth } from "@clerk/nextjs/server";
import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";

import { LIVE_MODEL } from "@/lib/gemini/live-config";

export const runtime = "nodejs";
/** Tokens are per-request secrets; nothing here may be cached. */
export const dynamic = "force-dynamic";

/** How long a minted token stays valid. Comfortably longer than one reconnect
 *  round trip, short enough that a leaked token is worthless within the hour. */
const TOKEN_TTL_MINUTES = 15;
/** How long the client has to actually open a session with it. */
const NEW_SESSION_WINDOW_MINUTES = 2;

export async function POST() {
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

  try {
    const client = new GoogleGenAI({ apiKey });
    const now = Date.now();

    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + TOKEN_TTL_MINUTES * 60_000).toISOString(),
        newSessionExpireTime: new Date(now + NEW_SESSION_WINDOW_MINUTES * 60_000).toISOString(),
        // Pin the token to the model we actually use, so a leaked token cannot
        // be spent on a different (more expensive) one.
        liveConnectConstraints: { model: LIVE_MODEL },
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
