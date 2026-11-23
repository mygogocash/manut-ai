import {
  ApiError,
  isLiveShop,
  isSending,
  REPLY_MAX_LENGTH,
  type ApprovalState,
  type ApprovalView,
  type AuditActor,
  type AuditEntry,
  type AwaitingOwner,
  type AwayView,
  type CreatedInvite,
  type DeletedShop,
  type DeletionGoes,
  type DeletionRequest,
  type DeletionState,
  type DeletionView,
  type Fact,
  type HelperRemoval,
  type Identity,
  type InboundMessage,
  type InviteView,
  type Payment,
  type People,
  type PilotApi,
  type ReplyAction,
  type Shop,
  type SubscriptionPayment,
  type WorkerDraft,
  type WorkerJobEntry,
} from "./types";
import { pilotGate } from "./gate";
import { endOfShopDay, formatIsoDate } from "../format";
import * as peopleRules from "@manut/people-rules";
import type { Away, Invite, PeopleState } from "@manut/people-rules";
import * as shopMemory from "@manut/shop-memory";
import type { MemoryState, Refusal, Result } from "@manut/shop-memory";
import {
  capOf,
  ceilSatang,
  gatewayDefaultCap,
  isCapValue,
  isMonth,
  monthOf,
  usageOf,
  validTenant,
  wipeMeter,
  writeCap,
  type FakeModel,
  type FakeModelGateway,
} from "./meter";

/// An in-memory stand-in for apps/api that keeps the contract's rules: one decision per request, approving
/// needs the shop's consent, a send settles `confirmed`, `failed` or `unknown`, admin calls need a key, and
/// lists come back newest first. Deleting a live shop asks its owner through a link that settles once, as the
/// API does. The pilot gate is measured by the API's rules (gate.ts): a trial starts at the shop's first LINE
/// connection, and the owner's decisions are the times recorded on its replies. It lets every screen run and be
/// tested with no backend.
///
/// Sample world: Baan Mali (owner Fon) on LINE, on day 14 of its trial, with customers asking about late parcels
/// and a refund, and a second shop, Sabai Tea, with nothing connected yet. Demo links on the practice home page
/// open the owner's page in each state: /approve/demo, demo-failed, demo-unknown, demo-sent, demo-declined,
/// demo-old and demo-expired; any other token is an invalid link. The deletion page's demo links (DEMO_DELETION_TOKENS) are
/// about Khao Soi Nimman, a shop that is not on the console's list, so practising them deletes nothing there.
///
/// Each shop's audit log is kept as the API keeps it: the same actions and outcomes, metadata only, ids that sort by
/// time and page with the API's cursor, exported with the shop and deleted with it. Practice actions are an
/// operator's with no Access identity, as the API records a service token. Baan Mali's log starts with the history
/// of its sample world.
///
/// What the team knows about each shop is kept by `@manut/shop-memory`'s own rules, as the API keeps it: a refusal
/// answers the API's status and code, a change is recorded in the shop's audit log by the fact's id and never its
/// words, and the facts are exported with the shop and deleted with it. Baan Mali starts with five facts the team
/// learned and two a customer said, which wait for its owner; Sabai Tea has been told nothing.
///
/// The owner's people (docs/people.md) are kept by `@manut/people-rules`' own rules, as the API keeps them: an invite for
/// one LINE account or email, once, for 7 days; removal that ends cover and sessions in one step; cover until a date. A
/// refusal answers the API's status and code, a change is recorded in the shop's audit log by ids only, and the people are
/// exported with the shop and deleted with it. Baan Mali starts with Mint, who helps and covers while Fon is away, Beam
/// invited and not yet joined, and a note Mint passed on; Sabai Tea has only its owner.
///
/// Each shop's model spend (docs/model-gateway.md) is kept as the API's meter keeps it: one record per call, the
/// reservations still open, and an operator's cap override. Months and totals are read from the records, so a total can
/// never disagree with what it adds up. Baan Mali has ฿186 spent of an operator's ฿300 cap with one call in progress, and
/// Sabai Tea the default cap and no calls. A cap set in practice is kept with the rest of the world.
///
/// What Nam, Pim and Ton did for each shop (docs/pilot-api.md, "Workers' drafts") is kept as the API lists it back: one
/// entry per job, oldest first as the shop's task index keeps them, read newest first by a job's task id. Baan Mali has
/// seven jobs, one for each way a job can end here, and Sabai Tea none. Nothing in practice starts a job, so they are the
/// sample's own; they are deleted with the shop, and the practice export does not carry them.

export type FakeApiOptions = {
  /// Read on every admin call, like the real client. Any non-empty key is accepted.
  operatorKey?: () => string | null;
  now?: () => number;
  /// Delay before each answer, so busy states show in the browser. 0 in tests.
  latencyMs?: number;
  /// How long a send stays `dispatching` before it settles on the next read.
  settleMs?: number;
  /// Where approval links point. Defaults to this page's origin.
  webOrigin?: string;
  /// Keeps the sample data across reloads and tabs, so an approval link opened in a new tab still works.
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;
  /// What the model gateway reads from the Worker's settings, and whether its meter is up (meter.ts).
  modelGateway?: FakeModelGateway;
};

type Outcome = "confirmed" | "failed" | "unknown";

/// The API keeps the trial start on its shop record but answers it only through the gate, never in the shop list.
type FakeShop = Shop & { trialStartedAt?: string };
type FakeConnection = {
  connectionId: string;
  tenant: string;
  channelId: string;
  botUserId: string;
  channelSecret: string;
};
type FakeMessage = InboundMessage & { tenant: string; webhookEventId?: string };
type FakeAction = Omit<ReplyAction, "approvalUrl"> & {
  tenant: string;
  token: string;
  expiresAt: string;
  outcome: Outcome;
};
/// The API's deletion record: who asked and when (the practice key has no Access identity, so nobody), the owner
/// confirmation it names for a live shop, and when the wipe finished.
type FakeDeletionRecord = {
  tenant: string;
  name: string;
  requestedAt: string;
  deletedBy: string | null;
  confirmationId?: string;
  deletedAt?: string;
};
/// One owner confirmation of deleting a shop, with what the shop held when it opened. It leaves `pending` once,
/// into `decided` or `withdrawn` (expired and replaced by a newer request), as approval-core's records do.
type FakeConfirmation = {
  id: string;
  tenant: string;
  token: string;
  shopName: string;
  goes: DeletionGoes;
  expiresAt: string;
  status: "pending" | "decided" | "withdrawn";
  approved?: boolean;
  decidedAt?: string;
};
/// An audit entry with the shop it belongs to, which the API keeps by the shop's own object instead.
type FakeAuditEntry = AuditEntry & { tenant: string };
/// One shop's people as the API keeps them, without the sessions' hashes the fake has no use for: the rules' whole state,
/// and the name the owner gave each invite and helper (kept after a helper is removed, so the log can still name them).
type FakePeople = { state: PeopleState; names: Record<string, string> };
/// A job with the shop it belongs to, which the API finds through the shop's own task index.
type FakeWorkerJob = WorkerJobEntry & { tenant: string };
type FakeDb = {
  version: 8;
  seq: number;
  shops: FakeShop[];
  connections: FakeConnection[];
  messages: FakeMessage[];
  actions: FakeAction[];
  payments: Payment[];
  subscriptionPayments: SubscriptionPayment[];
  deletions: FakeDeletionRecord[];
  confirmations: FakeConfirmation[];
  /// Tokens that answer 410, standing in for links whose signed expiry has passed.
  expiredTokens: string[];
  audit: FakeAuditEntry[];
  /// What the team knows, per shop, as `@manut/shop-memory` keeps it. A shop with no entry has been told nothing.
  memory: Record<string, MemoryState>;
  /// The owner's people, per shop. A shop with no entry has only its owner.
  people: Record<string, FakePeople>;
  model: FakeModel;
  /// Every shop's worker jobs, oldest first, the order the API's task index keeps them in.
  workers: FakeWorkerJob[];
};

/// The saved world's `version` decides whether it is read: a world saved before deletions needed an owner's yes
/// (version 1), before trial starts and subscription payments were kept (version 2), before the audit log
/// (version 3), before what the team knows (version 4), before the model meter (version 5), before the workers' jobs
/// (version 6) or before the owner's people (version 7) is replaced by a fresh one rather than read without them.
const STORAGE_KEY = "manut.pilot.fake.v1";
const FAKE_API_ORIGIN = "https://pilot-api.invalid";
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export const PRACTICE_CHANNEL_SECRET = "practice-channel-secret";

export const DEMO_TOKENS = {
  waiting: "demo",
  failed: "demo-failed",
  unknown: "demo-unknown",
  sent: "demo-sent",
  declined: "demo-declined",
  expiredRequest: "demo-old",
  expiredLink: "demo-expired",
} as const;

export const DEMO_DELETION_TOKENS = {
  waiting: "demo-delete",
  deleting: "demo-delete-deleting",
  deleted: "demo-delete-done",
  kept: "demo-delete-kept",
  unanswered: "demo-delete-old",
  expiredLink: "demo-delete-expired",
} as const;

