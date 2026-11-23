import type { ActiveOnDay14, GateMeasure, GateShop, GateStatus, PilotGate, SubscriptionPayment } from "./types";

/// The Phase 1 gate's rules for practice mode, the same as the API's (`apps/api/src/pilot-gate.ts`, and
/// docs/pilot-api.md, "The pilot gate"), so the console shows in practice what it shows against the real backend.
/// The two apps share no code, so a change to a rule there is made here as well.

export const TRIAL_DAYS = 14;
/// ฿499, in satang.
export const SUBSCRIPTION_PRICE_SATANG = 49_900;
/// Active on day N: at least one owner decision on a reply in the 7 Bangkok calendar days up to and including day N.
export const ACTIVE_WINDOW_DAYS = 7;
export const PAID_THRESHOLD_PERCENT = 25;
export const ACTIVE_THRESHOLD_PERCENT = 50;

const DAY_MS = 24 * 60 * 60 * 1000;
/// Thailand keeps UTC+7 all year, so a fixed offset gives the shop's calendar day exactly.
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

export function bangkokDay(ms: number): number {
  return Math.floor((ms + BANGKOK_OFFSET_MS) / DAY_MS);
}

/// 1 on the Bangkok calendar day the trial started, 2 from the next midnight in Bangkok, and so on.
export function trialDay(startMs: number, nowMs: number): number {
  return Math.max(1, bangkokDay(nowMs) - bangkokDay(startMs) + 1);
}

export type GateShopInput = {
  tenant: string;
  name: string;
  trialStartedAt: string | null;
  decisions: string[];
  subscriptionPayments: SubscriptionPayment[];
};

function paidOf(payments: SubscriptionPayment[]): { paidAt?: string; paidSatang: number } {
  const ordered = [...payments].sort(
    (a, b) => Date.parse(a.confirmedAt) - Date.parse(b.confirmedAt) || (a.id < b.id ? -1 : 1),
  );
  let total = 0;
  let paidAt: string | undefined;
  for (const payment of ordered) {
    total += payment.amountSatang;
    if (paidAt === undefined && total >= SUBSCRIPTION_PRICE_SATANG) paidAt = payment.confirmedAt;
  }
  return { ...(paidAt === undefined ? {} : { paidAt }), paidSatang: total };
}

function activeOnDay14(startMs: number, day: number, decisionsMs: number[]): ActiveOnDay14 {
  if (day < TRIAL_DAYS) return "not_yet";
  const lastWindowDay = bangkokDay(startMs) + TRIAL_DAYS - 1;
  const firstWindowDay = lastWindowDay - ACTIVE_WINDOW_DAYS + 1;
  if (decisionsMs.some((ms) => bangkokDay(ms) >= firstWindowDay && bangkokDay(ms) <= lastWindowDay)) return "yes";
  return day > TRIAL_DAYS ? "no" : "not_yet";
}

export function gateShop(input: GateShopInput, nowMs: number): GateShop {
  const decided = input.decisions
    .map((at) => ({ at, ms: Date.parse(at) }))
    .filter((decision) => Number.isFinite(decision.ms));
  const latest = decided.reduce<{ at: string; ms: number } | null>(
    (best, decision) => (best === null || decision.ms > best.ms ? decision : best),
    null,
  );
  const { paidAt, paidSatang } = paidOf(input.subscriptionPayments);
  const startMs = input.trialStartedAt === null ? Number.NaN : Date.parse(input.trialStartedAt);
  const day = Number.isFinite(startMs) ? trialDay(startMs, nowMs) : null;
  return {
    tenant: input.tenant,
    name: input.name,
    trialStartedAt: day === null ? null : input.trialStartedAt,
    day,
    trialEnded: day !== null && day > TRIAL_DAYS,
    paid: paidAt !== undefined,
    ...(paidAt === undefined ? {} : { paidAt }),
    paidSatang,
    activeOnDay14: day === null ? "not_yet" : activeOnDay14(startMs, day, decided.map((decision) => decision.ms)),
    ...(latest ? { lastDecisionAt: latest.at } : {}),
  };
}

export function pilotGate(inputs: GateShopInput[], nowMs: number): PilotGate {
  const shops = inputs.map((input) => gateShop(input, nowMs));
  const counted = shops.filter((shop) => shop.trialEnded);
  const measure = (count: number, thresholdPercent: number): GateMeasure => ({
    count,
    percent: counted.length === 0 ? null : Math.floor((count * 100) / counted.length),
    thresholdPercent,
    met: counted.length > 0 && count * 100 >= thresholdPercent * counted.length,
  });
  const paid = measure(counted.filter((shop) => shop.paid).length, PAID_THRESHOLD_PERCENT);
  const active = measure(counted.filter((shop) => shop.activeOnDay14 === "yes").length, ACTIVE_THRESHOLD_PERCENT);
  const status: GateStatus =
    counted.length === 0 ? "not_enough_data" : paid.met && active.met ? "on_track" : "below_line";
  return {
    asOf: new Date(nowMs).toISOString(),
    rules: { trialDays: TRIAL_DAYS, priceSatang: SUBSCRIPTION_PRICE_SATANG, activeWindowDays: ACTIVE_WINDOW_DAYS },
    shops,
    cohort: { counted: counted.length, paid, active, status },
  };
}
