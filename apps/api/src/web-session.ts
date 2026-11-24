/// The owner's web app's session (docs/web-app.md; docs/pilot-api.md, "The web app's session"), and the one place the API
/// reads a cookie.
///
/// The app a person adds to their phone's home screen (apps/web, `/app/`) signs them in with a code sent to their email, as
/// the join page does, and keeps the sign-in after the app is closed. It keeps it in cookies this API sets and the page's
/// own script cannot read (`HttpOnly`), so no token ever reaches the page, and none can be taken from it by a script that
/// should not be there:
///
/// - `__Host-manut-sign-in`: the person's sign-in of the lifted auth, as its device id and refresh token, for the 30 days a
///   refresh lasts, renewed by each refresh up to the lifted auth's own cap of 90 days;
/// - `__Host-manut-access`: that sign-in's access token, for the hour it lasts;
/// - `__Host-manut-shop-<16 hex>`: one shop session for each shop the person is in (`mos1.` as its owner, `mhs1.` as a
///   helper), with the id it decides as, for the 30 days it lasts less an hour, so a session about to end is never sent.
///
/// Every route here is the app's alone, and this is the only code in the API that reads those cookies. Every other route
/// takes a bearer token in its `Authorization` header and nothing else, so no route the desktop or a helper's app calls
/// ever accepts a credential a browser sends by itself. Each route here hands the request to the route that does the work,
/// with the right bearer from the cookies: the person's own routes for their shops (`GET /v1/shops`,
/// `POST /v1/shops/session`, `POST /v1/shops/session/end`), the lifted auth to sign in, refresh and sign out, and the
/// shop's approvals with that shop's own session (`GET /v1/approvals`, `POST /v1/approvals/{requestId}/decision`). So a
/// decision made here is made by the same code, under the same session and role, as one from the desktop, and goes through
/// approval-core's rules in the request's own task.
///
/// Against requests another site makes a browser send (CSRF), three things, each enough alone for a browser that keeps to
/// the standards: the cookies are `SameSite=Strict`, so a browser sends none with a request another site starts; every
/// route needs the header `x-manut-web: 1`, which a page on another origin can send only after a CORS preflight that this
/// API never answers; and a request that says where it comes from (`Origin`, `Sec-Fetch-Site`) must say this origin, which
/// every change must say. The `__Host-` prefix makes the browser keep each cookie to this exact host, `Secure` and on
/// every path, so another host under the same domain can neither set one nor shadow it.
///
/// No answer here carries a token. The page learns that someone is signed in and which shops they are in, never a
/// credential, and every answer is `no-store`.

import { isValidTenant } from "./companies";
import { approvalsRoute, type ApprovalsEnv } from "./approvals";
import { sha256Hex } from "./auth";
import { readBodyBytes, readJsonBody } from "./body";
import { emailExchange, emailSignIn, type EmailSignInEnv } from "./email-code";
import type { JobFlags } from "./job-flow";
import { hasExactly } from "./people";
import { shopsRoute } from "./shops";
import { authCall, type TenantDataEnv } from "./tenant-data";

export type WebSessionEnv = ApprovalsEnv & TenantDataEnv & EmailSignInEnv;

export const SIGN_IN_COOKIE = "__Host-manut-sign-in";
export const ACCESS_COOKIE = "__Host-manut-access";
export const SHOP_COOKIE_PREFIX = "__Host-manut-shop-";
/// The header every route here needs. A page on another origin cannot send it without a CORS preflight, which nothing in
/// this API answers.
export const WEB_HEADER = "x-manut-web";

