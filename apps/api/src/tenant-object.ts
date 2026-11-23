import { DurableObject } from "cloudflare:workers";
import { actorOr, auditPut, auditTenantRoute, wipeAuditTenant } from "./audit-log";
import { readJsonBody } from "./body";
import type { AttentionItem } from "./inbound";
import { memoryTenantRoute, wipeMemoryTenant } from "./memory-store";
import { modelTenantRoute, wipeModelTenant } from "./model-meter";
import { peopleTenantRoute, wipePeopleTenant } from "./people-store";
import { pilotTenantRoute, wipePilotTenant } from "./pilot-store";
import { routineTenantRoute, wipeRoutineTenant } from "./routine-store";

const MAX_BODY_BYTES = 256 * 1024;
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
export class TenantObject extends DurableObject {
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
    // reservations and one metering record per call (model-meter.ts).
    if (url.pathname.startsWith("/model/")) {
      return modelTenantRoute(this.ctx.storage, request, url);
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
  /// override, monthly totals, reservations, per-call records), audit log
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
    return Response.json(tombstone);
  }
}
