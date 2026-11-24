/// The model gateway (docs/model-gateway.md): the one way Manut AI calls a
/// language model for a shop. Every call is priced before it is made, held
/// against the shop's monthly cap, made, and then settled at what the provider
/// bills, so cost per shop is measured call by call and no shop can spend past
/// its cap. The worker adapter contract (docs/phase-0-spikes.md, "Cost") rests
/// on this: a worker never holds a provider key and never calls a model itself.
///
/// The order of one call:
///
/// 1. Check the request, the owner's settings and the provider's key, before
///    anything is held.
/// 2. Reserve the worst case (the input estimate and the whole output allowance
///    at the model's price) in the shop's TenantObject, which refuses with 402
///    `budget_exceeded` when that would pass the cap (model-meter.ts).
/// 3. Call the provider.
/// 4. Settle at the provider's own token counts and release the rest; after a
///    provider failure release it all; when the provider answered but its
///    usage cannot be read, charge the worst case.
///
/// Also here: the operator routes that read a shop's month, set its cap
/// override, and list the shops near or at their caps this month, under the
/// admin gate's exact ADMIN_METHODS entries (index.ts).

import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import type { CapCrossing, CapNotice } from "./model-alerts";
import type { CapOverride, UsageState } from "./model-meter";
import {
  bangkokMonth,
  ceilSatang,
  costMillisatang,
  effectiveCap,
  floorSatang,
  gatewaySettings,
  isMonth,
  MAX_CAP_SATANG,
  MILLISATANG_PER_SATANG,
  priceOf,
  worstCaseMillisatang,
} from "./model-price";
import {
  modelProvider,
  ProviderError,
  type ChatRequest,
  type ChatResult,
  type ChatUsage,
  type ModelProvider,
} from "./model-provider";
import { operatorIdentity } from "./pilot";
import { authCall, tenantCall, type TenantDataEnv } from "./tenant-data";

export type ModelGatewayEnv = Pick<TenantDataEnv, "TENANT"> & {
  /// Anthropic's API key: a Worker secret the owner adds. Without it every call
  /// is refused with 503 `not_configured`, before anything is held or sent.
  ANTHROPIC_API_KEY?: string;
  /// Satang per US dollar, a whole number; ฿35.00 (3500) when unset.
  MODEL_SATANG_PER_USD?: string;
  /// Each shop's monthly cap in satang unless an operator overrides it; ฿200
  /// (20000) when unset.
  MODEL_DEFAULT_CAP_SATANG?: string;
  /// `stand-in` for local runs; Anthropic when unset.
  MODEL_PROVIDER?: string;
};

/// Output tokens one call may ask for. The provider waits for the whole answer
/// rather than streaming it, and Anthropic's guidance keeps such requests near
/// 16,000 tokens so they finish well inside an HTTP timeout. A streaming
/// provider is what would raise it.
export const MAX_OUTPUT_TOKENS = 16_000;
/// Text one call may send, in UTF-8 bytes: about the models' one-million-token
/// window, and small enough that every amount stays a safe integer.
const MAX_INPUT_BYTES = 1_000_000;
const MAX_MESSAGES = 1_000;
/// Token counts above this are not a real answer from any model here; a
/// provider reporting them is treated as unreadable.
const MAX_USAGE_TOKENS = 100_000_000;
const MAX_BODY_BYTES = 16 * 1024;

export type ModelCallResult =
  | {
      ok: true;
      callId: string;
      text: string;
      stopReason: string;
      usage: ChatUsage;
      costMillisatang: number;
      costSatang: number;
    }
  | { ok: false; status: 400; error: "invalid_request" | "unknown_model" }
  | {
      ok: false;
      status: 402;
      error: "budget_exceeded";
      month: string;
      capSatang: number;
      spentSatang: number;
      heldSatang: number;
      neededSatang: number;
    }
  | { ok: false; status: 503; error: "not_configured"; setting: string }
  /// A shop its owner made, which no operator has counted in yet (shop-waits.ts): nothing is held or sent.
  | { ok: false; status: 403; error: "not_counted_in" }
  | { ok: false; status: 503; error: "meter_unavailable" }
  | { ok: false; status: 502 | 503; error: "provider_error"; retryable: boolean; callId: string };

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const encoder = new TextEncoder();