/// How long the sign-in cookie lasts: the 30 days a refresh token lasts (`REFRESH_TTL_SECONDS` in auth-object.ts). Each
/// refresh sets it again, and the lifted auth ends the chain after 90 days whatever the cookie says.
export const SIGN_IN_MAX_AGE = 30 * 24 * 3600;
/// The access cookie goes this long before its token ends, so a token about to end is never sent.
const ACCESS_EARLY_SECONDS = 60;
/// A shop cookie goes an hour before its session ends, and the next read of the person's shops opens a new one.
const SHOP_EARLY_SECONDS = 3600;
const MAX_BODY_BYTES = 16 * 1024;
/// A token of the lifted auth: 32 random bytes in hex (auth-object.ts, `randomToken`).
const LIFTED_TOKEN = /^[0-9a-f]{64}$/;
/// The device id this route mints for a sign-in: `web-` and a UUID. The page never names one.
const WEB_DEVICE = /^web-[0-9a-f-]{36}$/;
/// A shop session (people.ts): the kind, the shop in base64url and 32 random bytes in hex.
const SHOP_TOKEN = /^(mos1|mhs1)\.([A-Za-z0-9_-]{1,512})\.([0-9a-f]{64})$/;
/// Who a shop session decides as: an owner account's id or a helper's, as the shop's record names them.
const DECIDER = /^[A-Za-z0-9_.:-]{1,128}$/;

type Role = "owner" | "helper";

/// What the browser sent: the sign-in, its access token, and the shop sessions by cookie name.
type Jar = {
  signIn: { deviceId: string; refresh: string } | null;
  access: string | null;
  shops: Map<string, { as: string; token: string }>;
};

/// A shop as the app is told of it: who owns it, the person's role there and the id their decisions name, and whether a
/// session for it is ready. Never its session.
type ShopView = { id: string; name: string; ownerName: string; role: Role; you: string | null; ready: boolean };

/// `/v1/web/*`. Answers null for every other path. The browser checks come first, before the method or the cookies, so a
/// request another site made a browser send learns nothing, not even which routes exist.
export async function webSessionRoute(request: Request, url: URL, env: WebSessionEnv, ctx: ExecutionContext,
  flags: JobFlags): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/web/")) return null;
  const refused = fromThisApp(request, url);
  if (refused) return refused;
  const jar = cookiesOf(request);
  const decision = /^\/v1\/web\/approvals\/([^/]+)\/decision$/.exec(url.pathname);
  try {
    if (url.pathname === "/v1/web/sign-in") return await signIn(request, url, env, ctx, jar);
    if (url.pathname === "/v1/web/shops") return await shops(request, url, env, ctx, jar);
    if (url.pathname === "/v1/web/sign-out") return await signOut(request, url, env, ctx, jar);
    if (url.pathname === "/v1/web/approvals") return await approvals(request, url, env, flags, jar);
    if (decision?.[1]) return await decide(request, url, env, flags, jar, decision[1]);
  } catch {
    return answer({ error: "web_unavailable" }, 503);
  }
  return answer({ error: "not_found" }, 404);
}

// ---------------------------------------------------------------------------
// The browser's side
// ---------------------------------------------------------------------------

/// The refusal for a request this app's page did not make, or null. The header is needed on every route, reads included,
/// so no plain link or form can reach one; a request that names its origin must name this one; and a change must name
/// it, as every browser does on a POST.
function fromThisApp(request: Request, url: URL): Response | null {
  if (request.headers.get(WEB_HEADER) !== "1") return answer({ error: "csrf_required" }, 403);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return answer({ error: "origin_forbidden" }, 403);
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return answer({ error: "origin_forbidden" }, 403);
  if (request.method !== "GET" && origin === null) return answer({ error: "origin_forbidden" }, 403);
  return null;
}

/// The cookies this file sets, as the browser sent them. A value that is not one of ours, in shape, is left out, so it is
/// never forwarded as a bearer.
function cookiesOf(request: Request): Jar {
  const jar: Jar = { signIn: null, access: null, shops: new Map() };
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === SIGN_IN_COOKIE && !jar.signIn) {
      const dot = value.lastIndexOf(".");
      const deviceId = value.slice(0, dot);
      const refresh = value.slice(dot + 1);
      if (dot > 0 && WEB_DEVICE.test(deviceId) && LIFTED_TOKEN.test(refresh)) jar.signIn = { deviceId, refresh };
    } else if (name === ACCESS_COOKIE && !jar.access) {
      if (LIFTED_TOKEN.test(value)) jar.access = value;
    } else if (name.startsWith(SHOP_COOKIE_PREFIX) && !jar.shops.has(name)) {
      const tilde = value.indexOf("~");
      const as = value.slice(0, tilde);
      const token = value.slice(tilde + 1);
      if (tilde > 0 && DECIDER.test(as) && SHOP_TOKEN.test(token)) jar.shops.set(name, { as, token });
    }
  }
  return jar;
}

