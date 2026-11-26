/// What a model call costs, in money Manut AI can count exactly. Every price is
/// an integer, every step is integer arithmetic, and every rounding goes up, so
/// the meter can overstate what a shop's calls cost but never understate it.
///
/// - Prices are US dollars per million tokens, written in millionths of a dollar
///   ("micros"): $2.00 per million tokens is 2_000_000.
/// - The exchange rate is satang per US dollar, a whole number (฿35.00 is 3_500).
/// - Spend is kept in millisatang, thousandths of a satang. Rounding each call up
///   to a whole satang would overstate a small call by most of a satang, which
///   adds up over a month of short chats; a thousandth of a satang is below the
///   price of a single token on every model here. People are shown whole satang.
///
/// The products on the way (tokens × micros × satang) pass 2^53 on a large call,
/// so they are BigInt; only the result, which is small, becomes a number.

import type { ChatRequest } from "./model-provider";

export const MILLISATANG_PER_SATANG = 1_000;

export type ModelPrice = {
  inputMicrosUsd: number;
  outputMicrosUsd: number;
  /// A higher price for the whole call once its prompt passes `overInputTokens`.
  longPrompt?: { overInputTokens: number; inputMicrosUsd: number; outputMicrosUsd: number };
};

/// Anthropic's first-party prices per million tokens (the `claude-api` skill's
/// model table, cached 3 November 2026; checked 23 November 2026). Only models
/// listed here can be called: a model the gateway cannot price, it cannot cap.
/// Claude Haiku 5.5's price covers prompts up to 100,000 tokens; above that the
/// whole call is charged at $0.50 and $2.50, the reading that costs more.
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  "claude-haiku-5-5": {
    inputMicrosUsd: 100_000,
    outputMicrosUsd: 500_000,
    longPrompt: { overInputTokens: 100_000, inputMicrosUsd: 500_000, outputMicrosUsd: 2_500_000 },
  },
  "claude-sonnet-5-5": { inputMicrosUsd: 2_000_000, outputMicrosUsd: 10_000_000 },
  "claude-opus-5-5": { inputMicrosUsd: 4_000_000, outputMicrosUsd: 20_000_000 },
});

/// The model's price, or null for any model not in the table. An own-property
/// check, so `constructor` or `__proto__` never passes for a model.
export function priceOf(model: string): ModelPrice | null {
  return Object.hasOwn(MODEL_PRICES, model) ? (MODEL_PRICES[model] ?? null) : null;
}

export type TokenCounts = { inputTokens: number; outputTokens: number };

/// micros per dollar × tokens per million ÷ millisatang per satang.
const DIVISOR = (1_000_000n * 1_000_000n) / BigInt(MILLISATANG_PER_SATANG);

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/// What `tokens` cost at `price`, in millisatang, rounded up once for the whole call.
export function costMillisatang(price: ModelPrice, tokens: TokenCounts, satangPerUsd: number): number {
  if (!isCount(tokens.inputTokens) || !isCount(tokens.outputTokens)) throw new RangeError("invalid_token_count");
  if (!Number.isSafeInteger(satangPerUsd) || satangPerUsd <= 0) throw new RangeError("invalid_exchange_rate");
  const rates = price.longPrompt && tokens.inputTokens > price.longPrompt.overInputTokens ? price.longPrompt : price;
  const micros =
    BigInt(tokens.inputTokens) * BigInt(rates.inputMicrosUsd) + BigInt(tokens.outputTokens) * BigInt(rates.outputMicrosUsd);
  const cost = (micros * BigInt(satangPerUsd) + DIVISOR - 1n) / DIVISOR;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("cost_out_of_range");
  return Number(cost);
}

/// Whole satang, rounded up: what a person is shown for an amount spent. The
/// remainder is taken first, so the division is exact and no float rounds it.
export function ceilSatang(millisatang: number): number {
  const remainder = millisatang % MILLISATANG_PER_SATANG;
  const whole = (millisatang - remainder) / MILLISATANG_PER_SATANG;
  return remainder === 0 ? whole : whole + 1;
}

/// Whole satang, rounded down: what a person is shown for an amount still left.
export function floorSatang(millisatang: number): number {
  return (millisatang - (millisatang % MILLISATANG_PER_SATANG)) / MILLISATANG_PER_SATANG;
}