/// Whether the request can be sent at all: a known shape, a sendable size and
/// an allowance within the limit. The model is checked against the price table
/// separately, so an unknown model gets its own answer.
function sendable(request: unknown): request is ChatRequest {
  if (!isRecord(request)) return false;
  const { model, system, messages, maxOutputTokens } = request;
  if (typeof model !== "string" || model.length === 0 || model.length > 128) return false;
  if (system !== undefined && (typeof system !== "string" || system.length === 0)) return false;
  if (typeof maxOutputTokens !== "number" || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 ||
      maxOutputTokens > MAX_OUTPUT_TOKENS) {
    return false;
  }
  // The provider takes turns that start with the customer; consecutive turns
  // of one role are allowed and joined by the provider.
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return false;
  if (!isRecord(messages[0]) || messages[0].role !== "user") return false;
  let bytes = typeof system === "string" ? encoder.encode(system).byteLength : 0;
  for (const message of messages) {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant") ||
        typeof message.content !== "string" || message.content.length === 0) {
      return false;
    }
    bytes += encoder.encode(message.content).byteLength;
    if (bytes > MAX_INPUT_BYTES) return false;
  }
  return true;
}

/// Whether a provider's answer can be priced. One that cannot is charged its
/// worst case: the provider answered, so it may well have billed.
function priceable(result: ChatResult): boolean {
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_USAGE_TOKENS;
  return isRecord(result) && typeof result.text === "string" && typeof result.stopReason === "string" &&
    isRecord(result.usage) && count(result.usage.inputTokens) && count(result.usage.outputTokens);
}

function meterWrite(env: ModelGatewayEnv, tenant: string, path: string, body: Record<string, unknown>): Promise<Response> {
  return tenantCall(env, tenant, path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-model": "1" },
    body: JSON.stringify({ tenant, ...body }),
  });
}

/// Writes that close a call already made. If one is lost, the hold it was meant
/// to close stays counted at its worst case and is charged that when it
/// expires, which is never below the truth, so the caller still gets its answer.
async function closeCall(env: ModelGatewayEnv, tenant: string, path: string, body: Record<string, unknown>): Promise<void> {
  try {
    const response = await meterWrite(env, tenant, path, body);
    await response.body?.cancel();
  } catch {
    // See above: the hold's expiry charges the worst case instead.
  }
}

/// One chat-completion call for `tenant`, metered and capped. `provider` and
/// `now` exist for tests and the Phase 2 stand-in worker; in production the
/// provider comes from the environment and the time from the clock.
export async function callModel(
  env: ModelGatewayEnv,
  tenant: string,
  request: ChatRequest,
  options: { provider?: ModelProvider; now?: () => number } = {},
): Promise<ModelCallResult> {
  if (!isValidTenant(tenant) || !sendable(request)) return { ok: false, status: 400, error: "invalid_request" };
  const price = priceOf(request.model);
  if (!price) return { ok: false, status: 400, error: "unknown_model" };
  const settings = gatewaySettings(env);
  if (!settings.ok) return { ok: false, status: 503, error: "not_configured", setting: settings.setting };
  const provider = options.provider ?? modelProvider(env);
  if (provider.missing) return { ok: false, status: 503, error: "not_configured", setting: provider.missing };
  const now = options.now ?? Date.now;
  const { satangPerUsd, defaultCapSatang } = settings.settings;
  const worst = worstCaseMillisatang(price, request, satangPerUsd);

  // A call the meter cannot hold is never made: an unmetered call is exactly
  // what the gateway exists to prevent.
  let reserved: Response;
  try {
    reserved = await meterWrite(env, tenant, "/model/reserve", {
      model: request.model,
      worstMillisatang: worst,
      defaultCapSatang,
      nowMs: now(),
    });
  } catch {
    return { ok: false, status: 503, error: "meter_unavailable" };
  }
  if (reserved.status === 402) {
    const refusal = (await reserved.json()) as {
      month: string;
      capSatang: number;
      spentMillisatang: number;
      heldMillisatang: number;
    };
    return {
      ok: false,
      status: 402,
      error: "budget_exceeded",
      month: refusal.month,
      capSatang: refusal.capSatang,
      spentSatang: ceilSatang(refusal.spentMillisatang),
      heldSatang: ceilSatang(refusal.heldMillisatang),
      neededSatang: ceilSatang(worst),
    };
  }
  if (reserved.status === 403) {
    // The meter's own refusal names why; any other 403 is the meter failing, not the shop waiting.
    const refusal = (await reserved.json().catch(() => null)) as { error?: unknown } | null;
    return refusal?.error === "not_counted_in" ? { ok: false, status: 403, error: "not_counted_in" }
      : { ok: false, status: 503, error: "meter_unavailable" };
  }
  if (!reserved.ok) {
    await reserved.body?.cancel();
    return { ok: false, status: 503, error: "meter_unavailable" };
  }
  const { callId } = (await reserved.json()) as { callId: string };

  let result: ChatResult;
  try {
    result = await provider.complete(request);
  } catch (caught) {
    const failure = caught instanceof ProviderError ? caught : new ProviderError({ status: 502, retryable: false });
    if (failure.billed) await closeCall(env, tenant, "/model/settle", { callId, unreadable: true, nowMs: now() });
    else await closeCall(env, tenant, "/model/release", { callId, nowMs: now() });
    return { ok: false, status: failure.status, error: "provider_error", retryable: failure.retryable, callId };
  }
  if (!priceable(result)) {
    await closeCall(env, tenant, "/model/settle", { callId, unreadable: true, nowMs: now() });
    return { ok: false, status: 502, error: "provider_error", retryable: false, callId };
  }
  const usage: ChatUsage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
  const cost = costMillisatang(price, usage, satangPerUsd);
  await closeCall(env, tenant, "/model/settle", { callId, ...usage, millisatang: cost, nowMs: now() });
  return { ok: true, callId, text: result.text, stopReason: result.stopReason, usage, costMillisatang: cost, costSatang: ceilSatang(cost) };
}