export function createFakeApi(options: FakeApiOptions = {}): PilotApi & { reset(): void } {
  const now = options.now ?? (() => Date.now());
  const operatorKey = options.operatorKey ?? (() => "practice-key");
  const latencyMs = options.latencyMs ?? 0;
  const settleMs = options.settleMs ?? 3000;
  const storage = options.storage;
  const webOrigin =
    options.webOrigin ?? (typeof location !== "undefined" ? location.origin : "http://localhost:5173");

  let db = load() ?? seed(now());

  function load(): FakeDb | null {
    if (!storage) return null;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as FakeDb;
      return parsed && parsed.version === 8 && Array.isArray(parsed.actions) && Array.isArray(parsed.confirmations) &&
        Array.isArray(parsed.subscriptionPayments) && Array.isArray(parsed.audit) &&
        typeof parsed.memory === "object" && parsed.memory !== null && Array.isArray(parsed.model?.calls) &&
        Array.isArray(parsed.model.overrides) && Array.isArray(parsed.model.holds) && Array.isArray(parsed.workers) &&
        typeof parsed.people === "object" && parsed.people !== null
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  function save(): void {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch {
      // A full or blocked store only loses the sample data on reload.
    }
  }

  /// Every call starts from what another tab may have saved and saves what it changed.
  async function run<T>(work: () => T): Promise<T> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    else await Promise.resolve();
    db = load() ?? db;
    const result = work();
    save();
    return JSON.parse(JSON.stringify(result)) as T;
  }

  function admin(): void {
    if (!operatorKey()) throw new ApiError(403, "forbidden");
  }

  function iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  function nextId(prefix: string): string {
    db.seq += 1;
    return `${prefix}_${db.seq}`;
  }

  /// Appends to the shop's audit log, now, as the API would: ids only, and a code for what happened.
  function audit(
    tenant: string,
    actor: AuditActor,
    action: string,
    subject: Record<string, string>,
    outcome = "ok",
    extra: { amountSatang?: number } = {},
  ): void {
    db.seq += 1;
    const at = now();
    db.audit.push({ tenant, id: auditId(at, db.seq), at: iso(at), actor, action, subject, outcome, ...extra });
  }

  /// The API's answers for a shop that is not there: `tenant_deleted`, saying when and by whom, once it has been
  /// deleted, and `shop_not_found` for a tenant that was never a shop.
  function shopOf(tenant: string): FakeShop {
    const shop = db.shops.find((s) => s.tenant === tenant);
    if (shop) return shop;
    const record = db.deletions.find((d) => d.tenant === tenant);
    if (record?.deletedAt) {
      throw new ApiError(404, "tenant_deleted", undefined, { deletedAt: record.deletedAt, deletedBy: record.deletedBy });
    }
    throw new ApiError(404, "shop_not_found");
  }

  /// The API's rule: the same name when it differs only in outer spaces or in how an accented letter was composed.
  function sameName(typed: string, stored: string): boolean {
    return typed.normalize("NFC").trim() === stored.normalize("NFC").trim();
  }

  /// What deleting the shop would take now, or null once it is gone.
  function goesOf(tenant: string): DeletionGoes | null {
    const shop = db.shops.find((s) => s.tenant === tenant);
    if (!shop) return null;
    const mine = <T extends { tenant: string }>(item: T) => item.tenant === tenant;
    return {
      messages: db.messages.filter(mine).length,
      replies: db.actions.filter(mine).length,
      // Both ledgers, as the API counts them: the deletion takes both.
      payments: db.payments.filter(mine).length + db.subscriptionPayments.filter(mine).length,
      lineConnected: Boolean(shop.lineConnectionId),
    };
  }

  function recordOf(tenant: string): FakeDeletionRecord | undefined {
    return db.deletions.find((d) => d.tenant === tenant);
  }

  function writeRecord(record: FakeDeletionRecord): FakeDeletionRecord {
    db.deletions = [...db.deletions.filter((d) => d.tenant !== record.tenant), record];
    return record;
  }

  function currentConfirmation(record: FakeDeletionRecord | undefined): FakeConfirmation | undefined {
    return record?.confirmationId ? db.confirmations.find((c) => c.id === record.confirmationId) : undefined;
  }

  /// Everything stored for the shop goes at once, and the record says when.
  function wipe(record: FakeDeletionRecord): DeletedShop {
    const mine = <T extends { tenant: string }>(item: T) => item.tenant === record.tenant;
    const deleted: DeletedShop = {
      tasksWiped: new Set(db.actions.filter(mine).map((a) => a.taskId)).size,
      connectionsWiped: db.connections.filter(mine).length,
      schedulesWiped: 0,
      occurrencesWiped: 0,
      sessionsWiped: 0,
      deletedAt: iso(now()),
    };
    db.shops = db.shops.filter((s) => !mine(s));
    db.connections = db.connections.filter((c) => !mine(c));
    db.messages = db.messages.filter((m) => !mine(m));
    db.actions = db.actions.filter((a) => !mine(a));
    db.payments = db.payments.filter((p) => !mine(p));
    db.subscriptionPayments = db.subscriptionPayments.filter((p) => !mine(p));
    // The log goes with the shop; the deletion record below keeps who asked and when.
    db.audit = db.audit.filter((e) => !mine(e));
    // What the team knew goes too, the fingerprints of what it forgot with it.
    delete db.memory[record.tenant];
    // The people go too, with the names the owner gave them.
    delete db.people[record.tenant];
    wipeMeter(db.model, record.tenant);
    // The jobs of its team go with it, drafts included.
    db.workers = db.workers.filter((job) => !mine(job));
    writeRecord({ ...record, deletedAt: deleted.deletedAt });
    return deleted;
  }

  function deletionLinkOf(confirmation: FakeConfirmation): string {
    return `${webOrigin.replace(/\/+$/, "")}/delete/${encodeURIComponent(confirmation.token)}`;
  }

  function awaiting(confirmation: FakeConfirmation): AwaitingOwner {
    return { status: "awaiting_owner", confirmUrl: deletionLinkOf(confirmation), expiresAt: confirmation.expiresAt };
  }

  /// The confirmation already open, or a new one. One that expired unanswered is withdrawn as the new one opens.
  function askOwner(shop: FakeShop, record: FakeDeletionRecord | undefined): AwaitingOwner {
    const current = currentConfirmation(record);
    if (current?.status === "pending") {
      if (now() < Date.parse(current.expiresAt)) return awaiting(current);
      current.status = "withdrawn";
    }
    const at = now();
    const confirmation: FakeConfirmation = {
      id: nextId("del"),
      tenant: shop.tenant,
      token: randomToken(),
      shopName: shop.name,
      goes: goesOf(shop.tenant)!,
      expiresAt: iso(at + DAY_MS),
      status: "pending",
    };
    db.confirmations.push(confirmation);
    writeRecord({ tenant: shop.tenant, name: shop.name, requestedAt: iso(at), deletedBy: null, confirmationId: confirmation.id });
    audit(shop.tenant, PRACTICE_OPERATOR, "deletion.requested", { confirmationId: confirmation.id }, "awaiting_owner");
    return awaiting(confirmation);
  }

  function deletionStateOf(confirmation: FakeConfirmation): DeletionState {
    if (confirmation.status === "decided") {
      if (!confirmation.approved) return "declined";
      const record = recordOf(confirmation.tenant);
      return record?.confirmationId === confirmation.id && record.deletedAt ? "deleted" : "deleting";
    }
    if (confirmation.status === "withdrawn") return "expired";
    return now() < Date.parse(confirmation.expiresAt) ? "awaiting_owner" : "expired";
  }

  function deletionViewOf(confirmation: FakeConfirmation): DeletionView {
    const state = deletionStateOf(confirmation);
    const view: DeletionView = {
      shopName: confirmation.shopName,
      goes: state === "deleted" ? confirmation.goes : (goesOf(confirmation.tenant) ?? confirmation.goes),
      state,
      expiresAt: confirmation.expiresAt,
    };
    if (confirmation.decidedAt) view.decidedAt = confirmation.decidedAt;
    return view;
  }

  function deletionRequestOf(tenant: string): DeletionRequest | undefined {
    const confirmation = currentConfirmation(recordOf(tenant));
    if (!confirmation) return undefined;
    const request: DeletionRequest = {
      state: deletionStateOf(confirmation),
      confirmUrl: deletionLinkOf(confirmation),
      expiresAt: confirmation.expiresAt,
    };
    if (confirmation.decidedAt) request.decidedAt = confirmation.decidedAt;
    return request;
  }

  /// A deletion link's confirmation. Its link expires with it, as the API signs both with one expiry.
  function confirmationByToken(token: string): FakeConfirmation {
    if (db.expiredTokens.includes(token)) throw new ApiError(410, "link_expired");
    const confirmation = db.confirmations.find((c) => c.token === token);
    if (!confirmation) throw new ApiError(404, "link_invalid");
    if (now() >= Date.parse(confirmation.expiresAt)) throw new ApiError(410, "link_expired");
    return confirmation;
  }

  /// A send that has had `settleMs` to finish settles on whoever reads it next.
  function settle(action: FakeAction): void {
    if (!isSending(action.state) || !action.decidedAt) return;
    if (now() - Date.parse(action.decidedAt) < settleMs) return;
    action.state = action.outcome;
    if (action.outcome !== "failed") action.dispatchedAt = iso(now());
    audit(action.tenant, SYSTEM, "dispatch.settled", { taskId: action.taskId, actionId: action.actionId },
      action.outcome);
  }

  function byToken(token: string): FakeAction {
    if (db.expiredTokens.includes(token)) throw new ApiError(410, "link_expired");
    const action = db.actions.find((a) => a.token === token);
    if (!action) throw new ApiError(404, "link_invalid");
    if (now() > Date.parse(action.expiresAt)) throw new ApiError(410, "link_expired");
    settle(action);
    return action;
  }

  function viewOf(action: FakeAction): ApprovalView {
    const shop = shopOf(action.tenant);
    const message = db.messages.find((m) => m.id === action.messageId);
    const view: ApprovalView = {
      shopName: shop.name,
      memberName: "Nam",
      memberRole: "sales chat",
      kind: "line.reply",
      customerName: message?.displayName ?? "a customer",
      customerMessage: message?.text ?? "",
      replyText: action.replyText,
      state: action.state,
      expiresAt: action.expiresAt,
      needsConsent: !shop.consent,
    };
    if (action.decidedAt) view.decidedAt = action.decidedAt;
    return view;
  }

  function linkOf(action: FakeAction): string {
    return `${webOrigin.replace(/\/+$/, "")}/approve/${encodeURIComponent(action.token)}`;
  }

  /// The shop's log, newest first, as the API answers it.
  function auditOf(tenant: string): AuditEntry[] {
    return db.audit
      .filter((entry) => entry.tenant === tenant)
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map(({ tenant: _tenant, ...entry }) => entry);
  }

  function newestFirst<T>(items: T[], at: (item: T) => string): T[] {
    return [...items].sort((a, b) => Date.parse(at(b)) - Date.parse(at(a)));
  }

  /// What the team knows about a shop: nothing for one it was never told about.
  function memoryOf(tenant: string): MemoryState {
    return db.memory[tenant] ?? shopMemory.emptyState();
  }

  /// The API's checks before a memory rule runs: a tenant of 1 to 256 characters, and a fact id of 1 to 64.
  function memoryTenant(tenant: unknown): string {
    if (typeof tenant !== "string" || tenant.length < 1 || tenant.length > 256) throw new ApiError(400, "tenant_required");
    return tenant;
  }

  function memoryFactId(id: unknown): string {
    if (typeof id !== "string" || id.length < 1 || id.length > 64) throw new ApiError(400, "invalid_request");
    return id;
  }

  /// One change to a shop's memory by the package's rule, as the API does it. A refusal answers the API's status and
  /// code and changes nothing. A change is kept and recorded in the shop's audit log by the fact's id, never its words;
  /// a confirm of a fact that is already confirmed hands back the very state it was given, so it records nothing.
  function changeFact(tenant: string, action: string, operate: (state: MemoryState) => Result): Fact {
    const before = memoryOf(tenant);
    const result = operate(before);
    if (!result.ok) throw new ApiError(MEMORY_STATUS[result.reason], result.reason);
    if (result.state !== before) {
      db.memory[tenant] = result.state;
      audit(tenant, PRACTICE_OPERATOR, action, { factId: result.fact.id });
    }
    return result.fact;
  }

  /// A shop's people: only its owner for a shop that was never given any.
  function peopleOf(tenant: string): FakePeople {
    return db.people[tenant] ?? { state: peopleRules.emptyPeople(tenant, OWNER_ID), names: {} };
  }

  /// The API's checks before any people route reads the shop: a tenant of 1 to 256 characters, then a pilot shop. The
  /// people routes say `shop_not_found` for anything that is not one, a deleted shop included.
  function peopleShop(tenant: unknown): FakeShop {
    if (!validTenant(tenant)) throw new ApiError(400, "tenant_required");
    const shop = db.shops.find((s) => s.tenant === tenant);
    if (!shop) throw new ApiError(404, "shop_not_found");
    return shop;
  }

  /// The id of an invite or a helper in a body: text of 1 to 256 characters, which is what the shop's record keeps.
  function peopleId(id: unknown): string {
    if (typeof id !== "string" || id.length < 1 || id.length > 256) throw new ApiError(400, "invalid_request");
    return id;
  }

  /// The link for an invite, the same each time it is shown while the invite waits. Nothing sends it, and a practice link
  /// opens nothing: it only has the shape of the API's `${WEB_ORIGIN}/join/{token}`.
  function inviteLink(invite: Invite): string {
    return `${webOrigin.replace(/\/+$/, "")}/join/practice-${invite.id}`;
  }

  /// An invite past its 7 days is never used, so it reads as expired whatever the record still says. The view has no link:
  /// the list adds one for an invite that waits, and creating one answers its link beside the invite.
  function inviteView(invite: Invite, name: string, nowMs: number): InviteView {
    return {
      id: invite.id,
      name,
      identity: invite.identity,
      status: invite.status === "pending" && nowMs >= invite.expiresAt ? "expired" : invite.status,
      createdAt: iso(invite.createdAt),
      expiresAt: iso(invite.expiresAt),
    };
  }

  function awayView(state: PeopleState, away: Away, names: Record<string, string>, nowMs: number): AwayView {
    return { helperId: away.helperId, name: names[away.helperId] ?? "", until: iso(away.until),
      inForce: peopleRules.coverAt(state, nowMs) !== null };
  }

  /// What the API's people list answers for the shop.
  function peopleList(shop: FakeShop): People {
    const { state, names } = peopleOf(shop.tenant);
    const nowMs = now();
    return {
      tenant: shop.tenant,
      owner: { name: shop.ownerName },
      // `devices` is the sessions open now: the fake never lets one run out, so it is every session of the helper's.
      helpers: state.helpers.map((helper) => ({ id: helper.id, name: names[helper.id] ?? "", identity: helper.identity,
        joinedAt: iso(helper.joinedAt), devices: helper.sessions.length })),
      invites: state.invites.map((invite) => {
        const shown = inviteView(invite, names[invite.id] ?? "", nowMs);
        return shown.status === "pending" ? { ...shown, inviteUrl: inviteLink(invite) } : shown;
      }),
      away: state.away ? awayView(state, state.away, names, nowMs) : null,
      passedOn: state.passedOn.map((passed) => ({ requestId: passed.requestId, kind: passed.kind, by: passed.by,
        name: names[passed.by] ?? "", note: passed.note, at: iso(passed.at) })),
      removed: state.removed.map((id) => ({ id, name: names[id] ?? "" })),
    };
  }

  return {
    reset() {
      db = seed(now());
      save();
    },

    async deliverLineWebhook(connectionId, rawBody, signature) {
      if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
      db = load() ?? db;
      const connection = db.connections.find((c) => c.connectionId === connectionId);
      if (!connection) throw new ApiError(404, "http_404");
      const expected = await lineSignature(connection.channelSecret, rawBody);
      if (!signature || signature !== expected) throw new ApiError(401, "http_401");
      let events: unknown[] = [];
      try {
        const parsed = JSON.parse(rawBody) as { events?: unknown };
        events = Array.isArray(parsed.events) ? parsed.events : [];
      } catch {
        events = [];
      }
      for (const event of events) {
        const e = event as {
          type?: string;
          webhookEventId?: string;
          timestamp?: number;
          source?: { userId?: string };
          message?: { type?: string; text?: string };
        };
        if (e.type !== "message" || e.message?.type !== "text" || typeof e.message.text !== "string") continue;
        if (!e.webhookEventId || db.messages.some((m) => m.webhookEventId === e.webhookEventId)) continue;
        db.messages.push({
          id: nextId("msg"),
          tenant: connection.tenant,
          connectionId,
          lineUserId: e.source?.userId ?? "unknown",
          text: e.message.text,
          receivedAt: iso(typeof e.timestamp === "number" ? e.timestamp : now()),
          webhookEventId: e.webhookEventId,
        });
      }
      save();
    },

    getApproval: (token) => run(() => viewOf(byToken(token))),

    giveConsent: (token) =>
      run(() => {
        const action = byToken(token);
        shopOf(action.tenant).consent = true;
        audit(action.tenant, OWNER, "consent.given", {});
        return viewOf(action);
      }),

    decide: (token, approve) =>
      run(() => {
        const action = byToken(token);
        if (action.state !== "proposed") throw new ApiError(409, "already_decided", viewOf(action));
        const shop = shopOf(action.tenant);
        if (approve && !shop.consent) throw new ApiError(403, "consent_required");
        action.decidedAt = iso(now());
        action.state = approve ? "dispatching" : "rejected";
        const about = { taskId: action.taskId, actionId: action.actionId };
        audit(action.tenant, OWNER, "reply.decided", about, approve ? "approved" : "declined");
        if (approve) audit(action.tenant, SYSTEM, "dispatch.started", about);
        return viewOf(action);
      }),

    createShop: (input) =>
      run(() => {
        admin();
        const name = input.name.trim();
        const ownerName = input.ownerName.trim();
        if (!name || !ownerName) throw new ApiError(400, "invalid_body");
        const shop: FakeShop = { tenant: nextId("shop"), name, ownerName, consent: false };
        db.shops.push(shop);
        audit(shop.tenant, PRACTICE_OPERATOR, "shop.created", {});
        return { tenant: shop.tenant, name: shop.name, ownerName: shop.ownerName };
      }),

    listShops: () =>
      run(() => {
        admin();
        return db.shops.map(({ trialStartedAt: _trial, ...shop }) => {
          const deletion = deletionRequestOf(shop.tenant);
          return deletion ? { ...shop, deletion } : shop;
        });
      }),

    createLineConnection: (input) =>
      run(() => {
        admin();
        const shop = shopOf(input.tenant);
        if (!input.channelId || !input.botUserId || !input.channelSecret || !input.channelAccessToken) {
          throw new ApiError(400, "invalid_body");
        }
        const connectionId = nextId("line");
        // The access token goes to the vault in the real backend and is never returned; the fake drops it.
        db.connections.push({
          connectionId,
          tenant: shop.tenant,
          channelId: input.channelId,
          botUserId: input.botUserId,
          channelSecret: input.channelSecret,
        });
        // The first connection starts the shop's trial; a later one never moves it.
        if (!shop.trialStartedAt && !shop.lineConnectionId) shop.trialStartedAt = iso(now());
        const previous = shop.lineConnectionId;
        shop.lineConnectionId = connectionId;
        audit(shop.tenant, PRACTICE_OPERATOR, "line.connected",
          { connectionId, ...(previous && previous !== connectionId ? { previousConnectionId: previous } : {}) });
        return { connectionId, webhookUrl: `${FAKE_API_ORIGIN}/v1/inbound/line/${connectionId}` };
      }),

    listMessages: (tenant) =>
      run(() => {
        admin();
        shopOf(tenant);
        return newestFirst(
          db.messages.filter((m) => m.tenant === tenant),
          (m) => m.receivedAt,
        ).map(({ tenant: _tenant, webhookEventId: _event, ...message }) => message);
      }),

    proposeReply: (input) =>
      run(() => {
        admin();
        shopOf(input.tenant);
        const message = db.messages.find((m) => m.id === input.messageId && m.tenant === input.tenant);
        if (!message) throw new ApiError(404, "unknown_message");
        if (input.text.length < 1 || input.text.length > REPLY_MAX_LENGTH) throw new ApiError(400, "invalid_text");
        const proposedAt = now();
        const action: FakeAction = {
          tenant: input.tenant,
          taskId: `task_${input.tenant}`,
          actionId: nextId("act"),
          messageId: message.id,
          replyText: input.text,
          state: "proposed",
          proposedAt: iso(proposedAt),
          token: randomToken(),
          expiresAt: iso(proposedAt + DAY_MS),
          outcome: "confirmed",
        };
        db.actions.push(action);
        message.replyActionId = action.actionId;
        audit(input.tenant, PRACTICE_OPERATOR, "reply.proposed",
          { taskId: action.taskId, actionId: action.actionId, messageId: message.id });
        return {
          taskId: action.taskId,
          actionId: action.actionId,
          approvalUrl: linkOf(action),
          expiresAt: action.expiresAt,
        };
      }),

    listActions: (tenant) =>
      run(() => {
        admin();
        shopOf(tenant);
        const actions = db.actions.filter((a) => a.tenant === tenant);
        actions.forEach(settle);
        return newestFirst(actions, (a) => a.proposedAt).map((a) => {
          const action: ReplyAction = {
            taskId: a.taskId,
            actionId: a.actionId,
            messageId: a.messageId,
            replyText: a.replyText,
            state: a.state,
            proposedAt: a.proposedAt,
            approvalUrl: linkOf(a),
          };
          if (a.decidedAt) action.decidedAt = a.decidedAt;
          if (a.dispatchedAt) action.dispatchedAt = a.dispatchedAt;
          return action;
        });
      }),

    recordPayment: (input) =>
      run(() => {
        admin();
        shopOf(input.tenant);
        const orderRef = input.orderRef.trim();
        const promptPayId = input.promptPayId.trim();
        if (!orderRef || !promptPayId || !Number.isSafeInteger(input.amountSatang) || input.amountSatang <= 0) {
          throw new ApiError(400, "invalid_body");
        }
        const payment: Payment = {
          id: nextId("pay"),
          tenant: input.tenant,
          orderRef,
          amountSatang: input.amountSatang,
          promptPayId,
          confirmedAt: iso(now()),
        };
        const note = input.slipNote?.trim();
        if (note) payment.slipNote = note;
        db.payments.push(payment);
        audit(input.tenant, PRACTICE_OPERATOR, "payment.recorded", { paymentId: payment.id }, "ok",
          { amountSatang: payment.amountSatang });
        return payment;
      }),

    listPayments: (tenant) =>
      run(() => {
        admin();
        shopOf(tenant);
        return newestFirst(
          db.payments.filter((p) => p.tenant === tenant),
          (p) => p.confirmedAt,
        );
      }),

    // Like the backend's export: connection metadata without the channel secret, and replies without their
    // link tokens, which the backend never stores.
    exportShop: (tenant) =>
      run(() => {
        admin();
        const shop = shopOf(tenant);
        return {
          tenant,
          exportedAt: iso(now()),
          connections: db.connections
            .filter((c) => c.tenant === tenant)
            .map(({ channelSecret: _secret, ...connection }) => connection),
          pilot: {
            shop,
            messages: db.messages.filter((m) => m.tenant === tenant),
            replies: db.actions
              .filter((a) => a.tenant === tenant)
              .map(({ token: _token, outcome: _outcome, ...reply }) => reply),
            payments: db.payments.filter((p) => p.tenant === tenant),
            subscriptionPayments: db.subscriptionPayments.filter((p) => p.tenant === tenant),
          },
          // As the backend's export: every entry, oldest first, and what the log could not write.
          audit: { entries: auditOf(tenant).reverse(), missed: null },
          // What the team knows: every fact, waiting ones included, and only how many it was told to forget.
          memory: shopMemory.exportFacts(memoryOf(tenant)),
          // Who the people are and what they passed on, as the API's export carries them (it never carries a session's hash).
          people: peopleOf(tenant),
        };
      }),

    // As the API: the name first; then a deletion the owner already said yes to is finished without asking again;
    // a live shop's owner is asked; a shop that never went live is deleted at once.
    deleteShop: (input) =>
      run((): DeletedShop | AwaitingOwner => {
        admin();
        const shop = shopOf(input.tenant);
        if (!sameName(input.confirmName, shop.name)) throw new ApiError(409, "name_mismatch");
        const record = recordOf(shop.tenant);
        const current = currentConfirmation(record);
        if (record && current?.status === "decided" && current.approved) return wipe(record);
        if (isLiveShop(shop)) return askOwner(shop, record);
        // Recorded and then wiped with the rest of the shop, as the API does.
        audit(shop.tenant, PRACTICE_OPERATOR, "deletion.requested", {});
        return wipe(writeRecord({ tenant: shop.tenant, name: shop.name, requestedAt: iso(now()), deletedBy: null }));
      }),

    getDeletion: (token) => run(() => deletionViewOf(confirmationByToken(token))),

    decideDeletion: (token, approve) =>
      run(() => {
        const confirmation = confirmationByToken(token);
        if (confirmation.status === "decided") {
          throw new ApiError(409, "already_decided", undefined, { deletionView: deletionViewOf(confirmation) });
        }
        if (confirmation.status === "withdrawn") throw new ApiError(404, "link_invalid");
        confirmation.status = "decided";
        confirmation.approved = approve;
        confirmation.decidedAt = iso(now());
        audit(confirmation.tenant, OWNER, "deletion.decided", { confirmationId: confirmation.id },
          approve ? "approved" : "declined");
        const deletion = recordOf(confirmation.tenant);
        if (approve && deletion?.confirmationId === confirmation.id) wipe(deletion);
        return deletionViewOf(confirmation);
      }),

    // As the API: the shop first, then a positive whole number of satang, a slip reference of 1 to 128 characters
    // once trimmed, and a slip not yet recorded for the shop, compared without spaces or capitals.
    recordSubscriptionPayment: (input) =>
      run(() => {
        admin();
        shopOf(input.tenant);
        const slipRef = input.slipRef.trim();
        if (!Number.isSafeInteger(input.amountSatang) || input.amountSatang <= 0 || slipRef.length < 1 ||
            slipRef.length > 128 || (input.slipNote !== undefined && input.slipNote.length > 1000)) {
          throw new ApiError(400, "invalid_request");
        }
        const plain = (ref: string) => ref.replace(/\s+/g, "").toUpperCase();
        if (db.subscriptionPayments.some((p) => p.tenant === input.tenant && plain(p.slipRef) === plain(slipRef))) {
          throw new ApiError(409, "slip_already_recorded");
        }
        const payment: SubscriptionPayment = {
          id: nextId("sub"),
          tenant: input.tenant,
          amountSatang: input.amountSatang,
          slipRef,
          confirmedAt: iso(now()),
        };
        const note = input.slipNote?.trim();
        if (note) payment.slipNote = note;
        db.subscriptionPayments.push(payment);
        audit(input.tenant, PRACTICE_OPERATOR, "subscription_payment.recorded", { paymentId: payment.id }, "ok",
          { amountSatang: payment.amountSatang });
        return payment;
      }),

    listSubscriptionPayments: (tenant) =>
      run(() => {
        admin();
        shopOf(tenant);
        return newestFirst(
          db.subscriptionPayments.filter((p) => p.tenant === tenant),
          (p) => p.confirmedAt,
        );
      }),

    // Every shop, in the order they were created, with the owner's decisions as the times recorded on its replies,
    // approvals and declines alike, as the API reads them.
    getGate: () =>
      run(() => {
        admin();
        return pilotGate(
          db.shops.map((shop) => ({
            tenant: shop.tenant,
            name: shop.name,
            trialStartedAt: shop.trialStartedAt ?? null,
            decisions: db.actions.flatMap((a) => (a.tenant === shop.tenant && a.decidedAt ? [a.decidedAt] : [])),
            subscriptionPayments: db.subscriptionPayments.filter((p) => p.tenant === shop.tenant),
          })),
          now(),
        );
      }),

    // As the API: any tenant (one with no log, or a deleted shop, reads as an empty page), newest first, the page
    // before an entry's id, 50 at a time unless asked for 1 to 200.
    listAudit: (tenant, query = {}) =>
      run(() => {
        admin();
        if (!tenant) throw new ApiError(400, "tenant_required");
        const limit = query.limit ?? 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, "invalid_request");
        const before = query.before;
        if (before !== undefined && !AUDIT_ID.test(before)) throw new ApiError(400, "invalid_request");
        const older = auditOf(tenant).filter((entry) => before === undefined || entry.id < before);
        const entries = older.slice(0, limit);
        const last = entries[entries.length - 1];
        return { tenant, entries, next: older.length > limit && last ? last.id : null, missed: null };
      }),

    // As the API: any tenant, an empty memory for one the team was never told about, every fact (waiting ones
    // included) oldest first, and only the number of forgotten fingerprints.
    getMemory: (tenant) =>
      run(() => {
        admin();
        const shop = memoryTenant(tenant);
        return { tenant: shop, ...shopMemory.exportFacts(memoryOf(shop)) };
      }),

    rememberFact: (input) =>
      run(() => {
        admin();
        const tenant = memoryTenant(input.tenant);
        return changeFact(tenant, "memory.remembered", (state) => shopMemory.remember(state, input.text, now()));
      }),

    confirmFact: (input) =>
      run(() => {
        admin();
        const tenant = memoryTenant(input.tenant);
        const id = memoryFactId(input.id);
        return changeFact(tenant, "memory.confirmed", (state) => shopMemory.confirm(state, id, now()));
      }),

    correctFact: (input) =>
      run(() => {
        admin();
        const tenant = memoryTenant(input.tenant);
        const id = memoryFactId(input.id);
        return changeFact(tenant, "memory.corrected", (state) => shopMemory.correct(state, id, input.text, now()));
      }),

    forgetFact: (input) =>
      run(() => {
        admin();
        const tenant = memoryTenant(input.tenant);
        const id = memoryFactId(input.id);
        const result = shopMemory.forget(memoryOf(tenant), id);
        if (!result.ok) throw new ApiError(MEMORY_STATUS[result.reason], result.reason);
        db.memory[tenant] = result.state;
        audit(tenant, PRACTICE_OPERATOR, "memory.forgotten", { factId: id });
        return { id };
      }),

    // As the API's people routes: the admin key, the shop (400 `tenant_required`, 404 `shop_not_found`), the body's own
    // checks, and then `@manut/people-rules`' rule, whose refusals answer the API's statuses. A change is kept and recorded
    // in the shop's audit log by ids only, never a name or an account's value; a refusal writes nothing.
    getPeople: (tenant) =>
      run(() => {
        admin();
        return peopleList(peopleShop(tenant));
      }),

    createInvite: (input) =>
      run((): CreatedInvite => {
        admin();
        const shop = peopleShop(input.tenant);
        const name = keptName(input.name);
        const identity = keptIdentity(input.identity);
        if (!name || !identity) throw new ApiError(400, "invalid_request");
        const record = peopleOf(shop.tenant);
        db.seq += 1;
        const made = peopleRules.invite(record.state, `inv-${db.seq}`, identity, now());
        if (!made.ok) throw new ApiError(made.refused === "bad_identity" || made.refused === "bad_id" ? 400 : 409, made.refused);
        db.people[shop.tenant] = { state: made.state, names: { ...record.names, [made.invite.id]: name } };
        audit(shop.tenant, PRACTICE_OPERATOR, "invite.created", { inviteId: made.invite.id });
        return { invite: inviteView(made.invite, name, now()), inviteUrl: inviteLink(made.invite) };
      }),

    revokeInvite: (input) =>
      run(() => {
        admin();
        const shop = peopleShop(input.tenant);
        const inviteId = peopleId(input.inviteId);
        const record = peopleOf(shop.tenant);
        const revoked = peopleRules.revokeInvite(record.state, inviteId);
        if (!revoked.ok) throw new ApiError(revoked.refused === "unknown_invite" ? 404 : 409, revoked.refused);
        db.people[shop.tenant] = { ...record, state: revoked.state };
        audit(shop.tenant, PRACTICE_OPERATOR, "invite.revoked", { inviteId });
        const invite = revoked.state.invites.find((one) => one.id === inviteId)!;
        return { invite: inviteView(invite, record.names[inviteId] ?? "", now()) };
      }),

    removeHelper: (input) =>
      run((): HelperRemoval => {
        admin();
        const shop = peopleShop(input.tenant);
        const helperId = peopleId(input.helperId);
        const record = peopleOf(shop.tenant);
        const removed = peopleRules.removeHelper(record.state, helperId);
        if (!removed.ok) throw new ApiError(404, removed.refused);
        db.people[shop.tenant] = { ...record, state: removed.state };
        audit(shop.tenant, PRACTICE_OPERATOR, "helper.removed", { helperId });
        return { removed: helperId, sessionsEnded: removed.endSessions.length, invitesRevoked: [...removed.revokedInvites],
          coverEnded: removed.coverEnded };
      }),

    // A date the rules can compare, or `bad_date`, as the API answers one it cannot read; then the rule's own `bad_date`
    // for a time that is not in the future, and `not_a_helper` for someone who is not one.
    setAway: (input) =>
      run(() => {
        admin();
        const shop = peopleShop(input.tenant);
        const helperId = peopleId(input.helperId);
        const until = typeof input.until === "string" ? Date.parse(input.until) : Number.NaN;
        if (!Number.isFinite(until)) throw new ApiError(400, "bad_date");
        const record = peopleOf(shop.tenant);
        const set = peopleRules.setAway(record.state, helperId, until, now());
        if (!set.ok) throw new ApiError(set.refused === "not_a_helper" ? 404 : 400, set.refused);
        db.people[shop.tenant] = { ...record, state: set.state };
        audit(shop.tenant, PRACTICE_OPERATOR, "away.set", { helperId });
        return { away: awayView(set.state, set.state.away!, record.names, now()) };
      }),

    // Clearing when nobody covers changes and records nothing, as the API does.
    clearAway: (input) =>
      run((): { away: null } => {
        admin();
        const shop = peopleShop(input.tenant);
        const record = peopleOf(shop.tenant);
        if (record.state.away === null) return { away: null };
        const covering = record.state.away.helperId;
        db.people[shop.tenant] = { ...record, state: peopleRules.clearAway(record.state) };
        audit(shop.tenant, PRACTICE_OPERATOR, "away.cleared", { helperId: covering });
        return { away: null };
      }),

    // As the API: the tenant, then the month (the current Bangkok month unless one is named), then the settings and the
    // meter. Any tenant reads, as in the API; a shop it never metered has an empty month on the default cap.
    getModelUsage: (tenant, month) =>
      run(() => {
        admin();
        if (!validTenant(tenant)) throw new ApiError(400, "tenant_required");
        if (month !== undefined && !isMonth(month)) throw new ApiError(400, "invalid_request");
        const defaultCapSatang = gatewayDefaultCap(options.modelGateway);
        return usageOf(db.model, tenant, month ?? monthOf(now()), defaultCapSatang);
      }),

    // As the API: the tenant, then a cap that is present and null or whole satang within the limit, then the settings
    // and the meter. The change and its audit entry are written together, and a refusal writes neither.
    setModelCap: (input) =>
      run(() => {
        admin();
        const { tenant, capSatang } = input;
        if (!validTenant(tenant)) throw new ApiError(400, "tenant_required");
        if (!isCapValue(capSatang)) throw new ApiError(400, "invalid_request");
        const defaultCapSatang = gatewayDefaultCap(options.modelGateway);
        writeCap(db.model, tenant, capSatang, iso(now()));
        if (capSatang === null) {
          audit(tenant, PRACTICE_OPERATOR, "model.cap_cleared", {});
        } else {
          audit(tenant, PRACTICE_OPERATOR, "model.cap_set", {}, "ok", { amountSatang: capSatang });
        }
        return capOf(db.model, tenant, defaultCapSatang);
      }),

    // As the API: the tenant, then the page (a size of 1 to 25, ten when absent, and a cursor that is a job's task id), then
    // the shop, then that the cursor is one of its jobs. Newest first; the page after a job is the jobs older than it.
    listWorkerJobs: (tenant, query = {}) =>
      run(() => {
        admin();
        if (!validTenant(tenant)) throw new ApiError(400, "tenant_required");
        const limit = query.limit ?? 10;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new ApiError(400, "invalid_request");
        const { before } = query;
        if (before !== undefined && !WORKER_TASK.test(before)) throw new ApiError(400, "invalid_request");
        if (!db.shops.some((shop) => shop.tenant === tenant)) throw new ApiError(404, "shop_not_found");
        const newest = db.workers.filter((job) => job.tenant === tenant).reverse();
        let start = 0;
        if (before !== undefined) {
          const at = newest.findIndex((job) => job.taskId === before);
          if (at < 0) throw new ApiError(400, "invalid_request");
          start = at + 1;
        }
        const page = newest.slice(start, start + limit);
        const last = page[page.length - 1];
        const more = start + limit < newest.length;
        return {
          tenant,
          jobs: page.map(({ tenant: _tenant, ...job }) => job),
          next: more && last ? last.taskId : null,
        };
      }),
  };

}

