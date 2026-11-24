import {
  ApiError,
  type ApprovalView,
  type AuditPage,
  type AwayView,
  type AwaitingOwner,
  type CreatedInvite,
  type CreatedLineConnection,
  type CreatedShop,
  type DeletedShop,
  type DeletionView,
  type EmailCodeSent,
  type EmailSignIn,
  type Fact,
  type HelperRemoval,
  type Identity,
  type InboundMessage,
  type InviteView,
  type JoinAnswer,
  type LinkedOwner,
  type Memory,
  type ModelAlerts,
  type ModelCap,
  type ModelUsage,
  type NewLineConnection,
  type NewModelCap,
  type NewPayment,
  type NewReply,
  type NewShop,
  type NewSubscriptionPayment,
  type Payment,
  type People,
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
  type UnlinkedOwner,
  type WebAnswer,
  type WebSession,
  type WebShop,
  type WorkerJobsPage,
} from "./types";

export type HttpApiOptions = {
  /// The API's origin, for example `https://api.example.com`. A path prefix is kept.
  origin: string;
  /// Read on every admin call, so a key entered or forgotten later takes effect at once.
  operatorKey: () => string | null;
  fetch?: typeof fetch;
};

type Request = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  admin?: boolean;
  headers?: Record<string, string>;
  /// The answer has no body (the LINE webhook).
  empty?: boolean;
  /// One of the owner's web app's routes: it sends the browser's cookies for this origin and the app's header.
  web?: boolean;
};

