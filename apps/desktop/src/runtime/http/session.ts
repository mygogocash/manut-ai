// The desktop's session with apps/api, through the sign-in the backend lifted from GoSpark has (apps/api/src/
// auth-object.ts): `POST /v1/auth/exchange` turns a Sign in with Apple identity token into an access token (one hour)
// and a refresh token, `POST /v1/auth/refresh` rotates both, and `DELETE /v1/auth/session` ends them.
//
// The desktop cannot get an Apple identity token by itself yet: that needs the app signed with the owner's Apple
// developer team and `APPLE_CLIENT_ID` set on the Worker (docs/runtime-adapter.md). Until then Settings › Developer
// takes an identity token and its nonce by hand, which is enough to run the whole path against a local API that trusts
// the test key. Everything after the exchange is the real path.
//
// Rules this module keeps:
// - The session lives in the keychain (`SessionVault`), as one JSON value that names the origin it belongs to. It is
//   never sent to another origin, never put in an address, and never logged or shown.
// - The access token is refreshed five minutes before it expires and is never sent after that. The API's verify step
//   deletes the refresh grant too when it sees an expired access token, so sending one would sign the computer out.
// - Refreshes are one at a time. Each rotates both tokens, so two at once would spend the same refresh token twice and
//   the second would end the session.
// - A 401 gets one refresh and one retry. A second 401, or a refresh the API refuses, ends the session here.
// - The same keychain item keeps the shop sessions (docs/several-shops.md): one token per shop the person acts for, by
//   shop id (shops.ts opens and uses them). Every change to the item, a refresh's new tokens or a shop session kept or
//   dropped, is written in turn and writes everything held at that moment, so no write ever puts back what a later one
//   replaced. Signing out ends every shop session on the API too, and forgets them here whatever the API said.
import { LinkDown, VaultUnavailable, type FetchLike, type SessionVault } from "./shell";

/** How long before expiry the access token is replaced. */
export const REFRESH_EARLY_MS = 5 * 60_000;
/** An identity token or nonce longer than these is not one; the API's own body limit is far above both. */
const MAX_IDENTITY = 16 * 1024;
const MAX_NONCE = 1024;
/** The longest shop id the API makes or takes (`isValidTenant` in apps/api). */
const MAX_SHOP_ID = 256;

/** One shop session as the keychain keeps it: the bearer token the API gave for that one shop, the role that shop's record
 *  gives this person there, and when it ends. It lasts 30 days and has no refresh; the app opens the shop again with the
 *  sign-in after that (shops.ts). */
export interface ShopSessionRecord {
  role: "owner" | "helper";
  accessToken: string;
  /** ms since epoch, on this computer's clock */
  expiresAt: number;
}

/** The keychain's copy of the session. Times are ms since epoch on this computer's clock. */
export interface StoredSession {
  /** 2 since the item keeps the shop sessions too. A value of 1, which keeps none, is still read: as one with none. */
  v: 1 | 2;
  /** the API it belongs to; it is never sent anywhere else */
  origin: string;
  /** the backend's tenant for this identity (`apple:<subject>`) */
  tenant: string;
  /** the device id the grant was issued to; `/refresh` checks it */
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  /** when the access token stops working, counted from when its answer arrived */
  accessExpiresAt: number;
  /** when this computer signed in; the API ends the whole chain 90 days after it */
  signedInAt: number;
  /** the shop sessions this computer holds, by shop id; absent in a value of version 1 */
  shops?: Record<string, ShopSessionRecord>;
}

export type SignInFailure = "invalid_identity" | "not_configured" | "rate_limited" | "offline" | "unavailable" | "keychain";

export type SignInState =
  | { kind: "loading" }
  /** this computer's shell keeps no keychain item yet (only macOS does), so Connected cannot sign in */
  | { kind: "no_keychain" }
  | { kind: "signing_in" }
  | { kind: "signed_in"; tenant: string; signedInAt: number }
  /** `failure`: why the last sign-in did not happen; `ended`: the API ended the session */
  | { kind: "signed_out"; failure?: SignInFailure; ended?: "expired" };

