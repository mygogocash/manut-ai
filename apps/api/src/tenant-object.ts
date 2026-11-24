import { DurableObject } from "cloudflare:workers";
import { actorOr, auditPut, auditTenantRoute, wipeAuditTenant } from "./audit-log";
import { readJsonBody } from "./body";
import type { AttentionItem } from "./inbound";
import { memoryTenantRoute, wipeMemoryTenant } from "./memory-store";
import { nextNoticeAt, noticesUnsent, sendCapNotices } from "./model-alerts";
import { holdsExpired, modelTenantRoute, nextSweepAt, sweepExpiredHolds, wipeModelTenant } from "./model-meter";
import { peopleTenantRoute, wipePeopleTenant } from "./people-store";
import { pilotTenantRoute, wipePilotTenant } from "./pilot-store";
import { routineTenantRoute, wipeRoutineTenant } from "./routine-store";
import type { TenantDataEnv } from "./tenant-data";

const MAX_BODY_BYTES = 256 * 1024;
/// The alarm is never set sooner than this from now, so work that is already late (a hold whose expiry passed with no
/// alarm set) or keeps failing (a notice AuthObject will not take) comes back once a minute, never in a loop.
const ALARM_FLOOR_MS = 60 * 1000;

/// One job the object's single alarm runs: whether it has work now, when it next will (epoch ms, or null for never),
/// and the work itself, which does whatever is due when it runs.
type AlarmJob = {
  name: string;
  due(kv: SyncKvStorage, nowMs: number): boolean;
  nextAt(kv: SyncKvStorage, nowMs: number): number | null;
  run(nowMs: number): Promise<void>;
};
/// Attention items kept per tenant, newest last. Older items fall off rather
/// than growing the record without bound; the inbox shows recent changes.
const MAX_ATTENTION_ITEMS = 200;
/// Delivery ids remembered per tenant for deduplication. A replay has to
/// land inside the one-minute timestamp window and Linear's own retries end
/// within about seven hours, so this many recent ids covers both with room
/// to spare for one tenant's sandbox workspace.
const MAX_REMEMBERED_DELIVERIES = 1000;