/// `/v1/admin/model/*`, after the admin gate. Answers null for any other path.
export async function modelAdminRoute(
  request: Request,
  url: URL,
  env: ModelGatewayEnv & Pick<TenantDataEnv, "AUTH">,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/admin/model/")) return null;
  const route = `${request.method} ${url.pathname}`;
  if (route === "GET /v1/admin/model/usage") return readMonth(env, url);
  if (route === "PUT /v1/admin/model/cap") return writeCap(request, env, ctx);
  if (route === "GET /v1/admin/model/alerts") return readAlerts(env);
  return json({ error: "not_found" }, 404);
}

/// A crossing as the routes show it: the spend that reached it rounded up for reading, as every spend here is, beside
/// the exact millisatang.
function crossingView(crossing: CapCrossing) {
  return {
    percent: crossing.percent,
    at: crossing.at,
    capSatang: crossing.capSatang,
    spentSatang: ceilSatang(crossing.spentMillisatang),
    spentMillisatang: crossing.spentMillisatang,
  };
}

/// `GET /v1/admin/model/usage?tenant=&month=`: a shop's spend, cap and calls for
/// one Bangkok month, the current one unless `month` (`YYYY-MM`) names another.
/// Spend and holds are rounded up and what is left rounded down, so the page
/// never shows a shop more room than it has.
async function readMonth(env: ModelGatewayEnv, url: URL): Promise<Response> {
  const tenant = url.searchParams.get("tenant") ?? "";
  if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
  const asked = url.searchParams.get("month");
  if (asked !== null && !isMonth(asked)) return json({ error: "invalid_request" }, 400);
  const month = asked ?? bangkokMonth(Date.now());
  const settings = gatewaySettings(env);
  if (!settings.ok) return json({ error: "not_configured", setting: settings.setting }, 503);
  const response = await tenantCall(env, tenant, `/model/usage?tenant=${encodeURIComponent(tenant)}&month=${month}`);
  if (!response.ok) return json({ error: "meter_unavailable" }, 503);
  const state = (await response.json()) as UsageState;
  const cap = effectiveCap(state.capOverride, settings.settings.defaultCapSatang);
  const spent = state.totals.spentMillisatang;
  const held = state.holds.reduce((sum, hold) => sum + hold.worstMillisatang, 0);
  const left = cap.capSatang * MILLISATANG_PER_SATANG - spent - held;
  const { ok, failed, unreadable, abandoned, refused } = state.totals;
  return json({
    tenant,
    month,
    capSatang: cap.capSatang,
    capSource: cap.source,
    capOverride: state.capOverride,
    spentSatang: ceilSatang(spent),
    spentMillisatang: spent,
    heldSatang: ceilSatang(held),
    heldMillisatang: held,
    remainingSatang: left > 0 ? floorSatang(left) : 0,
    counts: { ok, failed, unreadable, abandoned, refused },
    tokens: { input: state.totals.inputTokens, output: state.totals.outputTokens },
    // The thresholds the month's charged spend has reached, lowest first (docs/model-gateway.md, "Alerts near the cap").
    crossings: (state.totals.crossings ?? []).map(crossingView),
    calls: state.calls,
    holds: state.holds.map((hold) => ({
      callId: hold.callId,
      model: hold.model,
      worstMillisatang: hold.worstMillisatang,
      at: new Date(hold.at).toISOString(),
      expiresAt: new Date(hold.expiresAt).toISOString(),
    })),
  });
}

