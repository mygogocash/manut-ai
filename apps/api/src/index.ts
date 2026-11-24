import { auditAdminRoute } from "./audit-log";
import { approvalsRoute } from "./approvals";
import { AuthObject } from "./auth-object";
import { hasAppleTokenShape } from "./auth";
import { codeRequestAddress, emailExchange, emailSignIn } from "./email-code";
import { peekJsonBody, readJsonBody } from "./body";
import { beginDispatchAction, finishDispatchAction } from "./broker-actions";
import { isOutpostRoute, outpostRoute, ownerOutpostRoute, ownerVaultRoute, vaultAdminRoute } from "./browser-control";
import { vaultResealRoute } from "./vault-reseal";
import { CompanyObject } from "./company-object";
import { ConnectorError } from "./connectors/types";
import { readConnectionSecret } from "./cred-broker";
import { readLinear } from "./connectors/linear";
import { CredObject } from "./cred-object";
import { googleRoute } from "./google-connect";
import { receiveLinearWebhook } from "./inbound";
import { memoryRoute } from "./memory";
import { modelAdminRoute } from "./model-gateway";
import { peopleRoute } from "./people";
import { pilotRoute } from "./pilot";
import { routinesRoute } from "./routines";
import { relayPath, relayRoute, relaySourceGroup } from "./relay";
import { RelayObject } from "./relay-object";
import { ScheduleObject } from "./schedule-object";
import { signUpsOpen } from "./self-serve";
import { shopsRoute } from "./shops";
import { TaskObject, type TaskRecordJSON } from "./task-object";
import { authCall, credStub, scheduleStub, tenantCall, tenantDelete, tenantExport, tenantPrune } from "./tenant-data";
import { TenantObject } from "./tenant-object";
import { isValidCompanyId, isValidSharedItemId, isValidTenant, GRANTS } from "./companies";
import { workersAdminRoute } from "./workers";

export { AuthObject, CompanyObject, CredObject, RelayObject, ScheduleObject, TaskObject, TenantObject };

export interface Env {
  TASK: DurableObjectNamespace;
  AUTH: DurableObjectNamespace;
  CRED: DurableObjectNamespace;
  SCHEDULES: DurableObjectNamespace;
  TENANT: DurableObjectNamespace;
  COMPANY: DurableObjectNamespace;
  /// One RelayObject per Mac, named `relay:<hostID>` (docs/relay-protocol-v1.md).
  RELAY: DurableObjectNamespace;
  /// Public ingress limits. Missing bindings fail closed before body or object work.
  AUTH_EXCHANGE_LIMITER?: RateLimit;
  /// Asking for a sign-in code by email (email-code.ts), keyed and configured as the exchange's limit.
  AUTH_CODE_LIMITER?: RateLimit;
  AUTH_SESSION_LIMITER?: RateLimit;
  LINEAR_INBOUND_LIMITER?: RateLimit;
  /// Relay upgrade gates, keyed per source group: an IPv4 address or an IPv6 /64.
  RELAY_HOST_LIMITER?: RateLimit;
  RELAY_PHONE_LIMITER?: RateLimit;
  /// The relay's kill switch. Only exactly "1" opens a relay route; every real
  /// environment leaves it unset until the owner turns the relay on (gate G3).
  RELAY_ENABLED?: string;
  /// Operator secret (`wrangler secret put CLOUD_API_KEY`). Never in config.
  CLOUD_API_KEY?: string;
  /// Expected protected admin Access application audience. Unset denies admin.
  ADMIN_ACCESS_AUD?: string;
  /// Explicit local test key source; production leaves this unset.
  TEST_JWKS_JSON?: string;
  /// Signing in by a code sent by email (email-code.ts; docs/pilot-api.md, "Signing in by email"). Built and off: both
  /// of its routes answer `email_not_configured` until EMAIL_SIGN_IN is exactly "on", a sender is bound and
  /// APPROVAL_LINK_SECRET can sign. EMAIL is Cloudflare Email Service's `send_email` binding, and EMAIL_FROM_ADDRESS
  /// and EMAIL_FROM_NAME the sender owners see (email-sender.ts). No environment sets any of them yet: turning it on
  /// waits for the owner, the Workers Paid plan and a sending domain.
  EMAIL_SIGN_IN?: string;
  EMAIL?: SendEmail;
  EMAIL_FROM_ADDRESS?: string;
  EMAIL_FROM_NAME?: string;
  /// TEST-ONLY: "on" sends codes to an in-memory outbox the workerd tests read (email-sender.ts). Only
  /// wrangler.test.json sets it, and the dev deploy check refuses every config with a `TEST_` var.
  TEST_EMAIL_OUTBOX?: string;
  /// Capability defaults. New capabilities ship off; an environment opts in
  /// explicitly. Dynamic flags (below) override these without a redeploy.
  OFFICE_CLOUD?: string;
  OFFICE_ROUTINES?: string;
  OFFICE_EXTERNAL_WRITES?: string;
  OFFICE_INBOUND?: string;
  OFFICE_SHARING?: string;
  /// Linear webhook signing secret (`wrangler secret put
  /// LINEAR_WEBHOOK_SECRET`). Never in config; without it every delivery is
  /// refused as unsigned.
  LINEAR_WEBHOOK_SECRET?: string;
  /// Manut AI pilot (docs/pilot-api.md, pilot.ts). The owner's approval page
  /// origin (`approvalUrl` is `${WEB_ORIGIN}/approve/{token}`) and this
  /// Worker's public origin (for each LINE `webhookUrl`): Worker vars, set
  /// per environment. Without them the routes that build those URLs refuse.
  WEB_ORIGIN?: string;
  PUBLIC_API_ORIGIN?: string;
  /// Signs the owner's approval links (`wrangler secret put
  /// APPROVAL_LINK_SECRET`, at least 32 characters). Never in config; without
  /// it no link is minted and every link is invalid.
  APPROVAL_LINK_SECRET?: string;
  /// Public pilot ingress: LINE webhooks, and the owner's approval routes,
  /// which the page polls while a send settles.
  LINE_INBOUND_LIMITER?: RateLimit;
  PILOT_APPROVAL_LIMITER?: RateLimit;
  /// The outposts' own routes (browser-control.ts), which take an outpost's credential: one bucket per address.
  OUTPOST_LIMITER?: RateLimit;
  /// Making a shop of one's own (self-serve.ts; docs/pilot-api.md, "Making a shop of your own"). Built and off: the route
  /// answers `sign_ups_closed` until SELF_SERVE_SHOPS is exactly "on", which no environment sets: opening sign-ups is the
  /// owner's call. While it is on, every try counts against SELF_SERVE_SHOP_LIMITER, per source address.
  SELF_SERVE_SHOPS?: string;
  SELF_SERVE_SHOP_LIMITER?: RateLimit;
  /// The pages Worker (pages.ts, wrangler.web.jsonc), which serves the web app for every path outside the API.
  /// Unbound, those paths answer this Worker's own 404.
  WEB?: Fetcher;
  /// The model gateway (model-gateway.ts, docs/model-gateway.md). Anthropic's
  /// API key is a Worker secret the owner adds (`wrangler secret put
  /// ANTHROPIC_API_KEY`); never in config, and without it every model call is
  /// refused with 503 not_configured. The exchange rate (satang per US dollar)
  /// and the default monthly cap per shop (satang) are Worker vars with
  /// documented defaults in model-price.ts; both are the owner's decision.
  /// MODEL_PROVIDER is `stand-in` only for local runs.
  ANTHROPIC_API_KEY?: string;
  MODEL_SATANG_PER_USD?: string;
  MODEL_DEFAULT_CAP_SATANG?: string;
  MODEL_PROVIDER?: string;
  /// Google Sheets for Ton's books (google-connect.ts, docs/connectors.md 4b): the owner's own OAuth client, two
  /// Wrangler secrets (`wrangler secret put GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`). Never in config; until both
  /// are set every Google route answers 503 google_not_configured and nothing reaches Google. No environment sets them
  /// yet. TEST_GOOGLE_ORIGIN is test-only, set in wrangler.test.json alone (google.ts).
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TEST_GOOGLE_ORIGIN?: string;
  /// The Google callback, which the owner's browser reaches with no session: one bucket per address.
  GOOGLE_CALLBACK_LIMITER?: RateLimit;
}

/// The paths this Worker answers itself. Everything else is a page of the web app.
function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/v1/") || pathname.startsWith("/relay/");
}

const MAX_BODY_BYTES = 256 * 1024;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/// These unauthenticated routes must be limited before parsing or waking AUTH.
/// Cloudflare supplies this source IP; client forwarding headers and body fields
/// never choose a bucket. Per-location limits are abuse control, not accounting.
async function ingressRateGate(request: Request, pathname: string, env: Env): Promise<Response | null> {
  let binding: RateLimit | undefined;
  let key = request.headers.get("cf-connecting-ip")?.trim();
  const relay = relayPath(pathname);
  if (request.method === "POST" && pathname === "/v1/auth/exchange") binding = env.AUTH_EXCHANGE_LIMITER;
  // Asking for a sign-in code sends an email, so it counts in a bucket of its own, keyed by the source IP as the
  // exchange's is. The limits per email address are the auth object's (email-code.ts).
  else if (request.method === "POST" && pathname === "/v1/auth/email/code") binding = env.AUTH_CODE_LIMITER;
  else if ((request.method === "POST" && pathname === "/v1/auth/refresh") ||
           (request.method === "DELETE" && pathname === "/v1/auth/session")) binding = env.AUTH_SESSION_LIMITER;
  else if (request.method === "POST" && pathname === "/v1/inbound/linear") binding = env.LINEAR_INBOUND_LIMITER;
  else if (request.method === "POST" && pathname.startsWith("/v1/inbound/line/")) binding = env.LINE_INBOUND_LIMITER;
  // Any method: the link is a bearer capability, so every probe counts. The
  // owner's two kinds of link share one limit, so probing both doubles nothing.
  else if (pathname.startsWith("/v1/pilot/approvals/") || pathname.startsWith("/v1/pilot/deletions/")) {
    binding = env.PILOT_APPROVAL_LIMITER;
  }
  // An outpost's heartbeat, redeem and steps carry its credential, so every try counts, before the credential is read.
  else if (isOutpostRoute(request.method, pathname)) binding = env.OUTPOST_LIMITER;
  // Google's redirect back to the owner's browser carries no session, only a state: every try counts, any method, before
  // the state is read.
  else if (pathname === "/v1/google/callback") binding = env.GOOGLE_CALLBACK_LIMITER;
  // Making a shop of one's own wakes AUTH to read the session and then makes a shop, so every try counts, any method, before
  // anything is read; but only while sign-ups are open: while they are closed the route answers sign_ups_closed and
  // touches nothing at all (self-serve.ts).
  else if (pathname === "/v1/shops/new" && signUpsOpen(env)) binding = env.SELF_SERVE_SHOP_LIMITER;
  else if (relay) {
    // Relay upgrades count per source group, an IPv4 address or an IPv6 /64, so
    // rotating addresses inside one prefix gains nothing (RT-1). Any method counts.
    binding = relay.role === "socket" ? env.RELAY_HOST_LIMITER : env.RELAY_PHONE_LIMITER;
    key = relaySourceGroup(key) ?? undefined;
  }
  else return null;

  if (!binding || !key) return json({ error: "rate_limit_unavailable" }, 503);
  try {
    const { success } = await binding.limit({ key });
    if (success === true) return null;
    if (success === false) return Response.json({ error: "rate_limited" },
      { status: 429, headers: { "retry-after": "60" } });
  } catch {
    // No request data or error text is logged: failure denies work safely.
  }
  return json({ error: "rate_limit_unavailable" }, 503);
}

/// Constant-time comparison so key guesses learn nothing from timing.
/// Length is checked first; key length alone is not treated as secret.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type RequestContext =
  /// A verified device session. Tenant comes from the provider subject, never
  /// from anything the client sent.
  | { tenant: string; operator: false }
  /// Only protected admin connection provisioning constructs this context.
  | { tenant: null; operator: true };

