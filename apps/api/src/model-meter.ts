/// The model gateway's ledger for one shop, kept in that shop's TenantObject
/// (`t:${tenant}`) beside its other records, so tenant export reads it and
/// tenant deletion wipes it. Per shop it holds:
///
/// - an optional cap override an operator set (`model-cap:`);
/// - one total per Bangkok calendar month: millisatang spent, calls by outcome,
///   refusals and tokens (`model-month:`);
/// - one reservation (a "hold") per call in flight (`model-hold:`);
/// - one metering record per call (`model-call:`): when, which model, token
///   counts, cost and outcome. Metadata only: no prompt or answer text is ever
///   sent here, let alone stored.
///
/// Every call settles once: settled with the provider's count, released after a
/// provider failure, or, if nothing settles it before its hold expires, charged
/// its worst case as abandoned. A call can reach only one of these, because each
/// deletes the hold it settles in the same transaction.
///
/// Atomicity. A Durable Object runs one request's synchronous code at a time,
/// and every write below runs inside `transactionSync` using the synchronous KV
/// API of SQLite-backed objects: it reads the month, the holds and the cap,
/// decides and writes without a single await, so no other request can run in
/// between, and a throw rolls all of it back. Two calls racing for the last of
/// a shop's budget are therefore checked one after the other, and only one can
/// pass. (Cloudflare's docs: input gates make reads followed by writes atomic
/// only when no other I/O comes between them; here there is no await at all.)
///
/// Only the Worker reaches these paths, and writes also need its `x-model`
/// header, the same defence in depth as `x-pilot` and `x-wipe`. Every key embeds
/// the URI-encoded tenant, like the object's other keys.

import { auditPutSync } from "./audit-log";
import { readJsonBody } from "./body";
import { ceilSatang, effectiveCap, isMonth, MAX_CAP_SATANG, MILLISATANG_PER_SATANG, bangkokMonth } from "./model-price";
import { sortableId } from "./pilot-store";
import { NOT_COUNTED_IN, teamWaits } from "./shop-waits";

const MAX_BODY_BYTES = 16 * 1024;
/// Records the usage read returns, newest first. Export always reads them all.
const MAX_LISTED_CALLS = 200;
/// Durable Object storage takes at most 128 keys per delete call.
const STORAGE_BATCH = 128;
/// How long a reservation stays held. Longer than the longest a provider is
/// allowed to take (ten minutes for Anthropic, model-provider.ts), so a call
/// still running is never mistaken for an abandoned one.
export const HOLD_TTL_MS = 15 * 60 * 1000;
/// The largest count or amount accepted from the Worker: far above any real
/// call, and low enough that every sum stays a safe integer.
const MAX_AMOUNT = 1_000_000_000_000;

export type CapOverride = { capSatang: number; setAt: string; setBy: string | null };

export type MeterOutcome = "ok" | "failed" | "unreadable" | "abandoned";

/// One model call. `at` is when its budget was reserved, which decides the
/// month it counts in. Token counts are the provider's own, and zero for a call
/// that failed, could not be read, or was abandoned. `satang` is `millisatang`
/// rounded up, for reading; totals add millisatang.
export type MeterRecord = {
  id: string;
  at: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  millisatang: number;
  satang: number;
  outcome: MeterOutcome;
};

export type MonthTotals = {
  month: string;
  spentMillisatang: number;
  ok: number;
  failed: number;
  unreadable: number;
  abandoned: number;
  /// Calls refused at the cap. They never reached a provider, so they have no
  /// record of their own, only this count.
  refused: number;
  inputTokens: number;
  outputTokens: number;
};

/// A call in flight: its worst case counts against its month until it settles.
/// Times are epoch milliseconds.
export type Hold = {
  callId: string;
  month: string;
  model: string;
  worstMillisatang: number;
  at: number;
  expiresAt: number;
};