/// Room for what a provider wraps around the text it is sent: the request's own
/// framing and each message's role. Generous on purpose; they cost a fraction of
/// a satang and keep the estimate above the provider's own count.
const REQUEST_OVERHEAD_TOKENS = 512;
const MESSAGE_OVERHEAD_TOKENS = 16;

const encoder = new TextEncoder();

/// An upper bound on the call's input tokens: one per UTF-8 byte of the system
/// prompt and messages, plus the overheads above. A token always covers at
/// least one byte, so the provider's count stays below this; Thai text, three
/// bytes a character, is where the margin is smallest.
export function estimateInputTokens(request: ChatRequest): number {
  let bytes = request.system === undefined ? 0 : encoder.encode(request.system).byteLength;
  for (const message of request.messages) bytes += encoder.encode(message.content).byteLength;
  return bytes + REQUEST_OVERHEAD_TOKENS + MESSAGE_OVERHEAD_TOKENS * request.messages.length;
}

/// What the call could cost at most: the input estimate and the whole output
/// allowance, at the model's price. This is what is reserved before the call.
export function worstCaseMillisatang(price: ModelPrice, request: ChatRequest, satangPerUsd: number): number {
  return costMillisatang(
    price,
    { inputTokens: estimateInputTokens(request), outputTokens: request.maxOutputTokens },
    satangPerUsd,
  );
}

/// Bangkok is seven hours ahead of UTC all year: Thailand keeps no daylight
/// saving, so a fixed offset is exact and needs no time zone data.
const BANGKOK_OFFSET_MS = 7 * 3600 * 1000;

/// The calendar month in Bangkok at `ms`, as `YYYY-MM`. Months turn at midnight
/// Bangkok time, which is 17:00 UTC the day before.
export function bangkokMonth(ms: number): string {
  const shifted = new Date(ms + BANGKOK_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function isMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/// ฿35.00 a dollar until the owner sets MODEL_SATANG_PER_USD. Mid-market rates in
/// mid-November 2026 were about ฿33.3 to ฿34.0, and a card payment in dollars
/// costs a little more than mid-market, so this overstates rather than
/// understates. The owner's decision.
export const DEFAULT_SATANG_PER_USD = 3_500;
/// ฿200 a shop a month until the owner sets MODEL_DEFAULT_CAP_SATANG: about two
/// fifths of the pilot's ฿499 price. The owner's decision.
export const DEFAULT_CAP_SATANG = 20_000;
/// ฿10 million: far above any shop's month, and low enough that the cap in
/// millisatang stays a safe integer.
export const MAX_CAP_SATANG = 1_000_000_000;
const MAX_SATANG_PER_USD = 1_000_000;

export type GatewaySettings = { satangPerUsd: number; defaultCapSatang: number };

/// A Worker var holding a whole number between `min` and `max`. Unset means the
/// documented default; anything else that is not plainly such a number answers
/// null, so a mistyped setting ("33.90", "3,390") stops the gateway instead of
/// quietly pricing calls at some other number.
function wholeSetting(raw: string | undefined, fallback: number, min: number, max: number): number | null {
  if (raw === undefined) return fallback;
  if (!/^\d{1,10}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

export function gatewaySettings(env: {
  MODEL_SATANG_PER_USD?: string;
  MODEL_DEFAULT_CAP_SATANG?: string;
}): { ok: true; settings: GatewaySettings } | { ok: false; setting: string } {
  const satangPerUsd = wholeSetting(env.MODEL_SATANG_PER_USD, DEFAULT_SATANG_PER_USD, 1, MAX_SATANG_PER_USD);
  if (satangPerUsd === null) return { ok: false, setting: "MODEL_SATANG_PER_USD" };
  const defaultCapSatang = wholeSetting(env.MODEL_DEFAULT_CAP_SATANG, DEFAULT_CAP_SATANG, 0, MAX_CAP_SATANG);
  if (defaultCapSatang === null) return { ok: false, setting: "MODEL_DEFAULT_CAP_SATANG" };
  return { ok: true, settings: { satangPerUsd, defaultCapSatang } };
}

/// A shop's cap: its operator-set override when there is one, else the default.
/// An override of zero is a real cap that stops every call.
export function effectiveCap(
  override: { capSatang: number } | null | undefined,
  defaultCapSatang: number,
): { capSatang: number; source: "override" | "default" } {
  return override ? { capSatang: override.capSatang, source: "override" } : { capSatang: defaultCapSatang, source: "default" };
}
