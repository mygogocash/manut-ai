import {
  ApiError,
  isSending,
  REPLY_MAX_LENGTH,
  type ApprovalState,
  type ApprovalView,
  type InboundMessage,
  type Payment,
  type PilotApi,
  type ReplyAction,
  type Shop,
} from "./types";

/// An in-memory stand-in for apps/api that keeps the contract's rules: one decision per request, approving
/// needs the shop's consent, a send settles `confirmed`, `failed` or `unknown`, admin calls need a key, and
/// lists come back newest first. It lets every screen run and be tested with no backend.
///
/// Sample world: Baan Mali (owner Fon) on LINE, with customers asking about late parcels and a refund, and a
/// second shop, Sabai Tea, with nothing connected yet. Demo links on the practice home page open the owner's
/// page in each state: /approve/demo, demo-failed, demo-unknown, demo-sent, demo-declined, demo-old and
/// demo-expired; any other token is an invalid link.

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

type FakeShop = Shop;
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
type FakeDb = {
  version: 1;
  seq: number;
  shops: FakeShop[];
  connections: FakeConnection[];
  messages: FakeMessage[];
  actions: FakeAction[];
  payments: Payment[];
  /// Tokens that answer 410, standing in for links whose signed expiry has passed.
  expiredTokens: string[];
};

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
      return parsed && parsed.version === 1 && Array.isArray(parsed.actions) ? parsed : null;
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

  function shopOf(tenant: string): FakeShop {
    const shop = db.shops.find((s) => s.tenant === tenant);
    if (!shop) throw new ApiError(404, "unknown_tenant");
    return shop;
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
        return db.shops;
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

  return {
    version: 1,
    seq: 100,
    shops: [
      { tenant, name: "Baan Mali", ownerName: "Fon", lineConnectionId: connectionId, consent: false },
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
    expiredTokens: [DEMO_TOKENS.expiredLink],
  };
}