/** What an authorised read came back with. */
export type Answer =
  | { kind: "ok"; status: number; json: unknown }
  /** a 4xx other than 401, with the API's own `error` code ("" when it sent none) */
  | { kind: "refused"; status: number; code: string; json: unknown }
  | { kind: "signed_out" }
  | { kind: "offline" }
  /** a 5xx, an answer that is not JSON, or a request the shell could not make */
  | { kind: "unavailable"; status?: number };

type Raw = { kind: "answer"; status: number; text: string } | { kind: "offline" } | { kind: "unavailable" };
type Refreshed = "ok" | "signed_out" | "offline" | "unavailable";

export interface SessionOptions {
  origin: string;
  fetch: FetchLike;
  vault: SessionVault;
  now?: () => number;
  /** a new device id for each sign-in */
  deviceId?: () => string;
  /** Called whenever a session this computer held ends (signed out here, ended by the API) or is replaced by a new
   *  sign-in, so what was read with it, the saved read of the shop, is forgotten with it. It runs before anything
   *  waits on the API. A failure in it never stops a sign-out. */
  onEnd?: () => unknown;
}

const text = (v: unknown, max = 8192): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** The token pair an exchange or a refresh answers, or null for anything else. */
function decodePair(body: string): { accessToken: string; refreshToken: string; tenant: string; expiresIn: number } | null {
  const v = parse(body) as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object") return null;
  const { accessToken, refreshToken, tenant, expiresIn } = v;
  if (!text(accessToken) || !text(refreshToken) || !text(tenant, 512)) return null;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return { accessToken, refreshToken, tenant, expiresIn };
}

/** The shop sessions of a stored value, each one whole. An entry that is not one is left out rather than failing the whole
 *  value: that shop is opened again with the sign-in, while a value read as nothing would sign the person out. */
function decodeShops(v: unknown): Record<string, ShopSessionRecord> {
  const out: Record<string, ShopSessionRecord> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [shop, s] of Object.entries(v as Record<string, unknown>)) {
    if (!text(shop, MAX_SHOP_ID) || !s || typeof s !== "object") continue;
    const { role, accessToken, expiresAt } = s as Partial<ShopSessionRecord>;
    if ((role !== "owner" && role !== "helper") || !text(accessToken) || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) continue;
    out[shop] = { role, accessToken, expiresAt };
  }
  return out;
}

/** The keychain's value as a session, or null when it is not one this version or the one before it wrote. */
function decodeStored(raw: string | null): StoredSession | null {
  const v = raw ? (parse(raw) as Partial<StoredSession> | undefined) : undefined;
  if (!v || typeof v !== "object" || (v.v !== 1 && v.v !== 2)) return null;
  const { origin, tenant, deviceId, accessToken, refreshToken, accessExpiresAt, signedInAt } = v;
  if (!text(origin) || !text(tenant, 512) || !text(deviceId, 128) || !text(accessToken) || !text(refreshToken)) return null;
  if (typeof accessExpiresAt !== "number" || typeof signedInAt !== "number") return null;
  return { v: 2, origin, tenant, deviceId, accessToken, refreshToken, accessExpiresAt, signedInAt, shops: v.v === 2 ? decodeShops(v.shops) : {} };
}

/** Why `/v1/auth/exchange` said no, in the words Settings shows. */
function exchangeFailure(status: number, body: string): SignInFailure {
  const code = (parse(body) as { error?: unknown } | undefined)?.error;
  if (status === 400 && code === "identity_not_configured") return "not_configured";
  if (status === 400 || status === 401) return "invalid_identity";
  if (status === 429) return "rate_limited";
  return "unavailable";
}