/// Tenant routes accept only revocable device sessions. The operator key is
/// explicitly refused here, so it cannot bypass tenant or company checks.
async function contextOf(request: Request, env: Env): Promise<RequestContext | null> {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length);
  const expected = env.CLOUD_API_KEY;
  if (expected && timingSafeEqual(token, expected)) return null;
  const stub = env.AUTH.get(env.AUTH.idFromName("auth"));
  const verify = await stub.fetch(
    new Request("https://auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
  if (!verify.ok) return null;
  const result = (await verify.json()) as { ok?: boolean; tenant?: string };
  if (!result.ok || !result.tenant) return null;
  return { tenant: result.tenant, operator: false };
}

function tenantHeaders(context: RequestContext, headers: Headers): void {
  // Public callers carry the tenant verified by AUTH.
  headers.set("x-tenant", context.tenant ?? "");
}

const ADMIN_METHODS = new Set([
  "GET /v1/admin/flags", "PUT /v1/admin/flags", "POST /v1/admin/prune",
  "GET /v1/admin/entitlements", "PUT /v1/admin/entitlements", "POST /v1/admin/connections",
  // Manut AI pilot operator console (docs/pilot-api.md). Ids travel in the
  // query string or the body, never the path, so each entry is exact.
  "POST /v1/admin/pilot/shops", "GET /v1/admin/pilot/shops", "POST /v1/admin/pilot/line-connections",
  "GET /v1/admin/pilot/messages", "POST /v1/admin/pilot/replies", "GET /v1/admin/pilot/actions",
  "POST /v1/admin/pilot/payments", "GET /v1/admin/pilot/payments",
  "GET /v1/admin/pilot/export", "POST /v1/admin/pilot/deletions",
  // The Phase 1 gate: the shop's own subscription payments, and the measurement.
  "POST /v1/admin/pilot/subscription-payments", "GET /v1/admin/pilot/subscription-payments",
  "GET /v1/admin/pilot/gate",
  // An operator adds a shop its owner made to the gate's cohort, or leaves it out again (pilot.ts). The tenant is in the body.
  "POST /v1/admin/pilot/gate/cohort",
  // The model gateway (model-gateway.ts): read a shop's month of model spend,
  // and set or clear its cap override. The tenant travels in the query or body.
  "GET /v1/admin/model/usage", "PUT /v1/admin/model/cap",
  // The shop's audit log (audit-log.ts), a page at a time. The tenant and the cursor travel in the query.
  "GET /v1/admin/audit",
  // What the team knows about the shop (memory.ts): read it, and the owner's say over each fact as an operator relays
  // it. A worker's proposal is a function, not a route. The tenant travels in the query or the body.
  "GET /v1/admin/memory", "POST /v1/admin/memory/remember", "POST /v1/admin/memory/confirm",
  "POST /v1/admin/memory/correct", "POST /v1/admin/memory/forget",
  // Nam, Pim and Ton (workers.ts): start one member's job for a shop, and read a shop's jobs back, newest first, a page
  // at a time. Every result is a draft; the runner calls the model through the gateway, never a route. The tenant travels
  // in the body (run) or the query (drafts).
  "POST /v1/admin/workers/run", "GET /v1/admin/workers/drafts",
  // The people around a shop (people.ts), on the owner's word: read them, invite a helper (a link to copy; nothing is
  // sent), revoke an invite, remove a helper, and set or clear cover. The tenant travels in the query or the body.
  "GET /v1/admin/people", "POST /v1/admin/people/invites", "POST /v1/admin/people/invites/revoke",
  "POST /v1/admin/people/remove", "POST /v1/admin/people/away", "POST /v1/admin/people/away/clear",
  // Several shops (shops.ts): link the account a code names to a shop as its owner, and unlink it. The tenant and the
  // code travel in the body.
  "POST /v1/admin/shops/owner", "POST /v1/admin/shops/owner/unlink",
  // The vault's site sign-ins and the outposts that type them (browser-control.ts): list sign-ins without any secret,
  // add one, replace a password, remove one, seal the shop's vault again after a key rotation (vault-reseal.ts);
  // register an outpost, list them. The tenant and the ids travel in the query or the body.
  "GET /v1/admin/vault/sign-ins", "POST /v1/admin/vault/sign-ins", "POST /v1/admin/vault/sign-ins/password",
  "POST /v1/admin/vault/sign-ins/remove", "POST /v1/admin/vault/reseal", "GET /v1/admin/outposts",
  "POST /v1/admin/outposts",
  // Remove an outpost, refusing what waits for it, or replace its credential, the new one shown once. The tenant and the
  // outpost's id travel in the body.
  "POST /v1/admin/outposts/remove", "POST /v1/admin/outposts/credential",
  // The team's routines (routines.ts): list a shop's with the team, make one, pause, resume or remove one, and pause or
  // resume the whole team; the shop templates a new shop can start from, and a shop's first-week questions with the
  // owner's answer relayed. The tenant and the ids travel in the query or the body.
  "GET /v1/admin/routines", "POST /v1/admin/routines", "POST /v1/admin/routines/pause", "POST /v1/admin/routines/resume",
  "POST /v1/admin/routines/remove", "POST /v1/admin/team/pause", "POST /v1/admin/team/resume",
  "GET /v1/admin/templates", "GET /v1/admin/questions", "POST /v1/admin/questions/answer",
]);

/// Only platform-authenticated Access context is trusted, never a JWT header
/// supplied by the caller. Both independent credentials are required.
function adminGate(request: Request, pathname: string, env: Env, ctx: ExecutionContext): Response | null {
  if (!pathname.startsWith("/v1/admin/")) return null;
  const audience = env.ADMIN_ACCESS_AUD;
  if (!audience?.trim() || ctx.access?.aud !== audience) return json({ error: "forbidden" }, 403);
  const header = request.headers.get("authorization") ?? "";
  if (!env.CLOUD_API_KEY || !header.startsWith("Bearer ") ||
      !timingSafeEqual(header.slice("Bearer ".length), env.CLOUD_API_KEY)) return json({ error: "forbidden" }, 403);
  if (!ADMIN_METHODS.has(`${request.method} ${pathname}`)) return json({ error: "not_found" }, 404);
  return null;
}

function hasClientProvenance(body: TaskRecordJSON): boolean {
  return Array.isArray(body.criteria) && body.criteria.some((criterion) => criterion &&
    (criterion.by === "human" || (typeof criterion.by === "string" && criterion.by.startsWith("check:"))));
}

/// Capability flags and kill switches. Dynamic records win over the
/// environment defaults so operations can halt new cloud tasks, routines,
/// or external writes without a redeploy — and disabling denies execution
/// in this trusted code, not just hides a button. Everything defaults off.
export type FeatureFlags = {
  officeCloud: boolean;
  officeRoutines: boolean;
  officeExternalWrites: boolean;
  /// Signed Linear webhooks becoming attention items (D-OFC22-inbound-transport).
  officeInbound: boolean;
  /// Every OFC-21 sharing route (`docs/office-sharing.md`). Off until the
  /// owner opens Release 4 under D-R4-live-gate, so nobody can be scoped,
  /// invited or shown shared work before then.
  officeSharing: boolean;
};

const FLAG_KEYS = ["officeCloud", "officeRoutines", "officeExternalWrites", "officeInbound", "officeSharing"] as const;

async function featureFlags(env: Env): Promise<FeatureFlags> {
  const defaults: FeatureFlags = {
    officeCloud: env.OFFICE_CLOUD === "1",
    officeRoutines: env.OFFICE_ROUTINES === "1",
    officeExternalWrites: env.OFFICE_EXTERNAL_WRITES === "1",
    officeInbound: env.OFFICE_INBOUND === "1",
    officeSharing: env.OFFICE_SHARING === "1",
  };
  try {
    const response = await authCall(env, "/flags");
    if (!response.ok) return defaults;
    const dynamic = (await response.json()) as Partial<Record<keyof FeatureFlags, unknown>>;
    return {
      officeCloud: typeof dynamic.officeCloud === "boolean" ? dynamic.officeCloud : defaults.officeCloud,
      officeRoutines:
        typeof dynamic.officeRoutines === "boolean" ? dynamic.officeRoutines : defaults.officeRoutines,
      officeExternalWrites:
        typeof dynamic.officeExternalWrites === "boolean"
          ? dynamic.officeExternalWrites
          : defaults.officeExternalWrites,
      officeInbound:
        typeof dynamic.officeInbound === "boolean" ? dynamic.officeInbound : defaults.officeInbound,
      officeSharing:
        typeof dynamic.officeSharing === "boolean" ? dynamic.officeSharing : defaults.officeSharing,
    };
  } catch {
    return defaults;
  }
}

async function tenantConsent(env: Env, tenant: string): Promise<boolean> {
  const response = await tenantCall(env, tenant, `/consent?tenant=${encodeURIComponent(tenant)}`);
  if (!response.ok) return false;
  const record = (await response.json()) as { cloudWork?: boolean };
  return record.cloudWork === true;
}

/// Cloud-work consent, re-read at every route that starts or continues work
/// rather than only when a task is created. Withdrawing it stops new and
/// continuing cloud work: queueing, retrying or replanning a task, claiming
/// an attempt and recording its heartbeats and steps, proposing or approving
/// an external action, and dispatching one. It never stops a user from
/// halting work or taking their data, so the cancel and pause commands,
/// rejecting an action, finishing an attempt, reads, event replay, export and
/// deletion stay open.
/// Returns the refusal to send, or null to carry on. Public callers carry
/// their verified tenant; protected provisioning does not invoke this gate.
async function consentGate(env: Env, context: RequestContext): Promise<Response | null> {
  if (!context.tenant) return null;
  if (await tenantConsent(env, context.tenant)) return null;
  return json({ error: "consent_required" }, 403);
}

/// Commands that put a task back in line for work. Cancel and pause stop
/// work and stay open after consent is withdrawn.
const COMMANDS_THAT_START_WORK = new Set(["queue", "retry", "replan"]);

/// The body a route forwards, and what it parsed to. A session request is
/// read once so the route can see whether it starts work, then forwarded as
/// the identical text. Public task callers always carry a verified tenant.
async function forwardedBody(
  request: Request,
  context: RequestContext,
): Promise<{ body: BodyInit | null; value: unknown } | Response> {
  if (!context.tenant) return { body: request.body, value: undefined };
  const peeked = await peekJsonBody(request, MAX_BODY_BYTES);
  if (!peeked.ok) return json({ error: peeked.error }, peeked.status);
  return { body: peeked.raw, value: peeked.value };
}

function fieldOf(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/// Rejects oversized bodies before a Durable Object wakes. Approximate for chunked
/// requests without a length; the object re-checks exact bytes.
function tooLarge(request: Request): boolean {
  const length = Number(request.headers.get("content-length") ?? "0");
  return Number.isFinite(length) && length > MAX_BODY_BYTES;
}

/// Per-company object address. Companies are their own authority boundary:
/// `c:${companyId}` never collides with the per-tenant `t:${tenant}`
/// namespace, and an id that was never created holds no record.
export function companyStub(env: Pick<Env, "COMPANY">, companyId: string): DurableObjectStub {
  return env.COMPANY.get(env.COMPANY.idFromName(`c:${companyId}`));
}

/// Guards for company-console writes from session callers: same-origin plus
/// a session-bound CSRF token. Protected admin provisioning never invokes
/// company-console writes. A missing or mismatched token fails closed;
/// pre-CSRF sessions fail here until they refresh.
async function companyWriteGuards(
  env: Pick<Env, "AUTH">,
  request: Request,
  url: URL,
  context: RequestContext,
): Promise<Response | null> {
  if (context.operator) return null;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return json({ error: "origin_forbidden" }, 403);
  if (!origin) {
    const referer = request.headers.get("referer");
    if (referer) {
      let refererOrigin: string;
      try {
        refererOrigin = new URL(referer).origin;
      } catch {
        return json({ error: "origin_forbidden" }, 403);
      }
      if (refererOrigin !== url.origin) return json({ error: "origin_forbidden" }, 403);
    }
  }
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const csrf = request.headers.get("x-csrf") ?? "";
  if (!token || !csrf) return json({ error: "csrf_required" }, 403);
  const check = await authCall(env, "/csrf-check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, csrf }),
  });
  const result = (await check.json().catch(() => null)) as { ok?: boolean } | null;
  if (!check.ok || result?.ok !== true) return json({ error: "csrf_forbidden" }, 403);
  return null;
}

/// Account-level company-creation entitlement. Absent means not entitled.
async function canCreateCompany(env: Pick<Env, "AUTH">, tenant: string): Promise<boolean> {
  const response = await authCall(env, `/entitlement?tenant=${encodeURIComponent(tenant)}`);
  if (!response.ok) return false;
  const record = (await response.json().catch(() => null)) as { canCreateCompany?: boolean } | null;
  return record?.canCreateCompany === true;
}

function adminHeaders(): Headers {
  return new Headers({ "content-type": "application/json", "x-admin": "1" });
}

/// Company headers for object calls: the caller comes from the verified
/// session, never from anything the client sent. The defensive operator
/// header is not honored by company member routes (403 inside the object);
/// public ingress never constructs an operator context.
function companyHeaders(context: RequestContext): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (context.operator) headers.set("x-operator", "1");
  else headers.set("x-tenant", context.tenant);
  return headers;
}

