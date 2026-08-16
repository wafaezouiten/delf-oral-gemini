/**
 * Published rate cards, and the line between what was measured and what was read.
 *
 * #12 asks for cost per sitting **measured rather than estimated**. Exactly half
 * of that is achievable: the token counts and the minutes are measured, by the
 * harness, against the real services. The price of a token is not a measurable
 * quantity — it is a number a vendor publishes and changes — so it is quoted
 * here with its source and the date it was read, and every figure in the report
 * that depends on one is marked as depending on one.
 *
 * Rates read 2026-08-16. Two of them are time-limited or tiered in ways that
 * matter more than the arithmetic, and both are flagged on the constant itself.
 *
 * NOT a product module. Nothing bills anybody; this exists so the report's costs
 * are computed from recorded tokens by code that can be re-run, rather than
 * multiplied out by hand in prose where an error is invisible.
 */

/** Dollars per million tokens. */
export interface TokenRate {
  input: number;
  output: number;
  /** Where the number came from, so a stale rate can be re-checked. */
  source: string;
  note?: string;
}

/**
 * This system's corrector.
 *
 * The output rate is the one that bites: this model reasons before answering and
 * the reasoning is billed as output, so a correction's output is roughly five
 * times the JSON it returns. `EvaluationUsage.thoughtsTokens` exists to keep that
 * visible.
 */
export const GEMINI_3_6_FLASH: TokenRate = {
  input: 0.75,
  output: 3.75,
  source: "https://ai.google.dev/gemini-api/docs/pricing",
  note: "Introductory rate through 2026-12-31; the posted standard rate from 2027-01-01 is $1.50/$7.50, i.e. every correction cost below doubles on that date.",
};

/**
 * The incumbent's corrector, reached through the Vercel AI Gateway.
 *
 * The gateway is a reseller. These are OpenAI's own posted rates, so the figures
 * below are a FLOOR on what the incumbent actually costs, not the invoice.
 */
export const OPENAI_GPT_5_4: TokenRate = {
  input: 2.5,
  output: 15,
  source: "https://openrouter.ai/openai/gpt-5.4",
  note: "Short-context rate. Rises to $5/$22.50 past ~270K input tokens, which no correction in this corpus approaches.",
};

/** Gemini Live, native audio — this system's examiner, the expensive half. */
export const GEMINI_LIVE_AUDIO: TokenRate = {
  input: 3,
  output: 12,
  source: "https://ai.google.dev/gemini-api/docs/pricing",
  note: "Audio modality. Text tokens on the same session (the system instruction, the transcriptions) are billed at the model's text rate, which is why the Live measurement records the two modalities separately.",
};

/**
 * The incumbent's examiner: an ElevenLabs conversational agent, billed per minute
 * of conversation rather than per token.
 *
 * This is the one number in the report that is neither measured nor measurable
 * from here — there is no ElevenLabs key in the reference checkout's environment,
 * and the agent id it points at is a live production agent that should not be
 * dialled for a benchmark. The range is what the vendor publishes across tiers.
 */
export const ELEVENLABS_AGENT_PER_MINUTE = {
  low: 0.08,
  high: 0.12,
  typical: 0.1,
  source: "https://elevenlabs.io/blog/we-cut-our-pricing-for-conversational-ai",
  note: "$0.08/min on an annual business plan, $0.10/min on Creator and Pro, $0.12/min premium. UNMEASURED: quoted from the rate card, not from an invoice or a call.",
} as const;

/** Cost in dollars for one call, from measured tokens. Nulls propagate as 0. */
export function tokenCost(
  rate: TokenRate,
  tokens: { input: number | null; output: number | null },
): number {
  return ((tokens.input ?? 0) * rate.input + (tokens.output ?? 0) * rate.output) / 1_000_000;
}

/** `$0.0123` — four decimals, because a correction costs less than a cent and a half. */
export function usd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}