export class ApiSession {
  readonly origin: string;
  state: SignInState = { kind: "loading" };
  private readonly fetch: FetchLike;
  private readonly vault: SessionVault;
  private readonly now: () => number;
  private readonly newDeviceId: () => string;
  private readonly onEnd: (() => unknown) | undefined;
  /** The sign-in this computer holds; its shop sessions are kept apart, in `shops`. */
  private record: StoredSession | null = null;
  /** The shop sessions held with the sign-in, by shop id. Only while signed in: a sign-out or an ended sign-in clears it. */
  private shops = new Map<string, ShopSessionRecord>();
  /** Moves on with every sign-in and every end of one, so an answer that arrives later can tell it is for a sign-in that
   *  is over (`keepShopSession`). */
  private chain = 0;
  /** Another origin's session found in the keychain item, which holds one session at a time. It is never sent here;
   *  a sign-in here ends it on its own API first, so overwriting the item never leaves it live there. */
  private foreign: StoredSession | null = null;
  private loading: Promise<void> | null = null;
  private refreshing: Promise<Refreshed> | null = null;
  private signingIn: Promise<SignInState> | null = null;
  /** The keychain item's changes, one after another in the order they were asked (`inTurn`). */
  private vaultTail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(s: SignInState) => void>();

  constructor(opts: SessionOptions) {
    this.origin = opts.origin;
    this.fetch = opts.fetch;
    this.vault = opts.vault;
    this.now = opts.now ?? Date.now;
    this.newDeviceId = opts.deviceId ?? (() => crypto.randomUUID());
    this.onEnd = opts.onEnd;
  }

