import {
  ApiError,
  type ApprovalView,
  type AuditPage,
  type AwaitingOwner,
  type CreatedLineConnection,
  type CreatedShop,
  type DeletedShop,
  type DeletionView,
  type Fact,
  type InboundMessage,
  type Memory,
  type ModelCap,
  type ModelUsage,
  type NewLineConnection,
  type NewModelCap,
  type NewPayment,
  type NewReply,
  type NewShop,
  type NewSubscriptionPayment,
  type Payment,
  type PilotApi,
  type PilotGate,
  type ProposedReply,
  type ReplyAction,
  type Shop,
  type ShopDeletion,
  type ShopExport,
  type ShopQuestion,
  type ShopQuestions,
  type ShopTemplate,
  type NewAnswer,
  type SubscriptionPayment,
} from "./types";

export type HttpApiOptions = {
  /// The API's origin, for example `https://api.example.com`. A path prefix is kept.
  origin: string;
  /// Read on every admin call, so a key entered or forgotten later takes effect at once.
  operatorKey: () => string | null;
  fetch?: typeof fetch;
};

type Request = {
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  admin?: boolean;
  headers?: Record<string, string>;
  /// The answer has no body (the LINE webhook).
  empty?: boolean;
};

/// The real client. Admin routes carry `Authorization: Bearer <operator key>` and send cookies, so a
/// Cloudflare Access session for the API host travels with them. The owner's routes carry neither: the
/// token in the path is their only credential.
export function createHttpApi(options: HttpApiOptions): PilotApi {
  const origin = options.origin.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function request<T>(req: Request): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...req.headers };
    if (req.admin) {
      const key = options.operatorKey();
      // Never let an admin call leave without its key: the gate would refuse it anyway, and a keyless call
      // could only confuse what the console shows.
      if (!key) throw new ApiError(0, "operator_key_missing");
      headers.authorization = `Bearer ${key}`;
    }
    let body: string | undefined;
    if (req.body !== undefined) {
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      headers["content-type"] ??= "application/json";
    }
    const query = req.query ? `?${new URLSearchParams(req.query).toString()}` : "";
    const init: RequestInit = {
      method: req.method,
      headers,
      credentials: req.admin ? "include" : "omit",
    };
    if (body !== undefined) init.body = body;

    let response: Response;
    try {
      response = await doFetch(`${origin}${req.path}${query}`, init);
    } catch {
      throw new ApiError(0, "network");
    }
    if (!response.ok) throw await errorOf(response);
    if (req.empty) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError(response.status, "bad_response");
    }
  }

  const approval = (token: string) => `/v1/pilot/approvals/${encodeURIComponent(token)}`;
  const deletion = (token: string) => `/v1/pilot/deletions/${encodeURIComponent(token)}`;

  return {
    deliverLineWebhook: (connectionId, rawBody, signature) =>
      request<void>({
        method: "POST",
        path: `/v1/inbound/line/${encodeURIComponent(connectionId)}`,
        body: rawBody,
        headers: { "x-line-signature": signature },
        empty: true,
      }),

    getApproval: (token) => request<ApprovalView>({ method: "GET", path: approval(token) }),
    giveConsent: (token) =>
      request<ApprovalView>({ method: "POST", path: `${approval(token)}/consent`, body: { cloudWork: true } }),
    decide: (token, approve) =>
      request<ApprovalView>({ method: "POST", path: `${approval(token)}/decision`, body: { approve } }),

    createShop: (input: NewShop) =>
      request<CreatedShop>({ method: "POST", path: "/v1/admin/pilot/shops", body: input, admin: true }),
    listShops: async () =>
      (await request<{ shops: Shop[] }>({ method: "GET", path: "/v1/admin/pilot/shops", admin: true })).shops,
    listTemplates: async () =>
      (await request<{ templates: ShopTemplate[] }>({ method: "GET", path: "/v1/admin/templates", admin: true })).templates,
    getQuestions: (tenant) =>
      request<ShopQuestions>({ method: "GET", path: "/v1/admin/questions", query: { tenant }, admin: true }),
    answerQuestion: async (input: NewAnswer) =>
      (await request<{ question: ShopQuestion }>({ method: "POST", path: "/v1/admin/questions/answer", body: input,
        admin: true })).question,
    createLineConnection: (input: NewLineConnection) =>
      request<CreatedLineConnection>({
        method: "POST",
        path: "/v1/admin/pilot/line-connections",
        body: input,
        admin: true,
      }),
    listMessages: async (tenant) =>
      (
        await request<{ messages: InboundMessage[] }>({
          method: "GET",
          path: "/v1/admin/pilot/messages",
          query: { tenant },
          admin: true,
        })
      ).messages,
    proposeReply: (input: NewReply) =>
      request<ProposedReply>({ method: "POST", path: "/v1/admin/pilot/replies", body: input, admin: true }),
    listActions: async (tenant) =>
      (
        await request<{ actions: ReplyAction[] }>({
          method: "GET",
          path: "/v1/admin/pilot/actions",
          query: { tenant },
          admin: true,
        })
      ).actions,
    recordPayment: (input: NewPayment) =>
      request<Payment>({ method: "POST", path: "/v1/admin/pilot/payments", body: input, admin: true }),
    listPayments: async (tenant) =>
      (
        await request<{ payments: Payment[] }>({
          method: "GET",
          path: "/v1/admin/pilot/payments",
          query: { tenant },
          admin: true,
        })
      ).payments,
    exportShop: (tenant) =>
      request<ShopExport>({ method: "GET", path: "/v1/admin/pilot/export", query: { tenant }, admin: true }),
    // A shop that never went live answers 200 with what was deleted; a live one answers 202 with the link for its
    // owner. Both are successes, and the caller tells them apart (`isAwaitingOwner`).
    deleteShop: (input: ShopDeletion) =>
      request<DeletedShop | AwaitingOwner>({
        method: "POST",
        path: "/v1/admin/pilot/deletions",
        body: input,
        admin: true,
      }),

    getDeletion: (token) => request<DeletionView>({ method: "GET", path: deletion(token) }),
    decideDeletion: (token, approve) =>
      request<DeletionView>({ method: "POST", path: `${deletion(token)}/decision`, body: { approve } }),

    recordSubscriptionPayment: (input: NewSubscriptionPayment) =>
      request<SubscriptionPayment>({
        method: "POST",
        path: "/v1/admin/pilot/subscription-payments",
        body: input,
        admin: true,
      }),
    listSubscriptionPayments: async (tenant) =>
      (
        await request<{ payments: SubscriptionPayment[] }>({
          method: "GET",
          path: "/v1/admin/pilot/subscription-payments",
          query: { tenant },
          admin: true,
        })
      ).payments,
    getGate: () => request<PilotGate>({ method: "GET", path: "/v1/admin/pilot/gate", admin: true }),

    // Only what the caller gave goes in the query, so the API's own defaults decide the rest.
    listAudit: (tenant, query = {}) =>
      request<AuditPage>({
        method: "GET",
        path: "/v1/admin/audit",
        query: {
          tenant,
          ...(query.before !== undefined ? { before: query.before } : {}),
          ...(query.limit !== undefined ? { limit: String(query.limit) } : {}),
        },
        admin: true,
      }),

    // What the team knows about a shop. A change sends the tenant and exactly what its route takes, and answers the
    // fact (Forget answers the id of the one it removed); a refusal is an ApiError with the API's code.
    getMemory: (tenant) => request<Memory>({ method: "GET", path: "/v1/admin/memory", query: { tenant }, admin: true }),
    rememberFact: (input) =>
      request<Fact>({ method: "POST", path: "/v1/admin/memory/remember", body: input, admin: true }),
    confirmFact: (input) =>
      request<Fact>({ method: "POST", path: "/v1/admin/memory/confirm", body: input, admin: true }),
    correctFact: (input) =>
      request<Fact>({ method: "POST", path: "/v1/admin/memory/correct", body: input, admin: true }),
    forgetFact: (input) =>
      request<{ id: string }>({ method: "POST", path: "/v1/admin/memory/forget", body: input, admin: true }),

    // The month goes in the query only when asked for: the API's own current Bangkok month decides otherwise.
    getModelUsage: (tenant, month) =>
      request<ModelUsage>({
        method: "GET",
        path: "/v1/admin/model/usage",
        query: { tenant, ...(month !== undefined ? { month } : {}) },
        admin: true,
      }),
    // Built field by field so `capSatang` is always in the body, null included: the API refuses a body without it,
    // so clearing a cap is said and never implied by leaving it out.
    setModelCap: (input: NewModelCap) =>
      request<ModelCap>({
        method: "PUT",
        path: "/v1/admin/model/cap",
        body: { tenant: input.tenant, capSatang: input.capSatang },
        admin: true,
      }),
  };
}

