/// The roadmap's Phase 1 gate (docs/plan.md, "Roadmap phases and coverage"): the pilot passes when at least 25% of
/// its shops pay ฿499 after their 14 free days and at least 50% are still active on day 14. Only the owner can pass a
/// gate; this module only measures it (docs/pilot-api.md, "The pilot gate"), from records the backend already keeps:
///
/// - when each shop's trial started: its first LINE connection (pilot-store.ts), the moment the service could start
///   working for it;
/// - its owner's decisions on replies, which the owner's link records on each reply record (`decidedAt`), for an
///   approval and a decline alike;
/// - the shop's own subscription payments to Manut AI, which an operator records against a slip.
///
/// Everything here is a pure function of those records and the time, so its edges (midnight in Bangkok, the first
/// and last moments of the active window, the cohort's cut-off) are tested without a clock.

import type { SubscriptionPayment } from "./pilot-store";

/// The free days before a shop pays. Day 1 is the Bangkok calendar day the trial started on, so the trial ends when
/// day 15 begins, at midnight in Bangkok, and "active on day 14" asks about the trial's last free day.
export const TRIAL_DAYS = 14;
/// ฿499 a month, in satang.
export const SUBSCRIPTION_PRICE_SATANG = 49_900;
/// A shop is active on day N when its owner decided at least one reply in the ACTIVE_WINDOW_DAYS calendar days up to
/// and including day N. A week, because owners of small shops do not decide every day (a quiet Monday, a day at
/// the market), while a whole week without one decision means the shop has stopped using the service. A shorter
/// window would count a busy owner's day off as churn; a longer one would let day 14 lean on the trial's first days.
export const ACTIVE_WINDOW_DAYS = 7;
/// The gate's two lines, in whole percent of the shops counted.
export const PAID_THRESHOLD_PERCENT = 25;
export const ACTIVE_THRESHOLD_PERCENT = 50;

const DAY_MS = 24 * 60 * 60 * 1000;
/// Thailand has kept UTC+7 all year, with no daylight saving, since 1920, so a fixed offset gives the shop's calendar
/// day exactly, without time-zone data in the Worker.
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/// The Bangkok calendar day a moment falls on, as whole days since 1 January 1970 there.
export function bangkokDay(ms: number): number {
  return Math.floor((ms + BANGKOK_OFFSET_MS) / DAY_MS);
}

/// The day of its trial a shop is on at `nowMs`: 1 on the Bangkok calendar day the trial started, 2 from the next
/// midnight in Bangkok, and so on. A start a moment ahead of `nowMs` (the shop's object and the Worker read their own
/// clocks) is still day 1, never day 0: the record says the trial has started.
export function trialDay(startMs: number, nowMs: number): number {
  return Math.max(1, bangkokDay(nowMs) - bangkokDay(startMs) + 1);
}

/// What the gate reads for one shop. `decisions` are the times its owner decided replies; the tenant object sends
/// only the latest one of each Bangkok day, which is all the window and the last decision need.
export type GateShopInput = {
  tenant: string;
  name: string;
  trialStartedAt: string | null;
  decisions: string[];
  subscriptionPayments: SubscriptionPayment[];
  /// The shop was made by its owner, with no operator (self-serve.ts). Absent or false for a shop an operator made.
  selfServe?: boolean;
  /// An operator added this self-serve shop to the cohort (docs/pilot-api.md, "The pilot gate").
  addedToCohort?: boolean;
};

/// "not_yet" until day 14 has an answer: before day 14 always, and on day 14 until a decision in its window arrives
/// or the day ends.
export type ActiveOnDay14 = "yes" | "no" | "not_yet";

export type GateShop = {
  tenant: string;
  name: string;
  /// Null until the shop's LINE account is connected, which starts the trial.
  trialStartedAt: string | null;
  /// Today's day of the trial, or null before it starts.
  day: number | null;
  /// Day 14 has passed. Only these shops are counted.
  trialEnded: boolean;
  /// The shop's subscription payments add up to at least the price, at any time since it joined: a shop that pays
  /// before its free days run out has paid for the days after them.
  paid: boolean;
  /// When the payments first reached the price.
  paidAt?: string;
  /// Everything the shop has paid Manut AI, in satang.
  paidSatang: number;
  activeOnDay14: ActiveOnDay14;
  /// The owner's latest decision on a reply.
  lastDecisionAt?: string;
  /// Made by its owner, with no operator (self-serve.ts).
  selfServe?: true;
  /// Whether the shop is counted once its day 14 has passed: every shop an operator made, and a self-serve shop only once
  /// an operator has added it, since nobody has spoken with its owner the way the pilot's owners were chosen and spoken with.
  inCohort: boolean;
};