/// What `GET /model/usage` answers: one month as stored. The Worker applies the
/// default cap and rounds for people (model-gateway.ts).
export type UsageState = {
  capOverride: CapOverride | null;
  totals: MonthTotals;
  holds: Hold[];
  calls: MeterRecord[];
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function bounded(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_AMOUNT;
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const enc = encodeURIComponent;
const keys = {
  cap: (tenant: string) => `model-cap:${enc(tenant)}`,
  months: (tenant: string) => `model-month:${enc(tenant)}:`,
  month: (tenant: string, month: string) => `model-month:${enc(tenant)}:${month}`,
  holds: (tenant: string) => `model-hold:${enc(tenant)}:`,
  hold: (tenant: string, callId: string) => `model-hold:${enc(tenant)}:${enc(callId)}`,
  calls: (tenant: string) => `model-call:${enc(tenant)}:`,
  callsIn: (tenant: string, month: string) => `model-call:${enc(tenant)}:${month}:`,
  call: (tenant: string, month: string, callId: string) => `model-call:${enc(tenant)}:${month}:${enc(callId)}`,
};

function emptyTotals(month: string): MonthTotals {
  return { month, spentMillisatang: 0, ok: 0, failed: 0, unreadable: 0, abandoned: 0, refused: 0, inputTokens: 0, outputTokens: 0 };
}

function readTotals(kv: SyncKvStorage, tenant: string, month: string): MonthTotals {
  return kv.get<MonthTotals>(keys.month(tenant, month)) ?? emptyTotals(month);
}

function readHolds(kv: SyncKvStorage, tenant: string): Hold[] {
  return [...kv.list<Hold>({ prefix: keys.holds(tenant) })].map(([, hold]) => hold);
}

/// Settles `hold` as `record` in one step: the record, the month's total, and
/// the hold's removal. Every way a call ends goes through here, so a call is
/// counted once.
function close(kv: SyncKvStorage, tenant: string, hold: Hold, record: MeterRecord): void {
  const totals = readTotals(kv, tenant, hold.month);
  const next: MonthTotals = {
    ...totals,
    spentMillisatang: totals.spentMillisatang + record.millisatang,
    inputTokens: totals.inputTokens + record.inputTokens,
    outputTokens: totals.outputTokens + record.outputTokens,
  };
  next[record.outcome] += 1;
  kv.put(keys.month(tenant, hold.month), next);
  kv.put(keys.call(tenant, hold.month, hold.callId), record);
  kv.delete(keys.hold(tenant, hold.callId));
}

function recordOf(hold: Hold, outcome: MeterOutcome, tokens: { inputTokens: number; outputTokens: number }, millisatang: number): MeterRecord {
  return {
    id: hold.callId,
    at: new Date(hold.at).toISOString(),
    model: hold.model,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    millisatang,
    satang: ceilSatang(millisatang),
    outcome,
  };
}

/// Holds nothing settled before they expired are charged their worst case:
/// the provider may have answered and billed while the settlement was lost,
/// and the worst case is never below what it could have billed.
function closeExpired(kv: SyncKvStorage, tenant: string, nowMs: number): void {
  for (const hold of readHolds(kv, tenant)) {
    if (hold.expiresAt <= nowMs) close(kv, tenant, hold, recordOf(hold, "abandoned", { inputTokens: 0, outputTokens: 0 }, hold.worstMillisatang));
  }
}

/// `/model/*` on a TenantObject. Reads need only the tenant; writes need the
/// Worker's `x-model` header as well.
export async function modelTenantRoute(storage: DurableObjectStorage, request: Request, url: URL): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  if (request.method === "GET") {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!bounded(tenant)) return json({ error: "invalid_request" }, 400);
    if (route === "GET /model/usage") {
      const month = url.searchParams.get("month");
      if (!isMonth(month)) return json({ error: "invalid_request" }, 400);
      return json(readUsage(storage.kv, tenant, month));
    }
    if (route === "GET /model/export") return json(exportModel(storage.kv, tenant));
    return json({ error: "not_found" }, 404);
  }
  if (request.headers.get("x-model") !== "1") return json({ error: "forbidden" }, 403);
  const parsed = await readJsonBody<Record<string, unknown>>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (body === null || typeof body !== "object" || Array.isArray(body) || !bounded(body.tenant)) {
    return json({ error: "invalid_request" }, 400);
  }
  switch (route) {
    case "POST /model/reserve":
      return reserve(storage, body.tenant, body);
    case "POST /model/settle":
      return settle(storage, body.tenant, body);
    case "POST /model/release":
      return release(storage, body.tenant, body);
    case "POST /model/cap":
      return setCap(storage, body.tenant, body);
  }
  return json({ error: "not_found" }, 404);
}