/// Everything the contract puts in an error answer is kept: the settled page on a second decision, what a partial
/// wipe left, when and by whom a deleted shop was deleted, and the setting a `not_configured` answer names. Fields of
/// the wrong type are dropped, not guessed.
async function errorOf(response: Response): Promise<ApiError> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const code = typeof record.error === "string" && record.error ? record.error : `http_${response.status}`;
  const view = isApprovalView(record.view) ? record.view : undefined;
  const failed = Array.isArray(record.failed) && record.failed.every((part) => typeof part === "string")
    ? (record.failed as string[])
    : undefined;
  return new ApiError(response.status, code, view, {
    ...(isDeletionView(record.view) ? { deletionView: record.view } : {}),
    ...(failed ? { failed } : {}),
    ...(typeof record.deletedAt === "string" ? { deletedAt: record.deletedAt } : {}),
    ...(typeof record.deletedBy === "string" || record.deletedBy === null ? { deletedBy: record.deletedBy } : {}),
    ...(typeof record.setting === "string" && record.setting ? { setting: record.setting } : {}),
  });
}

function isApprovalView(value: unknown): value is ApprovalView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.state === "string" && typeof v.replyText === "string" && typeof v.shopName === "string";
}

function isDeletionView(value: unknown): value is DeletionView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.state === "string" && typeof v.shopName === "string" && typeof v.goes === "object" &&
    v.goes !== null;
}
