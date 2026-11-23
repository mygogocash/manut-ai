import {
  ApiError,
  type ApprovalView,
  type CreatedLineConnection,
  type CreatedShop,
  type DeletedShop,
  type InboundMessage,
  type NewLineConnection,
  type NewPayment,
  type NewReply,
  type NewShop,
  type Payment,
  type PilotApi,
  type ProposedReply,
  type ReplyAction,
  type Shop,
  type ShopDeletion,
  type ShopExport,
} from "./types";

export type HttpApiOptions = {
  /// The API's origin, for example `https://api.example.com`. A path prefix is kept.
  origin: string;
  /// Read on every admin call, so a key entered or forgotten later takes effect at once.
  operatorKey: () => string | null;
  fetch?: typeof fetch;
};

type Request = {
  method: "GET" | "POST";
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
    deleteShop: (input: ShopDeletion) =>
      request<DeletedShop>({ method: "POST", path: "/v1/admin/pilot/deletions", body: input, admin: true }),
  };
}

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
  return new ApiError(response.status, code, view);
}

function isApprovalView(value: unknown): value is ApprovalView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.state === "string" && typeof v.replyText === "string" && typeof v.shopName === "string";
}