/// How each refusal of the package is answered: the API's statuses for the memory routes.
const MEMORY_STATUS: Record<Refusal, number> = {
  invalid_text: 400,
  invalid_source: 400,
  not_found: 404,
  already_known: 409,
  forgotten: 409,
  full: 409,
};

/// The id the API gives a shop's owner in the rules' state: in the pilot the owner has no account.
const OWNER_ID = "owner";

/// The longest name the owner may give a helper, in characters after outer spaces are trimmed, as the API keeps it.
const MAX_NAME = 80;
/// The longest id, name or account the API's record keeps.
const MAX_FIELD = 256;

/// A name as a person reads it, by the API's rule: no outer spaces, 1 to 80 characters, composed the same way whatever the
/// keyboard, and no control character, so a name can never break a line in the console or a log. Null for anything else.
function keptName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFC").trim();
  return name.length > 0 && [...name].length <= MAX_NAME && !/\p{Cc}/u.test(name) ? name : null;
}

/// The identity as the API keeps it: only the fields its kind has, an email without outer spaces (its case kept, and
/// compared without it) and a LINE account id exactly. Null for what is not an identity at all; one of the right shape with
/// a value the rules refuse (an empty id, an address with no `@`) is left for them to refuse.
function keptIdentity(value: unknown): Identity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  if (identity.kind === "line" && typeof identity.id === "string" && identity.id.length <= MAX_FIELD) {
    return { kind: "line", id: identity.id };
  }
  if (identity.kind === "email" && typeof identity.address === "string" && identity.address.length <= MAX_FIELD) {
    return { kind: "email", address: identity.address.trim() };
  }
  return null;
}