  subscribe(fn: (s: SignInState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Reads the keychain once. A session for another origin reads as signed out here and is never sent here. */
  load(): Promise<void> {
    return (this.loading ??= this.readVault());
  }

  /** Exchanges an identity token and its raw nonce for a session and keeps it in the keychain. The session the
   *  keychain held before (this origin's or another's) is ended first, so a sign-in never leaves one live on an API. */
  async signIn(identityToken: string, nonce: string): Promise<SignInState> {
    await this.load();
    if (this.state.kind === "no_keychain") return this.state;
    if (this.signingIn) return this.signingIn;
    const token = identityToken.trim();
    const raw = nonce.trim();
    if (!token || !raw || token.length > MAX_IDENTITY || raw.length > MAX_NONCE) return this.set({ kind: "signed_out", failure: "invalid_identity" });
    this.signingIn = (async () => {
      if (this.record) await this.signOut();
      else if (this.foreign) await this.endForeign(this.foreign);
      return this.exchange(token, raw);
    })().finally(() => {
      this.signingIn = null;
    });
    return this.signingIn;
  }

  /** Ends the session on the API, with every shop session held with it, then forgets them all here whatever the API
   *  said. `revoked` is false when the API could not be told of one of them; the tokens are gone from this computer
   *  either way. */
  async signOut(): Promise<{ revoked: boolean }> {
    await this.load();
    const rec = this.record;
    if (!rec) {
      if (this.state.kind !== "no_keychain") this.set({ kind: "signed_out" });
      // Nothing is held, but a read kept from an earlier session may be: signing out forgets it all the same.
      await this.ended();
      return { revoked: false };
    }
    // Nothing uses the session from here on, so a refresh answering late cannot bring it back (see `rotate`), and a shop
    // opened while this runs is not kept with it (`keepShopSession`).
    const shops = this.letGo();
    // What was read with the session goes first, without waiting on the API, which may be slow or out of reach.
    await this.ended();
    // The sign-in and each shop session end on the API together (docs/pilot-api.md, "Ending a shop session"): a shop
    // session does not end with the sign-in there, so leaving one out would leave it working for up to 30 days.
    const [res, ...shopsEnded] = await Promise.all([
      this.send("DELETE", "/v1/auth/session", rec.accessToken),
      ...shops.map((s) => this.endShopSession(s.accessToken)),
    ]);
    const revoked = res.kind === "answer" && res.status === 200 && shopsEnded.every(Boolean);
    try {
      await this.wipe();
      this.set({ kind: "signed_out" });
    } catch {
      this.set({ kind: "signed_out", failure: "keychain" });
    }
    return { revoked };
  }

  /** The shop session this computer holds for `shop`, or null. */
  shopSession(shop: string): ShopSessionRecord | null {
    return this.record ? (this.shops.get(shop) ?? null) : null;
  }

  /** The shops this computer holds a session for. */
  heldShops(): string[] {
    return this.record ? [...this.shops.keys()] : [];
  }

  /** Where the sign-in stands now: `keepShopSession` takes it, so a shop session opened under a sign-in that has ended since
   *  is never kept under the next one. */
  get signInChain(): number {
    return this.chain;
  }

  /** Keeps a shop session with the sign-in, in the keychain item, when the sign-in it was opened under (`chain`) is still
   *  the one held. Otherwise the person signed out, or someone else signed in, while it was being opened: it is ended on
   *  the API at once, so none is left working, and false says it was not kept. A keychain that refuses the write leaves it
   *  working for this run; the next start opens the shop again. */
  async keepShopSession(shop: string, s: ShopSessionRecord, chain: number): Promise<boolean> {
    await this.load();
    if (!this.record || chain !== this.chain) {
      void this.endShopSession(s.accessToken);
      return false;
    }
    this.shops.set(shop, s);
    await this.save().catch(() => undefined);
    return true;
  }

  /** Forgets the sessions of these shops here: the shop left the person's list, or the API ended its session. */
  async dropShopSessions(shops: readonly string[]): Promise<void> {
    let changed = false;
    for (const shop of shops) changed = this.shops.delete(shop) || changed;
    if (changed) await this.save().catch(() => undefined);
  }

  /** A request with `bearer`, a shop session's token, in place of the sign-in's, and with none of the sign-in's rules: a
   *  shop session has no refresh, and what a 401 from it means is shops.ts's to say. The token is sent only as the
   *  bearer, to this session's own origin. */
  async sendAs(bearer: string, method: "GET" | "POST", path: string, body?: unknown): Promise<Answer> {
    return answerOf(await this.send(method, path, bearer, body));
  }

  /** An authorised GET of `path` (`/v1/...`). */
  read(path: string): Promise<Answer> {
    return this.authorised("GET", path);
  }

  /** An authorised POST of `body`, as JSON, to `path` (`/v1/...`): answering an ask. It is sent once, and once more only
   *  after a 401, which the API answers from the session before it reads the body, so the first one decided nothing. A
   *  request that got no answer is never sent again from here: the API may have it. */
  write(path: string, body: unknown): Promise<Answer> {
    return this.authorised("POST", path, body);
  }

  // ---- inside ---------------------------------------------------------------------------------------------------

  private async authorised(method: "GET" | "POST", path: string, body?: unknown): Promise<Answer> {
    await this.load();
    let rec = this.record;
    if (!rec) return { kind: "signed_out" };
    if (rec.accessExpiresAt - this.now() < REFRESH_EARLY_MS) {
      const refreshed = await this.refreshFor(rec.accessToken);
      if (refreshed !== "ok") return { kind: refreshed };
      rec = this.record;
      if (!rec) return { kind: "signed_out" };
    }
    const used = rec.accessToken;
    let res = await this.send(method, path, used, body);
    if (res.kind === "answer" && res.status === 401 && !removed(res)) {
      const refreshed = await this.refreshFor(used);
      if (refreshed !== "ok") return { kind: refreshed };
      const again = this.record;
      if (!again) return { kind: "signed_out" };
      res = await this.send(method, path, again.accessToken, body);
      if (res.kind === "answer" && res.status === 401 && !removed(res)) {
        await this.end();
        return { kind: "signed_out" };
      }
    }
    // A helper the owner removed is signed out of the shop on every device at once (docs/people.md); no refresh brings
    // that back. The session ends here too, with what was read with it, and the answer is kept so the card can say when.
    if (removed(res)) await this.end();
    return answerOf(res);
  }

  private set(s: SignInState): SignInState {
    this.state = s;
    for (const fn of [...this.listeners]) fn(s);
    return s;
  }

  private async readVault(): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.vault.read();
    } catch (e) {
      this.set(e instanceof VaultUnavailable ? { kind: "no_keychain" } : { kind: "signed_out", failure: "keychain" });
      return;
    }
    const rec = decodeStored(raw);
    if (rec && rec.origin === this.origin) {
      const { shops, ...signIn } = rec;
      this.record = signIn;
      this.shops = new Map(Object.entries(shops ?? {}));
      this.set({ kind: "signed_in", tenant: rec.tenant, signedInAt: rec.signedInAt });
    } else {
      this.foreign = rec;
      this.set({ kind: "signed_out" });
    }
  }

