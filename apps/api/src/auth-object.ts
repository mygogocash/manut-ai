import { DurableObject } from "cloudflare:workers";
import { sha256Hex, verifyAppleToken } from "./auth";
import { readJsonBody } from "./body";
import { pilotDeletionRoute, pilotRegistryRoute } from "./pilot-store";
import { shopsAuthRoute, wipeShopsTenant } from "./shops-store";

type AuthEnv = {
  APPLE_CLIENT_ID?: string;
  APPLE_JWKS_URL?: string;
  /// Test-only JWKS. Production never sets it, so the Apple endpoint is the
  /// only key source there.
  TEST_JWKS_JSON?: string;
};

type SessionRec = {
  tenant: string;
  deviceId: string;
  exp: number;
  refreshHash: string;
  /// Binds CSRF tokens for company-console writes to this session. Absent on
  /// pre-company records, which fail closed on company writes until refresh.
  csrfHash?: string | undefined;
  /// Absent legacy records belong to generation zero. A tenant wipe advances it.
  wipeGeneration?: number | undefined;
  /// The email Apple verified when this session's chain was signed in (auth.ts), carried through every refresh. An
  /// email invite checks it (docs/people.md); nothing else reads it, and it never names the tenant.
  email?: string | undefined;
};

/// One row of the per-tenant membership index: which companies this tenant
/// belongs to and in what role. The CompanyObject stays authoritative for
/// membership and grants; this index only answers "which companies am I in"
/// without scanning every company object.
type MembershipEntry = {
  companyId: string;
  role: string;
};

/// One row of the inbound route index: a tenant vault that holds a
/// connection for a provider account, so a webhook naming only the account
/// (a Linear organization) can find where to look. The vault stays
/// authoritative: the inbound route re-reads the connection's metadata and
/// ignores a row whose connection is revoked, wiped or re-pointed.
type InboundRoute = {
  tenant: string;
  connectionId: string;
};

/// Rows kept per provider account, newest first. One workspace connected by
/// more than a few tenants is outside the sandbox this serves.
const MAX_INBOUND_ROUTES = 20;

type RefreshRec = {
  accessHash: string;
  tenant: string;
  deviceId: string;
  exp: number;
  /// First issuance of the grant chain, bounding rolling refresh to an
  /// absolute lifetime. Absent on pre-lifetime grants, which are treated as
  /// born at first rotation.
  born?: number | undefined;
  wipeGeneration?: number | undefined;
  /// The chain's verified email (`SessionRec.email`), so a refresh hands it to the next session.
  email?: string | undefined;
};

const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_SECONDS = 30 * 24 * 3600;
/// Absolute cap on a grant chain no matter how often it rotates: 90 days,
/// after which the device signs in again. Bounds the blast radius of a
/// stolen refresh token that keeps rotating ahead of detection.
const REFRESH_ABSOLUTE_TTL_SECONDS = 90 * 24 * 3600;
const MAX_BODY_BYTES = 256 * 1024;