type CompanyAuthority =
  | {
      ok: true;
      company: { id: string; name: string; policyVersion: number };
      membership: { role: string; status: string };
      grants: string[];
      grantRevision: number;
      allowedConnections?: string[];
    }
  | { ok: false; status: number; body: unknown };

/// Resolves the caller's standing in a company: membership, explicit grants,
/// and the current grant revision. Non-members receive the authority's own
/// refusal, which carries no company content.
async function companyAuthority(
  env: Pick<Env, "COMPANY">,
  companyId: string,
  context: RequestContext,
): Promise<CompanyAuthority> {
  const headers = new Headers();
  if (context.operator) headers.set("x-operator", "1");
  else headers.set("x-tenant", context.tenant ?? "");
  const response = await companyStub(env, companyId).fetch(
    new Request("https://company/get", { headers }),
  );
  const body = (await response.json().catch(() => null)) as {
    company?: { id: string; name: string; policyVersion: number };
    membership?: { role: string; status: string };
    grants?: string[];
    grantRevision?: number;
    allowedConnections?: string[];
  } | null;
  if (!response.ok) return { ok: false, status: response.status, body };
  if (
    !body?.company ||
    !body?.membership ||
    !Array.isArray(body?.grants) ||
    typeof body?.grantRevision !== "number" ||
    (body?.allowedConnections !== undefined && !Array.isArray(body?.allowedConnections))
  ) {
    return { ok: false, status: 500, body: { error: "authority_unavailable" } };
  }
  return {
    ok: true,
    company: body.company,
    membership: body.membership,
    grants: body.grants,
    grantRevision: body.grantRevision,
    ...(body.allowedConnections === undefined ? {} : { allowedConnections: body.allowedConnections }),
  };
}

/// Verifies a `?company=` read hint: the caller must be an active member of
/// the named company. Returns the company id to assert in `x-company-member`
/// (letting fellow members read each other's company tasks), "" when no hint
/// was given, or the refusal to send. The object still matches the assertion
/// against the record's own company, so a hint for the wrong company opens
/// nothing.
async function companyReadAssertion(
  env: Pick<Env, "COMPANY">,
  context: RequestContext,
  url: URL,
): Promise<string | Response> {
  const hint = url.searchParams.get("company") ?? "";
  if (!hint) return "";
  if (context.operator) return hint;
  if (!isValidCompanyId(hint) || hint === "mine") return json({ error: "invalid_company_id" }, 400);
  const authority = await companyAuthority(env, hint, context);
  if (!authority.ok) return json(authority.body, authority.status);
  return hint;
}

/// Reads a task document as the caller for company checks. Returns null when
/// the task cannot be read; callers fall through to the authoritative object
/// response in that case instead of inventing their own refusal. A verified
/// company assertion opens reads on fellow members' company tasks.
async function readTaskDoc(
  env: Pick<Env, "TASK">,
  context: RequestContext,
  taskId: string,
  companyMember?: string,
): Promise<{ companyId?: string } | null> {
  const headers = new Headers();
  tenantHeaders(context, headers);
  if (companyMember) headers.set("x-company-member", companyMember);
  const response = await env.TASK.get(env.TASK.idFromName(taskId)).fetch(
    new Request("https://task/", { headers }),
  );
  if (!response.ok) return null;
  const doc = (await response.json().catch(() => null)) as { companyId?: unknown } | null;
  if (!doc) return null;
  return typeof doc.companyId === "string" ? { companyId: doc.companyId } : {};
}

