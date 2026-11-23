import {
  ApiError,
  isLiveShop,
  isSending,
  REPLY_MAX_LENGTH,
  type ApprovalState,
  type ApprovalView,
  type AwaitingOwner,
  type DeletedShop,
  type DeletionGoes,
  type DeletionRequest,
  type DeletionState,
  type DeletionView,
  type InboundMessage,
  type Payment,
  type PilotApi,
  type ReplyAction,
  type Shop,
  type SubscriptionPayment,
} from "./types";
import { pilotGate } from "./gate";

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
type FakeDb = {
  version: 3;
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
};

/// The saved world's `version` decides whether it is read: a world saved before deletions needed an owner's yes
/// (version 1) or before trial starts and subscription payments were kept (version 2) is replaced by a fresh one
/// rather than read without them.
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
      return parsed && parsed.version === 3 && Array.isArray(parsed.actions) && Array.isArray(parsed.confirmations) &&
        Array.isArray(parsed.subscriptionPayments)
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

  function newestFirst<T>(items: T[], at: (item: T) => string): T[] {
    return [...items].sort((a, b) => Date.parse(at(b)) - Date.parse(at(a)));
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
        shop.lineConnectionId = connectionId;
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
        const record = recordOf(confirmation.tenant);
        if (approve && record?.confirmationId === confirmation.id) wipe(record);
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
  };
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
    version: 3,
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
  };
}