/// `PUT /v1/admin/model/cap` with `{ tenant, capSatang }`: sets the shop's
/// monthly cap in whole satang, or with `capSatang: null` clears the override
/// so the default applies again. `capSatang` must be present, so a body that
/// forgot it never clears a cap by accident. The record keeps the operator's
/// Access identity, when Access gives one.
async function writeCap(request: Request, env: ModelGatewayEnv, ctx: ExecutionContext): Promise<Response> {
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body)) return json({ error: "invalid_request" }, 400);
  if (!isValidTenant(body.tenant)) return json({ error: "tenant_required" }, 400);
  const cap = body.capSatang;
  if (cap !== null && (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 0 || cap > MAX_CAP_SATANG)) {
    return json({ error: "invalid_request" }, 400);
  }
  const settings = gatewaySettings(env);
  if (!settings.ok) return json({ error: "not_configured", setting: settings.setting }, 503);
  // The default cap and the time go too, so the meter measures this month against the new cap in the same write: a
  // lowered cap notes a threshold the spend is already past, and a raised one takes off one it is back under.
  const written = await meterWrite(env, body.tenant, "/model/cap", {
    capSatang: cap,
    setBy: await operatorIdentity(ctx),
    defaultCapSatang: settings.settings.defaultCapSatang,
    nowMs: Date.now(),
  });
  if (!written.ok) return json({ error: "meter_unavailable" }, 503);
  const { capOverride } = (await written.json()) as { capOverride: CapOverride | null };
  const effective = effectiveCap(capOverride, settings.settings.defaultCapSatang);
  return json({ tenant: body.tenant, capSatang: effective.capSatang, capSource: effective.source, capOverride });
}

/// `GET /v1/admin/model/alerts`: the shops whose charged model spend has reached 80% or 100% of their cap this Bangkok
/// month, across all shops, read from AuthObject's record alone (model-alerts.ts): one bounded read, however many shops
/// there are, and no shop's own object is asked. The shops at their cap come first, then those near it, the latest to
/// cross first within each. `truncated` says the month had more rows than one read lists.
async function readAlerts(env: Pick<TenantDataEnv, "AUTH">): Promise<Response> {
  const month = bangkokMonth(Date.now());
  let response: Response;
  try {
    response = await authCall(env, `/model-alerts?month=${month}`);
  } catch {
    return json({ error: "alerts_unavailable" }, 503);
  }
  if (!response.ok) {
    await response.body?.cancel();
    return json({ error: "alerts_unavailable" }, 503);
  }
  const { rows, truncated } = (await response.json()) as { rows: CapNotice[]; truncated: boolean };
  const latest = (row: CapNotice) => row.crossings.reduce((at, crossing) => (crossing.at > at ? crossing.at : at), "");
  const shops = rows
    .filter((row) => row.crossings.length > 0)
    .map((row) => ({
      tenant: row.tenant,
      percent: Math.max(...row.crossings.map((crossing) => crossing.percent)),
      latest: latest(row),
      crossings: row.crossings.map(crossingView),
    }))
    .sort((a, b) => b.percent - a.percent || (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0) ||
      (a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : 0))
    .map(({ latest: _latest, ...shop }) => shop);
  return json({ month, shops, truncated });
}