  private async exchange(identityToken: string, nonce: string): Promise<SignInState> {
    this.set({ kind: "signing_in" });
    const deviceId = this.newDeviceId();
    const res = await this.send("POST", "/v1/auth/exchange", null, { provider: "apple", identityToken, nonce, deviceId });
    if (res.kind !== "answer") return this.set({ kind: "signed_out", failure: res.kind });
    if (res.status !== 200) return this.set({ kind: "signed_out", failure: exchangeFailure(res.status, res.text) });
    const pair = decodePair(res.text);
    if (!pair) return this.set({ kind: "signed_out", failure: "unavailable" });
    const now = this.now();
    const rec: StoredSession = {
      v: 2,
      origin: this.origin,
      tenant: pair.tenant,
      deviceId,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessExpiresAt: now + pair.expiresIn * 1000,
      signedInAt: now,
    };
    try {
      // A new sign-in holds no shop session yet: the ones of the session it replaced were ended with it.
      await this.inTurn(() => this.vault.write(JSON.stringify({ ...rec, shops: {} })));
    } catch {
      // A session this computer cannot keep would be lost at the next start while staying live on the API for up to
      // 30 days, so it is ended at once.
      await this.send("DELETE", "/v1/auth/session", rec.accessToken);
      return this.set({ kind: "signed_out", failure: "keychain" });
    }
    this.record = rec;
    this.shops = new Map();
    this.chain += 1;
    return this.set({ kind: "signed_in", tenant: rec.tenant, signedInAt: rec.signedInAt });
  }

  /** Ends another origin's session, and each shop session held with it, on that origin's own API (best effort: the item
   *  is overwritten either way). */
  private async endForeign(rec: StoredSession): Promise<void> {
    this.foreign = null;
    await this.ended();
    await Promise.all([
      this.send("DELETE", "/v1/auth/session", rec.accessToken, undefined, rec.origin),
      ...Object.values(rec.shops ?? {}).map((s) => this.endShopSession(s.accessToken, rec.origin)),
    ]);
  }

  /** Ends one shop session on the API (`POST /v1/shops/session/end`, the session itself as the bearer, exactly `{}`).
   *  True when it is over there: ended now, or already refused (a 401 says no shop takes it any more). */
  private async endShopSession(token: string, origin = this.origin): Promise<boolean> {
    const res = await this.send("POST", "/v1/shops/session/end", token, {}, origin);
    return res.kind === "answer" && (res.status === 200 || res.status === 401);
  }

  /** Stops holding the sign-in and its shop sessions, in memory, and answers the shop sessions it held. */
  private letGo(): ShopSessionRecord[] {
    const shops = [...this.shops.values()];
    this.record = null;
    this.shops = new Map();
    this.chain += 1;
    return shops;
  }

  /** One change to the keychain item at a time, in the order asked. A change that fails never stops the ones after it. */
  private inTurn<T>(job: () => Promise<T>): Promise<T> {
    const run = this.vaultTail.then(job, job);
    this.vaultTail = run.catch(() => undefined);
    return run;
  }

  /** Writes what is held when the write's turn comes: the sign-in and its shop sessions. Nothing is written once nothing
   *  is held, so a write asked before a sign-out never puts the item back after the sign-out cleared it. */
  private save(): Promise<void> {
    return this.inTurn(async () => {
      if (!this.record) return;
      await this.vault.write(JSON.stringify({ ...this.record, v: 2, shops: Object.fromEntries(this.shops) }));
    });
  }

