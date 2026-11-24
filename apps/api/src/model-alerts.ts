/// Alerts near the cap (docs/model-gateway.md, "Alerts near the cap"): which shops' model spend has reached 80% or 100% of
/// their monthly cap this month, kept across all shops, so the console lists them from one bounded read instead of asking
/// every shop's object on each page load. The meter notes each crossing in the shop's own month (model-meter.ts,
/// `checkCrossings`); this module carries the notes to one place. It has two halves.
///
/// In each shop's TenantObject, a notice (`model-notice:<tenant>`): the shop's crossings in its latest month with a change,
/// numbered (`seq`), and whether AuthObject has it yet. The meter queues it in the same transaction that notes or takes off
/// a crossing, so the two commit together and a crossing cannot be noted without its notice. The object sends it at once
/// after the write (tenant-object.ts), and when that fails its alarm sends it again a minute later, until AuthObject has it.
///
/// In AuthObject, beside the shops' registry (pilot-store.ts): one row per listed shop, under the month of its newest
/// notice (`model-alert:<month>:<tenant>`), and a pointer to that row (`model-alert-of:<tenant>`). Every console list of
/// shops is read from AuthObject already, so a month's rows are one prefix list there. The record stays bounded: a shop
/// has at most one row, a newer month's notice replaces it, a notice that takes every crossing off removes it, and a
/// notice older than the one kept changes nothing. A row is written only for a shop on the registry, checked in the same
/// transaction, and taking a shop off the registry, the last step of its deletion, takes its row and pointer in the same
/// transaction (`forgetModelAlerts`), so a deleted shop is never listed, even when a notice it sent arrives late.
///
/// Metadata only: a month, thresholds, amounts and times. No prompt or answer text reaches either half.

import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { isMonth, MAX_CAP_SATANG } from "./model-price";
import { authCall, type TenantDataEnv } from "./tenant-data";

/// The thresholds a month's spend is watched for, in whole percent of the shop's cap: near it, and at it.
export const CAP_THRESHOLDS = [80, 100] as const;
export type CapPercent = (typeof CAP_THRESHOLDS)[number];

/// A threshold the month's charged spend reached, as it was noted: when, the cap it was measured against, and the spend
/// (in millisatang) that reached it.
export type CapCrossing = { percent: CapPercent; at: string; capSatang: number; spentMillisatang: number };

/// What the shop's object sends: the shop's crossings in one month, numbered so that AuthObject keeps only the newest.
export type CapNotice = { tenant: string; seq: number; month: string; crossings: CapCrossing[] };

/// A notice as the shop's object keeps it until AuthObject has it. `retryAt` is when the alarm sends it again after a
/// send failed, and null while no send has failed.
type QueuedNotice = CapNotice & { sent: boolean; retryAt: number | null };

/// How long after a failed send the object's alarm sends a notice again.
export const NOTICE_RETRY_MS = 60 * 1000;
/// The most rows one read lists, far more than the pilot's shops. A month with more says so (`truncated`).
export const MAX_LISTED_ALERTS = 500;
const MAX_BODY_BYTES = 4 * 1024;
/// Passes one send makes over the queue: a notice queued while another was on its way goes in the next pass.
const SEND_PASSES = 3;

const enc = encodeURIComponent;
const NOTICE_PREFIX = "model-notice:";
const ROW_PREFIX = "model-alert:";
const rowKey = (month: string, tenant: string) => `${ROW_PREFIX}${month}:${enc(tenant)}`;
const pointerKey = (tenant: string) => `model-alert-of:${enc(tenant)}`;

