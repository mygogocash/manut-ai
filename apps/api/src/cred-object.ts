import { DurableObject } from "cloudflare:workers";
import { readJsonBody } from "./body";
import { keyTag, openSecret, sealSecret, type SealedSecret } from "./cred-crypto";
import { isSignInVaultPath, signInVaultRoute, wipeSignInVault } from "./sign-in-vault";

type CredEnv = {
  CRED_KEY?: string;
  CRED_KEY_PREVIOUS?: string;
};

/// `line` is a Manut AI pilot shop's LINE Official Account. Its sealed secret
/// is one envelope holding both the channel access token and the channel
/// secret (connectors/line.ts), so both stay encrypted at rest and neither is
/// returned by any route; its account is the channel id and its one granted
/// resource the bot's user id.
export type ConnectionProviders = "gmail" | "gcal" | "linear" | "line";

type ConnectionRec = {
  id: string;
  tenant: string;
  provider: string;
  accountId: string;
  scopes: string[];
  sealed: SealedSecret;
  createdAt: string;
  revokedAt: string | null;
  refreshLeaseUntil: number;
  /// The narrowed slice this connection may act inside, mirroring
  /// OfficeConnectionGrant: provider-native resource ids (Gmail label ids,
  /// Calendar calendar ids, Linear project ids). Empty means the adapter's
  /// safe default, never everything.
  resourceIds: string[];
  /// Whether the grant permits external writes. Reads never need it; every
  /// dispatch does. Defaults to false: a connection created before this field
  /// can read but cannot dispatch until its scope is reviewed.
  allowsActions: boolean;
  /// Server-owned revision, starting at 1. Action proposals bind the revision
  /// they were approved under; dispatch compares against this value, never a
  /// caller-supplied number.
  grantRevision: number;
};

/// What the vault may actually hold: records sealed before granted scope
/// existed carry none of the grant fields, and read with safe defaults.
type StoredConnectionRec = Omit<ConnectionRec, "resourceIds" | "allowsActions" | "grantRevision"> & {
  resourceIds?: string[];
  allowsActions?: boolean;
  grantRevision?: number;
};

const KNOWN_PROVIDERS = new Set(["gmail", "gcal", "linear", "line"]);
const REFRESH_LEASE_SECONDS = 60;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESOURCE_IDS = 100;
const MAX_RESOURCE_ID_LENGTH = 256;