  private wipe(): Promise<void> {
    return this.inTurn(() => this.vault.clear());
  }

  /** Refreshes unless the token a request used was already replaced (another request's refresh got there first). */
  private refreshFor(used: string): Promise<Refreshed> {
    if (!this.record) return Promise.resolve("signed_out");
    if (this.record.accessToken !== used) return Promise.resolve("ok");
    return (this.refreshing ??= this.rotate().finally(() => {
      this.refreshing = null;
    }));
  }

  private async rotate(): Promise<Refreshed> {
    const rec = this.record;
    if (!rec) return "signed_out";
    const res = await this.send("POST", "/v1/auth/refresh", null, { refreshToken: rec.refreshToken, deviceId: rec.deviceId });
    if (res.kind !== "answer") return res.kind;
    if (res.status === 401) {
      // invalid_grant or session_expired: the API ended the chain (90 days, a wipe, or a token already spent).
      if (this.record === rec) await this.end();
      return "signed_out";
    }
    const pair = res.status === 200 ? decodePair(res.text) : null;
    if (!pair) return "unavailable";
    const next: StoredSession = {
      ...rec,
      tenant: pair.tenant,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessExpiresAt: this.now() + pair.expiresIn * 1000,
    };
    if (this.record !== rec) {
      // Signed out while this refresh ran: the sign-out ended the old pair, so end the new one too.
      await this.send("DELETE", "/v1/auth/session", next.accessToken);
      return "signed_out";
    }
    this.record = next;
    // In turn with every other change to the item, and with the shop sessions held by then, so a shop kept while this
    // refresh was on its way is written too.
    await this.save().catch(() => {
      // The old pair in the keychain is spent now. The new one keeps this run working; the next start will find the
      // old pair refused and sign in again. Nothing better can be done without a keychain that takes writes.
    });
    return "ok";
  }

  /** The API ended the session: forget it here, with the shop sessions held with it. Those do not end with the sign-in on
   *  the API, so they are ended there as a sign-out ends them; nothing waits on that. */
  private async end(): Promise<void> {
    const shops = this.letGo();
    await this.ended();
    for (const s of shops) void this.endShopSession(s.accessToken);
    await this.wipe().catch(() => undefined);
    this.set({ kind: "signed_out", ended: "expired" });
  }

  /** Tells whoever kept something read with the session that it is over. */
  private async ended(): Promise<void> {
    try {
      await this.onEnd?.();
    } catch {
      // Whatever it could not forget, the session still ends.
    }
  }

  private async send(method: "GET" | "POST" | "DELETE", path: string, bearer: string | null, body?: unknown, origin = this.origin): Promise<Raw> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      const res = await this.fetch(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { kind: "answer", status: res.status, text: await res.text() };
    } catch (e) {
      return { kind: e instanceof LinkDown && e.kind === "offline" ? "offline" : "unavailable" };
    }
  }
}

/** The API's 401 for a helper the owner removed (`removed`, with `removedAt`), as opposed to a session that only needs a
 *  refresh. */
function removed(res: Raw): boolean {
  return res.kind === "answer" && res.status === 401 && (parse(res.text) as { error?: unknown } | undefined)?.error === "removed";
}

/** A raw answer as the runtime reads it: JSON on a 2xx, the API's error code on a 4xx, unavailable otherwise. */
function answerOf(res: Raw): Answer {
  if (res.kind !== "answer") return res.kind === "offline" ? { kind: "offline" } : { kind: "unavailable" };
  const json = parse(res.text);
  if (res.status >= 200 && res.status < 300) return json === undefined ? { kind: "unavailable", status: res.status } : { kind: "ok", status: res.status, json };
  if (res.status >= 400 && res.status < 500) {
    const code = json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error : "";
    return { kind: "refused", status: res.status, code, json: json ?? null };
  }
  return { kind: "unavailable", status: res.status };
}