/// The real client. Admin routes carry `Authorization: Bearer <operator key>` and send cookies, so a
/// Cloudflare Access session for the API host travels with them. The owner's routes carry neither: the
/// token in the path is their only credential. The join page's routes carry neither too: their credential is the
/// session the page passes in, which the page holds in memory and this client never keeps. The owner's web app's routes
/// carry no token at all: they send this origin's cookies, which hold its session where the page cannot read it, and
/// the app's header, without which the API refuses them (docs/pilot-api.md, "The web app's session").
export function createHttpApi(options: HttpApiOptions): PilotApi {
  const origin = options.origin.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  /// One request, answered with the response it got, whatever its status; one that never got an answer is ApiError 0
  /// `network`. Every route goes through here, so the key, the cookies and the body are decided in one place.
  async function send(req: Request): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json", ...req.headers };
    if (req.web) headers["x-manut-web"] = "1";
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
      // Only the web app's routes send this origin's cookies, and no other route reads one.
      credentials: req.admin ? "include" : req.web ? "same-origin" : "omit",
    };
    if (body !== undefined) init.body = body;

    try {
      return await doFetch(`${origin}${req.path}${query}`, init);
    } catch {
      throw new ApiError(0, "network");
    }
  }

  async function request<T>(req: Request): Promise<T> {
    const response = await send(req);
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
    setGateCohort: (tenant, counted) =>
      request<{ tenant: string; counted: boolean }>({ method: "POST", path: "/v1/admin/pilot/gate/cohort", body: { tenant, counted },
        admin: true }),

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

    // The owner's people. A change sends the tenant and exactly what its route takes, built field by field so nothing a caller
    // adds ever travels (a `role` above all), and answers what the API answers; a refusal is an ApiError with the API's code.
    getPeople: (tenant) => request<People>({ method: "GET", path: "/v1/admin/people", query: { tenant }, admin: true }),
    createInvite: (input) =>
      request<CreatedInvite>({
        method: "POST",
        path: "/v1/admin/people/invites",
        body: { tenant: input.tenant, name: input.name, identity: identityBody(input.identity) },
        admin: true,
      }),
    revokeInvite: (input) =>
      request<{ invite: InviteView }>({
        method: "POST",
        path: "/v1/admin/people/invites/revoke",
        body: { tenant: input.tenant, inviteId: input.inviteId },
        admin: true,
      }),
    removeHelper: (input) =>
      request<HelperRemoval>({
        method: "POST",
        path: "/v1/admin/people/remove",
        body: { tenant: input.tenant, helperId: input.helperId },
        admin: true,
      }),
    setAway: (input) =>
      request<{ away: AwayView }>({
        method: "POST",
        path: "/v1/admin/people/away",
        body: { tenant: input.tenant, helperId: input.helperId, until: input.until },
        admin: true,
      }),
    clearAway: (input) =>
      request<{ away: null }>({ method: "POST", path: "/v1/admin/people/away/clear", body: { tenant: input.tenant }, admin: true }),

    // The owner's linked account (docs/several-shops.md): built field by field, like the people changes, so the code is all that
    // names an account and nothing a caller adds ever travels.
    linkOwner: (input) =>
      request<LinkedOwner>({
        method: "POST",
        path: "/v1/admin/shops/owner",
        body: { tenant: input.tenant, code: input.code },
        admin: true,
      }),
    unlinkOwner: (input) =>
      request<UnlinkedOwner>({ method: "POST", path: "/v1/admin/shops/owner/unlink", body: { tenant: input.tenant }, admin: true }),

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
    // No query: the list is always the API's own current Bangkok month, across all shops.
    getModelAlerts: () => request<ModelAlerts>({ method: "GET", path: "/v1/admin/model/alerts", admin: true }),

    // Only what the caller gave goes in the query, so the API's own defaults decide the rest.
    listWorkerJobs: (tenant, query = {}) =>
      request<WorkerJobsPage>({
        method: "GET",
        path: "/v1/admin/workers/drafts",
        query: {
          tenant,
          ...(query.before !== undefined ? { before: query.before } : {}),
          ...(query.limit !== undefined ? { limit: String(query.limit) } : {}),
        },
        admin: true,
      }),

    // The join page's routes. Each body is built field by field, as the API takes exactly these fields, and the invite
    // token goes in one place only: the accept's body. No path or query ever carries a token or an address.
    requestEmailCode: (email) =>
      request<EmailCodeSent>({ method: "POST", path: "/v1/auth/email/code", body: { email } }),
    exchangeEmailCode: (input) =>
      request<EmailSignIn>({
        method: "POST",
        path: "/v1/auth/exchange",
        body: { provider: "email", email: input.email, code: input.code, deviceId: input.deviceId },
      }),
    // A refusal of the invite (used, expired, revoked, unknown, another account) is an answer the page shows, so it
    // resolves whatever its status; only an answer that is not one of these is an error.
    acceptInvite: async (input) => {
      const response = await send({
        method: "POST",
        path: "/v1/people/accept",
        body: { token: input.inviteToken },
        headers: { authorization: `Bearer ${input.accessToken}` },
      });
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        parsed = undefined;
      }
      const answer = joinAnswerOf(parsed);
      if (answer) return answer;
      if (response.ok || (isRecord(parsed) && typeof parsed.answer === "string")) {
        throw new ApiError(response.status, "bad_response");
      }
      throw errorFrom(response, parsed);
    },
    endShopSession: async (accessToken) => {
      await request<unknown>({
        method: "POST",
        path: "/v1/shops/session/end",
        body: {},
        headers: { authorization: `Bearer ${accessToken}` },
      });
    },
    signOut: async (accessToken) => {
      await request<unknown>({ method: "DELETE", path: "/v1/auth/session", headers: { authorization: `Bearer ${accessToken}` } });
    },

    // The owner's web app. Each body is built field by field, as each route takes exactly these fields, and nothing here
    // ever holds a token: the session is in the browser's cookies, which the page cannot read.
    webSignIn: async (input) => {
      await request<unknown>({ method: "POST", path: "/v1/web/sign-in", body: { email: input.email, code: input.code }, web: true });
    },
    // Signed out is an answer, with whether signing in by email is on at all; anything else that is not a list is an error.
    webShops: async (): Promise<WebSession> => {
      const response = await send({ method: "POST", path: "/v1/web/shops", body: {}, web: true });
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        parsed = undefined;
      }
      if (response.ok && isRecord(parsed) && Array.isArray(parsed.shops)) return { signedIn: true, shops: webShopsOf(parsed) };
      if (response.status === 401 && isRecord(parsed) && parsed.error === "signed_out") {
        return { signedIn: false, emailSignIn: parsed.emailSignIn !== false };
      }
      throw response.ok ? new ApiError(response.status, "bad_response") : errorFrom(response, parsed);
    },
    webApprovals: (shop, state) =>
      answerOf(send({ method: "GET", path: "/v1/web/approvals", query: { shop, state }, web: true })),
    webDecide: (input) =>
      answerOf(send({
        method: "POST",
        path: `/v1/web/approvals/${encodeURIComponent(input.requestId)}/decision`,
        body: { shop: input.shop, optionId: input.optionId, seenRevision: input.seenRevision },
        web: true,
      })),
    webSignOut: async () => {
      await request<unknown>({ method: "POST", path: "/v1/web/sign-out", body: {}, web: true });
    },
  };
}

