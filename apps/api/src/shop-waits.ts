/// A shop its owner made waits for an operator before its team does anything (docs/several-shops.md, "A shop its owner
/// makes"; docs/decisions.md, 24 Nov 2026). Anyone can make a shop once sign-ups open, and one mailbox can have as many
/// accounts as it likes, so until an operator counts the shop in (the console's "Count it", which sets `addedToCohortAt`,
/// pilot-store.ts) the model gateway refuses its calls (model-meter.ts) and its routines' runs are skipped
/// (routine-store.ts), each with `not_counted_in`. Nothing such a shop asks for is sent to a model or spent on the owner's
/// key: not a routine's topic, not the shop's name, not what the team knows. A shop an operator made never waits.
///
/// Both checks read the shop's record in the same transaction as what they decide, in the shop's own TenantObject. This
/// module imports nothing, so the stores that check can use it without importing one another.

/// Why a waiting shop's model calls are refused and its routines' runs skipped, and what the API says about its team.
export const NOT_COUNTED_IN = "not_counted_in";

/// The key of a pilot shop's record in its TenantObject (pilot-store.ts writes it).
export function pilotShopKey(tenant: string): string {
  return `pilot-shop:${encodeURIComponent(tenant)}`;
}

/// Whether a shop's team waits: its owner made it, and no operator has counted it in yet.
export function waitsForOperator(shop: { selfServe?: true; addedToCohortAt?: string } | null | undefined): boolean {
  return shop?.selfServe === true && shop.addedToCohortAt === undefined;
}

/// The same, read from the shop's record in the caller's transaction. A tenant that is no pilot shop does not wait.
export function teamWaits(kv: SyncKvStorage, tenant: string): boolean {
  return waitsForOperator(kv.get<{ selfServe?: true; addedToCohortAt?: string }>(pilotShopKey(tenant)));
}