/// Broker-only credential store. Provider secrets enter sealed and leave
/// only through the broker's internal read: listing and revocation expose
/// metadata, never secret material. Records are tenant-scoped, and a
/// mismatched tenant reads as not-found.
export class CredObject extends DurableObject {
  private get credEnv(): CredEnv {
    return this.env as unknown as CredEnv;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The shop's site sign-ins for browser control (sign-in-vault.ts), sealed with the same keys as connections.
    if (isSignInVaultPath(url.pathname)) return signInVaultRoute(this.ctx.storage, this.credEnv, request, url);
    if (request.method === "POST" && url.pathname === "/connections") {
      return this.store(request);
    }
    if (request.method === "GET" && url.pathname === "/connections") {
      return this.list(url, request);
    }
    if (request.method === "GET" && url.pathname === "/first-connection") {
      return this.firstConnection(url, request);
    }
    const connectionRead = url.pathname.match(/^\/connections\/([^/]+)$/);
    if (request.method === "GET" && connectionRead) {
      // Metadata for one connection: the Mac inspector and the Linear read
      // route build their grants from this. Secret material never leaves the
      // vault through here; the broker-only /use path unseals it.
      const loaded = await this.load(connectionRead[1] ?? "", request);
      if (loaded instanceof Response) return loaded;
      return Response.json(this.public(loaded));
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/connections/")) {
      return this.revoke(url, request);
    }
    if (request.method === "POST" && url.pathname === "/lease") {
      return this.lease(request, true);
    }
    if (request.method === "POST" && url.pathname === "/release") {
      return this.lease(request, false);
    }
    if (request.method === "POST" && url.pathname === "/use") {
      return this.use(request);
    }
    if (request.method === "POST" && url.pathname === "/rekey") {
      return this.rekey(request);
    }
    if (request.method === "POST" && url.pathname === "/tenant-wipe") {
      return this.tenantWipe(request);
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  private keyOrVaultError(): string | Response {
    const key = this.credEnv.CRED_KEY;
    if (!key) return Response.json({ error: "vault_not_configured" }, { status: 400 });
    return key;
  }

  private tenantOf(request: Request): string {
    return request.headers.get("x-tenant") ?? "";
  }

  private async load(id: string, request: Request): Promise<ConnectionRec | Response> {
    const record = await this.ctx.storage.get<StoredConnectionRec>(`conn:${id}`);
    if (!record || record.revokedAt) return Response.json({ error: "not_found" }, { status: 404 });
    const tenant = this.tenantOf(request);
    if (record.tenant !== tenant) return Response.json({ error: "not_found" }, { status: 404 });
    // Records sealed before granted scope existed carry none of it: they read
    // (adapters fall back to safe defaults) but never dispatch until reviewed.
    return { resourceIds: [], allowsActions: false, grantRevision: 1, ...record };
  }

  private async store(request: Request): Promise<Response> {
    const key = this.keyOrVaultError();
    if (typeof key !== "string") return key;
    let body: {
      tenant?: unknown;
      provider?: unknown;
      accountId?: unknown;
      scopes?: unknown;
      refreshToken?: unknown;
      resourceIds?: unknown;
      allowsActions?: unknown;
    };
    const stored = await readJsonBody<typeof body>(request, MAX_BODY_BYTES);
    if (!stored.ok) return Response.json({ error: stored.error }, { status: stored.status });
    body = stored.value;
    const headerTenant = this.tenantOf(request);
    // The tenant comes from the verified session header; a client-supplied
    // tenant that disagrees is rejected rather than trusted.
    if (
      typeof body.tenant !== "string" ||
      body.tenant.length === 0 ||
      (headerTenant && body.tenant !== headerTenant) ||
      typeof body.provider !== "string" ||
      !KNOWN_PROVIDERS.has(body.provider) ||
      typeof body.accountId !== "string" ||
      body.accountId.length === 0 ||
      body.accountId.length > 256 ||
      !Array.isArray(body.scopes) ||
      !body.scopes.every((scope): scope is string => typeof scope === "string") ||
      typeof body.refreshToken !== "string" ||
      body.refreshToken.length === 0 ||
      body.refreshToken.length > 8192 ||
      (body.resourceIds !== undefined &&
        (!Array.isArray(body.resourceIds) ||
          body.resourceIds.length > MAX_RESOURCE_IDS ||
          !body.resourceIds.every(
            (id): id is string => typeof id === "string" && id.length > 0 && id.length <= MAX_RESOURCE_ID_LENGTH,
          ))) ||
      (body.allowsActions !== undefined && typeof body.allowsActions !== "boolean")
    ) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const id = crypto.randomUUID();
    const record: ConnectionRec = {
      id,
      tenant: body.tenant,
      provider: body.provider,
      accountId: body.accountId,
      scopes: [...body.scopes],
      sealed: await sealSecret(body.refreshToken, key),
      createdAt: new Date().toISOString(),
      revokedAt: null,
      refreshLeaseUntil: 0,
      // The granted slice is set once, at connection time. Narrowing or widening
      // it later is a reviewed grant change with its own revision, not an edit
      // here. The revision starts at 1 and is never client-supplied.
      resourceIds: Array.isArray(body.resourceIds) ? [...(body.resourceIds as string[])] : [],
      allowsActions: body.allowsActions === true,
      grantRevision: 1,
    };
    // No per-tenant index: the vault itself is per-tenant (M4 phase 2), so
    // listing scans this object's connections directly.
    await this.ctx.storage.put(`conn:${id}`, record);
    return Response.json({ id });
  }

  private async list(url: URL, request: Request): Promise<Response> {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!tenant || tenant !== this.tenantOf(request)) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const connections = [];
    for (const [, record] of await this.ctx.storage.list<ConnectionRec>({ prefix: "conn:" })) {
      if (!record.revokedAt) connections.push(this.public(record));
    }
    return Response.json({ connections });
  }

  /// When the tenant first connected one provider: the earliest creation time
  /// among its connections to it, revoked ones included, since revocation keeps
  /// the record (without its secret). Only that time leaves, nothing else about
  /// any connection. The Manut AI pilot gate reads it as the trial start of a
  /// shop that was connected before trial starts were recorded on the shop.
  private async firstConnection(url: URL, request: Request): Promise<Response> {
    const tenant = url.searchParams.get("tenant") ?? "";
    const provider = url.searchParams.get("provider") ?? "";
    if (!tenant || tenant !== this.tenantOf(request) || !KNOWN_PROVIDERS.has(provider)) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    let first: { createdAt: string; ms: number } | null = null;
    for (const [, record] of await this.ctx.storage.list<StoredConnectionRec>({ prefix: "conn:" })) {
      if (record.tenant !== tenant || record.provider !== provider) continue;
      const ms = Date.parse(record.createdAt);
      if (Number.isFinite(ms) && (first === null || ms < first.ms)) first = { createdAt: record.createdAt, ms };
    }
    return Response.json({ createdAt: first?.createdAt ?? null });
  }

  private async revoke(url: URL, request: Request): Promise<Response> {
    const id = url.pathname.split("/")[2] ?? "";
    const record = await this.load(id, request);
    if (record instanceof Response) return record;
    // Revocation wipes secret material but keeps the tombstone, so a
    // restored backup cannot quietly resurrect a live credential.
    const tombstone: ConnectionRec = {
      ...record,
      sealed: { keyTag: "", iv: "", data: "" },
      revokedAt: new Date().toISOString(),
      refreshLeaseUntil: 0,
    };
    await this.ctx.storage.put(`conn:${id}`, tombstone);
    return Response.json({ revoked: true });
  }

  /// Serializes provider refreshes per connection: a holder extends the
  /// lease, a contender inside the window gets 409, releasing clears it.
  private async lease(request: Request, acquire: boolean): Promise<Response> {
    let body: { id?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    if (typeof body.id !== "string") return Response.json({ error: "invalid_request" }, { status: 400 });
    const record = await this.load(body.id, request);
    if (record instanceof Response) return record;
    const now = Date.now() / 1000;
    if (acquire) {
      if (record.refreshLeaseUntil > now) {
        return Response.json({ error: "refresh_in_progress" }, { status: 409 });
      }
      await this.ctx.storage.put(`conn:${record.id}`, {
        ...record,
        refreshLeaseUntil: now + REFRESH_LEASE_SECONDS,
      });
      return Response.json({ lease: true });
    }
    await this.ctx.storage.put(`conn:${record.id}`, { ...record, refreshLeaseUntil: 0 });
    return Response.json({ lease: false });
  }

  /// Broker-internal plaintext read. No worker route exposes this: only
  /// broker code holding the binding calls it, and the tenant must match.
  private async use(request: Request): Promise<Response> {
    const key = this.keyOrVaultError();
    if (typeof key !== "string") return key;
    let body: { id?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    if (typeof body.id !== "string") return Response.json({ error: "invalid_request" }, { status: 400 });
    const record = await this.load(body.id, request);
    if (record instanceof Response) return record;
    try {
      const refreshToken = await openSecret(record.sealed, key, this.credEnv.CRED_KEY_PREVIOUS);
      return Response.json({ refreshToken });
    } catch {
      return Response.json({ error: "unseal_failed" }, { status: 500 });
    }
  }

  /// Re-seals a record under the current key after an operator rotation.
  private async rekey(request: Request): Promise<Response> {
    const key = this.keyOrVaultError();
    if (typeof key !== "string") return key;
    let body: { id?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    if (typeof body.id !== "string") return Response.json({ error: "invalid_request" }, { status: 400 });
    const record = await this.load(body.id, request);
    if (record instanceof Response) return record;
    let plaintext: string;
    try {
      plaintext = await openSecret(record.sealed, key, this.credEnv.CRED_KEY_PREVIOUS);
    } catch {
      return Response.json({ error: "unseal_failed" }, { status: 500 });
    }
    const sealed = await sealSecret(plaintext, key);
    await this.ctx.storage.put(`conn:${record.id}`, { ...record, sealed });
    return Response.json({ rekeyed: true, keyTag: sealed.keyTag });
  }

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
    // The vault is per-tenant, so wiping is deleting every connection record, and every site sign-in, outpost and
    // sign-in grant (sign-in-vault.ts).
    const keys: string[] = [];
    for (const [key] of await this.ctx.storage.list({ prefix: "conn:" })) {
      keys.push(key);
    }
    await this.ctx.storage.delete(keys);
    const signIns = await wipeSignInVault(this.ctx.storage);
    return Response.json({ connectionsWiped: keys.length, ...signIns });
  }

  private public(record: ConnectionRec): object {
    return {
      id: record.id,
      provider: record.provider,
      accountId: record.accountId,
      scopes: record.scopes,
      resourceIds: record.resourceIds ?? [],
      allowsActions: record.allowsActions ?? false,
      grantRevision: record.grantRevision ?? 1,
      createdAt: record.createdAt,
    };
  }
}