/// One of the gate's two shares. `percent` is rounded down, so a share never shows a line it has not reached, and is
/// null while no shop is counted. `met` compares the exact counts, never the rounded percent.
export type GateMeasure = { count: number; percent: number | null; thresholdPercent: number; met: boolean };

export type GateStatus = "not_enough_data" | "on_track" | "below_line";

export type PilotGate = {
  asOf: string;
  rules: { trialDays: number; priceSatang: number; activeWindowDays: number };
  shops: GateShop[];
  cohort: { counted: number; paid: GateMeasure; active: GateMeasure; status: GateStatus };
};

function parsed(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/// When the payments first reached the price, taking them in the order they were confirmed, and their total. Money
/// stays in integer satang throughout; the record route accepts nothing else.
function paidOf(payments: SubscriptionPayment[]): { paidAt?: string; paidSatang: number } {
  const ordered = [...payments].sort((a, b) => parsed(a.confirmedAt) - parsed(b.confirmedAt) || (a.id < b.id ? -1 : 1));
  let total = 0;
  let paidAt: string | undefined;
  for (const payment of ordered) {
    total += payment.amountSatang;
    if (paidAt === undefined && total >= SUBSCRIPTION_PRICE_SATANG) paidAt = payment.confirmedAt;
  }
  return { ...(paidAt === undefined ? {} : { paidAt }), paidSatang: total };
}

/// Whether the owner was active on day 14: a decision in the ACTIVE_WINDOW_DAYS Bangkok calendar days that end with
/// the trial's last free day. A yes can come on day 14 itself; a no only once day 14 is over.
function activeOnDay14(startMs: number, day: number, decisionsMs: number[]): ActiveOnDay14 {
  if (day < TRIAL_DAYS) return "not_yet";
  const lastWindowDay = bangkokDay(startMs) + TRIAL_DAYS - 1;
  const firstWindowDay = lastWindowDay - ACTIVE_WINDOW_DAYS + 1;
  const inWindow = decisionsMs.some((ms) => bangkokDay(ms) >= firstWindowDay && bangkokDay(ms) <= lastWindowDay);
  if (inWindow) return "yes";
  return day > TRIAL_DAYS ? "no" : "not_yet";
}

export function gateShop(input: GateShopInput, nowMs: number): GateShop {
  const decided = input.decisions.map((at) => ({ at, ms: parsed(at) })).filter((decision) => Number.isFinite(decision.ms));
  const latest = decided.reduce<{ at: string; ms: number } | null>(
    (best, decision) => (best === null || decision.ms > best.ms ? decision : best), null);
  const { paidAt, paidSatang } = paidOf(input.subscriptionPayments);
  const startMs = input.trialStartedAt === null ? Number.NaN : parsed(input.trialStartedAt);
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
    ...(input.selfServe ? { selfServe: true as const } : {}),
    inCohort: !input.selfServe || input.addedToCohort === true,
  };
}

/// Every shop's row, and the cohort: the shops counted (`inCohort`) whose day 14 has passed, how many of them paid and how
/// many were active on day 14, each against its line. "not_enough_data" while no shop's day 14 has passed; "on_track" when both
/// shares meet their lines; "below_line" when either does not.
export function pilotGate(inputs: GateShopInput[], nowMs: number): PilotGate {
  const shops = inputs.map((input) => gateShop(input, nowMs));
  // A self-serve shop is listed with the others and left out of the counts until an operator adds it.
  const counted = shops.filter((shop) => shop.inCohort && shop.trialEnded);
  const measure = (count: number, thresholdPercent: number): GateMeasure => ({
    count,
    percent: counted.length === 0 ? null : Math.floor((count * 100) / counted.length),
    thresholdPercent,
    met: counted.length > 0 && count * 100 >= thresholdPercent * counted.length,
  });
  const paid = measure(counted.filter((shop) => shop.paid).length, PAID_THRESHOLD_PERCENT);
  const active = measure(counted.filter((shop) => shop.activeOnDay14 === "yes").length, ACTIVE_THRESHOLD_PERCENT);
  const status: GateStatus = counted.length === 0 ? "not_enough_data" : paid.met && active.met ? "on_track" : "below_line";
  return {
    asOf: new Date(nowMs).toISOString(),
    rules: { trialDays: TRIAL_DAYS, priceSatang: SUBSCRIPTION_PRICE_SATANG, activeWindowDays: ACTIVE_WINDOW_DAYS },
    shops,
    cohort: { counted: counted.length, paid, active, status },
  };
}