/// Reserves a call's worst case against its month, or refuses with 402 when the
/// month's spend, the holds still open in it and this worst case together would
/// pass the cap. Reaching the cap exactly is allowed. The time comes from the
/// Worker, which also prices the call; both are trusted, and only the Worker
/// can reach this path.
function reserve(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>): Response {
  const { model, worstMillisatang, defaultCapSatang, nowMs } = body;
  if (!bounded(model, 128) || !isAmount(worstMillisatang) || worstMillisatang === 0 || !isTime(nowMs) ||
      typeof defaultCapSatang !== "number" || !Number.isSafeInteger(defaultCapSatang) || defaultCapSatang < 0 ||
      defaultCapSatang > MAX_CAP_SATANG) {
    return json({ error: "invalid_request" }, 400);
  }
  const answer = storage.transactionSync(() => {
    const kv = storage.kv;
    // A shop its owner made spends nothing until an operator counts it in (shop-waits.ts), whatever its cap: refused
    // before anything is held, and not counted as a refusal at the cap.
    if (teamWaits(kv, tenant)) return { status: 403, body: { error: NOT_COUNTED_IN } };
    closeExpired(kv, tenant, nowMs);
    const month = bangkokMonth(nowMs);
    const { capSatang } = effectiveCap(kv.get<CapOverride>(keys.cap(tenant)), defaultCapSatang);
    const totals = readTotals(kv, tenant, month);
    const heldMillisatang = readHolds(kv, tenant)
      .filter((hold) => hold.month === month)
      .reduce((sum, hold) => sum + hold.worstMillisatang, 0);
    if (totals.spentMillisatang + heldMillisatang + worstMillisatang > capSatang * MILLISATANG_PER_SATANG) {
      kv.put(keys.month(tenant, month), { ...totals, refused: totals.refused + 1 } satisfies MonthTotals);
      return {
        status: 402,
        body: {
          error: "budget_exceeded",
          month,
          capSatang,
          spentMillisatang: totals.spentMillisatang,
          heldMillisatang,
          neededMillisatang: worstMillisatang,
        },
      };
    }
    const callId = sortableId("call", nowMs, 0);
    const hold: Hold = { callId, month, model, worstMillisatang, at: nowMs, expiresAt: nowMs + HOLD_TTL_MS };
    kv.put(keys.hold(tenant, callId), hold);
    return {
      status: 200,
      body: { callId, month, capSatang, spentMillisatang: totals.spentMillisatang, heldMillisatang: heldMillisatang + worstMillisatang },
    };
  });
  return json(answer.body, answer.status);
}

/// Settles a held call: with the provider's counts and the cost the Worker
/// priced from them, or, when the provider answered but its usage could not be
/// read (`unreadable: true`), at the hold's worst case. A hold past its expiry
/// that nothing has closed yet still settles here, more exactly than an
/// abandonment would. The cost is charged as given even above the worst case:
/// it is what the provider bills, and the meter never records less.
function settle(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>): Response {
  const { callId, inputTokens, outputTokens, millisatang, unreadable, nowMs } = body;
  const exact = isAmount(inputTokens) && isAmount(outputTokens) && isAmount(millisatang);
  if (!bounded(callId) || !isTime(nowMs) || (unreadable !== true && !exact)) return json({ error: "invalid_request" }, 400);
  const answer = storage.transactionSync(() => {
    const kv = storage.kv;
    const hold = kv.get<Hold>(keys.hold(tenant, callId));
    if (!hold) {
      closeExpired(kv, tenant, nowMs);
      return null;
    }
    const record =
      unreadable === true
        ? recordOf(hold, "unreadable", { inputTokens: 0, outputTokens: 0 }, hold.worstMillisatang)
        : recordOf(hold, "ok", { inputTokens: inputTokens as number, outputTokens: outputTokens as number }, millisatang as number);
    close(kv, tenant, hold, record);
    closeExpired(kv, tenant, nowMs);
    return record;
  });
  return answer ? json({ record: answer }) : json({ error: "not_reserved" }, 409);
}