/// The name of the cookie that holds the person's session for `shop`: the first 16 hex characters of the shop id's
/// SHA-256, since a shop id may hold characters a cookie name cannot.
export async function shopCookieName(shop: string): Promise<string> {
  return `${SHOP_COOKIE_PREFIX}${(await sha256Hex(shop)).slice(0, 16)}`;
}

/// The shop a shop session names, or null when it is not one. Naming a shop proves nothing; only that shop's record
/// holding the token does, which the route the token is sent to checks.
function tokenShop(token: string): string | null {
  const segment = SHOP_TOKEN.exec(token)?.[2];
  if (!segment) return null;
  try {
    const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${Math.max(0, Math.floor(maxAge))}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

function clearCookie(name: string): string {
  return `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

/// An answer of this file: JSON, never stored by a browser or a proxy, with the cookies it sets or clears.
function answer(body: unknown, status = 200, cookies: readonly string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// A body of exactly `{}`, or none at all; anything else is refused, so nothing a page adds is ever read.
async function emptyBody(request: Request): Promise<Response | null> {
  const read = await readBodyBytes(request, MAX_BODY_BYTES);
  if (!read.ok) return answer({ error: read.error }, read.status);
  if (read.value.byteLength === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(read.value));
  } catch {
    return answer({ error: "invalid_json" }, 400);
  }
  return isRecord(value) && Object.keys(value).length === 0 ? null : answer({ error: "invalid_request" }, 400);
}

// ---------------------------------------------------------------------------
// Handing a request on
// ---------------------------------------------------------------------------

/// A request to another route of this API, with `bearer` as its only credential and `body`, when given, as JSON.
function inner(url: URL, path: string, method: string, bearer: string, body?: unknown): { request: Request; url: URL } {
  const target = new URL(path, url.origin);
  const headers = new Headers({ authorization: `Bearer ${bearer}` });
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return { request: new Request(target, init), url: target };
}

async function jsonOf(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

/// The person's access token, refreshed with the sign-in cookie when there is none or `again` is asked, with the cookies
/// a refresh sets added to `cookies`. Null when there is no sign-in, or the lifted auth ended it; a refresh that fails
/// for any other reason throws, so it is answered as the API being unavailable rather than as signed out.
///
/// A refused refresh clears no cookie: two of the person's tabs refreshing at once send the same refresh token, the
/// first gets the next one and the second is refused, and clearing on that refusal would sign out the first as well. A
/// sign-in cookie that no longer works only fails again, until a new sign-in replaces it or it runs out.
async function accessOf(env: WebSessionEnv, jar: Jar, cookies: string[], again = false): Promise<string | null> {
  if (jar.access && !again) return jar.access;
  if (!jar.signIn) return null;
  const response = await authCall(env, "/refresh", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: jar.signIn.refresh, deviceId: jar.signIn.deviceId }) });
  if (response.status === 401) {
    await response.body?.cancel();
    return null;
  }
  const tokens = await jsonOf(response);
  if (!response.ok || !isRecord(tokens) || typeof tokens.accessToken !== "string" || !LIFTED_TOKEN.test(tokens.accessToken) ||
      typeof tokens.refreshToken !== "string" || !LIFTED_TOKEN.test(tokens.refreshToken)) {
    throw new Error("refresh_unavailable");
  }
  const life = typeof tokens.expiresIn === "number" ? tokens.expiresIn : 3600;
  jar.access = tokens.accessToken;
  jar.signIn = { deviceId: jar.signIn.deviceId, refresh: tokens.refreshToken };
  cookies.push(setCookie(ACCESS_COOKIE, tokens.accessToken, life - ACCESS_EARLY_SECONDS),
    setCookie(SIGN_IN_COOKIE, `${jar.signIn.deviceId}.${tokens.refreshToken}`, SIGN_IN_MAX_AGE));
  return tokens.accessToken;
}

/// Ends, best effort, every session the browser holds: each shop session through `POST /v1/shops/session/end`, as the
/// desktop does on signing out, and the sign-in through the lifted auth's own `DELETE /v1/auth/session`, with an access
/// token refreshed for it when the browser holds none. A session that cannot be ended now runs out by itself: a shop
/// session in its 30 days, a sign-in in the hour its access token lasts and its refresh in 30 days. Answers how many shop
/// sessions ended.
async function endEverything(url: URL, env: WebSessionEnv, ctx: ExecutionContext, jar: Jar): Promise<number> {
  let ended = 0;
  for (const { token } of jar.shops.values()) {
    const end = inner(url, "/v1/shops/session/end", "POST", token, {});
    const response = await shopsRoute(end.request, end.url, env, ctx).catch(() => null);
    if (response?.ok) ended += 1;
    await response?.body?.cancel();
  }
  const scratch: string[] = [];
  let access = jar.access ?? (await accessOf(env, jar, scratch).catch(() => null));
  for (let attempt = 0; access && attempt < 2; attempt += 1) {
    const response = await authCall(env, "/session", { method: "DELETE", headers: { authorization: `Bearer ${access}` } });
    await response.body?.cancel();
    if (response.status !== 401 || attempt > 0) break;
    // The access cookie's token had already ended: a refresh gives one that ends the chain.
    access = await accessOf(env, jar, scratch, true).catch(() => null);
  }
  return ended;
}

/// Clears every cookie of this file the browser sent, and the sign-in's two whether it sent them or not.
function clearAll(jar: Jar): string[] {
  return [clearCookie(SIGN_IN_COOKIE), clearCookie(ACCESS_COOKIE), ...[...jar.shops.keys()].map(clearCookie)];
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

/// `POST /v1/web/sign-in` with exactly `{ email, code }`: signs in with a code sent by email, as `POST /v1/auth/exchange`
/// does with `provider: "email"`, under a device id this route mints, and keeps the sign-in in cookies. Whatever the
/// browser held before (another person's sign-in, or this person's older one) is ended and cleared first, so a sign-in
/// never shows one person another's shops. The exchange's refusals are answered as it answers them: 401 `wrong_code` with
/// `triesLeft`, 401 `code_ended`, 400 `invalid_request` and 400 `email_not_configured`.
async function signIn(request: Request, url: URL, env: WebSessionEnv, ctx: ExecutionContext, jar: Jar): Promise<Response> {
  if (request.method !== "POST") return answer({ error: "method_not_allowed" }, 405);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return answer({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !hasExactly(body, ["email", "code"])) return answer({ error: "invalid_request" }, 400);
  const deviceId = `web-${crypto.randomUUID()}`;
  const asked = emailExchange({ provider: "email", email: body.email, code: body.code, deviceId });
  if (!asked) return answer({ error: "invalid_request" }, 400);
  if (!emailSignIn(env)) return answer({ error: "email_not_configured" }, 400);
  const response = await authCall(env, "/exchange", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "email", email: asked.address, code: asked.code, deviceId }) });
  const result = await jsonOf(response);
  if (!response.ok) {
    // Only the exchange's own refusals are passed on, field by field; anything else is the API failing.
    if (isRecord(result) && typeof result.error === "string" && (response.status === 400 || response.status === 401)) {
      const triesLeft = typeof result.triesLeft === "number" ? { triesLeft: result.triesLeft } : {};
      return answer({ error: result.error, ...triesLeft }, response.status);
    }
    return answer({ error: "auth_unavailable" }, 503);
  }
  if (!isRecord(result) || typeof result.accessToken !== "string" || !LIFTED_TOKEN.test(result.accessToken) ||
      typeof result.refreshToken !== "string" || !LIFTED_TOKEN.test(result.refreshToken)) {
    return answer({ error: "auth_unavailable" }, 503);
  }
  await endEverything(url, env, ctx, jar);
  const life = typeof result.expiresIn === "number" ? result.expiresIn : 3600;
  return answer({ signedIn: true }, 200, [
    ...[...jar.shops.keys()].map(clearCookie),
    setCookie(ACCESS_COOKIE, result.accessToken, life - ACCESS_EARLY_SECONDS),
    setCookie(SIGN_IN_COOKIE, `${deviceId}.${result.refreshToken}`, SIGN_IN_MAX_AGE),
  ]);
}

/// `POST /v1/web/shops` with `{}`: the shops the person is in (`GET /v1/shops`), each with a session ready: one the
/// browser holds is kept, and one it lacks is opened (`POST /v1/shops/session`) and kept, so a helper's phone counts as
/// one device for its 30 days rather than one each time the app opens. A cookie for a shop the person is no longer in
/// (removed, unlinked or deleted) is cleared. 401 `signed_out` when there is no sign-in or the lifted auth ended it, with
/// `emailSignIn`, whether signing in by email is on, so the app can say on opening that it is not; 503
/// `shops_unavailable` when the shops cannot be read. A shop whose session could not be opened is listed with
/// `ready: false`.
async function shops(request: Request, url: URL, env: WebSessionEnv, ctx: ExecutionContext, jar: Jar): Promise<Response> {
  if (request.method !== "POST") return answer({ error: "method_not_allowed" }, 405);
  const refused = await emptyBody(request);
  if (refused) return refused;
  const cookies: string[] = [];
  const signedOut = () => answer({ error: "signed_out", emailSignIn: emailSignIn(env) !== null }, 401, cookies);
  let listed: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const access = await accessOf(env, jar, cookies, attempt > 0);
    if (!access) return signedOut();
    const list = inner(url, "/v1/shops", "GET", access);
    listed = await shopsRoute(list.request, list.url, env, ctx);
    // An access token the lifted auth no longer holds (signed out elsewhere, or past its hour) is refreshed once.
    if (listed?.status !== 401) break;
    await listed.body?.cancel();
  }
  if (!listed || listed.status === 401) return signedOut();
  const body = await jsonOf(listed);
  if (!listed.ok || !isRecord(body) || !Array.isArray(body.shops)) return answer({ error: "shops_unavailable" }, 503, cookies);
  const access = jar.access ?? "";
  const kept = new Set<string>();
  const views: ShopView[] = [];
  for (const entry of body.shops) {
    if (!isRecord(entry) || !isValidTenant(entry.id) || typeof entry.name !== "string" || typeof entry.ownerName !== "string" ||
        (entry.role !== "owner" && entry.role !== "helper")) continue;
    const name = await shopCookieName(entry.id);
    if (kept.has(name)) continue;
    kept.add(name);
    const shop = { id: entry.id, name: entry.name, ownerName: entry.ownerName, role: entry.role as Role };
    const held = jar.shops.get(name);
    if (held && tokenShop(held.token) === shop.id) {
      views.push({ ...shop, you: held.as, ready: true });
      continue;
    }
    const open = inner(url, "/v1/shops/session", "POST", access, { shop: shop.id });
    const opened = await shopsRoute(open.request, open.url, env, ctx);
    const session = opened ? await jsonOf(opened) : null;
    const token = isRecord(session) && isRecord(session.session) ? session.session.accessToken : undefined;
    const expiresAt = isRecord(session) && isRecord(session.session) ? session.session.expiresAt : undefined;
    const role = isRecord(session) ? session.role : undefined;
    const as = isRecord(session) && isRecord(session.account) ? session.account.id
      : isRecord(session) && isRecord(session.helper) ? session.helper.id : undefined;
    if (opened?.ok && typeof token === "string" && tokenShop(token) === shop.id && typeof expiresAt === "string" &&
        (role === "owner" || role === "helper") && typeof as === "string" && DECIDER.test(as)) {
      const seconds = (Date.parse(expiresAt) - Date.now()) / 1000 - SHOP_EARLY_SECONDS;
      cookies.push(setCookie(name, `${as}~${token}`, seconds));
      views.push({ ...shop, role, you: as, ready: true });
    } else {
      views.push({ ...shop, you: null, ready: false });
    }
  }
  for (const name of jar.shops.keys()) if (!kept.has(name)) cookies.push(clearCookie(name));
  return answer({ shops: views }, 200, cookies);
}

/// `POST /v1/web/sign-out` with `{}`: ends every session the browser holds (`endEverything`) and clears every cookie,
/// whether or not each could be ended, so the browser keeps nothing. With nothing held it changes nothing and answers the
/// same.
async function signOut(request: Request, url: URL, env: WebSessionEnv, ctx: ExecutionContext, jar: Jar): Promise<Response> {
  if (request.method !== "POST") return answer({ error: "method_not_allowed" }, 405);
  const refused = await emptyBody(request);
  if (refused) return refused;
  const shopsEnded = await endEverything(url, env, ctx, jar);
  return answer({ signedOut: true, shopsEnded }, 200, clearAll(jar));
}

/// The session the browser holds for `shop`, with its cookie's name, or null.
async function heldFor(jar: Jar, shop: string): Promise<{ name: string; token: string } | null> {
  const name = await shopCookieName(shop);
  const held = jar.shops.get(name);
  return held && tokenShop(held.token) === shop ? { name, token: held.token } : null;
}

/// A shop route's answer, passed on as it was, with its shop named on a 401. A shop session the shop no longer holds is
/// answered 401 `session_ended`, and its cookie cleared, so the app reads the person's shops again, which opens a new
/// one; a session that removal or unlinking ended keeps its own answer (`removed`, `unlinked`, with when), and its
/// cookie is cleared too, as nothing can open it again.
async function passOn(response: Response, shop: string, name: string): Promise<Response> {
  const body = await jsonOf(response);
  if (response.status === 401) {
    const ended = isRecord(body) && (body.error === "removed" || body.error === "unlinked") ? body : { error: "session_ended" };
    return answer({ ...ended, shop }, 401, [clearCookie(name)]);
  }
  return answer(body, response.status);
}

/// `GET /v1/web/approvals?shop=…&state=open|recent[&limit=…]`: that shop's approvals, as `GET /v1/approvals` answers
/// them to the shop's own session. Only `shop`, `state` and `limit` may be in the query, and the shop route checks the
/// last two. 401 `session_ended` with `shop` when the browser holds no session for it.
async function approvals(request: Request, url: URL, env: WebSessionEnv, flags: JobFlags, jar: Jar): Promise<Response> {
  if (request.method !== "GET") return answer({ error: "method_not_allowed" }, 405);
  const names = [...url.searchParams.keys()];
  const shop = url.searchParams.get("shop");
  if (names.some((name) => name !== "shop" && name !== "state" && name !== "limit") ||
      names.length !== new Set(names).size || !isValidTenant(shop)) {
    return answer({ error: "invalid_request" }, 400);
  }
  const held = await heldFor(jar, shop);
  if (!held) return answer({ error: "session_ended", shop }, 401);
  const query = new URLSearchParams();
  for (const name of ["state", "limit"]) {
    const value = url.searchParams.get(name);
    if (value !== null) query.set(name, value);
  }
  const list = inner(url, `/v1/approvals?${query.toString()}`, "GET", held.token);
  const response = await approvalsRoute(list.request, list.url, env, flags);
  return response ? passOn(response, shop, held.name) : answer({ error: "not_found" }, 404);
}

/// `POST /v1/web/approvals/{requestId}/decision` with exactly `{ shop, optionId, seenRevision }`: decides one of that
/// shop's requests through `POST /v1/approvals/{requestId}/decision` with the shop's own session, which takes who decides
/// from that session and passes the decision through approval-core. The route's answers are passed on as they are.
async function decide(request: Request, url: URL, env: WebSessionEnv, flags: JobFlags, jar: Jar, requestId: string):
  Promise<Response> {
  if (request.method !== "POST") return answer({ error: "method_not_allowed" }, 405);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return answer({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !hasExactly(body, ["shop", "optionId", "seenRevision"]) || !isValidTenant(body.shop)) {
    return answer({ error: "invalid_request" }, 400);
  }
  const held = await heldFor(jar, body.shop);
  if (!held) return answer({ error: "session_ended", shop: body.shop }, 401);
  const sent = inner(url, `/v1/approvals/${requestId}/decision`, "POST", held.token,
    { optionId: body.optionId, seenRevision: body.seenRevision });
  const response = await approvalsRoute(sent.request, sent.url, env, flags);
  return response ? passOn(response, body.shop, held.name) : answer({ error: "not_found" }, 404);
}