/// A web route's answer with its JSON body, whatever its status: the app reads it field by field. An answer that is not
/// JSON is the API failing (`bad_response`).
async function answerOf(sent: Promise<Response>): Promise<WebAnswer> {
  const response = await sent;
  try {
    return { status: response.status, body: (await response.json()) as unknown };
  } catch {
    throw new ApiError(response.status, "bad_response");
  }
}

/// The shops of a `POST /v1/web/shops` answer, read field by field: an entry this build cannot read (a role it does not
/// know above all) is left out, since nothing here could act for it, and nothing else an entry held is kept.
export function webShopsOf(body: unknown): WebShop[] {
  const entries = isRecord(body) && Array.isArray(body.shops) ? body.shops : [];
  const seen = new Set<string>();
  const shops: WebShop[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !isText(entry.id) || !entry.id || seen.has(entry.id) || !isText(entry.name) ||
        !isText(entry.ownerName) || (entry.role !== "owner" && entry.role !== "helper") || typeof entry.ready !== "boolean") {
      continue;
    }
    seen.add(entry.id);
    shops.push({ id: entry.id, name: entry.name, ownerName: entry.ownerName, role: entry.role,
      you: isText(entry.you) && entry.you ? entry.you : null, ready: entry.ready });
  }
  return shops;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

/// An accept's answer, read field by field so the page only ever shows what the contract says each answer carries, or
/// null when the body is not one of them. A `wrong_account` keeps only the shop and the kind of account: anything else the
/// body held, an invited address above all, is dropped, so it can never reach the screen.
function joinAnswerOf(body: unknown): JoinAnswer | null {
  if (!isRecord(body)) return null;
  switch (body.answer) {
    case "joined": {
      const { shop, helper, session } = body;
      if (!isRecord(shop) || !isText(shop.id) || !isText(shop.name) || !isText(shop.ownerName)) return null;
      if (!isRecord(helper) || !isText(helper.id) || !isText(helper.name)) return null;
      if (!isRecord(session) || !isText(session.accessToken) || !isText(session.expiresAt)) return null;
      return {
        answer: "joined",
        shop: { id: shop.id, name: shop.name, ownerName: shop.ownerName },
        helper: { id: helper.id, name: helper.name },
        session: { accessToken: session.accessToken, expiresAt: session.expiresAt },
      };
    }
    case "wrong_account": {
      const { shop, invitedOn } = body;
      if (!isRecord(shop) || !isText(shop.name) || !isText(shop.ownerName)) return null;
      if (invitedOn !== "line" && invitedOn !== "email") return null;
      return { answer: "wrong_account", shop: { name: shop.name, ownerName: shop.ownerName }, invitedOn };
    }
    case "already_used":
    case "expired":
    case "revoked":
    case "unknown":
      return { answer: body.answer };
    default:
      return null;
  }
}

/// An identity with only the fields its kind has, so nothing else can ride along into an invite.
function identityBody(identity: Identity): Identity {
  return identity.kind === "line" ? { kind: "line", id: identity.id } : { kind: "email", address: identity.address };
}

async function errorOf(response: Response): Promise<ApiError> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  return errorFrom(response, parsed);
}

/// Whole seconds, as a wait is given: a whole number from 0, in the body as a number or in a header as digits.
function wholeSeconds(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/// Everything the contract puts in an error answer is kept: the settled page on a second decision, what a partial
/// wipe left, when and by whom a deleted shop was deleted, the setting a `not_configured` answer names, how long to wait
/// before another sign-in code (the body's `retryAfter`, else the `retry-after` header) and how many tries a code has
/// left. Fields of the wrong type are dropped, not guessed.
function errorFrom(response: Response, parsed: unknown): ApiError {
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const retryAfter = wholeSeconds(record.retryAfter) ?? wholeSeconds(response.headers.get("retry-after"));
  const triesLeft = wholeSeconds(record.triesLeft);
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
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    ...(triesLeft !== undefined ? { triesLeft } : {}),
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
