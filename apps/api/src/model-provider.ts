/// The one kind of model call the gateway makes: a chat completion. A provider
/// takes the messages, the model and the output allowance, and answers with the
/// text and the token counts it will bill for. Providers know nothing of prices,
/// caps or shops; the gateway (model-gateway.ts) wraps every call in a
/// reservation and a settlement, so no provider can be called around the meter.

import type { FetchImpl } from "./connectors/types";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ChatRequest = {
  model: string;
  /// Instructions for the whole conversation, such as who the team member is.
  system?: string;
  messages: ChatMessage[];
  /// The most output tokens the call may produce. A model's thinking counts
  /// against it too, so this bounds what the call can cost.
  maxOutputTokens: number;
};

export type ChatUsage = { inputTokens: number; outputTokens: number };

export type ChatResult = {
  text: string;
  /// Why the model stopped, as the provider says it: `end_turn`, `max_tokens`,
  /// `refusal` and so on. A caller checks it before using the text.
  stopReason: string;
  usage: ChatUsage;
};

export interface ModelProvider {
  readonly id: string;
  /// The setting this provider still needs before it can call a model, or null
  /// when it is ready. The gateway refuses up front while one is missing.
  readonly missing: string | null;
  complete(request: ChatRequest): Promise<ChatResult>;
}

/// A call that did not produce a usable answer. Only status codes travel with
/// it, never the provider's message, so no prompt text can reach a log or a
/// response through an error.
export class ProviderError extends Error {
  readonly status: 502 | 503;
  readonly code: "not_configured" | "provider_error";
  /// Whether the same call may succeed if it is tried again later.
  readonly retryable: boolean;
  /// Whether the provider may have charged for the call: it answered, but the
  /// answer could not be read. The gateway then charges the worst case.
  readonly billed: boolean;
  /// The provider's HTTP status when it answered at all.
  readonly upstreamStatus: number | null;

  constructor(init: {
    status: 502 | 503;
    code?: "not_configured" | "provider_error";
    retryable: boolean;
    billed?: boolean;
    upstreamStatus?: number | null;
  }) {
    super(init.code ?? "provider_error");
    this.name = "ProviderError";
    this.status = init.status;
    this.code = init.code ?? "provider_error";
    this.retryable = init.retryable;
    this.billed = init.billed ?? false;
    this.upstreamStatus = init.upstreamStatus ?? null;
  }
}

/// A provider for tests and local runs that never leaves the Worker. It echoes
/// the last customer message, so the same request always gets the same answer,
/// and counts one token per character: never more than the gateway's estimate,
/// which counts one per byte, just as a real tokenizer's count stays below it.
export function standInProvider(): ModelProvider {
  return {
    id: "stand-in",
    missing: null,
    async complete(request) {
      const asked = request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      const reply = [...`Stand-in reply to: ${asked}`];
      const characters = (text: string | undefined) => (text === undefined ? 0 : [...text].length);
      const inputTokens =
        characters(request.system) + request.messages.reduce((sum, message) => sum + characters(message.content), 0);
      const cut = reply.length > request.maxOutputTokens;
      const kept = cut ? reply.slice(0, request.maxOutputTokens) : reply;
      return {
        text: kept.join(""),
        stopReason: cut ? "max_tokens" : "end_turn",
        usage: { inputTokens, outputTokens: kept.length },
      };
    },
  };
}