/// Membership opens reads, while task mutations require an explicit write
/// grant. Read the authoritative scope even without a hint so a creator
/// cannot bypass a revoked company grant by falling back to tenant ownership.
/// These assertions are constructed here; client-supplied headers never pass
/// through to the task object.
async function taskWriteAssertions(
  env: Pick<Env, "COMPANY" | "TASK">,
  context: RequestContext,
  url: URL,
  taskId: string,
): Promise<{ member: string; writer: string } | Response> {
  if (context.operator) return { member: "", writer: "" };
  const member = await companyReadAssertion(env, context, url);
  if (member instanceof Response) return member;
  const doc = await readTaskDoc(env, context, taskId, member || undefined);
  if (!doc?.companyId) return { member, writer: "" };
  const authority = await companyAuthority(env, doc.companyId, context);
  if (!authority.ok) return json(authority.body, authority.status);
  if (!authority.grants.includes(GRANTS.TASKS_CREATE) && !authority.grants.includes(GRANTS.APPROVALS_DECIDE)) {
    return json({ error: "grant_required", grants: [GRANTS.TASKS_CREATE, GRANTS.APPROVALS_DECIDE] }, 403);
  }
  return { member: doc.companyId, writer: doc.companyId };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // One origin (docs/pilot-api.md): this Worker is the front door, and every path outside the API goes to the
    // pages Worker. This Worker keeps no static assets of its own: Cloudflare runs a Worker with assets behind a
    // router that does not pass ctx.access, and the admin gate below needs it (pages.ts).
    if (!isApiPath(url.pathname)) return env.WEB ? env.WEB.fetch(request) : json({ error: "not_found" }, 404);
    const rateDenial = await ingressRateGate(request, url.pathname, env);
    if (rateDenial) return rateDenial;
    const adminDenial = adminGate(request, url.pathname, env, ctx);
    if (adminDenial) return adminDenial;

    // Health carries no task data and stays public.
    if (request.method === "GET" && url.pathname === "/v1/health") {
      return json({
        ok: true,
        service: "manut-api",
        families: [
          "tasks",
          "work",
          "build",
          "automations",
          "research",
          "docs",
          "sheets",
          "slides",
          "websites",
          "design",
          "memory",
          "skills",
          "dashboards",
          "schedules",
          "credits",
        ],
      });
    }

    // The relay answers for everything under /relay/ (docs/relay-protocol-v1.md);
    // its upgrade gates already ran in ingressRateGate.
    const relay = await relayRoute(request, url, env);
    if (relay) return relay;

    // Identity endpoints mint sessions, so they stand outside task auth.
    // Bound actual bytes before an object call, even when the declared length lies.
    if (request.method === "POST" && (url.pathname === "/v1/auth/exchange" || url.pathname === "/v1/auth/refresh" ||
        url.pathname === "/v1/auth/email/code")) {
      const length = request.headers.get("content-length");
      if (length === null) return json({ error: "length_required" }, 411);
      if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) return json({ error: "invalid_request" }, 400);
      if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
      const parsed = await readJsonBody<Record<string, unknown>>(request, MAX_BODY_BYTES);
      if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
      if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        return json({ error: "invalid_request" }, 400);
      }
      if (url.pathname === "/v1/auth/exchange" && parsed.value.provider === "apple" &&
          typeof parsed.value.identityToken === "string" &&
          !hasAppleTokenShape(parsed.value.identityToken, Boolean(env.TEST_JWKS_JSON))) {
        return json({ error: "invalid_identity" }, 401);
      }
      // Signing in by email (email-code.ts): a body that is not exactly the route's, and any request while email sign-in
      // is off, is answered here, so neither wakes AUTH. The object checks both again before it keeps or sends anything.
      const codeRoute = url.pathname === "/v1/auth/email/code";
      if (codeRoute || (url.pathname === "/v1/auth/exchange" && parsed.value.provider === "email")) {
        if (!(codeRoute ? codeRequestAddress(parsed.value) : emailExchange(parsed.value))) {
          return json({ error: "invalid_request" }, 400);
        }
        if (!emailSignIn(env)) return json({ error: "email_not_configured" }, 400);
      }
      const target = codeRoute ? "email-code" : url.pathname.endsWith("exchange") ? "exchange" : "refresh";
      const stub = env.AUTH.get(env.AUTH.idFromName("auth"));
      return stub.fetch(
        new Request(`https://auth/${target}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: parsed.raw,
        }),
      );
    }
    if (request.method === "DELETE" && url.pathname === "/v1/auth/session") {
      const authorization = request.headers.get("authorization");
      if (!authorization) return json({ error: "unauthorized" }, 401);
      const stub = env.AUTH.get(env.AUTH.idFromName("auth"));
      return stub.fetch(
        new Request("https://auth/session", {
          method: "DELETE",
          headers: { authorization },
        }),
      );
    }

    // Inbound Linear webhooks (inbound.ts). Public, because Linear holds no
    // session: the signature is the credential. While officeInbound is off
    // the request falls through to the final not_found, byte for byte what
    // a path that does not exist answers, so a scanner cannot tell the route
    // is there, and nothing in the request is read.
    if (url.pathname === "/v1/inbound/linear" && request.method === "POST") {
      if ((await featureFlags(env)).officeInbound) {
        return receiveLinearWebhook(request, env, Date.now());
      }
    }

    // Manut AI pilot (pilot.ts): the LINE webhook, the owner's signed
    // approval link, and the operator console. Its ingress limits and the
    // admin gate already ran above; flags are read only by routes that need
    // them.
    const pilot = await pilotRoute(request, url, env, ctx, () => featureFlags(env));
    if (pilot) return pilot;

    // The model gateway's operator routes (model-gateway.ts). The admin gate
    // above already required both credentials and an exact method.
    const model = await modelAdminRoute(request, url, env, ctx);
    if (model) return model;

    // The shop's audit log (audit-log.ts), read-only. The admin gate above already required both credentials and
    // the exact method.
    const audit = await auditAdminRoute(request, url, env);
    if (audit) return audit;

    // What the team knows about the shop (memory.ts): the operator's routes, under the admin gate above, and the owner's
    // own from the shop's session.
    const memory = await memoryRoute(request, url, env, ctx);
    if (memory) return memory;

    // Nam, Pim and Ton (workers.ts). The admin gate above already required both credentials and the exact method; the
    // runner reads the kill switches and the owner's consent before it creates anything.
    const workers = await workersAdminRoute(request, url, env, ctx, () => featureFlags(env));
    if (workers) return workers;

    // The people around a shop (people.ts): the operator's routes, under the admin gate above, the owner's own from the
    // shop's session, and a helper's own joining and opening the shop on another device, which need a signed-in session.
    const people = await peopleRoute(request, url, env, ctx);
    if (people) return people;
    // Several shops (shops.ts): a signed-in person's shops, a shop session for one of them and the owner's link code,
    // which need the person's own session; a shop session's sign-out, and its consent and export on the lifted routes'
    // paths below, which answer every other credential; and the operator's link and unlink of an owner's account, under
    // the gate above.
    const shops = await shopsRoute(request, url, env, ctx);
    if (shops) return shops;
    // The vault's site sign-ins and the outposts (browser-control.ts). The admin gate above already required both
    // credentials and the exact method for the operator's routes; an outpost's own routes need its credential.
    // Sealing one shop's vault again under the current key after a rotation (vault-reseal.ts), under the gate above.
    const resealed = await vaultResealRoute(request, url, env, ctx);
    if (resealed) return resealed;
    const vault = await vaultAdminRoute(request, url, env, ctx);
    if (vault) return vault;
    const outpost = await outpostRoute(request, url, env, () => featureFlags(env));
    if (outpost) return outpost;
    // This Mac registering itself as an outpost through the desktop, with the owner's session (browser-control.ts).
    const ownerOutpost = await ownerOutpostRoute(request, url, env);
    if (ownerOutpost) return ownerOutpost;
    // The owner's Connections: the shop's sign-ins and outposts, a new password, and renaming or removing an outpost, with
    // the owner's session (browser-control.ts).
    const ownerVault = await ownerVaultRoute(request, url, env);
    if (ownerVault) return ownerVault;
    // Google Sheets for Ton's books (google-connect.ts): the owner's own routes from their session, and Google's callback,
    // whose ingress limit ran above. Off, every one answers google_not_configured.
    const google = await googleRoute(request, url, env, { flags: () => featureFlags(env) });
    if (google) return google;

    // The team's routines, Pause everyone, shop templates and their first-week questions (routines.ts): the
    // operator's routes, under the admin gate above, and the shop's own session's routes. Making or changing a routine
    // runs nothing; each run reads the switches and the owner's consent again.
    const routines = await routinesRoute(request, url, env, ctx);
    if (routines) return routines;

    // Capability flags and kill switches. Operator only: sessions never
    // reach this, so a compromised device cannot re-enable cloud work.
    if (url.pathname === "/v1/admin/flags") {
      if (request.method === "GET") {
        return json(await featureFlags(env));
      }
      if (request.method === "PUT") {
        if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        const response = await authCall(env, "/flags", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return json(await response.json(), response.status);
      }
    }

    // Retention sweep, on call. Operator only: sessions never reach this,
    // so no device can age another tenant's records out. The scheduled
    // trigger arrives with durable routines; until then this route is how
    // the windows in retention.ts are enforced. The tenant comes from the
    // operator's body and is validated like any other tenant id.
    if (url.pathname === "/v1/admin/prune" && request.method === "POST") {
      if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      const tenant = typeof body.tenant === "string" ? body.tenant : "";
      if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
      return tenantPrune(env, tenant, Date.now());
    }

    // Connector credentials. Sessions bind to their own tenant; protected
    // admin provisioning names one explicitly. Secrets never come back
    // out of these routes: listing shows metadata, reading plaintext stays
    // inside broker code.
    if (url.pathname === "/v1/connections" || url.pathname === "/v1/admin/connections") {
      const context: RequestContext | null = url.pathname === "/v1/admin/connections" ?
        { tenant: null, operator: true } : await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      if (request.method === "POST") {
        if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        const tenant = context.tenant ?? (typeof body.tenantId === "string" ? body.tenantId : "");
        if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
        body.tenant = tenant;
        const headers = new Headers({ "content-type": "application/json" });
        headers.set("x-tenant", tenant);
        const stub = credStub(env, tenant);
        const stored = await stub.fetch(
          new Request("https://cred/connections", { method: "POST", headers, body: JSON.stringify(body) }),
        );
        // A Linear webhook names only its workspace, so the inbound route
        // needs an index from workspace to tenant vault. Only the operator's
        // provisioning writes it (D-OFC22-connect-method): the account id is
        // whatever the caller declares and nothing checks it with Linear yet,
        // so a session naming someone else's workspace must not start
        // receiving that workspace's events. It is written flag on or off, so
        // turning officeInbound on later finds connections provisioned
        // before. Best effort like the membership index: the vault stays
        // authoritative, and a missing row only means deliveries for this
        // connection store nothing.
        if (context.operator && stored.ok && body.provider === "linear" && typeof body.accountId === "string") {
          const created = (await stored.clone().json().catch(() => null)) as { id?: unknown } | null;
          if (typeof created?.id === "string") {
            await authCall(env, "/inbound-routes", {
              method: "POST",
              headers: adminHeaders(),
              body: JSON.stringify({
                provider: "linear",
                accountId: body.accountId,
                tenant,
                connectionId: created.id,
              }),
            }).catch(() => undefined);
          }
        }
        return stored;
      }
      if (request.method === "GET") {
        const tenant =
          context.tenant ?? url.searchParams.get("tenant") ?? "";
        if (!tenant) return json({ error: "tenant_required" }, 400);
        const headers = new Headers();
        headers.set("x-tenant", tenant);
        const stub = credStub(env, tenant);
        return stub.fetch(
          new Request(`https://cred/connections?tenant=${encodeURIComponent(tenant)}`, { headers }),
        );
      }
    }
    const connectionMatch = url.pathname.match(/^\/v1\/connections\/([^/]+)$/);
    if (connectionMatch && request.method === "DELETE") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      const connectionId = connectionMatch[1];
      if (!connectionId) return json({ error: "invalid_request" }, 400);
      // Tenant comes from the session, never the path: the store re-checks it.
      // The operator key is refused on this public route.
      const tenant = context.tenant ?? url.searchParams.get("tenant") ?? "";
      const headers = new Headers();
      headers.set("x-tenant", tenant);
      const stub = credStub(env, tenant);
      return stub.fetch(new Request(`https://cred/connections/${encodeURIComponent(connectionId)}`, {
        method: "DELETE",
        headers,
      }));
    }
    const linearIssuesMatch = url.pathname.match(/^\/v1\/connections\/([^/]+)\/linear\/issues$/);
    if (linearIssuesMatch && request.method === "GET") {
      // First OFC-22 integration read: Linear issues inside granted projects.
      // Reads stay open where writes need consent (consentGate leaves reads
      // alone by contract), but everything scoping the read is server-side:
      // the account and the granted projects come from the stored grant, and
      // the caller names only a subset plus a window and a page size. Reads
      // store nothing. A step counts as a real sandbox call only on the
      // owner's recorded run; every automated check here is a simulation.
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      const tenant = context.tenant ?? url.searchParams.get("tenant") ?? "";
      if (!tenant) return json({ error: "tenant_required" }, 400);
      const connectionId = linearIssuesMatch[1] ?? "";
      if (!connectionId) return json({ error: "invalid_request" }, 400);
      const headers = new Headers();
      headers.set("x-tenant", tenant);
      const metaResp = await credStub(env, tenant).fetch(
        new Request(`https://cred/connections/${encodeURIComponent(connectionId)}`, { headers }),
      );
      if (!metaResp.ok) return json(await metaResp.json().catch(() => ({ error: "connection_unavailable" })), metaResp.status);
      const meta = (await metaResp.json()) as {
        provider?: unknown;
        accountId?: unknown;
        resourceIds?: unknown;
        allowsActions?: unknown;
      };
      if (meta.provider !== "linear") return json({ error: "wrong_provider" }, 400);
      if (typeof meta.accountId !== "string" || !meta.accountId) {
        return json({ error: "connection_unavailable" }, 500);
      }
      const grantedIds = Array.isArray(meta.resourceIds)
        ? meta.resourceIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256)
        : [];
      const updatedSince = url.searchParams.get("updatedSince") ?? "";
      if (!Number.isFinite(Date.parse(updatedSince))) return json({ error: "invalid_request" }, 400);
      const first = Number(url.searchParams.get("first") ?? "");
      if (!Number.isInteger(first) || first < 1 || first > 25) return json({ error: "invalid_request" }, 400);
      const wanted = (url.searchParams.get("projectIds") ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0 && id.length <= 256)
        .slice(0, 50);
      // No projectIds means no projects, never everything: an empty grant
      // allows nothing, and an omitted list selects nothing.
      let secret: string;
      try {
        secret = await readConnectionSecret(env, connectionId, tenant);
      } catch {
        return json({ error: "vault_not_configured" }, 500);
      }
      try {
        const result = await readLinear(
          fetch,
          { connectionId, accountId: meta.accountId, resourceIds: grantedIds, allowsActions: false },
          secret,
          { accountId: meta.accountId, projectIds: wanted, updatedSince, first },
        );
        return json({ connectionId, issues: result.issues });
      } catch (error) {
        if (error instanceof ConnectorError) {
          if (error.code === "forbidden") return json({ error: error.message }, 403);
          if (error.code === "rate_limited") {
            const init: ResponseInit =
              error.retryAfter !== undefined
                ? { status: 429, headers: { "retry-after": String(error.retryAfter) } }
                : { status: 429 };
            return Response.json({ error: error.message }, init);
          }
          return json({ error: error.message }, 502);
        }
        throw error;
      }
    }

    // Attention items from inbound events, newest first, for the caller's
    // own verified tenant. Gated like
    // the webhook: with officeInbound off there is nothing to read.
    if (url.pathname === "/v1/inbound/attention" && request.method === "GET") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      if (!(await featureFlags(env)).officeInbound) {
        return json({ error: "feature_disabled", feature: "officeInbound" }, 403);
      }
      const tenant = context.tenant ?? url.searchParams.get("tenant") ?? "";
      if (!tenant) return json({ error: "tenant_required" }, 400);
      const response = await tenantCall(env, tenant, `/attention?tenant=${encodeURIComponent(tenant)}`);
      return json(await response.json(), response.status);
    }

    // Explicit cloud-work consent, per tenant. Sessions must opt in before
    // their tasks run anywhere off the Mac. Operator credentials cannot
    // bypass this public session boundary. A shop session never gets here:
    // shops.ts answers it above, for its shop's owner only.
    if (url.pathname === "/v1/consent/cloud") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      if (request.method === "GET") {
        const tenant = context.tenant ?? url.searchParams.get("tenant") ?? "";
        if (!tenant) return json({ error: "tenant_required" }, 400);
        const response = await tenantCall(env, tenant, `/consent?tenant=${encodeURIComponent(tenant)}`);
        return json(await response.json(), response.status);
      }
      if (request.method === "PUT") {
        if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
        let body: { enabled?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        if (typeof body.enabled !== "boolean") return json({ error: "invalid_request" }, 400);
        const tenant = context.tenant ?? url.searchParams.get("tenant") ?? "";
        if (!tenant) return json({ error: "tenant_required" }, 400);
        const response = await tenantCall(env, tenant, "/consent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenant, cloudWork: body.enabled }),
        });
        return json(await response.json(), response.status);
      }
    }

    // Tenant export and deletion (tenant-data.ts). Export assembles tasks,
    // connection metadata, schedules, consent, and attention items; deletion
    // wipes tasks, connections, schedules, sessions, and inbound routes
    // through their owning objects, then consent, the task index, and
    // attention items, and leaves a tombstone. Either answers 500 naming the
    // parts that failed rather than reporting a partial result as complete.
    // A shop session's export is answered above (shops.ts); no shop session
    // deletes here, which stays with the owner's confirmation link.
    if (url.pathname === "/v1/tenant/export" && request.method === "GET") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      const tenant = context.tenant ?? url.searchParams.get("tenant") ?? "";
      if (!tenant) return json({ error: "tenant_required" }, 400);
      return tenantExport(env, tenant);
    }
    if (url.pathname === "/v1/tenant/data" && request.method === "DELETE") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      const tenant = context.tenant ?? url.searchParams.get("tenant") ?? "";
      if (!tenant) return json({ error: "tenant_required" }, 400);
      // Snapshot what the wipe will remove from company indexes before it
      // runs: the tenant task ids and the tenant's companies. Pruning
      // happens after a successful wipe; failures are reported additively
      // (the data is verifiably gone either way, and pruned rows would only
      // have rendered as unavailable stubs).
      const snapshotIndex = await tenantCall(env, tenant, `/index?tenant=${encodeURIComponent(tenant)}`);
      const snapshotIds = snapshotIndex.ok
        ? (((await snapshotIndex.json().catch(() => null)) as { taskIds?: string[] } | null)?.taskIds ?? [])
        : [];
      const snapshotMembers = await authCall(env, `/memberships?tenant=${encodeURIComponent(tenant)}`);
      const snapshotCompanies = snapshotMembers.ok
        ? (
            ((await snapshotMembers.json().catch(() => null)) as { memberships?: { companyId?: string }[] } | null)
              ?.memberships ?? []
          )
            .map((entry) => entry.companyId)
            .filter((id): id is string => typeof id === "string")
        : [];
      const result = await tenantDelete(env, tenant);
      const wiped = (await result.json().catch(() => null)) as Record<string, unknown> | null;
      if (!result.ok || !wiped) return json(wiped, result.status);
      const companyIndexPruned: string[] = [];
      const companyIndexFailed: string[] = [];
      await Promise.all(
        snapshotCompanies.map(async (companyId) => {
          const pruned = await companyStub(env, companyId)
            .fetch(
              new Request("https://company/tasks-prune", {
                method: "POST",
                headers: { "content-type": "application/json", "x-authority": "1" },
                body: JSON.stringify({ taskIds: snapshotIds }),
              }),
            )
            .catch(() => null);
          if (pruned && pruned.ok) companyIndexPruned.push(companyId);
          else companyIndexFailed.push(companyId);
        }),
      );
      return json({ ...wiped, companyIndexPruned, companyIndexFailed });
    }

    // Durable routines. Each tenant's schedules live in its own object with
    // its own alarm, so one tenant's sweep never touches another's, and
    // occurrence claims stay singular per schedule.
    if (url.pathname === "/v1/schedules") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      if (request.method === "POST") {
        // Creating a schedule arms future cloud work, so both switches guard
        // it the way they guard dispatch: a disabled routine or cloud switch
        // means no new schedules. Reads stay open.
        const flags = await featureFlags(env);
        if (!flags.officeCloud) {
          return json({ error: "feature_disabled", feature: "officeCloud" }, 403);
        }
        if (!flags.officeRoutines) {
          return json({ error: "feature_disabled", feature: "officeRoutines" }, 403);
        }
        if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        const tenant = context.tenant ?? (typeof body.tenantId === "string" ? body.tenantId : "");
        if (!tenant) return json({ error: "tenant_required" }, 400);
        if (context.tenant && !(await tenantConsent(env, tenant))) {
          return json({ error: "consent_required" }, 403);
        }
        const headers = new Headers({ "content-type": "application/json" });
        headers.set("x-tenant", tenant);
        const stub = scheduleStub(env, tenant);
        return stub.fetch(
          new Request("https://schedules/schedules", { method: "POST", headers, body: JSON.stringify(body) }),
        );
      }
      if (request.method === "GET") {
        const tenant = context.tenant ?? url.searchParams.get("tenant") ?? "";
        if (!tenant) return json({ error: "tenant_required" }, 400);
        const headers = new Headers();
        headers.set("x-tenant", tenant);
        const stub = scheduleStub(env, tenant);
        return stub.fetch(new Request("https://schedules/schedules", { headers }));
      }
    }
    const scheduleMatch = url.pathname.match(/^\/v1\/schedules\/([^/]+)$/);
    if (scheduleMatch) {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      const tenant = context.tenant ?? url.searchParams.get("tenant") ?? "";
      const headers = new Headers();
      headers.set("x-tenant", context.tenant ?? "");
      const stub = scheduleStub(env, tenant);
      if (request.method === "GET") {
        return stub.fetch(new Request(`https://schedules/schedules/${scheduleMatch[1]}`, { headers }));
      }
      if (request.method === "DELETE") {
        return stub.fetch(
          new Request(`https://schedules/schedules/${scheduleMatch[1]}`, { method: "DELETE", headers }),
        );
      }
    }

    // Approvals for a session (approvals.ts): the shop's approval-core records
    // as approval-core's wire JSON, read like a task with neither a switch nor
    // consent; a decision on one, with the switches and consent of the owner's
    // link; and a helper passing one on. The shop's own session is its owner and
    // a helper session a helper (people.ts); the role never comes from a body.
    const approvals = await approvalsRoute(request, url, env, () => featureFlags(env));
    if (approvals) return approvals;

    // Exact-action approvals. Proposals and decisions pass through to the
    // task's ledger; dispatch runs the broker, which re-verifies everything
    // before touching a provider.
    const actionPropose = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/actions$/);
    if (actionPropose && request.method === "POST") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      const flags = await featureFlags(env);
      if (!flags.officeCloud) {
        return json({ error: "feature_disabled", feature: "officeCloud" }, 403);
      }
      if (!flags.officeExternalWrites) {
        return json({ error: "feature_disabled", feature: "officeExternalWrites" }, 403);
      }
      if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
      const actionTaskId = actionPropose[1];
      if (!actionTaskId) return json({ error: "invalid_request" }, 400);
      const refused = await consentGate(env, context);
      if (refused) return refused;
      const headers = new Headers({ "content-type": "application/json" });
      tenantHeaders(context, headers);
      // Company tasks bind proposals to the current grant revision: the
      // revision is stamped here from the authority, never trusted from the
      // proposer, and proposing needs the tasks.create grant. The hint opens
      // the doc read for fellow members; without it only the creator's own
      // tasks resolve here, and everyone else falls through to the object's
      // tenant check.
      const proposeAssertion = await companyReadAssertion(env, context, url);
      if (proposeAssertion instanceof Response) return proposeAssertion;
      const proposeDoc = await readTaskDoc(
        env,
        context,
        actionTaskId,
        proposeAssertion || undefined,
      );
      let proposeBody: BodyInit | null = request.body;
      if (proposeDoc?.companyId && !context.operator) {
        const authority = await companyAuthority(env, proposeDoc.companyId, context);
        if (!authority.ok) return json(authority.body, authority.status);
        if (!authority.grants.includes(GRANTS.TASKS_CREATE)) {
          return json({ error: "grant_required", grant: GRANTS.TASKS_CREATE }, 403);
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = (await request.json()) as Record<string, unknown>;
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        parsed.grantRevision = authority.grantRevision;
        if (
          authority.allowedConnections !== undefined &&
          (typeof parsed.connectionId !== "string" || !authority.allowedConnections.includes(parsed.connectionId))
        ) {
          return json({ error: "connection_not_allowed" }, 403);
        }
        proposeBody = JSON.stringify(parsed);
        // Membership proven above: the proposal writes against this
        // company's task, and the object still matches the assertion
        // against the record's own company.
        headers.set("x-company-member", proposeDoc.companyId);
      }
      const stub = env.TASK.get(env.TASK.idFromName(actionTaskId));
      return stub.fetch(
        new Request("https://task/actions", { method: "POST", headers, body: proposeBody }),
      );
    }
    const actionItem = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/actions\/([^/]+)(\/(decision|dispatch))?$/);
    if (actionItem) {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      const [, taskId, actionId, , leaf] = actionItem;
      if (!taskId || !actionId) return json({ error: "invalid_request" }, 400);
      // Reads name their company scope up front. Writes resolve the scope
      // from the authoritative task record below instead, so one membership
      // lookup serves each request rather than two.
      const isActionRead = !leaf && request.method === "GET";
      const actionAssertion = isActionRead ? await companyReadAssertion(env, context, url) : "";
      if (actionAssertion instanceof Response) return actionAssertion;
      const headers = new Headers({ "content-type": "application/json" });
      tenantHeaders(context, headers);
      if (actionAssertion) headers.set("x-company-member", actionAssertion);
      const stub = env.TASK.get(env.TASK.idFromName(taskId));
      if (isActionRead) {
        return stub.fetch(new Request(`https://task/actions/${actionId}`, { headers }));
      }
      if (leaf === "decision" && request.method === "POST") {
        if (!(await featureFlags(env)).officeCloud) {
          return json({ error: "feature_disabled", feature: "officeCloud" }, 403);
        }
        if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
        // Approving lets an external write go ahead, so it needs consent;
        // rejecting stops one and stays open.
        const forwarded = await forwardedBody(request, context);
        if (forwarded instanceof Response) return forwarded;
        if (fieldOf(forwarded.value, "approve") === true) {
          const refused = await consentGate(env, context);
          if (refused) return refused;
        }
        // Company tasks gate decisions on the authority: approving needs the
        // approvals.decide grant, rejecting needs membership. Either way the
        // caller must belong to the company — the authority's own refusal
        // answers non-members.
        if (!context.operator) {
          const decisionAssertion = await companyReadAssertion(env, context, url);
          if (decisionAssertion instanceof Response) return decisionAssertion;
          const decisionDoc = await readTaskDoc(env, context, taskId, decisionAssertion || undefined);
          if (decisionDoc?.companyId) {
            const authority = await companyAuthority(env, decisionDoc.companyId, context);
            if (!authority.ok) return json(authority.body, authority.status);
            if (fieldOf(forwarded.value, "approve") === true) {
              if (!authority.grants.includes(GRANTS.APPROVALS_DECIDE)) {
                return json({ error: "approval_grant_required", grant: GRANTS.APPROVALS_DECIDE }, 403);
              }
              // Approving binds the connection too: a proposal on a
              // connection the company no longer allows cannot be approved
              // into dispatchability.
              if (authority.allowedConnections !== undefined) {
                const decideHeaders = new Headers();
                tenantHeaders(context, decideHeaders);
                decideHeaders.set("x-company-member", decisionDoc.companyId);
                const decideRead = await stub.fetch(
                  new Request(`https://task/actions/${actionId}`, { headers: decideHeaders }),
                );
                const decideProposal = (await decideRead.json().catch(() => null)) as {
                  connectionId?: unknown;
                } | null;
                if (!decideRead.ok || !decideProposal) {
                  return json(decideProposal ?? { error: "not_found" }, decideRead.status);
                }
                if (
                  typeof decideProposal.connectionId !== "string" ||
                  !authority.allowedConnections.includes(decideProposal.connectionId)
                ) {
                  return json({ error: "connection_not_allowed" }, 403);
                }
              }
            }
            // Membership verified above: fellow members may decide on each
            // other's company tasks, and the object still matches this
            // against the proposal's own company.
            headers.set("x-company-member", decisionDoc.companyId);
          }
        }
        return stub.fetch(
          new Request(`https://task/actions/${actionId}/decision`, {
            method: "POST",
            headers,
            body: forwarded.body,
          }),
        );
      }
      if (leaf === "dispatch" && request.method === "POST") {
        const flags = await featureFlags(env);
        if (!flags.officeCloud) {
          return json({ error: "feature_disabled", feature: "officeCloud" }, 403);
        }
        if (!flags.officeExternalWrites) {
          return json({ error: "feature_disabled", feature: "officeExternalWrites" }, 403);
        }
        if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
        let dispatchBody: { grantRevision?: unknown };
        try {
          dispatchBody = (await request.json()) as typeof dispatchBody;
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        if (!Number.isInteger(dispatchBody.grantRevision)) return json({ error: "invalid_request" }, 400);
        // An approval given before consent was withdrawn does not outlive
        // it: the refusal comes before the begin gate, so the action stays
        // approved and no provider is called.
        const refused = await consentGate(env, context);
        if (refused) return refused;
        // Company tasks rebind the approval to the live authority before the
        // begin gate: the revision must still be current, the approver must
        // still be an entitled member, and a bound target revision must still
        // match. Anything else refuses with no provider call.
        let dispatchCompany = "";
        if (!context.operator) {
          // Membership is proven by the dispatch check below; until then
          // the hint path opens the doc and proposal reads for fellow
          // members. Cross-member dispatch names its company scope.
          const dispatchAuthority = await taskWriteAssertions(env, context, url, taskId);
          if (dispatchAuthority instanceof Response) return dispatchAuthority;
          const dispatchAssertion = dispatchAuthority.member;
          const dispatchDoc = await readTaskDoc(env, context, taskId, dispatchAssertion || undefined);
          if (dispatchDoc?.companyId) {
            const actionHeaders = new Headers();
            tenantHeaders(context, actionHeaders);
            if (dispatchAssertion) actionHeaders.set("x-company-member", dispatchAssertion);
            const actionRead = await stub.fetch(
              new Request(`https://task/actions/${actionId}`, { headers: actionHeaders }),
            );
            const proposal = (await actionRead.json().catch(() => null)) as {
              grantRevision?: unknown;
              approval?: { by?: unknown };
              connectionId?: unknown;
              expectedTargetRevision?: unknown;
              state?: unknown;
            } | null;
            if (!actionRead.ok || !proposal) {
              return json(proposal ?? { error: "not_found" }, actionRead.status);
            }
            // Everyone reaching here is either the creator (tenant match)
            // or a member of this company (verified hint equal to it), so
            // asserting it at the begin gate below is sound. The authority
            // check itself runs only for approved proposals.
            dispatchCompany = dispatchDoc.companyId;
            // Only approved proposals reach the authority check: anything
            // else falls through to the begin gate, which owns the precise
            // refusal (not_approved, already_decided, expired).
            if (proposal.state === "approved") {
              const check = await companyStub(env, dispatchDoc.companyId).fetch(
                new Request("https://company/dispatch-check", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-authority": "1",
                  },
                  body: JSON.stringify({
                    grantRevision: proposal.grantRevision,
                    approverTenant: proposal.approval?.by ?? "",
                    connectionId: proposal.connectionId,
                    ...(proposal.expectedTargetRevision !== undefined
                      ? {
                          expectedTargetRevision: proposal.expectedTargetRevision,
                          currentTargetRevision: (dispatchBody as { currentTargetRevision?: unknown })
                            .currentTargetRevision,
                        }
                      : {}),
                  }),
                }),
              );
              const verdict = (await check.json().catch(() => null)) as unknown;
              if (!check.ok) return json(verdict, check.status);
            }
          }
        }
        // Async receipt: the begin gate runs synchronously, the provider call
        // and settle run after the response in waitUntil, and the client polls
        // the action for its terminal state. A disconnect mid-provider-call
        // no longer strands the action — the settle still lands.
        const begun = await beginDispatchAction(env, taskId, actionId, {
          tenant: context.tenant ?? "",
          grantRevision: dispatchBody.grantRevision as number,
          ...(dispatchCompany ? { companyMember: dispatchCompany } : {}),
        });
        if (!begun.ok) return begun.response;
        ctx.waitUntil(
          finishDispatchAction(env, taskId, actionId, {
            tenant: context.tenant ?? "",
            grantRevision: dispatchBody.grantRevision as number,
            proposal: begun.proposal,
            ...(dispatchCompany ? { companyMember: dispatchCompany } : {}),
          }).catch(() => undefined),
        );
        return json(begun.proposal, 202);
      }
    }

    // Ordered event replay for one task. The cursor rides the query string so
    // replay stays a plain GET; the object owns floors, tips, and resync.
    const eventsMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/events$/);
    if (eventsMatch) {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      const eventsTaskId = eventsMatch[1];
      if (!eventsTaskId) return json({ error: "invalid_request" }, 400);
      const stub = env.TASK.get(env.TASK.idFromName(eventsTaskId));
      const headers = new Headers();
      tenantHeaders(context, headers);
      const eventsAssertion = await companyReadAssertion(env, context, url);
      if (eventsAssertion instanceof Response) return eventsAssertion;
      if (eventsAssertion) headers.set("x-company-member", eventsAssertion);
      return stub.fetch(new Request(`https://task/events${url.search}`, { headers }));
    }

    // Long-poll event wait: holds the request until events past the cursor
    // arrive or the timeout lapses, so consoles can follow work without
    // blind polling. Reconnect with the returned tip as the next cursor;
    // every round re-verifies the session and the company membership, so
    // revocation ends the wait instead of leaking one more event. This is a
    // polling assist with live authorization — not a socket; a push
    // transport stays future work.
    const eventsWaitMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/events\/wait$/);
    if (eventsWaitMatch) {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      const waitTaskId = eventsWaitMatch[1];
      if (!waitTaskId) return json({ error: "invalid_request" }, 400);
      const after = Number(url.searchParams.get("after") ?? "0");
      if (!Number.isInteger(after) || after < 0) return json({ error: "invalid_cursor" }, 400);
      const timeoutRaw = Number(url.searchParams.get("timeoutMs") ?? "5000");
      if (!Number.isFinite(timeoutRaw)) return json({ error: "invalid_request" }, 400);
      const timeoutMs = Math.min(20000, Math.max(100, Math.floor(timeoutRaw)));
      const started = Date.now();
      const deadline = started + timeoutMs;
      const stub = env.TASK.get(env.TASK.idFromName(waitTaskId));
      for (;;) {
        // Live standing every round: an expired session or a revoked
        // membership ends the wait with the same refusal a fresh request
        // would get.
        const live = await contextOf(request, env);
        if (!live) return json({ error: "unauthorized" }, 401);
        const waiting = await companyReadAssertion(env, live, url);
        if (waiting instanceof Response) return waiting;
        const headers = new Headers();
        tenantHeaders(live, headers);
        if (waiting) headers.set("x-company-member", waiting);
        const poll = await stub.fetch(
          new Request(`https://task/events?after=${after}&limit=200`, { headers }),
        );
        const body = (await poll.json().catch(() => null)) as {
          events?: unknown[];
          floor?: number;
          tip?: number;
        } | null;
        if (!poll.ok || !body) return json(body, poll.status);
        if ((body.events ?? []).length > 0 || Date.now() >= deadline) {
          return json({ events: body.events ?? [], floor: body.floor, tip: body.tip, waitedMs: Date.now() - started });
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    // Client lifecycle commands. The only states a client can reach on its
    // own; running, verifying, and completed stay on the trusted path.
    // Commands are retry-safe: the idempotency key is required.
    const commandMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/commands$/);
    if (commandMatch) {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      if (!(await featureFlags(env)).officeCloud) {
        return json({ error: "feature_disabled", feature: "officeCloud" }, 403);
      }
      if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const commandKey = request.headers.get("idempotency-key");
      if (!commandKey) return json({ error: "idempotency_key_required" }, 400);
      const commandTaskId = commandMatch[1];
      if (!commandTaskId) return json({ error: "invalid_request" }, 400);
      // Only commands that put the task back in line need consent. Unknown
      // or unparseable bodies pass through to the object's own 400.
      const forwarded = await forwardedBody(request, context);
      if (forwarded instanceof Response) return forwarded;
      const commandType = fieldOf(forwarded.value, "type");
      if (typeof commandType === "string" && COMMANDS_THAT_START_WORK.has(commandType)) {
        const refused = await consentGate(env, context);
        if (refused) return refused;
      }
      const stub = env.TASK.get(env.TASK.idFromName(commandTaskId));
      const headers = new Headers({ "content-type": "application/json" });
      headers.set("x-task-id", commandTaskId);
      headers.set("idempotency-key", commandKey);
      headers.set("x-route", "POST /v1/tasks/:id/commands");
      tenantHeaders(context, headers);
      const commandAssertions = await taskWriteAssertions(env, context, url, commandTaskId);
      if (commandAssertions instanceof Response) return commandAssertions;
      if (commandAssertions.member) headers.set("x-company-member", commandAssertions.member);
      if (commandAssertions.writer) headers.set("x-company-writer", commandAssertions.writer);
      const expectedRev = request.headers.get("x-expected-rev");
      if (expectedRev) headers.set("x-expected-rev", expectedRev);
      return stub.fetch(
        new Request("https://task/commands", { method: "POST", headers, body: forwarded.body }),
      );
    }

    // Attempt ownership: claims mint fencing tokens, mutations spend them.
    // Bodies pass through; the object validates executors, leases, fences,
    // budgets, and step identity.
    const attemptClaim = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/attempts$/);
    if (attemptClaim && request.method === "POST") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      if (!(await featureFlags(env)).officeCloud) {
        return json({ error: "feature_disabled", feature: "officeCloud" }, 403);
      }
      if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
      const claimTaskId = attemptClaim[1];
      if (!claimTaskId) return json({ error: "invalid_request" }, 400);
      const refused = await consentGate(env, context);
      if (refused) return refused;
      const headers = new Headers({ "content-type": "application/json" });
      tenantHeaders(context, headers);
      const claimAssertions = await taskWriteAssertions(env, context, url, claimTaskId);
      if (claimAssertions instanceof Response) return claimAssertions;
      if (claimAssertions.member) headers.set("x-company-member", claimAssertions.member);
      if (claimAssertions.writer) headers.set("x-company-writer", claimAssertions.writer);
      const stub = env.TASK.get(env.TASK.idFromName(claimTaskId));
      return stub.fetch(
        new Request("https://task/attempts", { method: "POST", headers, body: request.body }),
      );
    }
    const attemptAction = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/attempts\/([^/]+)\/(heartbeat|steps|finish)$/);
    if (attemptAction && request.method === "POST") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      if (!(await featureFlags(env)).officeCloud) {
        return json({ error: "feature_disabled", feature: "officeCloud" }, 403);
      }
      if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
      const attemptTaskId = attemptAction[1];
      const attemptId = attemptAction[2];
      const attemptOp = attemptAction[3];
      if (!attemptTaskId || !attemptId || !attemptOp) return json({ error: "invalid_request" }, 400);
      // Heartbeats and steps continue work, so they need consent; a refused
      // heartbeat lets the lease lapse, which is how the work stops. Finish
      // only closes the attempt with its outcome and changes no task state,
      // so an executor can always settle.
      if (attemptOp !== "finish") {
        const refused = await consentGate(env, context);
        if (refused) return refused;
      }
      const headers = new Headers({ "content-type": "application/json" });
      tenantHeaders(context, headers);
      const attemptAssertions = await taskWriteAssertions(env, context, url, attemptTaskId);
      if (attemptAssertions instanceof Response) return attemptAssertions;
      if (attemptAssertions.member) headers.set("x-company-member", attemptAssertions.member);
      if (attemptAssertions.writer) headers.set("x-company-writer", attemptAssertions.writer);
      const stub = env.TASK.get(env.TASK.idFromName(attemptTaskId));
      return stub.fetch(
        new Request(`https://task/attempts/${attemptId}/${attemptOp}`, {
          method: "POST",
          headers,
          body: request.body,
        }),
      );
    }

    const taskMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
      const routeTaskId = taskMatch[1];
      if (!routeTaskId) return json({ error: "invalid_request" }, 400);
      const stub = env.TASK.get(env.TASK.idFromName(routeTaskId));
      if (request.method === "GET") {
        const assertion = await companyReadAssertion(env, context, url);
        if (assertion instanceof Response) return assertion;
        const headers = new Headers();
        tenantHeaders(context, headers);
        if (assertion) headers.set("x-company-member", assertion);
        return stub.fetch(new Request("https://task/", { headers }));
      }
      if (request.method === "PUT") {
        let body: TaskRecordJSON;
        try {
          body = (await request.json()) as TaskRecordJSON;
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        if (!body?.id || typeof body.id !== "string") {
          return json({ error: "id_required" }, 400);
        }
        // The object re-checks this, but the route needs the id settled
        // before it stamps the tenant below.
        if (body.id !== routeTaskId) {
          return json({ error: "id_mismatch" }, 400);
        }
        if (hasClientProvenance(body)) return json({ error: "client_provenance_forbidden" }, 400);
        // The tenant is stamped here, never trusted from the client — same
        // rule as POST /v1/tasks. A session owns its tasks; without this, an
        // owner PUT omitting tenantId would clear tenancy and expose the task
        // to every tenant through the object's empty-tenant pass-through.
        const putTenant = context.tenant ?? "";
        if (!(await featureFlags(env)).officeCloud) {
          return json({ error: "feature_disabled", feature: "officeCloud" }, 403);
        }
        if (context.tenant) {
          if (!(await tenantConsent(env, context.tenant))) {
            return json({ error: "consent_required" }, 403);
          }
          body.tenantId = context.tenant;
        }
        // Company scope on update is verified like on create; the object
        // additionally refuses any change once set. Adoption of a
        // company-less task needs the same membership and grant.
        const putCompany = typeof body.companyId === "string" ? body.companyId : "";
        let putVerified = "";
        if (putCompany) {
          if (!isValidCompanyId(putCompany)) return json({ error: "invalid_company_id" }, 400);
          if (!context.operator) {
            const authority = await companyAuthority(env, putCompany, context);
            if (!authority.ok) return json(authority.body, authority.status);
            if (!authority.grants.includes(GRANTS.TASKS_CREATE)) {
              return json({ error: "grant_required", grant: GRANTS.TASKS_CREATE }, 403);
            }
          }
          putVerified = putCompany;
        } else if (body.companyId !== undefined) {
          return json({ error: "invalid_company_id" }, 400);
        }
        const headers = new Headers({ "content-type": "application/json" });
        headers.set("x-task-id", routeTaskId);
        headers.set("x-route", "PUT /v1/tasks/:id");
        tenantHeaders(context, headers);
        if (putVerified) headers.set("x-company-verified", putVerified);
        const idempotencyKey = request.headers.get("idempotency-key");
        if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
        // Revision fencing is enforced by the object; the route only carries
        // the client's expectation through so a stale writer is rejected.
        const expectedRev = request.headers.get("x-expected-rev");
        if (expectedRev) headers.set("x-expected-rev", expectedRev);
        const response = await stub.fetch(
          new Request("https://task/", {
            method: "PUT",
            headers,
            body: JSON.stringify(body),
          }),
        );
        // PUT can create (upsert). Index on success — the call is idempotent,
        // so re-indexing an update is harmless, while a missing id would make
        // export and tenant deletion unable to find the task.
        if (response.ok && putTenant) {
          await tenantCall(env, putTenant, "/index", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tenant: putTenant, taskId: body.id }),
          }).catch(() => undefined);
        }
        return response;
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/tasks") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      if (!(await featureFlags(env)).officeCloud) {
        return json({ error: "feature_disabled", feature: "officeCloud" }, 403);
      }
      if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
      const idempotencyKey = request.headers.get("idempotency-key");
      if (!idempotencyKey) return json({ error: "idempotency_key_required" }, 400);
      let body: TaskRecordJSON;
      try {
        body = (await request.json()) as TaskRecordJSON;
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      if (!body?.id) return json({ error: "id_required" }, 400);
      if (hasClientProvenance(body)) return json({ error: "client_provenance_forbidden" }, 400);
      if (body.location !== "cloud") return json({ error: "cloud_tasks_only" }, 400);
      // The tenant is stamped here, never trusted from the client: a session
      // owns its tasks, and the object refuses cross-tenant reads. Sessions
      // additionally need explicit cloud-work consent; without it, an app
      // upgrade can never start uploading work on its own.
      const createTenant = context.tenant ?? (typeof body.tenantId === "string" ? body.tenantId : "");
      if (context.tenant) {
        body.tenantId = context.tenant;
        if (!(await tenantConsent(env, context.tenant))) {
          return json({ error: "consent_required" }, 403);
        }
      }
      // Company scope is verified here and stamped for the object: the
      // caller must be an active member holding tasks.create, and the
      // verified company rides x-company-verified. A client-supplied
      // companyId never survives on its own word.
      const createCompany = typeof body.companyId === "string" ? body.companyId : "";
      let verifiedCompany = "";
      if (createCompany) {
        if (!isValidCompanyId(createCompany)) return json({ error: "invalid_company_id" }, 400);
        if (!context.operator) {
          const authority = await companyAuthority(env, createCompany, context);
          if (!authority.ok) return json(authority.body, authority.status);
          if (!authority.grants.includes(GRANTS.TASKS_CREATE)) {
            return json({ error: "grant_required", grant: GRANTS.TASKS_CREATE }, 403);
          }
        }
        verifiedCompany = createCompany;
        body.companyId = createCompany;
      } else if (body.companyId !== undefined) {
        return json({ error: "invalid_company_id" }, 400);
      }
      // Index before creating: a phantom id on a failed create is skipped by
      // export, while a missing id would make deletion unprovable.
      if (createTenant) {
        await tenantCall(env, createTenant, "/index", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenant: createTenant, taskId: body.id }),
        });
      }
      const stub = env.TASK.get(env.TASK.idFromName(body.id));
      // Create-only: the object answers 409 when the id already exists, so a retried
      // POST with a fresh idempotency key cannot silently overwrite, and a retried POST
      // with the same key replays the stored record.
      const createHeaders = new Headers({
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-task-id": body.id,
        "x-route": "POST /v1/tasks",
        "x-tenant": createTenant,
        "x-create-only": "1",
      });
      if (verifiedCompany) createHeaders.set("x-company-verified", verifiedCompany);
      const created = await stub.fetch(
        new Request("https://task/", {
          method: "PUT",
          headers: createHeaders,
          body: JSON.stringify(body),
        }),
      );
      if (created.ok && verifiedCompany && context.tenant) {
        // Company task index for the company-scoped list. Best effort like
        // the tenant index above: the authority still enforces membership
        // when an index row is missing.
        const indexHeaders = new Headers({ "content-type": "application/json" });
        indexHeaders.set("x-tenant", context.tenant);
        await companyStub(env, verifiedCompany)
          .fetch(
            new Request("https://company/tasks-index", {
              method: "POST",
              headers: indexHeaders,
              body: JSON.stringify({ taskId: body.id }),
            }),
          )
          .catch(() => undefined);
      }
      return created;
    }

    // Company administration. Companies are a stricter layer than tasks:
    // every route re-resolves membership and explicit grants inside the
    // company authority, and a supplied company id is a requested scope that
    // never falls back to another company. Writes from session callers need
    // the session-bound CSRF token plus same-origin. Operator credentials
    // are refused before reaching company routes.
    if (request.method === "POST" && url.pathname === "/v1/companies") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      const guarded = await companyWriteGuards(env, request, url, context);
      if (guarded) return guarded;
      if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
      let body: { id?: unknown; name?: unknown; timezone?: unknown; ownerTenant?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      // Session callers create for themselves, never a client-supplied owner.
      const creator =
        context.tenant ?? (typeof body.ownerTenant === "string" ? body.ownerTenant : "");
      if (!creator) return json({ error: "tenant_required" }, 400);
      if (!context.operator && !(await canCreateCompany(env, creator))) {
        return json({ error: "company_create_forbidden" }, 403);
      }
      const id = typeof body.id === "string" ? body.id : crypto.randomUUID();
      // "mine" is the membership-listing route, never a company.
      if (id === "mine" || !isValidCompanyId(id)) return json({ error: "invalid_company_id" }, 400);
      const headers = companyHeaders(context);
      headers.set("x-tenant", creator);
      headers.set("x-entitled", "1");
      const response = await companyStub(env, id).fetch(
        new Request("https://company/create", {
          method: "POST",
          headers,
          body: JSON.stringify({ id, name: body.name, timezone: body.timezone }),
        }),
      );
      const created = (await response.json().catch(() => null)) as { company?: { id?: string } } | null;
      // Index-before-read, like tasks: a missing index row only hides the
      // company from /mine, while the authority still enforces membership.
      // A failed index write is ignored here and surfaced by re-reading.
      if (response.ok && created?.company?.id) {
        await authCall(env, "/memberships", {
          method: "POST",
          headers: adminHeaders(),
          body: JSON.stringify({ tenant: creator, companyId: created.company.id, role: "owner" }),
        }).catch(() => undefined);
      }
      return json(created, response.status);
    }
    if (request.method === "GET" && url.pathname === "/v1/companies/mine") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      if (!context.tenant) return json({ error: "tenant_required" }, 400);
      const index = await authCall(env, `/memberships?tenant=${encodeURIComponent(context.tenant)}`);
      const listed = (await index.json().catch(() => null)) as {
        memberships?: { companyId?: string; role?: string }[];
      } | null;
      if (!index.ok || !listed) return json({ error: "memberships_unavailable" }, 500);
      const memberships: { companyId: string; role: string; name?: string; unavailable?: boolean }[] = [];
      for (const entry of listed.memberships ?? []) {
        if (typeof entry.companyId !== "string" || typeof entry.role !== "string") continue;
        const headers = new Headers();
        headers.set("x-tenant", context.tenant);
        const read = await companyStub(env, entry.companyId).fetch(
          new Request("https://company/get", { headers }),
        );
        if (!read.ok) {
          memberships.push({ companyId: entry.companyId, role: entry.role, unavailable: true });
          continue;
        }
        const detail = (await read.json().catch(() => null)) as { company?: { name?: string } } | null;
        if (typeof detail?.company?.name === "string") {
          memberships.push({ companyId: entry.companyId, role: entry.role, name: detail.company.name });
        } else {
          memberships.push({ companyId: entry.companyId, role: entry.role, unavailable: true });
        }
      }
      return json({ memberships });
    }
    const companyMatch = url.pathname.match(/^\/v1\/companies\/([^/]+)(\/(members|grants|revoke|connections|scope))?$/);
    // "import-template" is a dedicated route below, never a company id: the
    // pattern above would otherwise match it as a single-segment id.
    if (companyMatch && companyMatch[1] !== "import-template") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      const companyId = companyMatch[1];
      const leaf = companyMatch[3];
      // "mine" is the membership-listing route, never a company.
      if (!companyId || companyId === "mine" || !isValidCompanyId(companyId)) {
        return json({ error: "invalid_company_id" }, 400);
      }
      const stub = companyStub(env, companyId);
      if (!leaf && request.method === "GET") {
        return stub.fetch(new Request("https://company/get", { headers: companyHeaders(context) }));
      }
      if (!leaf && request.method === "PATCH") {
        const guarded = await companyWriteGuards(env, request, url, context);
        if (guarded) return guarded;
        if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
        return stub.fetch(
          new Request("https://company/configure", {
            method: "PATCH",
            headers: companyHeaders(context),
            body: request.body,
          }),
        );
      }
      if (!leaf && request.method === "DELETE") {
        const guarded = await companyWriteGuards(env, request, url, context);
        if (guarded) return guarded;
        // Read the task index before the record disappears: every indexed
        // task is released back to tenant-only isolation afterwards, so none
        // keeps pointing at a deleted company. A refusal here aborts before
        // anything is deleted.
        const preHeaders = new Headers();
        if (context.operator) preHeaders.set("x-operator", "1");
        else preHeaders.set("x-tenant", context.tenant ?? "");
        const preIndex = await stub.fetch(new Request("https://company/tasks-index", { headers: preHeaders }));
        const preListed = (await preIndex.json().catch(() => null)) as { taskIds?: string[] } | null;
        if (!preIndex.ok || !preListed || !Array.isArray(preListed.taskIds)) {
          return json(preListed ?? { error: "task_index_unavailable" }, preIndex.status);
        }
        const response = await stub.fetch(
          new Request("https://company/delete", { method: "DELETE", headers: companyHeaders(context) }),
        );
        const deleted = (await response.json().catch(() => null)) as {
          deleted?: string;
          members?: string[];
        } | null;
        if (!response.ok || !deleted) return json(deleted, response.status);
        // Detach fan-out: each task reverts to its creator's tenancy. A task
        // already gone counts as resolved; anything else is reported, never
        // silent — but per-task failures do not resurrect the company.
        const detached: string[] = [];
        const detachFailed: string[] = [];
        await Promise.all(
          (preListed.taskIds ?? []).map(async (taskId) => {
            const release = await env.TASK.get(env.TASK.idFromName(taskId))
              .fetch(
                new Request("https://task/detach-company", {
                  method: "POST",
                  headers: { "x-company-detach": companyId },
                }),
              )
              .catch(() => null);
            if (release && (release.ok || release.status === 404)) detached.push(taskId);
            else detachFailed.push(taskId);
          }),
        );
        // Scrub the membership index for every former member. The company is
        // already gone; report honestly whether the index followed.
        const pruned: string[] = [];
        const failed: string[] = [];
        await Promise.all(
          (deleted.members ?? []).map(async (member) => {
            const unindexed = await authCall(env, "/memberships-remove", {
              method: "POST",
              headers: adminHeaders(),
              body: JSON.stringify({ tenant: member, companyId: deleted.deleted }),
            }).catch(() => null);
            if (unindexed && unindexed.ok) pruned.push(member);
            else failed.push(member);
          }),
        );
        return json({ ...deleted, detached, detachFailed, indexPruned: pruned, indexFailed: failed }, response.status);
      }
      if (leaf === "members" && request.method === "GET") {
        return stub.fetch(new Request("https://company/members", { headers: companyHeaders(context) }));
      }
      if (leaf === "members" && request.method === "POST") {
        const guarded = await companyWriteGuards(env, request, url, context);
        if (guarded) return guarded;
        if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
        let body: { tenant?: unknown; role?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        const response = await stub.fetch(
          new Request("https://company/members", {
            method: "POST",
            headers: companyHeaders(context),
            body: JSON.stringify(body),
          }),
        );
        const added = (await response.json().catch(() => null)) as {
          membership?: { role?: string };
        } | null;
        if (response.ok && typeof body.tenant === "string" && added?.membership?.role) {
          await authCall(env, "/memberships", {
            method: "POST",
            headers: adminHeaders(),
            body: JSON.stringify({ tenant: body.tenant, companyId, role: added.membership.role }),
          }).catch(() => undefined);
        }
        return json(added, response.status);
      }
      if (leaf === "members" && request.method === "PATCH") {
        const guarded = await companyWriteGuards(env, request, url, context);
        if (guarded) return guarded;
        if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
        let body: { tenant?: unknown; role?: unknown; status?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        const response = await stub.fetch(
          new Request("https://company/members", {
            method: "PATCH",
            headers: companyHeaders(context),
            body: JSON.stringify(body),
          }),
        );
        const updated = (await response.json().catch(() => null)) as {
          membership?: { role?: string; status?: string };
        } | null;
        if (response.ok && typeof body.tenant === "string" && updated?.membership) {
          if (updated.membership.status === "revoked") {
            await authCall(env, "/memberships-remove", {
              method: "POST",
              headers: adminHeaders(),
              body: JSON.stringify({ tenant: body.tenant, companyId }),
            }).catch(() => undefined);
          } else if (updated.membership.role) {
            await authCall(env, "/memberships", {
              method: "POST",
              headers: adminHeaders(),
              body: JSON.stringify({ tenant: body.tenant, companyId, role: updated.membership.role }),
            }).catch(() => undefined);
          }
        }
        return json(updated, response.status);
      }
      if (leaf === "grants" && request.method === "POST") {
        const guarded = await companyWriteGuards(env, request, url, context);
        if (guarded) return guarded;
        if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
        return stub.fetch(
          new Request("https://company/grants", {
            method: "POST",
            headers: companyHeaders(context),
            body: request.body,
          }),
        );
      }
      // Connection allowlist: which connections this company's exact actions
      // may use. Membership and the members.manage grant are enforced inside
      // the object; the worker only applies the console write guards.
      if (leaf === "connections" && request.method === "POST") {
        const guarded = await companyWriteGuards(env, request, url, context);
        if (guarded) return guarded;
        if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
        return stub.fetch(
          new Request("https://company/connections-allow", {
            method: "POST",
            headers: companyHeaders(context),
            body: request.body,
          }),
        );
      }
      // One member's shared scope (OFC-21): which shared items they may see.
      // Like every sharing route it answers the kill-switch refusal while
      // officeSharing is off, before the guards or the body are read. The
      // owner check and the grant live inside the authority.
      if (leaf === "scope" && request.method === "PATCH") {
        if (!(await featureFlags(env)).officeSharing) {
          return json({ error: "feature_disabled", feature: "officeSharing" }, 403);
        }
        const guarded = await companyWriteGuards(env, request, url, context);
        if (guarded) return guarded;
        if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
        return stub.fetch(
          new Request("https://company/scope", {
            method: "PATCH",
            headers: companyHeaders(context),
            body: request.body,
          }),
        );
      }
      if (leaf === "revoke" && request.method === "POST") {
        const guarded = await companyWriteGuards(env, request, url, context);
        if (guarded) return guarded;
        if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
        let body: { tenant?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        const response = await stub.fetch(
          new Request("https://company/revoke", {
            method: "POST",
            headers: companyHeaders(context),
            body: JSON.stringify(body),
          }),
        );
        const revoked = (await response.json().catch(() => null)) as unknown;
        if (response.ok && typeof body.tenant === "string") {
          await authCall(env, "/memberships-remove", {
            method: "POST",
            headers: adminHeaders(),
            body: JSON.stringify({ tenant: body.tenant, companyId }),
          }).catch(() => undefined);
        }
        return json(revoked, response.status);
      }
    }

    // Shared run records (OFC-21, `shared-items.ts`): the owner publishes
    // (PUT) and withdraws (DELETE) one run's shared copy; members list and
    // read what is in their shared scope. The run's comments
    // (`shared-comments.ts`) hang off the same path: members holding
    // comments.write add one (POST), and members read them (GET). Like every
    // sharing route these answer the kill-switch refusal while officeSharing
    // is off, before the ids, the guards or the body are read, and that covers
    // reads too, so nobody is shown shared work while the switch is off.
    // Membership, scope, the owner check and the grants live inside the
    // authority.
    const sharedMatch = url.pathname.match(/^\/v1\/companies\/([^/]+)\/shared(?:\/([^/]+)(\/comments)?)?$/);
    if (sharedMatch) {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      if (!(await featureFlags(env)).officeSharing) {
        return json({ error: "feature_disabled", feature: "officeSharing" }, 403);
      }
      const sharedCompany = sharedMatch[1];
      if (
        !sharedCompany ||
        sharedCompany === "mine" ||
        sharedCompany === "import-template" ||
        !isValidCompanyId(sharedCompany)
      ) {
        return json({ error: "invalid_company_id" }, 400);
      }
      const stub = companyStub(env, sharedCompany);
      const runId = sharedMatch[2];
      if (runId === undefined) {
        if (request.method === "GET") {
          return stub.fetch(new Request(`https://company/shared${url.search}`, { headers: companyHeaders(context) }));
        }
        return json({ error: "not_found" }, 404);
      }
      if (!isValidSharedItemId(runId)) return json({ error: "invalid_shared_item_id" }, 400);
      if (sharedMatch[3] !== undefined) {
        // The run comes from the path alone; only the page parameters are
        // carried over, so a query cannot name a different run.
        const comments = new URL("https://company/shared-comments");
        comments.searchParams.set("run", runId);
        if (request.method === "GET") {
          for (const name of ["limit", "cursor"]) {
            const value = url.searchParams.get(name);
            if (value !== null) comments.searchParams.set(name, value);
          }
          return stub.fetch(new Request(comments, { headers: companyHeaders(context) }));
        }
        if (request.method === "POST") {
          const guarded = await companyWriteGuards(env, request, url, context);
          if (guarded) return guarded;
          if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
          return stub.fetch(new Request(comments, { method: "POST", headers: companyHeaders(context), body: request.body }));
        }
        return json({ error: "not_found" }, 404);
      }
      const item = `https://company/shared-item?run=${encodeURIComponent(runId)}`;
      if (request.method === "GET") {
        return stub.fetch(new Request(item, { headers: companyHeaders(context) }));
      }
      if (request.method === "PUT" || request.method === "DELETE") {
        const guarded = await companyWriteGuards(env, request, url, context);
        if (guarded) return guarded;
        if (request.method === "DELETE") {
          return stub.fetch(new Request(item, { method: "DELETE", headers: companyHeaders(context) }));
        }
        if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
        return stub.fetch(new Request(item, { method: "PUT", headers: companyHeaders(context), body: request.body }));
      }
      return json({ error: "not_found" }, 404);
    }

    // Company task list: cursor pages over the company task index for
    // members. Each id resolves to its task document with the verified
    // membership assertion, so fellow members see each other's company
    // tasks; an id that no longer resolves is marked unavailable rather
    // than silently dropped. The total is the index size — a snapshot
    // count, never a claim about task states.
    const companyTasksMatch = url.pathname.match(/^\/v1\/companies\/([^/]+)\/tasks$/);
    if (companyTasksMatch && request.method === "GET") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      const listCompany = companyTasksMatch[1];
      if (!listCompany || !isValidCompanyId(listCompany) || listCompany === "mine") {
        return json({ error: "invalid_company_id" }, 400);
      }
      if (!context.operator) {
        const authority = await companyAuthority(env, listCompany, context);
        if (!authority.ok) return json(authority.body, authority.status);
      }
      const listHeaders = new Headers();
      if (context.operator) listHeaders.set("x-operator", "1");
      else listHeaders.set("x-tenant", context.tenant ?? "");
      const index = await companyStub(env, listCompany).fetch(
        new Request(`https://company/tasks-index${url.search}`, { headers: listHeaders }),
      );
      const listed = (await index.json().catch(() => null)) as {
        taskIds?: string[];
        nextCursor?: string | null;
        total?: number;
      } | null;
      if (!index.ok || !listed) return json(listed ?? { error: "task_index_unavailable" }, index.status);
      if (!Array.isArray(listed.taskIds)) return json({ error: "task_index_unavailable" }, 500);
      const tasks: unknown[] = [];
      for (const id of listed.taskIds) {
        const headers = new Headers();
        tenantHeaders(context, headers);
        if (!context.operator) headers.set("x-company-member", listCompany);
        const read = await env.TASK.get(env.TASK.idFromName(id)).fetch(
          new Request("https://task/", { headers }),
        );
        if (!read.ok) {
          tasks.push({ id, unavailable: true });
          continue;
        }
        tasks.push(await read.json());
      }
      return json({ tasks, nextCursor: listed.nextCursor ?? null, total: listed.total ?? tasks.length });
    }

    // Company template export: profile plus active roles for reuse. No
    // tenants, grants, or secrets cross this boundary by construction.
    const companyTemplateMatch = url.pathname.match(/^\/v1\/companies\/([^/]+)\/template$/);
    if (companyTemplateMatch && request.method === "GET") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      const templateCompany = companyTemplateMatch[1];
      if (!templateCompany || !isValidCompanyId(templateCompany) || templateCompany === "mine") {
        return json({ error: "invalid_company_id" }, 400);
      }
      return companyStub(env, templateCompany).fetch(
        new Request("https://company/template", { headers: companyHeaders(context) }),
      );
    }

    // Template import: same entitlement and write guards as creating a
    // company. The creator becomes owner with full grants; members and
    // grants are never restored — authority is always re-granted by a
    // human in the new company.
    if (request.method === "POST" && url.pathname === "/v1/companies/import-template") {
      const context = await contextOf(request, env);
      if (!context) return json({ error: "unauthorized" }, 401);
      const guarded = await companyWriteGuards(env, request, url, context);
      if (guarded) return guarded;
      if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
      let body: { template?: unknown; name?: unknown; id?: unknown; ownerTenant?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      const creator =
        context.tenant ?? (typeof body.ownerTenant === "string" ? body.ownerTenant : "");
      if (!creator) return json({ error: "tenant_required" }, 400);
      if (!context.operator && !(await canCreateCompany(env, creator))) {
        return json({ error: "company_create_forbidden" }, 403);
      }
      const id = typeof body.id === "string" ? body.id : crypto.randomUUID();
      if (id === "mine" || !isValidCompanyId(id)) return json({ error: "invalid_company_id" }, 400);
      const headers = companyHeaders(context);
      headers.set("x-tenant", creator);
      headers.set("x-entitled", "1");
      const response = await companyStub(env, id).fetch(
        new Request("https://company/template-import", {
          method: "POST",
          headers,
          body: JSON.stringify({ template: body.template, name: body.name, id }),
        }),
      );
      const imported = (await response.json().catch(() => null)) as {
        company?: { id?: string };
        membership?: { role?: string };
      } | null;
      if (response.ok && imported?.company?.id && imported?.membership?.role) {
        await authCall(env, "/memberships", {
          method: "POST",
          headers: adminHeaders(),
          body: JSON.stringify({
            tenant: creator,
            companyId: imported.company.id,
            role: imported.membership.role,
          }),
        }).catch(() => undefined);
      }
      return json(imported, response.status);
    }

    // Account entitlements. Operator only: sessions never reach this, so a
    // compromised device cannot entitle itself to mint companies.
    if (url.pathname === "/v1/admin/entitlements") {
      if (request.method === "GET") {
        const tenant = url.searchParams.get("tenant") ?? "";
        if (!tenant) return json({ error: "tenant_required" }, 400);
        const response = await authCall(env, `/entitlement?tenant=${encodeURIComponent(tenant)}`);
        return json(await response.json(), response.status);
      }
      if (request.method === "PUT") {
        if (tooLarge(request)) return json({ error: "body_too_large" }, 413);
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        const response = await authCall(env, "/entitlement", {
          method: "POST",
          headers: adminHeaders(),
          body: JSON.stringify(body),
        });
        return json(await response.json(), response.status);
      }
    }

    return json({ error: "not_found" }, 404);
  },
};