/// The shop's notice, in its own TenantObject. The meter's wipe takes it with the rest of the meter.
export function capNoticeKey(tenant: string): string {
  return `${NOTICE_PREFIX}${enc(tenant)}`;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// Queues the shop's crossings in `month` for AuthObject, in the caller's transaction. The record keeps each shop's latest
/// month, so a change to an earlier month (a call reserved before midnight and abandoned after it) is not queued: it stays
/// in that month's own total and in the audit log.
export function queueCapNotice(kv: SyncKvStorage, tenant: string, month: string, crossings: CapCrossing[]): void {
  const key = capNoticeKey(tenant);
  const prior = kv.get<QueuedNotice>(key);
  if (prior && prior.month > month) return;
  kv.put(key, { tenant, seq: (prior?.seq ?? 0) + 1, month, crossings, sent: false, retryAt: null } satisfies QueuedNotice);
}

function unsent(kv: SyncKvStorage): [string, QueuedNotice][] {
  return [...kv.list<QueuedNotice>({ prefix: NOTICE_PREFIX })].filter(([, notice]) => !notice.sent);
}

/// Whether a notice is still to be sent: the alarm's notice job has work.
export function noticesUnsent(kv: SyncKvStorage): boolean {
  return unsent(kv).length > 0;
}

/// When the alarm should next send: the soonest retry of an unsent notice, or now for one no send has tried yet.
export function nextNoticeAt(kv: SyncKvStorage, nowMs: number): number | null {
  let soonest: number | null = null;
  for (const [, notice] of unsent(kv)) {
    const at = notice.retryAt ?? nowMs;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}

/// Sends the unsent notices to AuthObject (`POST /model-alerts`), each marked sent once AuthObject answers, and given a
/// retry a minute out when the send fails. With `dueBy`, only those no send has tried, or whose retry has come: a write
/// does not wait on a send that just failed. A notice replaced while it was on its way stays unsent, and the next pass
/// sends the new one.
export async function sendCapNotices(storage: DurableObjectStorage, env: Pick<TenantDataEnv, "AUTH">,
  options: { dueBy?: number } = {}): Promise<void> {
  const tried = new Set<string>();
  for (let pass = 0; pass < SEND_PASSES; pass++) {
    const waiting = unsent(storage.kv).filter(([key, notice]) => !tried.has(`${key}#${notice.seq}`) &&
      (options.dueBy === undefined || notice.retryAt === null || notice.retryAt <= options.dueBy));
    if (waiting.length === 0) return;
    for (const [key, notice] of waiting) {
      tried.add(`${key}#${notice.seq}`);
      let delivered = false;
      try {
        const response = await authCall(env, "/model-alerts", {
          method: "POST",
          headers: { "content-type": "application/json", "x-model": "1" },
          body: JSON.stringify({ tenant: notice.tenant, seq: notice.seq, month: notice.month, crossings: notice.crossings }),
        });
        delivered = response.ok;
        await response.body?.cancel();
      } catch {
        delivered = false;
      }
      const answeredAt = Date.now();
      storage.transactionSync(() => {
        const current = storage.kv.get<QueuedNotice>(key);
        if (!current || current.seq !== notice.seq) return;
        const next: QueuedNotice = delivered ? { ...current, sent: true, retryAt: null }
          : { ...current, retryAt: answeredAt + NOTICE_RETRY_MS };
        storage.kv.put(key, next);
      });
    }
  }
}

/// Whether `value` is a crossing as the meter writes one.
export function isCapCrossing(value: unknown): value is CapCrossing {
  if (!isRecord(value)) return false;
  const { percent, at, capSatang, spentMillisatang } = value;
  return (CAP_THRESHOLDS as readonly unknown[]).includes(percent) &&
    typeof at === "string" && at.length <= 40 && Number.isFinite(Date.parse(at)) &&
    typeof capSatang === "number" && Number.isSafeInteger(capSatang) && capSatang >= 0 && capSatang <= MAX_CAP_SATANG &&
    typeof spentMillisatang === "number" && Number.isSafeInteger(spentMillisatang) && spentMillisatang >= 0;
}

/// A notice as the shop's object sent it, rebuilt field by field so nothing else is kept; null when it is not one.
function noticeOf(value: unknown): CapNotice | null {
  if (!isRecord(value)) return null;
  const { tenant, seq, month, crossings } = value;
  if (!isValidTenant(tenant) || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1 || !isMonth(month) ||
      !Array.isArray(crossings) || crossings.length > CAP_THRESHOLDS.length || !crossings.every(isCapCrossing) ||
      new Set(crossings.map((crossing) => crossing.percent)).size !== crossings.length) {
    return null;
  }
  return {
    tenant, seq, month,
    crossings: crossings.map(({ percent, at, capSatang, spentMillisatang }) => ({ percent, at, capSatang, spentMillisatang })),
  };
}

/// Keeps `notice` as the shop's row, in the caller's transaction, when the shop is listed and the notice is newer than
/// the one kept. Answers whether it was kept.
function keepNotice(kv: SyncKvStorage, notice: CapNotice, listed: boolean): boolean {
  if (!listed) return false;
  const pointer = kv.get<{ month: string; seq: number }>(pointerKey(notice.tenant));
  if (pointer && pointer.seq >= notice.seq) return false;
  if (pointer) kv.delete(rowKey(pointer.month, notice.tenant));
  if (notice.crossings.length > 0) kv.put(rowKey(notice.month, notice.tenant), notice);
  kv.put(pointerKey(notice.tenant), { month: notice.month, seq: notice.seq });
  return true;
}

/// `/model-alerts` on AuthObject:
/// - `GET ?month=`: the listed shops' rows for the month, at most `MAX_LISTED_ALERTS`, and whether there were more;
/// - `POST` `CapNotice`: keep a shop's notice, with the Worker's `x-model` header, which only a shop's TenantObject sends.
///   It answers 200 `{ stored }` whether or not the notice was kept, so a shop's object stops sending one that is older
///   than the record's, or for a shop that is not on the registry.
///
/// `listed` says whether a tenant is on the shops' registry; AuthObject passes its registry's own check, read in the
/// same transaction as the write.
export async function modelAlertsRoute(storage: DurableObjectStorage, request: Request, url: URL,
  listed: (kv: SyncKvStorage, tenant: string) => boolean): Promise<Response> {
  if (request.method === "GET") {
    const month = url.searchParams.get("month");
    if (!isMonth(month)) return json({ error: "invalid_request" }, 400);
    const rows = [...storage.kv.list<CapNotice>({ prefix: `${ROW_PREFIX}${month}:`, limit: MAX_LISTED_ALERTS + 1 })]
      .map(([, row]) => row);
    return json({ month, rows: rows.slice(0, MAX_LISTED_ALERTS), truncated: rows.length > MAX_LISTED_ALERTS });
  }
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  if (request.headers.get("x-model") !== "1") return json({ error: "forbidden" }, 403);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const notice = noticeOf(parsed.value);
  if (!notice) return json({ error: "invalid_request" }, 400);
  const stored = storage.transactionSync(() => keepNotice(storage.kv, notice, listed(storage.kv, notice.tenant)));
  return json({ stored });
}

/// Takes the shop's row and pointer, in the caller's transaction: the registry's removal (pilot-store.ts).
export function forgetModelAlerts(kv: SyncKvStorage, tenant: string): void {
  const pointer = kv.get<{ month: string; seq: number }>(pointerKey(tenant));
  if (pointer) kv.delete(rowKey(pointer.month, tenant));
  kv.delete(pointerKey(tenant));
}
