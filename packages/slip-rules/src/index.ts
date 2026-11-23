/**
 * Pure rules that compare a payment slip, already read into fields, with an order.
 * Reading the image is not this package's job. A verdict only says whether the slip agrees with the order: it
 * never marks anything paid, because the owner still confirms that the money arrived.
 */

/** Money is integer satang, never a float. */
export type Satang = number;

/** What was read off the slip. Any field may be missing because the reader can fail on any of them. */
export interface Slip {
  amountSatang?: Satang | null | undefined;
  payeeName?: string | null | undefined;
  /** ISO 8601 moment the slip says the transfer happened. */
  paidAt?: string | null | undefined;
  /** The bank's transaction reference, unique per transfer. */
  reference?: string | null | undefined;
}

export interface Order {
  orderRef: string;
  amountSatang: Satang;
  /** ISO 8601 moment the order was placed. */
  placedAt: string;
}

export interface SlipCheckInput {
  slip: Slip;
  order: Order;
  /** The name on the shop's PromptPay account. */
  shopName: string;
  /** Slip references already used, each mapped to the order it settled. */
  usedReferences: Readonly<Record<string, string>>;
}

export type SlipField = "amountSatang" | "payeeName" | "paidAt" | "reference";

export type SlipVerdict =
  | { kind: "unreadable"; missing: SlipField[] }
  | { kind: "already_used"; reference: string; earlierOrderRef: string }
  | { kind: "other_payee"; payeeName: string }
  | { kind: "amount_differs"; slipSatang: Satang; orderSatang: Satang }
  | { kind: "older_than_order"; paidAt: string; placedAt: string }
  /** `ownerMustConfirm` is always true: agreeing with the order is not proof the money arrived. */
  | { kind: "matches"; ownerMustConfirm: true };

/** Phones and banks disagree about the time by a little; five minutes is allowed before a slip is "older". */
export const CLOCK_SKEW_MS = 5 * 60_000;

const FIELD_ORDER: SlipField[] = ["amountSatang", "payeeName", "paidAt", "reference"];

/** Names compare without case, spaces or dots, so `Fon S.` equals `fon s`. */
export function normalizeName(name: string): string {
  return name.normalize("NFC").toLowerCase().replace(/[\s.]+/gu, "");
}

export function sameName(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}

function momentMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function present(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Which slip fields could not be used. A negative or fractional amount is as unusable as a missing one. */
export function missingFields(slip: Slip): SlipField[] {
  const missing = new Set<SlipField>();
  if (!Number.isSafeInteger(slip.amountSatang) || (slip.amountSatang as number) < 0) missing.add("amountSatang");
  if (!present(slip.payeeName)) missing.add("payeeName");
  if (momentMs(slip.paidAt) === null) missing.add("paidAt");
  if (!present(slip.reference)) missing.add("reference");
  return FIELD_ORDER.filter((f) => missing.has(f));
}

/**
 * One verdict for a slip. When several apply the order is: unreadable, already used, other payee, amount
 * differs, older than order.
 */
export function checkSlip(input: SlipCheckInput): SlipVerdict {
  const { slip, order, shopName, usedReferences } = input;

  const missing = missingFields(slip);
  if (missing.length > 0) return { kind: "unreadable", missing };

  // missingFields proved these are present, so the casts only tell the compiler what it cannot follow.
  const reference = (slip.reference as string).trim();
  const payeeName = slip.payeeName as string;
  const amount = slip.amountSatang as number;
  const paidMs = momentMs(slip.paidAt) as number;

  // The same slip may be checked again against the order it already settled; only another order's use counts.
  if (Object.hasOwn(usedReferences, reference)) {
    const earlier = usedReferences[reference] as string;
    if (earlier !== order.orderRef) return { kind: "already_used", reference, earlierOrderRef: earlier };
  }

  if (!sameName(payeeName, shopName)) return { kind: "other_payee", payeeName };

  if (amount !== order.amountSatang) {
    return { kind: "amount_differs", slipSatang: amount, orderSatang: order.amountSatang };
  }

  const placedMs = momentMs(order.placedAt);
  if (placedMs !== null && paidMs < placedMs - CLOCK_SKEW_MS) {
    return { kind: "older_than_order", paidAt: slip.paidAt as string, placedAt: order.placedAt };
  }

  return { kind: "matches", ownerMustConfirm: true };
}