/// Per-tenant state: cloud-work consent, the task index for export and
/// deletion, inbound attention items, and the deletion tombstone. Split out
/// of AuthObject (M4 phase 1): sessions and flags stay global because the
/// Worker learns the tenant from the session and ops controls are
/// environment-wide, but everything keyed by tenant lives here, addressed
/// `t:${tenant}` (`t:operator` for the tenantless operator path). Storage
/// keys keep their `consent:` / `tenant-tasks:` / `tomb:` prefixes
/// unchanged; inbound items add `attention:` and `attention-deliveries:`.
///
/// The object's one alarm serves every job in `jobs`, set for whichever is due
/// first. Before the model gateway's sweep it had no alarm: nothing else kept
/// here (the pilot's records, routines, people, memory, the audit log) schedules
/// anything, since routines' clocks are the ScheduleObject's alarm and the
/// session sweep is AuthObject's. A job added later goes in `jobs`.
export class TenantObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    // An object that wakes with work and no alarm sets one: holds made before the sweep existed, or an alarm lost.
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) await this.arm();
    });
  }

  private get tenantEnv(): Pick<TenantDataEnv, "AUTH"> {
    return this.env as unknown as Pick<TenantDataEnv, "AUTH">;
  }

  /// The model gateway's two jobs: the sweep, which charges every reservation
  /// nothing settled in time as abandoned (model-meter.ts), and sending the
  /// shop's crossings of its cap to the cross-shop record (model-alerts.ts).
  private readonly jobs: readonly AlarmJob[] = [
    {
      name: "model-sweep",
      due: holdsExpired,
      nextAt: (kv) => nextSweepAt(kv),
      run: async (nowMs) => {
        sweepExpiredHolds(this.ctx.storage, nowMs);
      },
    },
    {
      name: "cap-notices",
      due: (kv) => noticesUnsent(kv),
      nextAt: nextNoticeAt,
      run: () => sendCapNotices(this.ctx.storage, this.tenantEnv),
    },
  ];

  /// Runs every job with work now, then sets the alarm for the next. One job's
  /// failure never stops another: its work is still there, so the alarm comes
  /// back for it.
  override async alarm(): Promise<void> {
    const nowMs = Date.now();
    for (const job of this.jobs) {
      if (!job.due(this.ctx.storage.kv, nowMs)) continue;
      try {
        await job.run(nowMs);
      } catch (error) {
        console.error("tenant alarm job failed", job.name, error);
      }
    }
    await this.arm();
  }

  /// Sets the alarm for the soonest moment any job has work, never sooner than
  /// `ALARM_FLOOR_MS` from now, or clears it when none has. It awaits only
  /// storage, so no other request can run in between and leave it stale.
  private async arm(): Promise<void> {
    const nowMs = Date.now();
    let soonest: number | null = null;
    for (const job of this.jobs) {
      const next = job.nextAt(this.ctx.storage.kv, nowMs);
      if (next !== null && (soonest === null || next < soonest)) soonest = next;
    }
    const current = await this.ctx.storage.getAlarm();
    if (soonest === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const at = Math.max(soonest, nowMs + ALARM_FLOOR_MS);
    if (current !== at) await this.ctx.storage.setAlarm(at);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/consent") {
      return this.consent(request);
    }
    if (request.method === "GET" && url.pathname === "/consent") {
      return this.readConsent(url);
    }
    if (request.method === "POST" && url.pathname === "/index") {
      return this.indexTask(request);
    }
    if (request.method === "GET" && url.pathname === "/index") {
      return this.readIndex(url);
    }
    if (request.method === "POST" && url.pathname === "/attention") {
      return this.recordAttention(request);
    }
    if (request.method === "GET" && url.pathname === "/attention") {
      return this.readAttention(url);
    }
    if (request.method === "POST" && url.pathname === "/tenant-wipe") {
      return this.tenantWipe(request);
    }
    // Manut AI pilot records for this tenant (pilot-store.ts).
    if (url.pathname.startsWith("/pilot/")) {
      return pilotTenantRoute(this.ctx.storage, request, url);
    }
    // The model gateway's ledger for this tenant: cap, monthly spend, open
    // reservations and one metering record per call (model-meter.ts). A write
    // can open or close a reservation and queue a crossing for the cross-shop
    // record, so after one the crossing is sent and the alarm set.
    if (url.pathname.startsWith("/model/")) {
      const response = await modelTenantRoute(this.ctx.storage, request, url);
      if (request.method !== "GET") {
        await sendCapNotices(this.ctx.storage, this.tenantEnv, { dueBy: Date.now() });
        await this.arm();
      }
      return response;
    }
    // The team's routines and their runs, whether the team is paused, and a shop template's first-week questions
    // (routine-store.ts).
    if (url.pathname === "/routines" || url.pathname.startsWith("/routines/")) {
      return routineTenantRoute(this.ctx.storage, request, url);
    }
    // The shop's audit log: who did what and when, metadata only (audit-log.ts).
    if (url.pathname === "/audit" || url.pathname.startsWith("/audit/")) {
      return auditTenantRoute(this.ctx.storage, request, url);
    }
    // What the team knows about the shop: its facts, and the owner's say over each (memory-store.ts).
    if (url.pathname === "/memory" || url.pathname.startsWith("/memory/")) {
      return memoryTenantRoute(this.ctx.storage, request, url);
    }
    // The people around the shop: the owner's helpers, invites, cover and notes passed on (people-store.ts).
    if (url.pathname === "/people" || url.pathname.startsWith("/people/")) {
      return peopleTenantRoute(this.ctx.storage, request, url);
    }
    if (request.method === "GET" && url.pathname === "/tombstone") {
      const tenant = url.searchParams.get("tenant") ?? "";
      if (!tenant) return Response.json({ error: "invalid_request" }, { status: 400 });
      const tombstone = await this.ctx.storage.get<{ deletedAt: string; tasksWiped: number }>(
        `tomb:${tenant}`,
      );
      return Response.json({ tombstone: tombstone ?? null });
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  /// Explicit cloud-work consent. Absent means not consented: an app upgrade
  /// or a new device never enables cloud processing by itself.
  ///
  /// Only the owner gives or withdraws it (a signed-in session, or the pilot
  /// owner's approval link), so the audit log names the owner unless the
  /// Worker says otherwise. The entry goes into the same write as the consent.
  private async consent(request: Request): Promise<Response> {
    const parsed = await readJsonBody<{ tenant?: unknown; cloudWork?: unknown; actor?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    if (typeof body.tenant !== "string" || !body.tenant || typeof body.cloudWork !== "boolean") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const record = { cloudWork: body.cloudWork, updatedAt: new Date().toISOString() };
    const action = body.cloudWork ? "consent.given" : "consent.withdrawn";
    const actor = actorOr(body.actor, { kind: "owner" });
    await this.ctx.storage.put({
      [`consent:${body.tenant}`]: record,
      ...(await auditPut(this.ctx.storage, body.tenant, actor ? { actor, action, subject: {}, outcome: "ok" } : null,
        action)),
    });
    return Response.json(record);
  }

  private async readConsent(url: URL): Promise<Response> {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!tenant) return Response.json({ error: "invalid_request" }, { status: 400 });
    const record = await this.ctx.storage.get<{ cloudWork: boolean; updatedAt: string }>(
      `consent:${tenant}`,
    );
    return Response.json(record ?? { cloudWork: false });
  }

  /// Task index for export and deletion. Synchronous by design: a task the
  /// index misses is a task deletion cannot prove gone.
  private async indexTask(request: Request): Promise<Response> {
    const parsed = await readJsonBody<{ tenant?: unknown; taskId?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    if (typeof body.tenant !== "string" || !body.tenant || typeof body.taskId !== "string") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const key = `tenant-tasks:${body.tenant}`;
    const ids = (await this.ctx.storage.get<string[]>(key)) ?? [];
    if (!ids.includes(body.taskId)) {
      await this.ctx.storage.put(key, [...ids, body.taskId]);
    }
    return Response.json({ indexed: true });
  }

  private async readIndex(url: URL): Promise<Response> {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!tenant) return Response.json({ error: "invalid_request" }, { status: 400 });
    const ids = (await this.ctx.storage.get<string[]>(`tenant-tasks:${tenant}`)) ?? [];
    return Response.json({ taskIds: ids });
  }

  /// One attention item per inbound delivery. The delivery id is the
  /// idempotency key: a repeat, whether Linear's retry or a replay inside the
  /// timestamp window, finds its id remembered and stores nothing. Only the
  /// worker's inbound route sets `x-inbound`; no client route reaches this
  /// object's paths directly. The object's input gate keeps the read and the
  /// write below one step, so two copies of a delivery cannot both store.
  private async recordAttention(request: Request): Promise<Response> {
    if (request.headers.get("x-inbound") !== "1") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const parsed = await readJsonBody<{
      tenant?: unknown;
      deliveryId?: unknown;
      connectionId?: unknown;
      eventType?: unknown;
      issueId?: unknown;
    }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    const bounded = (value: unknown): value is string =>
      typeof value === "string" && value.length > 0 && value.length <= 256;
    if (
      !bounded(body.tenant) ||
      !bounded(body.deliveryId) ||
      !bounded(body.connectionId) ||
      !bounded(body.eventType) ||
      !bounded(body.issueId)
    ) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const deliveriesKey = `attention-deliveries:${body.tenant}`;
    const deliveries = (await this.ctx.storage.get<string[]>(deliveriesKey)) ?? [];
    if (deliveries.includes(body.deliveryId)) return Response.json({ created: false });
    const item: AttentionItem = {
      id: crypto.randomUUID(),
      connectionId: body.connectionId,
      eventType: body.eventType,
      issueId: body.issueId,
      receivedAt: new Date().toISOString(),
    };
    const itemsKey = `attention:${body.tenant}`;
    const items = (await this.ctx.storage.get<AttentionItem[]>(itemsKey)) ?? [];
    await this.ctx.storage.put({
      [itemsKey]: [...items, item].slice(-MAX_ATTENTION_ITEMS),
      [deliveriesKey]: [...deliveries, body.deliveryId].slice(-MAX_REMEMBERED_DELIVERIES),
    });
    return Response.json({ created: true });
  }

  /// Newest first, the order an inbox reads them in.
  private async readAttention(url: URL): Promise<Response> {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!tenant) return Response.json({ error: "invalid_request" }, { status: 400 });
    const items = (await this.ctx.storage.get<AttentionItem[]>(`attention:${tenant}`)) ?? [];
    return Response.json({ items: [...items].reverse() });
  }

  /// Wipes the tenant's consent, task index, attention items, pilot records
  /// (shop, customer messages, replies, payments), routines (the team's
  /// setup, its first-week questions and every run), model meter (cap
  /// override, monthly totals and their crossings of the cap, reservations,
  /// per-call records, and the crossings' notice for AuthObject), audit log
  /// (entries and the miss count), memory (facts and the fingerprints of
  /// forgotten texts) and people (helpers, invites and every helper
  /// session, so no helper can open a deleted shop), then writes a tombstone.
  /// Sessions are wiped by AuthObject through the worker; the tombstone
  /// proves the deletion happened and marks any data that reappears
  /// afterwards as new, never restored.
  private async tenantWipe(request: Request): Promise<Response> {
    if (request.headers.get("x-wipe") !== "1") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const parsed = await readJsonBody<{ tenant?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    if (typeof body.tenant !== "string" || !body.tenant) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const ids = (await this.ctx.storage.get<string[]>(`tenant-tasks:${body.tenant}`)) ?? [];
    await this.ctx.storage.delete(`tenant-tasks:${body.tenant}`);
    await this.ctx.storage.delete(`consent:${body.tenant}`);
    await this.ctx.storage.delete([`attention:${body.tenant}`, `attention-deliveries:${body.tenant}`]);
    await wipePilotTenant(this.ctx.storage, body.tenant);
    await wipeRoutineTenant(this.ctx.storage, body.tenant);
    await wipeModelTenant(this.ctx.storage, body.tenant);
    await wipeMemoryTenant(this.ctx.storage, body.tenant);
    await wipePeopleTenant(this.ctx.storage, body.tenant);
    await wipeAuditTenant(this.ctx.storage, body.tenant);
    const tombstone = { deletedAt: new Date().toISOString(), tasksWiped: ids.length };
    await this.ctx.storage.put(`tomb:${body.tenant}`, tombstone);
    // Nothing the wipe left has work for the alarm, so it is cleared rather than left to wake for nothing.
    await this.arm();
    return Response.json(tombstone);
  }
}
