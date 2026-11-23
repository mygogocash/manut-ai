import { formatIsoDate } from "../format";
import {
  ApiError,
  MODEL_CAP_MAX_SATANG,
  type ModelCall,
  type ModelCap,
  type ModelCapOverride,
  type ModelHold,
  type ModelUsage,
} from "./types";

/// The model gateway's meter as the practice API keeps it (docs/model-gateway.md), apart from the fake's own file so that
/// file stays about the pilot. The meter holds a cap override per shop, one record per call, and the reservations still
/// open. The API counts the calls it refused at the cap, but the fake makes no calls to refuse, so it keeps no count.
/// Months and totals are read from the records, so a total can never disagree with what it adds up.

export type FakeModel = {
  overrides: (ModelCapOverride & { tenant: string })[];
  calls: (ModelCall & { tenant: string })[];
  holds: (ModelHold & { tenant: string })[];
};

/// What the model gateway reads from the Worker's settings, so practice and tests can put a page in the states a
/// misread setting or an unreadable meter causes. A var left out takes the API's default.
export type FakeModelGateway = {
  vars?: { MODEL_SATANG_PER_USD?: string; MODEL_DEFAULT_CAP_SATANG?: string };
  /// The meter cannot be read or written, so both model routes answer 503 `meter_unavailable`.
  meterUnavailable?: boolean;
};

const MILLISATANG_PER_SATANG = 1000;
/// The newest records one month's answer lists, as the API lists them.
const LISTED_CALLS = 200;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH.test(value);
}

export function validTenant(tenant: unknown): tenant is string {
  return typeof tenant === "string" && tenant.length > 0 && tenant.length <= 256;
}

/// A cap the API takes: null, or whole satang from 0 to the limit. Anything else, a missing one included, is refused.
export function isCapValue(value: unknown): value is number | null {
  return value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MODEL_CAP_MAX_SATANG);
}

/// A Worker var holding a whole number between `min` and `max`, as the API reads one (model-price.ts): unset means the
/// documented default, and anything else that is not plainly such a number answers null.
function wholeSetting(raw: string | undefined, fallback: number, min: number, max: number): number | null {
  if (raw === undefined) return fallback;
  if (!/^\d{1,10}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

/// What both model routes check once their own request is sound, in the API's order: the Worker's settings, which name
/// the var they cannot read, then the meter itself. Answers the default cap the settings give.
export function gatewayDefaultCap(gateway: FakeModelGateway | undefined): number {
  const vars = gateway?.vars ?? {};
  if (wholeSetting(vars.MODEL_SATANG_PER_USD, 3500, 1, 1_000_000) === null) {
    throw new ApiError(503, "not_configured", undefined, { setting: "MODEL_SATANG_PER_USD" });
  }
  const defaultCapSatang = wholeSetting(vars.MODEL_DEFAULT_CAP_SATANG, 20_000, 0, MODEL_CAP_MAX_SATANG);
  if (defaultCapSatang === null) {
    throw new ApiError(503, "not_configured", undefined, { setting: "MODEL_DEFAULT_CAP_SATANG" });
  }
  if (gateway?.meterUnavailable) throw new ApiError(503, "meter_unavailable");
  return defaultCapSatang;
}

/// Whole satang from millisatang, as the API rounds them: spend up and what is left down, with the remainder taken first
/// so no float rounds anything.
export function ceilSatang(millisatang: number): number {
  const remainder = millisatang % MILLISATANG_PER_SATANG;
  const whole = (millisatang - remainder) / MILLISATANG_PER_SATANG;
  return remainder === 0 ? whole : whole + 1;
}

function floorSatang(millisatang: number): number {
  return (millisatang - (millisatang % MILLISATANG_PER_SATANG)) / MILLISATANG_PER_SATANG;
}

/// The calendar month in Bangkok at `ms`, as `YYYY-MM`: the shop's own day (format.ts) cut to its month. Months turn at
/// midnight Bangkok time, as in the API.
export function monthOf(ms: number): string {
  return formatIsoDate(new Date(ms).toISOString()).slice(0, 7);
}

/// A shop's cap: its operator's override when there is one, else the default. An override of zero is a real cap.
export function capOf(model: FakeModel, tenant: string, defaultCapSatang: number): ModelCap {
  const override = model.overrides.find((o) => o.tenant === tenant);
  return {
    tenant,
    capSatang: override ? override.capSatang : defaultCapSatang,
    capSource: override ? "override" : "default",
    capOverride: override ? { capSatang: override.capSatang, setAt: override.setAt, setBy: override.setBy } : null,
  };
}

/// One month of one shop's meter, read as the API answers `GET /v1/admin/model/usage`: totals over every call of the
/// month, the newest 200 records, and spend and holds rounded up with what is left rounded down.
export function usageOf(model: FakeModel, tenant: string, month: string, defaultCapSatang: number): ModelUsage {
  const cap = capOf(model, tenant, defaultCapSatang);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const all = model.calls
    .filter((call) => call.tenant === tenant && monthOf(Date.parse(call.at)) === month)
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
    .map(({ tenant: _tenant, ...call }) => call);
  const holds = model.holds
    .filter((hold) => hold.tenant === tenant && monthOf(Date.parse(hold.at)) === month)
    .map(({ tenant: _tenant, ...hold }) => hold);
  const counts = { ok: 0, failed: 0, unreadable: 0, abandoned: 0, refused: 0 };
  for (const call of all) {
    if (call.outcome === "ok" || call.outcome === "failed" || call.outcome === "unreadable" ||
        call.outcome === "abandoned") {
      counts[call.outcome] += 1;
    }
  }
  const spent = sum(all.map((call) => call.millisatang));
  const held = sum(holds.map((hold) => hold.worstMillisatang));
  const left = cap.capSatang * MILLISATANG_PER_SATANG - spent - held;
  return {
    tenant,
    month,
    capSatang: cap.capSatang,
    capSource: cap.capSource,
    capOverride: cap.capOverride,
    spentSatang: ceilSatang(spent),
    spentMillisatang: spent,
    heldSatang: ceilSatang(held),
    heldMillisatang: held,
    remainingSatang: left > 0 ? floorSatang(left) : 0,
    counts,
    tokens: { input: sum(all.map((call) => call.inputTokens)), output: sum(all.map((call) => call.outputTokens)) },
    calls: all.slice(0, LISTED_CALLS),
    holds,
  };
}

/// Sets a shop's cap override, or clears it with null. It takes effect at the next read, as in the API, where it applies
/// from the next reservation.
export function writeCap(model: FakeModel, tenant: string, capSatang: number | null, setAt: string): void {
  model.overrides = model.overrides.filter((o) => o.tenant !== tenant);
  // The practice key has no Access identity, so nobody is named, as the API records a service token.
  if (capSatang !== null) model.overrides.push({ tenant, capSatang, setAt, setBy: null });
}

/// The meter lives in the shop's own object in the API, so its cap, calls and open reservations go with the rest.
export function wipeMeter(model: FakeModel, tenant: string): void {
  model.overrides = model.overrides.filter((o) => o.tenant !== tenant);
  model.calls = model.calls.filter((c) => c.tenant !== tenant);
  model.holds = model.holds.filter((h) => h.tenant !== tenant);
}