/// Releases a held call whose provider failed: nothing is charged, and the
/// record says the call failed.
function release(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>): Response {
  const { callId, nowMs } = body;
  if (!bounded(callId) || !isTime(nowMs)) return json({ error: "invalid_request" }, 400);
  const answer = storage.transactionSync(() => {
    const kv = storage.kv;
    const hold = kv.get<Hold>(keys.hold(tenant, callId));
    if (!hold) {
      closeExpired(kv, tenant, nowMs);
      return null;
    }
    const record = recordOf(hold, "failed", { inputTokens: 0, outputTokens: 0 }, 0);
    close(kv, tenant, hold, record);
    closeExpired(kv, tenant, nowMs);
    return record;
  });
  return answer ? json({ record: answer }) : json({ error: "not_reserved" }, 409);
}

/// Sets the shop's cap override, or clears it with null. Takes effect at the
/// next reservation; calls already holding budget keep it. The operator who
/// set it is written to the shop's audit log in the same transaction, so the
/// cap and its entry commit together (audit-log.ts).
function setCap(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>): Response {
  const { capSatang, setBy } = body;
  const valid = capSatang === null || (typeof capSatang === "number" && Number.isSafeInteger(capSatang) && capSatang >= 0 && capSatang <= MAX_CAP_SATANG);
  if (!valid || (setBy !== null && !bounded(setBy))) return json({ error: "invalid_request" }, 400);
  const capOverride = storage.transactionSync((): CapOverride | null => {
    const actor = { kind: "operator" as const, email: setBy };
    if (capSatang === null) {
      storage.kv.delete(keys.cap(tenant));
      auditPutSync(storage.kv, tenant, { actor, action: "model.cap_cleared", subject: {}, outcome: "ok" },
        "model.cap_cleared");
      return null;
    }
    const override: CapOverride = { capSatang, setAt: new Date().toISOString(), setBy };
    storage.kv.put(keys.cap(tenant), override);
    auditPutSync(storage.kv, tenant, { actor, action: "model.cap_set", subject: {}, outcome: "ok",
      amountSatang: capSatang }, "model.cap_set");
    return override;
  });
  return json({ capOverride });
}

/// One month as stored: the cap override, the month's total, the holds open in
/// it (expired ones included, still counted at their worst case until a write
/// closes them) and its newest records. A read never writes.
function readUsage(kv: SyncKvStorage, tenant: string, month: string): UsageState {
  return {
    capOverride: kv.get<CapOverride>(keys.cap(tenant)) ?? null,
    totals: readTotals(kv, tenant, month),
    holds: readHolds(kv, tenant).filter((hold) => hold.month === month),
    calls: [...kv.list<MeterRecord>({ prefix: keys.callsIn(tenant, month), reverse: true, limit: MAX_LISTED_CALLS })].map(
      ([, record]) => record,
    ),
  };
}

/// Everything the meter holds for the shop, oldest first, for tenant export.
function exportModel(kv: SyncKvStorage, tenant: string) {
  return {
    capOverride: kv.get<CapOverride>(keys.cap(tenant)) ?? null,
    months: [...kv.list<MonthTotals>({ prefix: keys.months(tenant) })].map(([, totals]) => totals),
    calls: [...kv.list<MeterRecord>({ prefix: keys.calls(tenant) })].map(([, record]) => record),
    holds: readHolds(kv, tenant),
  };
}

/// Part of the TenantObject's tenant wipe: every meter row for the tenant.
export async function wipeModelTenant(storage: DurableObjectStorage, tenant: string): Promise<void> {
  const doomed: string[] = [keys.cap(tenant)];
  for (const prefix of [keys.months(tenant), keys.holds(tenant), keys.calls(tenant)]) {
    doomed.push(...(await storage.list({ prefix })).keys());
  }
  for (let i = 0; i < doomed.length; i += STORAGE_BATCH) {
    await storage.delete(doomed.slice(i, i + STORAGE_BATCH));
  }
}