/// Anthropic's Messages API, as the `claude-api` skill documents it for raw HTTP
/// (checked 23 November 2026): POST with `x-api-key`, `anthropic-version` and a
/// JSON body of `model`, `max_tokens`, `messages` and an optional `system`. The
/// answer's `content` is a list of blocks; the text is in the `text` blocks, and
/// `usage` carries `input_tokens`, `output_tokens` and the two cache counts.
/// This uses fetch rather than Anthropic's SDK because the gateway adds no
/// dependency; the SDK would replace this one function.
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
/// Version 2026-10-21 refuses `temperature`, `top_p` and `top_k`, so none is sent.
export const ANTHROPIC_VERSION = "2026-10-21";
/// The same ceiling Anthropic's SDKs use by default. A reservation outlives it
/// (model-meter.ts), so an answer that arrives at the last moment still settles.
const ANTHROPIC_TIMEOUT_MS = 10 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/// The text, stop reason and usage of a Messages API answer, or null when any
/// part of the usage is missing or impossible.
function readMessage(body: unknown): ChatResult | null {
  if (!isRecord(body) || !Array.isArray(body.content) || !isRecord(body.usage)) return null;
  const usage = body.usage;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const cacheWrite = usage.cache_creation_input_tokens == null ? 0 : count(usage.cache_creation_input_tokens);
  const cacheRead = usage.cache_read_input_tokens == null ? 0 : count(usage.cache_read_input_tokens);
  if (input === null || output === null || cacheWrite === null || cacheRead === null) return null;
  const text = body.content
    .filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  return {
    text,
    stopReason: typeof body.stop_reason === "string" ? body.stop_reason : "unknown",
    // This provider asks for no prompt caching, so both cache counts are zero.
    // Should one appear, a cache write is counted twice (it costs up to twice an
    // input token) and a read once (it costs a tenth), so the meter can only
    // overstate. `input_tokens` excludes both.
    usage: { inputTokens: input + 2 * cacheWrite + cacheRead, outputTokens: output },
  };
}

/// Whether a failed answer is worth trying again: Anthropic's `x-should-retry`
/// header when it gives one, and otherwise the statuses its SDKs retry (408,
/// 409, 429 and 5xx, 529 "overloaded" among them).
function retryableStatus(response: Response): boolean {
  const hint = response.headers.get("x-should-retry");
  if (hint === "true") return true;
  if (hint === "false") return false;
  return response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
}

/// The key is the Worker secret ANTHROPIC_API_KEY, which the owner adds; until
/// then the provider names it as missing and refuses every call, sending nothing.
export function anthropicProvider(
  apiKey: string | undefined,
  fetchImpl: FetchImpl = (url, init) => fetch(url, init),
): ModelProvider {
  return {
    id: "anthropic",
    missing: apiKey ? null : "ANTHROPIC_API_KEY",
    async complete(request) {
      if (!apiKey) throw new ProviderError({ status: 503, code: "not_configured", retryable: false });
      let response: Response;
      try {
        response = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
          body: JSON.stringify({
            model: request.model,
            max_tokens: request.maxOutputTokens,
            ...(request.system === undefined ? {} : { system: request.system }),
            messages: request.messages.map(({ role, content }) => ({ role, content })),
          }),
          signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
        });
      } catch {
        // No answer arrived (a network failure or the timeout): nothing to bill,
        // and a later attempt may well get through.
        throw new ProviderError({ status: 503, retryable: true });
      }
      if (!response.ok) {
        // An error answer is not billed. Its body is dropped unread.
        const retryable = retryableStatus(response);
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderError({ status: retryable ? 503 : 502, retryable, upstreamStatus: response.status });
      }
      const parsed = readMessage(await response.json().catch(() => null));
      if (!parsed) throw new ProviderError({ status: 502, retryable: false, billed: true, upstreamStatus: response.status });
      return parsed;
    },
  };
}

function unconfigured(setting: string): ModelProvider {
  return {
    id: "unconfigured",
    missing: setting,
    async complete() {
      throw new ProviderError({ status: 503, code: "not_configured", retryable: false });
    },
  };
}

/// The provider an environment names: Anthropic unless MODEL_PROVIDER says
/// `stand-in` (for local runs). Any other value is refused rather than read as
/// Anthropic, so a typo can never send real traffic somewhere unintended.
export function modelProvider(env: { ANTHROPIC_API_KEY?: string; MODEL_PROVIDER?: string }): ModelProvider {
  switch (env.MODEL_PROVIDER ?? "anthropic") {
    case "anthropic":
      return anthropicProvider(env.ANTHROPIC_API_KEY);
    case "stand-in":
      return standInProvider();
    default:
      return unconfigured("MODEL_PROVIDER");
  }
}