/// Who the fake's log names. Practice actions come from the practice key, which has no Access identity: the API
/// records such an operator as `email: null`, as it records a service token.
const PRACTICE_OPERATOR: AuditActor = { kind: "operator", email: null };
const OWNER: AuditActor = { kind: "owner" };
const SYSTEM: AuditActor = { kind: "system" };

/// The API's entry ids: a base-36 millisecond clock, a sequence and a random tail, so ids sort by time and page with
/// the same cursor the API takes.
const AUDIT_ID = /^aud-[0-9a-z]{9}-[0-9a-z]{3}-[0-9a-f]{8}$/;

/// The ids the API gives a worker job's task, which are also all a page's cursor may be.
const WORKER_TASK = /^worker-task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function auditId(ms: number, seq: number): string {
  return sortableId("aud", ms, seq);
}

/// A prefix, a base-36 millisecond clock, a sequence and a random tail, so ids sort by time. The meter's call ids
/// (`call-…`) are made the same way.
function sortableId(prefix: string, ms: number, seq: number): string {
  const tail = new Uint8Array(4);
  crypto.getRandomValues(tail);
  const hex = [...tail].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${ms.toString(36).padStart(9, "0")}-${(seq % 46656).toString(36).padStart(3, "0")}-${hex}`;
}

/// LINE's `x-line-signature`: base64 HMAC-SHA256 of the raw body under the channel secret.
export async function lineSignature(channelSecret: string, rawBody: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
  let binary = "";
  for (const byte of mac) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function seed(at: number): FakeDb {
  const ago = (minutes: number) => new Date(at - minutes * MINUTE_MS).toISOString();
  const later = (minutes: number) => new Date(at + minutes * MINUTE_MS).toISOString();
  const tenant = "shop_baanmali";
  const connectionId = "line_baanmali";
  const message = (
    id: string,
    minutesAgo: number,
    lineUserId: string,
    text: string,
    displayName?: string,
  ): FakeMessage => {
    const m: FakeMessage = { id, tenant, connectionId, lineUserId, text, receivedAt: ago(minutesAgo) };
    if (displayName) m.displayName = displayName;
    return m;
  };
  const action = (
    id: string,
    messageId: string,
    token: string,
    replyText: string,
    proposedMinutesAgo: number,
    state: ApprovalState,
    outcome: Outcome,
    decidedMinutesAgo?: number,
  ): FakeAction => {
    const a: FakeAction = {
      tenant,
      taskId: `task_${tenant}`,
      actionId: id,
      messageId,
      replyText,
      state,
      proposedAt: ago(proposedMinutesAgo),
      token,
      // The seeded links stay open for a day from now, so the demo links keep working.
      expiresAt: later(24 * 60),
      outcome,
    };
    if (decidedMinutesAgo !== undefined) {
      a.decidedAt = ago(decidedMinutesAgo);
      if (state === "confirmed") a.dispatchedAt = ago(decidedMinutesAgo);
    }
    return a;
  };

  const messages: FakeMessage[] = [
    message("msg_ploy", 12, "Uploy", "สวัสดีค่ะ สั่งเทียนหอมไปตั้งแต่วันพุธ ยังไม่ได้รับของเลยค่ะ", "Khun Ploy"),
    message("msg_arthit", 25, "Uarthit", "เทียนที่ได้รับมาแตกครับ ขอคืนเงินได้ไหมครับ ออเดอร์ SP-2291", "Khun Arthit"),
    message("msg_nok", 48, "Unok", "Hi, my order SP-2296 still says preparing. Will it ship this week?", "Khun Nok"),
    message("msg_tracking", 75, "Uanon", "ขอเลขพัสดุหน่อยค่ะ สั่งเซ็ตของขวัญไป 3 วันแล้ว"),
    message("msg_mai", 300, "Umai", "ได้รับของแล้วค่ะ หอมมาก ขอบคุณค่ะ", "Khun Mai"),
    message("msg_fah", 420, "Ufah", "ถ้าซื้อ 5 เซ็ต ลด 20% ได้ไหมคะ", "Khun Fah"),
    message("msg_joy", 1330, "Ujoy", "ร้านเปิดกี่โมงคะ", "Khun Joy"),
  ];
  const actions: FakeAction[] = [
    action(
      "act_ploy",
      "msg_ploy",
      DEMO_TOKENS.waiting,
      "ขออภัยที่พัสดุล่าช้านะคะ ตอนนี้ของออกจากคลังแล้ว คาดว่าจะถึงภายในวันอังคารค่ะ",
      10,
      "proposed",
      "confirmed",
    ),
    action(
      "act_nok",
      "msg_nok",
      DEMO_TOKENS.failed,
      "Sorry for the wait, Khun Nok. Your order ships tomorrow morning and should reach you by Tuesday.",
      40,
      "proposed",
      "failed",
    ),
    action(
      "act_tracking",
      "msg_tracking",
      DEMO_TOKENS.unknown,
      "ขออภัยที่รอนานนะคะ ของออกจากคลังเมื่อเช้านี้ค่ะ จะส่งเลขพัสดุให้ภายในวันนี้นะคะ",
      70,
      "proposed",
      "unknown",
    ),
    action("act_mai", "msg_mai", DEMO_TOKENS.sent, "ขอบคุณมากนะคะ ดีใจที่ชอบกลิ่นนี้ค่ะ", 290, "confirmed", "confirmed", 282),
    action("act_fah", "msg_fah", DEMO_TOKENS.declined, "ได้เลยค่ะ ลด 20% ให้นะคะ", 410, "rejected", "confirmed", 395),
    action("act_joy", "msg_joy", DEMO_TOKENS.expiredRequest, "ร้านเปิดทุกวัน 10:00 ถึง 19:00 ค่ะ", 1320, "expired", "confirmed"),
  ];
  for (const a of actions) {
    const m = messages.find((x) => x.id === a.messageId);
    if (m) m.replyActionId = a.actionId;
  }

  // The deletion page's demo links, each about its own copy of Khao Soi Nimman, a shop that is not on the console's
  // list. Each copy has the deletion record its state needs, so answering one never changes another.
  const goes: DeletionGoes = { messages: 12, replies: 9, payments: 3, lineConnected: true };
  const demo = (
    key: keyof typeof DEMO_DELETION_TOKENS,
    state: Pick<FakeConfirmation, "status" | "approved" | "decidedAt">,
    deletedAt?: string,
  ) => {
    const tenant = `shop_khaosoi_${key}`;
    const confirmation: FakeConfirmation = {
      id: `del_${key}`,
      tenant,
      token: DEMO_DELETION_TOKENS[key],
      shopName: "Khao Soi Nimman",
      goes,
      expiresAt: later(24 * 60),
      ...state,
    };
    const record: FakeDeletionRecord = {
      tenant,
      name: "Khao Soi Nimman",
      requestedAt: ago(30),
      deletedBy: null,
      confirmationId: confirmation.id,
      ...(deletedAt ? { deletedAt } : {}),
    };
    return { confirmation, record };
  };
  const demos = [
    demo("waiting", { status: "pending" }),
    demo("deleting", { status: "decided", approved: true, decidedAt: ago(20) }),
    demo("deleted", { status: "decided", approved: true, decidedAt: ago(20) }, ago(20)),
    demo("kept", { status: "decided", approved: false, decidedAt: ago(20) }),
    demo("unanswered", { status: "withdrawn" }),
  ];

  return {
    version: 8,
    seq: 100,
    shops: [
      // Connected 13 days ago, so today is day 14 of its trial, and Fon's answers this morning make it active.
      {
        tenant,
        name: "Baan Mali",
        ownerName: "Fon",
        lineConnectionId: connectionId,
        consent: false,
        trialStartedAt: ago(13 * 24 * 60),
      },
      { tenant: "shop_sabaitea", name: "Sabai Tea", ownerName: "Dao", consent: false },
    ],
    connections: [
      {
        connectionId,
        tenant,
        channelId: "2001234567",
        botUserId: "Ubaanmalibot",
        channelSecret: PRACTICE_CHANNEL_SECRET,
      },
    ],
    messages,
    actions,
    payments: [
      {
        id: "pay_2288",
        tenant,
        orderRef: "SP-2288",
        amountSatang: 45000,
        promptPayId: "0812345678",
        confirmedAt: ago(1500),
      },
      {
        id: "pay_2301",
        tenant,
        orderRef: "SP-2301",
        amountSatang: 129000,
        promptPayId: "0812345678",
        slipNote: "Slip time 14:02, seen in the shop's bank app",
        confirmedAt: ago(120),
      },
    ],
    subscriptionPayments: [],
    deletions: demos.map((entry) => entry.record),
    confirmations: demos.map((entry) => entry.confirmation),
    expiredTokens: [DEMO_TOKENS.expiredLink, DEMO_DELETION_TOKENS.expiredLink],
    audit: sampleAudit(at, tenant, connectionId),
    memory: { [tenant]: sampleMemory(at) },
    people: { [tenant]: samplePeople(at, tenant) },
    model: seedModel(at, tenant),
    workers: sampleWorkers(at, tenant),
  };
}

/// Baan Mali's model spend as the meter would have kept it: 50 calls spread across the Bangkok month `at` falls in, ฿186.00
/// in all, against the ฿300 cap an operator set five days ago, and one more call still in progress. Each kind of call is
/// priced at ฿35 a dollar by docs/model-gateway.md's table and rounded up once per call: a Sonnet 5.5 reply of 2,800
/// tokens in and 560 out is 39,200 millisatang. Spreading the calls from the month's first moment to `at` keeps them in
/// the current month whatever day the practice world is made.
function seedModel(at: number, tenant: string): FakeModel {
  const monthStart = Date.parse(`${monthOf(at)}-01T00:00:00+07:00`);
  // Per kind: model, tokens in, tokens out, millisatang each, how many, and how it ended.
  const kinds: [string, number, number, number, number, string][] = [
    ["claude-opus-5-5", 52_000, 5_200, 1_092_000, 6, "ok"], // the week's plan
    ["claude-opus-5-5", 31_000, 2_900, 637_000, 12, "ok"], // the research behind a reply
    ["claude-opus-5-5", 18_000, 1_200, 336_000, 11, "ok"], // an order looked up
    ["claude-sonnet-5-5", 2_800, 560, 39_200, 18, "ok"], // a reply drafted
    ["claude-haiku-5-5", 1_400, 250, 928, 2, "ok"], // a message sorted
    ["claude-haiku-5-5", 0, 0, 0, 1, "failed"], // the provider failed, so nothing was charged
  ];
  const rows = kinds.flatMap(([model, inputTokens, outputTokens, millisatang, count, outcome]) =>
    Array.from({ length: count }, () => ({ model, inputTokens, outputTokens, millisatang, outcome })));
  // A fixed shuffle mixes the kinds without a random number: 31 and 50 share no factor, so it visits every row once.
  const calls = rows.map((_, i) => {
    const row = rows[(i * 31) % rows.length]!;
    const when = monthStart + Math.floor(((at - monthStart) * (i + 1)) / (rows.length + 1));
    return {
      tenant,
      id: sortableId("call", when, i),
      at: new Date(when).toISOString(),
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      millisatang: row.millisatang,
      satang: ceilSatang(row.millisatang),
      outcome: row.outcome,
    };
  });
  // A Sonnet reply asked for a minute ago: its worst case is held, 3,400 tokens in and 1,000 out at the table's price.
  const heldAt = at - MINUTE_MS;
  return {
    overrides: [{ tenant, capSatang: 30_000, setAt: new Date(at - 5 * DAY_MS).toISOString(), setBy: "ops@manut.test" }],
    calls,
    holds: [{
      tenant,
      callId: sortableId("call", heldAt, rows.length),
      model: "claude-sonnet-5-5",
      worstMillisatang: 58_800,
      at: new Date(heldAt).toISOString(),
      expiresAt: new Date(heldAt + 15 * MINUTE_MS).toISOString(),
    }],
  };
}

/// Baan Mali's audit log as its sample world would have written it, oldest first, and Sabai Tea's one entry. The
/// times match the sample's own: the shop and its LINE account 13 days ago, then each payment, reply and decision.
function sampleAudit(at: number, tenant: string, connectionId: string): FakeAuditEntry[] {
  const operator: AuditActor = { kind: "operator", email: null };
  // The operator who set Baan Mali's cap was signed in through Access, so the log names them.
  const named: AuditActor = { kind: "operator", email: "ops@manut.test" };
  const owner: AuditActor = { kind: "owner" };
  const system: AuditActor = { kind: "system" };
  const taskId = `task_${tenant}`;
  let seq = 0;
  const entry = (shop: string, minutesAgo: number, actor: AuditActor, action: string, subject: Record<string, string>,
    outcome = "ok", amountSatang?: number): FakeAuditEntry => {
    const ms = at - minutesAgo * MINUTE_MS;
    seq += 1;
    return { tenant: shop, id: auditId(ms, seq), at: new Date(ms).toISOString(), actor, action, subject, outcome,
      ...(amountSatang !== undefined ? { amountSatang } : {}) };
  };
  const helper: AuditActor = { kind: "helper", id: "helper-mint" };
  const reply = (actionId: string, messageId: string) => ({ taskId, actionId, messageId });
  const decided = (actionId: string) => ({ taskId, actionId });
  return [
    entry(tenant, 13 * 24 * 60 + 30, operator, "shop.created", {}),
    entry(tenant, 13 * 24 * 60, operator, "line.connected", { connectionId }),
    entry(tenant, 5 * 24 * 60, named, "model.cap_set", {}, "ok", 30000),
    entry("shop_sabaitea", 2 * 24 * 60, operator, "shop.created", {}),
    // What the team learned about the shop, by the ids of the facts in `sampleMemory`.
    entry(tenant, 12 * 24 * 60, operator, "memory.remembered", { factId: "f1" }),
    entry(tenant, 11 * 24 * 60, system, "memory.proposed", { factId: "f2" }),
    entry(tenant, 6 * 24 * 60, system, "memory.proposed", { factId: "f3" }),
    entry(tenant, 3 * 24 * 60, system, "memory.proposed", { factId: "f4" }),
    entry(tenant, 2 * 24 * 60, system, "memory.proposed", { factId: "f5" }),
    entry(tenant, 1500, operator, "payment.recorded", { paymentId: "pay_2288" }, "ok", 45000),
    entry(tenant, 1320, operator, "reply.proposed", reply("act_joy", "msg_joy")),
    entry(tenant, 410, operator, "reply.proposed", reply("act_fah", "msg_fah")),
    entry(tenant, 395, owner, "reply.decided", decided("act_fah"), "declined"),
    entry(tenant, 290, operator, "reply.proposed", reply("act_mai", "msg_mai")),
    entry(tenant, 282, owner, "reply.decided", decided("act_mai"), "approved"),
    entry(tenant, 282, system, "dispatch.started", decided("act_mai")),
    entry(tenant, 282, system, "dispatch.settled", decided("act_mai"), "confirmed"),
    entry(tenant, 120, operator, "payment.recorded", { paymentId: "pay_2301" }, "ok", 129000),
    entry(tenant, 90, system, "memory.proposed", { factId: "f6" }, "awaiting_owner"),
    entry(tenant, 50, system, "memory.proposed", { factId: "f7" }, "awaiting_owner"),
    // What the people of `samplePeople` did, by ids only: Mint invited and joined ten days ago, opened the shop on a second
    // device, was set to cover yesterday, passed a note on this morning, and Beam was invited two hours ago.
    entry(tenant, 10 * 24 * 60, operator, "invite.created", { inviteId: "inv-mint" }),
    entry(tenant, 10 * 24 * 60 - 5, helper, "helper.joined", { inviteId: "inv-mint", helperId: "helper-mint" }),
    entry(tenant, 2 * 24 * 60, helper, "helper.session_opened", { helperId: "helper-mint" }),
    entry(tenant, 24 * 60, operator, "away.set", { helperId: "helper-mint" }),
    entry(tenant, 180, helper, "request.passed_on", { requestId: "req_refund", taskId }),
    entry(tenant, 120, operator, "invite.created", { inviteId: "inv-beam" }),
    entry(tenant, 70, operator, "reply.proposed", reply("act_tracking", "msg_tracking")),
    entry(tenant, 40, operator, "reply.proposed", reply("act_nok", "msg_nok")),
    entry(tenant, 10, operator, "reply.proposed", reply("act_ploy", "msg_ploy")),
  ];
}

/// Baan Mali's people as its sample world would have made them, by the package's own rules, as the design canvas's People
/// board draws them: Mint, a helper for ten days with two devices, who covers messages until the end of the fourth day from
/// now while Fon is away and passed on a note about a refund this morning; and Beam, invited on LINE two hours ago, whose
/// link still waits. The ids are the ones `sampleAudit` names.
function samplePeople(at: number, tenant: string): FakePeople {
  const mint: Identity = { kind: "email", address: "mint@baanmali.example" };
  const beam: Identity = { kind: "line", id: "beam.baanmali" };
  const joinedAt = at - 10 * DAY_MS + 5 * MINUTE_MS;
  const refused = (what: string, why: string) => new Error(`the sample ${what} was refused: ${why}`);
  let state = peopleRules.emptyPeople(tenant, OWNER_ID);

  const invitedMint = peopleRules.invite(state, "inv-mint", mint, at - 10 * DAY_MS);
  if (!invitedMint.ok) throw refused("invite for Mint", invitedMint.refused);
  const joined = peopleRules.acceptInvite(invitedMint.state, "inv-mint", mint, "helper-mint", "hs-mint-1", joinedAt);
  if (joined.answer !== "joined") throw refused("joining of Mint", joined.answer);
  const second = peopleRules.addSession(joined.state, "helper-mint", "hs-mint-2");
  if (!second.ok) throw refused("second device of Mint", second.refused);
  // "Until Friday" is the end of that day on the shop's calendar, the moment a date field's day ends at.
  const until = Date.parse(endOfShopDay(formatIsoDate(new Date(at + 4 * DAY_MS).toISOString()))!);
  const covering = peopleRules.setAway(second.state, "helper-mint", until, at - DAY_MS);
  if (!covering.ok) throw refused("cover", covering.refused);
  const note = peopleRules.passOn(covering.state, "helper-mint", { id: "req_refund", kind: "money", decided: null },
    "The customer sent a photo of the broken jar. It looks right to me.", at - 3 * 60 * MINUTE_MS);
  if (!note.ok) throw refused("note", note.refused);
  const invitedBeam = peopleRules.invite(note.state, "inv-beam", beam, at - 2 * 60 * MINUTE_MS);
  if (!invitedBeam.ok) throw refused("invite for Beam", invitedBeam.refused);
  state = invitedBeam.state;

  return { state, names: { "inv-mint": "Mint", "helper-mint": "Mint", "inv-beam": "Beam" } };
}

/// What Nam, Pim and Ton did for Baan Mali, oldest first, as the API's task index would list it: one job for each way a job
/// can end, and the two ways a handover shows. The jobs answer the messages of the sample world above, every draft is a draft
/// nobody has sent, and the money is whole satang as the gateway prices a small model call. Its LINE account is past its
/// three days of practice, so a reply says it needs Fon's approval to be sent. Ids look like the API's: `worker-task-` and a UUID.
function sampleWorkers(at: number, tenant: string): FakeWorkerJob[] {
  const ago = (minutes: number) => new Date(at - minutes * MINUTE_MS).toISOString();
  // A summary covers the day before the job ran, on the shop's calendar.
  const dayBefore = (minutes: number) => formatIsoDate(ago(minutes + 24 * 60));
  let count = 0;
  const job = (minutesAgo: number, entry: Omit<WorkerJobEntry, "taskId" | "at">): FakeWorkerJob => {
    count += 1;
    return { tenant, taskId: `worker-task-6a7c1f00-0000-4000-8000-${String(count).padStart(12, "0")}`, at: ago(minutesAgo),
      ...entry };
  };
  const draft = (minutesAgo: number, text: string, extra: Pick<WorkerDraft, "about" | "send"> = {}): WorkerDraft =>
    ({ text, at: ago(minutesAgo), ...extra });
  const send = { answer: "ask", kind: "reply" } as const;
  const day = 24 * 60;
  return [
    // Nam was asked for yesterday's numbers, which are Ton's job, and passed it on.
    job(day + 120, { member: "ton", passedFrom: "nam", job: "daily_summary", ending: { state: "done" },
      draft: draft(day + 119, "Yesterday: 3 paid orders, ฿2,370 in sales. Nothing needs checking.",
        { about: { date: dayBefore(day + 120) } }), costSatang: 2 }),
    job(20 * 60, { member: "pim", job: "post", ending: { state: "done" },
      draft: draft(20 * 60 - 1, "เซ็ตของขวัญเทียนหอม 3 กลิ่น ห่อฟรีตลอดเดือนธันวาคม สั่งได้ทาง LINE ร้านค่ะ"), costSatang: 3 }),
    job(5 * 60, { member: "nam", job: "reply", ending: { state: "done" },
      draft: draft(5 * 60 - 1, "Hi Khun Nok, thank you for waiting. Order SP-2296 is being packed and ships tomorrow morning, so it should reach you by Tuesday.",
        { about: { messageId: "msg_nok" }, send }), costSatang: 2 }),
    job(3 * 60, { member: "ton", job: "daily_summary", ending: { state: "failed", reason: "payments_unavailable" },
      draft: null }),
    job(90, { member: "pim", job: "post", ending: { state: "awaiting_owner" },
      draft: draft(88, "Free gift wrapping all December. Order by 15 December and it reaches you before Christmas."),
      costSatang: 3 }),
    // Pim was asked for a reply, which is Nam's job, and passed it on; Nam has not taken it up.
    job(40, { member: "pim", job: "reply", ending: { state: "handed_over", to: "nam" }, draft: null }),
    job(8, { member: "nam", job: "reply", ending: { state: "done" },
      draft: draft(7, "ขออภัยที่พัสดุล่าช้านะคะ ตอนนี้ของออกจากคลังแล้ว คาดว่าจะถึงภายในวันอังคารค่ะ",
        { about: { messageId: "msg_ploy" }, send }), costSatang: 2 }),
  ];
}

/// What Baan Mali's team knows, as its sample world would have taught it, and the design canvas's own sample facts: what Fon
/// said herself, what a price list, twelve of her edits, ninety days of orders and a cost sheet taught it, and two things
/// customers said, which wait for Fon. Built by the package's own rules, so the practice world holds exactly what the API
/// would. Ids are f1 to f7 and the next is f8.
function sampleMemory(at: number): MemoryState {
  const ago = (minutes: number) => at - minutes * MINUTE_MS;
  const day = 24 * 60;
  let state = shopMemory.emptyState();
  const keep = (result: Result) => {
    if (!result.ok) throw new Error(`the sample fact was refused: ${result.reason}`);
    state = result.state;
  };
  keep(shopMemory.remember(state, "Gift wrapping is free in December.", ago(12 * day)));
  keep(shopMemory.propose(state, "Free shipping on orders over ฿800",
    { kind: "document", name: "your price list", date: ago(20 * day) }, ago(11 * day)));
  keep(shopMemory.propose(state, "Reply warmly and end with ค่ะ", { kind: "edits", count: 12 }, ago(6 * day)));
  keep(shopMemory.propose(state, "Jasmine is the best seller", { kind: "orders", days: 90 }, ago(3 * day)));
  keep(shopMemory.propose(state, "A jasmine candle costs ฿118 to make",
    { kind: "connection", name: "Google Sheets", detail: "cost sheet" }, ago(2 * day)));
  keep(shopMemory.propose(state, "Closed on Mondays", { kind: "customer", chat: "line:Ujoy" }, ago(90)));
  keep(shopMemory.propose(state, "Customers expect 20% off when they buy 5 sets", { kind: "customer", chat: "line:Ufah" }, ago(50)));
  return state;
}
