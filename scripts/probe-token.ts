/**
 * Isolate the ephemeral-token connection path.
 *
 * The config bisect showed every field is accepted with a direct API key, so
 * whatever stops setup completing lives in the token flow: the apiVersion, the
 * token's own constraints, or how the constrained config must match the
 * connect-time config.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { GoogleGenAI, Modality, type LiveConnectConfig } from "@google/genai";

import { LIVE_MODEL } from "../src/lib/gemini/live-config";

const BARE: LiveConnectConfig = { responseModalities: [Modality.AUDIO] };

async function mint(apiKey: string, tokenConfig: Record<string, unknown>): Promise<string> {
  const server = new GoogleGenAI({ apiKey });
  const token = await server.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + 15 * 60_000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(),
      ...tokenConfig,
    },
  });
  if (!token.name) throw new Error("no token minted");
  return token.name;
}

async function tryConnect(
  token: string,
  apiVersion: string | undefined,
  cfg: LiveConnectConfig,
): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey: token,
    ...(apiVersion ? { httpOptions: { apiVersion } } : {}),
  });
  let info = "";
  try {
    const session = await Promise.race([
      ai.live.connect({
        model: LIVE_MODEL,
        config: cfg,
        callbacks: {
          onopen: () => {},
          onmessage: () => {},
          onerror: (error) => {
            info = ` error=${String(error).slice(0, 90)}`;
          },
          onclose: (event) => {
            info = ` closed(code=${event?.code ?? "?"}, reason="${event?.reason ?? ""}")`;
          },
        },
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
    ]);
    if (session === null) return `HANG${info}`;
    session.close();
    return "OK";
  } catch (error) {
    return `THROW: ${String(error).slice(0, 140)}`;
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  console.log(`model: ${LIVE_MODEL}\n`);

  const cases: Array<{ label: string; tokenConfig: Record<string, unknown>; apiVersion?: string }> =
    [
      {
        label: "constrained token + v1alpha",
        tokenConfig: { liveConnectConstraints: { model: LIVE_MODEL } },
        apiVersion: "v1alpha",
      },
      {
        label: "constrained token, no apiVersion",
        tokenConfig: { liveConnectConstraints: { model: LIVE_MODEL } },
      },
      { label: "unconstrained token + v1alpha", tokenConfig: {}, apiVersion: "v1alpha" },
      { label: "unconstrained token, no apiVersion", tokenConfig: {} },
      { label: "unconstrained token + v1beta", tokenConfig: {}, apiVersion: "v1beta" },
    ];

  for (const testCase of cases) {
    try {
      const token = await mint(apiKey, testCase.tokenConfig);
      const result = await tryConnect(token, testCase.apiVersion, BARE);
      console.log(`  ${testCase.label.padEnd(36)} ${result}`);
    } catch (error) {
      console.log(`  ${testCase.label.padEnd(36)} MINT FAILED: ${String(error).slice(0, 100)}`);
    }
  }

  // If a constrained token works, the constraint must also carry the config the
  // session will actually use — that is the documented purpose of the field.
  console.log("\n  constrained token whose constraint carries the full config:");
  try {
    const token = await mint(apiKey, {
      liveConnectConstraints: { model: LIVE_MODEL, config: BARE },
    });
    console.log(
      `  ${"  with config in constraint".padEnd(36)} ${await tryConnect(token, "v1alpha", BARE)}`,
    );
  } catch (error) {
    console.log(`    MINT FAILED: ${String(error).slice(0, 140)}`);
  }
  console.log("");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