function wipeGeneration(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error("invalid_wipe_generation");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/// Device sessions for cloud identity. Sign in with Apple mints them;
/// refresh rotates them; revoke ends them. Every method takes its inputs
/// from the worker, which only forwards allowlisted fields, so a client can
/// never declare its own tenant: the tenant always comes from a verified
/// provider subject.
export class AuthObject extends DurableObject {
  private get authEnv(): AuthEnv {
    return this.env as unknown as AuthEnv;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/exchange") {
      return this.exchange(request);
    }
    if (request.method === "POST" && url.pathname === "/refresh") {
      return this.refresh(request);
    }
    if (request.method === "DELETE" && url.pathname === "/session") {
      return this.revoke(request);
    }
    if (request.method === "POST" && url.pathname === "/verify") {
      return this.verify(request);
    }
    if (request.method === "POST" && url.pathname === "/tenant-wipe") {
      return this.tenantWipe(request);
    }
    if (request.method === "POST" && url.pathname === "/csrf-check") {
      return this.csrfCheck(request);
    }
    if (url.pathname === "/entitlement") {
      if (request.method === "GET") return this.readEntitlement(url);
      if (request.method === "POST") return this.writeEntitlement(request);
    }
    if (url.pathname === "/memberships") {
      if (request.method === "GET") return this.readMemberships(url);
      if (request.method === "POST") return this.writeMembership(request);
    }
    if (request.method === "POST" && url.pathname === "/memberships-remove") {
      return this.removeMembership(request);
    }
    if (url.pathname === "/inbound-routes") {
      if (request.method === "GET") return this.readInboundRoutes(url);
      if (request.method === "POST") return this.writeInboundRoute(request);
    }
    // The Manut AI pilot's shop registry (pilot-store.ts).
    if (url.pathname === "/pilot-shops") {
      return pilotRegistryRoute(this.ctx.storage, request);
    }
    // Pilot shop deletions and the owners' confirmations of them, kept here so
    // both outlive the shop's own objects.
    if (url.pathname === "/pilot-deletions" || url.pathname.startsWith("/pilot-deletions/")) {
      return pilotDeletionRoute(this.ctx.storage, request);
    }
    // Several shops (shops-store.ts): which shops each signed-in person is in, and owners' one-use link codes.
    if (url.pathname === "/identity-shops" || url.pathname.startsWith("/identity-shops/") ||
        url.pathname === "/owner-codes" || url.pathname.startsWith("/owner-codes/")) {
      return shopsAuthRoute(this.ctx.storage, request, url);
    }
    if (url.pathname === "/flags") {
      if (request.method === "GET") {
        const flags = (await this.ctx.storage.get<Record<string, boolean>>("flags")) ?? {};
        return Response.json(flags);
      }
      if (request.method === "POST") {
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return Response.json({ error: "invalid_json" }, { status: 400 });
        }
        const next = (await this.ctx.storage.get<Record<string, boolean>>("flags")) ?? {};
        for (const key of ["officeCloud", "officeRoutines", "officeExternalWrites", "officeInbound", "officeSharing"]) {
          if (body[key] === undefined) continue;
          if (typeof body[key] !== "boolean") {
            return Response.json({ error: "invalid_request" }, { status: 400 });
          }
          next[key] = body[key] as boolean;
        }
        await this.ctx.storage.put("flags", next);
        return Response.json(next);
      }
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  private async exchange(request: Request): Promise<Response> {
    let body: { provider?: unknown; identityToken?: unknown; nonce?: unknown; deviceId?: unknown };
    const exchanged = await readJsonBody<typeof body>(request, MAX_BODY_BYTES);
    if (!exchanged.ok) return Response.json({ error: exchanged.error }, { status: exchanged.status });
    body = exchanged.value;
    if (
      body.provider !== "apple" ||
      typeof body.identityToken !== "string" ||
      typeof body.nonce !== "string" ||
      typeof body.deviceId !== "string" ||
      body.deviceId.length === 0 ||
      body.deviceId.length > 128
    ) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (!this.authEnv.APPLE_CLIENT_ID && !this.authEnv.TEST_JWKS_JSON) {
      return Response.json({ error: "identity_not_configured" }, { status: 400 });
    }
    let tenant: string;
    let identityExpiry: number;
    let email: string | undefined;
    try {
      const identity = await verifyAppleToken(body.identityToken, body.nonce, {
        clientId: this.authEnv.APPLE_CLIENT_ID ?? "test-client",
        jwksJson: this.authEnv.TEST_JWKS_JSON,
        jwksUrl: this.authEnv.APPLE_JWKS_URL,
      });
      tenant = identity.tenant;
      identityExpiry = identity.exp;
      email = identity.email;
    } catch {
      return Response.json({ error: "invalid_identity" }, { status: 401 });
    }
    const now = Date.now() / 1000;
    const access = randomToken();
    const refresh = randomToken();
    const csrf = randomToken();
    const session: SessionRec = {
      tenant,
      deviceId: body.deviceId,
      exp: now + ACCESS_TTL_SECONDS,
      refreshHash: await sha256Hex(refresh),
      csrfHash: await sha256Hex(csrf),
      ...(email ? { email } : {}),
    };
    const grant: RefreshRec = {
      accessHash: await sha256Hex(access),
      tenant,
      deviceId: body.deviceId,
      exp: now + REFRESH_TTL_SECONDS,
      born: now,
      ...(email ? { email } : {}),
    };
    const usedKey = `used:${await sha256Hex(body.identityToken)}`;
    // Verification can suspend; consuming the token and issuing its session are one
    // transaction, so concurrent devices cannot both exchange the same signed identity.
    const issued = await this.ctx.storage.transaction(async (storage) => {
      if (await storage.get(usedKey) !== undefined) return false;
      const generation = wipeGeneration(await storage.get(`wiped:${tenant}`));
      if (identityExpiry <= Date.now() / 1_000) return false;
      await storage.put({
        [`sat:${grant.accessHash}`]: { ...session, wipeGeneration: generation },
        [`srt:${session.refreshHash}`]: { ...grant, wipeGeneration: generation },
        [usedKey]: identityExpiry,
      });
      const alarm = await storage.getAlarm();
      const expiry = Math.ceil(identityExpiry * 1_000);
      if (alarm === null || expiry < alarm) await storage.setAlarm(expiry);
      return true;
    });
    if (!issued) return Response.json({ error: "invalid_identity" }, { status: 401 });
    return Response.json({
      accessToken: access,
      refreshToken: refresh,
      csrf,
      expiresIn: ACCESS_TTL_SECONDS,
      tenant,
    });
  }

  /// One alarm covers consumed identities together; no token or claim body is stored.
  /// Unknown records stay fail-closed rather than forgetting an unexpired consumption.
  override async alarm(): Promise<void> {
    const now = Date.now() / 1_000;
    await this.ctx.storage.transaction(async (storage) => {
      let next = Infinity;
      let startAfter: string | undefined;
      // Bound memory and each delete batch to the storage API's 128-key limit.
      // The cursor advances over retained and removed keys alike.
      while (true) {
        const consumed = await storage.list<number>({ prefix: "used:", limit: 128,
          ...(startAfter === undefined ? {} : { startAfter }) });
        const expired: string[] = [];
        for (const [key, expiry] of consumed) {
          startAfter = key;
          if (!Number.isFinite(expiry)) continue;
          if (expiry <= now) expired.push(key);
          else next = Math.min(next, expiry);
        }
        if (expired.length) await storage.delete(expired);
        if (consumed.size < 128) break;
      }
      if (Number.isFinite(next)) await storage.setAlarm(Math.ceil(next * 1_000));
      else await storage.deleteAlarm();
    });
  }

  private async refresh(request: Request): Promise<Response> {
    let body: { refreshToken?: unknown; deviceId?: unknown };
    const refreshed = await readJsonBody<typeof body>(request, MAX_BODY_BYTES);
    if (!refreshed.ok) return Response.json({ error: refreshed.error }, { status: refreshed.status });
    body = refreshed.value;
    if (typeof body.refreshToken !== "string" || typeof body.deviceId !== "string") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const presentedHash = await sha256Hex(body.refreshToken);
    const access = randomToken();
    const refresh = randomToken();
    const csrf = randomToken();
    const accessHash = await sha256Hex(access);
    const refreshHash = await sha256Hex(refresh);
    const csrfHash = await sha256Hex(csrf);
    // Reading the grant, checking the wipe and rotating both credentials must
    // commit together. A wipe racing this call either invalidates its new pair
    // or makes this transaction refuse the old generation.
    return this.ctx.storage.transaction(async (storage) => {
      const grant = await storage.get<RefreshRec>(`srt:${presentedHash}`);
      if (!grant || grant.deviceId !== body.deviceId) {
        return Response.json({ error: "invalid_grant" }, { status: 401 });
      }
      const now = Date.now() / 1000;
      const generation = wipeGeneration(await storage.get(`wiped:${grant.tenant}`));
      await storage.delete([`sat:${grant.accessHash}`, `srt:${presentedHash}`]);
      if (grant.exp <= now || wipeGeneration(grant.wipeGeneration) !== generation) {
        return Response.json({ error: "invalid_grant" }, { status: 401 });
      }
      const born = grant.born ?? now;
      if (now - born > REFRESH_ABSOLUTE_TTL_SECONDS) {
        return Response.json({ error: "session_expired" }, { status: 401 });
      }
      const email = grant.email ? { email: grant.email } : {};
      const session: SessionRec = { tenant: grant.tenant, deviceId: grant.deviceId,
        exp: now + ACCESS_TTL_SECONDS, refreshHash, csrfHash, wipeGeneration: generation, ...email };
      const next: RefreshRec = { accessHash, tenant: grant.tenant, deviceId: grant.deviceId,
        exp: now + REFRESH_TTL_SECONDS, born, wipeGeneration: generation, ...email };
      await storage.put({ [`sat:${accessHash}`]: session, [`srt:${refreshHash}`]: next });
      return Response.json({ accessToken: access, refreshToken: refresh, csrf,
        expiresIn: ACCESS_TTL_SECONDS, tenant: grant.tenant });
    });
  }

  private async revoke(request: Request): Promise<Response> {
    const header = request.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return Response.json({ error: "unauthorized" }, { status: 401 });
    const accessHash = await sha256Hex(header.slice("Bearer ".length));
    const session = await this.ctx.storage.get<SessionRec>(`sat:${accessHash}`);
    if (!session) return Response.json({ error: "invalid_session" }, { status: 401 });
    await this.forget(accessHash, session.refreshHash);
    return Response.json({ revoked: true });
  }

  private async verify(request: Request): Promise<Response> {
    let body: { token?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ ok: false });
    }
    if (typeof body.token !== "string") return Response.json({ ok: false });
    const accessHash = await sha256Hex(body.token);
    return this.ctx.storage.transaction(async (storage) => {
      const session = await storage.get<SessionRec>(`sat:${accessHash}`);
      if (!session) return Response.json({ ok: false });
      const generation = wipeGeneration(await storage.get(`wiped:${session.tenant}`));
      if (session.exp <= Date.now() / 1000 || wipeGeneration(session.wipeGeneration) !== generation) {
        await storage.delete([`sat:${accessHash}`, `srt:${session.refreshHash}`]);
        return Response.json({ ok: false });
      }
      // The verified email rides along only for the routes that check who is signed in (people.ts); every other
      // route reads the tenant alone.
      return Response.json({ ok: true, tenant: session.tenant, ...(session.email ? { email: session.email } : {}) });
    });
  }

  private async forget(accessHash: string, refreshHash: string | null): Promise<void> {
    await this.ctx.storage.delete(`sat:${accessHash}`);
    if (refreshHash) await this.ctx.storage.delete(`srt:${refreshHash}`);
  }

  /// Verifies a session-bound CSRF token for company-console writes. The
  /// session's access token arrives in the Authorization header (never
  /// ambient), so this is defense in depth plus the contract the web console
  /// codes against. Sessions minted before CSRF existed have no hash and
  /// fail closed here until they refresh.
  private async csrfCheck(request: Request): Promise<Response> {
    let body: { token?: unknown; csrf?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ ok: false });
    }
    if (typeof body.token !== "string" || typeof body.csrf !== "string") {
      return Response.json({ ok: false });
    }
    const accessHash = await sha256Hex(body.token);
    const session = await this.ctx.storage.get<SessionRec>(`sat:${accessHash}`);
    if (!session || session.exp <= Date.now() / 1000) return Response.json({ ok: false });
    if (!session.csrfHash) return Response.json({ ok: false });
    return Response.json({ ok: (await sha256Hex(body.csrf)) === session.csrfHash });
  }

  /// Account-level company-creation entitlement. Absent means not entitled:
  /// fail closed, so tenant membership never implies a right to mint new
  /// companies. Only the worker writes this, on the operator-authed admin
  /// route, carrying `x-admin`.
  private async readEntitlement(url: URL): Promise<Response> {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!tenant) return Response.json({ error: "invalid_request" }, { status: 400 });
    const record = await this.ctx.storage.get<{ canCreateCompany: boolean }>(`entitlement:${tenant}`);
    return Response.json({ canCreateCompany: record?.canCreateCompany === true });
  }

  private async writeEntitlement(request: Request): Promise<Response> {
    if (request.headers.get("x-admin") !== "1") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const parsed = await readJsonBody<{ tenant?: unknown; canCreateCompany?: unknown }>(
      request,
      MAX_BODY_BYTES,
    );
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    if (typeof body.tenant !== "string" || !body.tenant || typeof body.canCreateCompany !== "boolean") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    await this.ctx.storage.put(`entitlement:${body.tenant}`, { canCreateCompany: body.canCreateCompany });
    return Response.json({ tenant: body.tenant, canCreateCompany: body.canCreateCompany });
  }

  /// Per-tenant membership index. The CompanyObject stays authoritative;
  /// these rows only answer "which companies am I in". Writes come from the
  /// worker after the company authority confirms the change, carrying
  /// `x-admin` like other worker-internal calls.
  private async readMemberships(url: URL): Promise<Response> {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!tenant) return Response.json({ error: "invalid_request" }, { status: 400 });
    const entries = (await this.ctx.storage.get<MembershipEntry[]>(`memberships:${tenant}`)) ?? [];
    return Response.json({ memberships: entries });
  }

  private async writeMembership(request: Request): Promise<Response> {
    if (request.headers.get("x-admin") !== "1") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const parsed = await readJsonBody<{ tenant?: unknown; companyId?: unknown; role?: unknown }>(
      request,
      MAX_BODY_BYTES,
    );
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    if (typeof body.tenant !== "string" || !body.tenant || typeof body.companyId !== "string" || !body.companyId) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (typeof body.role !== "string" || !body.role) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const entries = (await this.ctx.storage.get<MembershipEntry[]>(`memberships:${body.tenant}`)) ?? [];
    const next = entries.filter((entry) => entry.companyId !== body.companyId);
    next.push({ companyId: body.companyId as string, role: body.role as string });
    await this.ctx.storage.put(`memberships:${body.tenant}`, next);
    return Response.json({ memberships: next });
  }

  private async removeMembership(request: Request): Promise<Response> {
    if (request.headers.get("x-admin") !== "1") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const parsed = await readJsonBody<{ tenant?: unknown; companyId?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    if (typeof body.tenant !== "string" || !body.tenant || typeof body.companyId !== "string" || !body.companyId) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const entries = (await this.ctx.storage.get<MembershipEntry[]>(`memberships:${body.tenant}`)) ?? [];
    const next = entries.filter((entry) => entry.companyId !== body.companyId);
    await this.ctx.storage.put(`memberships:${body.tenant}`, next);
    return Response.json({ memberships: next });
  }

  private async readInboundRoutes(url: URL): Promise<Response> {
    const provider = url.searchParams.get("provider") ?? "";
    const account = url.searchParams.get("account") ?? "";
    if (!provider || !account) return Response.json({ error: "invalid_request" }, { status: 400 });
    const key = `inbound-route:${provider}:${encodeURIComponent(account)}`;
    const routes = (await this.ctx.storage.get<InboundRoute[]>(key)) ?? [];
    return Response.json({ routes });
  }

  /// Written by the worker when a connection is stored, never by a client:
  /// only the connections route sends `x-admin` here.
  private async writeInboundRoute(request: Request): Promise<Response> {
    if (request.headers.get("x-admin") !== "1") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const parsed = await readJsonBody<{
      provider?: unknown;
      accountId?: unknown;
      tenant?: unknown;
      connectionId?: unknown;
    }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    const bounded = (value: unknown): value is string =>
      typeof value === "string" && value.length > 0 && value.length <= 256;
    if (!bounded(body.provider) || !bounded(body.accountId) || !bounded(body.tenant) || !bounded(body.connectionId)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const key = `inbound-route:${body.provider}:${encodeURIComponent(body.accountId)}`;
    const routes = (await this.ctx.storage.get<InboundRoute[]>(key)) ?? [];
    const route: InboundRoute = { tenant: body.tenant, connectionId: body.connectionId };
    const next = [route, ...routes.filter((entry) => entry.connectionId !== route.connectionId)].slice(
      0,
      MAX_INBOUND_ROUTES,
    );
    await this.ctx.storage.put(key, next);
    return Response.json({ routes: next.length });
  }

  /// Wipes a tenant's sessions and the global index rows that name it, all
  /// but a pilot shop's registry row, which the tenant deletion removes last
  /// of all (tenant-data.ts). Consent, the task index, attention items and
  /// the tombstone live in the per-tenant TenantObject (M4 phase 1) and are
  /// wiped through the worker alongside tasks, connections, and schedules.
  private async tenantWipe(request: Request): Promise<Response> {
    if (request.headers.get("x-wipe") !== "1") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    let body: { tenant?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    if (typeof body.tenant !== "string" || !body.tenant) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const tenant = body.tenant;
    // A durable generation invalidates orphaned grants too. This counter avoids
    // wall-clock ties: a new sign-in immediately after a wipe remains usable.
    const generation = await this.ctx.storage.transaction(async (storage) => {
      const next = wipeGeneration(await storage.get(`wiped:${tenant}`)) + 1;
      if (!Number.isSafeInteger(next)) throw new Error("invalid_wipe_generation");
      await storage.put(`wiped:${tenant}`, next);
      return next;
    });
    const sessionKeys: string[] = [];
    // No secondary index: sessions are found by scanning the small session
    // namespace for this tenant's records.
    const sessions = await this.ctx.storage.list<SessionRec>({ prefix: "sat:" });
    for (const [key, session] of sessions) {
      if (session.tenant === tenant && wipeGeneration(session.wipeGeneration) < generation) {
        sessionKeys.push(key);
        await this.ctx.storage.delete(`srt:${session.refreshHash}`);
      }
    }
    await this.ctx.storage.delete(sessionKeys);
    // Company-console state for this tenant goes with the sessions: the
    // account entitlement and the membership index. Company records
    // themselves are owned by their companies, not by any one member.
    // A pilot shop's registry row stays until the shop's own data is gone,
    // so a deletion that stops part way never takes the shop off the
    // operator console's list while data is left.
    await this.ctx.storage.delete([`entitlement:${body.tenant}`, `memberships:${body.tenant}`]);
    // Inbound routes name the tenant, so they go too. The index is keyed by
    // provider account, not tenant, so this scans it; it holds one row per
    // connected workspace and stays small.
    for (const [key, routes] of await this.ctx.storage.list<InboundRoute[]>({ prefix: "inbound-route:" })) {
      const kept = routes.filter((route) => route.tenant !== body.tenant);
      if (kept.length === routes.length) continue;
      if (kept.length === 0) await this.ctx.storage.delete(key);
      else await this.ctx.storage.put(key, kept);
    }
    // Every person's index rows that name a deleted shop go too, and a person's own waiting link code (shops-store.ts).
    wipeShopsTenant(this.ctx.storage, body.tenant);
    return Response.json({ sessionsWiped: sessionKeys.length });
  }
}
