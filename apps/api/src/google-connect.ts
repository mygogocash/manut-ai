/// The owner's Google routes, for Ton's books in a Google Sheet (docs/pilot-api.md, "Google Sheets for Ton's books";
/// docs/connectors.md, 4b). Off until the owner's OAuth client exists: while `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
/// or `PUBLIC_API_ORIGIN` is missing, every route here answers `google_not_configured` before it reads anything else,
/// and nothing reaches Google.
///
/// - `GET /v1/google`: whether the shop is connected, whether the connection works or broke and why, in words the owner
///   reads, and the sheet Ton appends to.
/// - `POST /v1/google/connect` with `{}`: a new sign-in. The answer is the address of Google's consent page for the
///   owner's browser, asking for `drive.file` only, offline, with a `state` and a PKCE challenge. The state names the
///   shop; the vault keeps its hash, the PKCE verifier sealed, and which owner session started it, once, for ten minutes.
/// - `GET /v1/google/callback`: Google sends the owner's browser back here. The state is taken from the vault once (a
///   second callback with it finds nothing), the owner session that started it must still hold, and the code is
///   exchanged with the verifier and the client secret, which never leaves this Worker. The refresh token is sealed in
///   the vault as the shop's Google connection, in place of any earlier one, and the browser is shown a short page.
/// - `POST /v1/google/disconnect` with `{}`: the token is revoked at Google, then forgotten in the vault.
/// - `POST /v1/google/books` with `{ month }`: the owner asks Ton to append that month of the books. Ton's job asks
///   through approval-core with the exact rows, and only the owner's decision sends them (books-sheet.ts).
///
/// Only the shop's owner reaches these, from an owner session or the shop's own session; a helper's session answers 403
/// `owner_only`, as on the owner's other routes. The callback is public, because the browser Google sends back carries
/// no session: its state is its credential, and its ingress limit runs first (index.ts). No token is ever in a response,
/// a page, a log or a URL this Worker makes; the code and the state are in Google's redirect by OAuth's design, and the
/// page answering it tells the browser to send no referrer.

import type { AuditActor } from "./audit-log";
import { appendAudit } from "./audit-log";
import { sha256Hex } from "./auth";
import { readJsonBody } from "./body";
import { isBooksMonth } from "./books-detail";
import { brokenWords, googleConnectionOf, googleVaultCall } from "./google-connection";
import { isValidTenant } from "./companies";
import { readConnectionSecret } from "./cred-broker";
import {
  authorizationUrl,
  DRIVE_FILE_SCOPE,
  exchangeCode,
  googleConfig,
  pkcePair,
  revokeToken,
  type FetchImpl,
  type GoogleConfig,
  type GoogleEnv,
} from "./google";
import type { JobFlags, JobFlowEnv } from "./job-flow";
import {
  bearer,
  callerOf,
  hasExactly,
  isShopSession,
  OWNER_SESSION,
  ownerActor,
  peopleCall,
  queryNamesSession,
  readShop,
  type Caller,
  type PeopleEnv,
} from "./people";
import type { OwnerSessionCheck } from "./people-store";
import { readRoutines } from "./routine-setup";
import { memberOn } from "./routine-store";
import { credStub } from "./tenant-data";
import { runWorker } from "./workers";

export type GoogleRouteEnv = JobFlowEnv & PeopleEnv & GoogleEnv;

type GoogleRouteOptions = {
  flags: JobFlags;
  /// Google's fetch. Tests hand in their fake Google; production leaves it unset and uses the global fetch.
  fetchImpl?: FetchImpl;
};

const MAX_BODY_BYTES = 16 * 1024;
/// A sign-in's state: the shop, base64url, then 32 random bytes in hex. Naming the shop proves nothing; only the vault
/// holding the state's hash for that shop does.
const STATE = /^mgs1\.([A-Za-z0-9_-]{1,512})\.([0-9a-f]{64})$/;
const CODE_MAX = 2048;

/// The owner's routes: the method each takes and the exact keys of its body.
const OWNER_ROUTES: ReadonlyMap<string, { method: "GET" | "POST"; keys?: readonly string[] }> = new Map([
  ["/v1/google", { method: "GET" }],
  ["/v1/google/connect", { method: "POST", keys: [] }],
  ["/v1/google/disconnect", { method: "POST", keys: [] }],
  ["/v1/google/books", { method: "POST", keys: ["month"] }],
]);

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function base64url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/// The text a base64url segment spells, or null unless the segment is that text's one canonical spelling.
function fromBase64url(segment: string): string | null {
  try {
    const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    return base64url(text) === segment ? text : null;
  } catch {
    return null;
  }
}

function newState(shop: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `mgs1.${base64url(shop)}.${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/// The shop a state names, or null when it is not a state this API makes.
function stateShop(state: string): string | null {
  const match = STATE.exec(state);
  const shop = match?.[1] ? fromBase64url(match[1]) : null;
  return shop !== null && isValidTenant(shop) ? shop : null;
}

export function isGoogleRoute(pathname: string): boolean {
  return pathname === "/v1/google" || pathname.startsWith("/v1/google/");
}

/// `/v1/google` and everything under it. Answers null for any other path.
export async function googleRoute(request: Request, url: URL, env: GoogleRouteEnv, options: GoogleRouteOptions):
  Promise<Response | null> {
  if (!isGoogleRoute(url.pathname)) return null;
  const config = googleConfig(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  if (url.pathname === "/v1/google/callback") return callback(request, url, env, config, fetchImpl);
  const route = OWNER_ROUTES.get(url.pathname);
  if (!route) return json({ error: "not_found" }, 404);
  if (!config) return json({ error: "google_not_configured" }, 503);
  const caller = await callerOf(request, env);
  if (caller instanceof Response) return caller;
  if (caller.role !== "owner") return json({ error: "owner_only" }, 403);
  if (request.method !== route.method) return json({ error: "method_not_allowed" }, 405);
  if (queryNamesSession(url)) return json({ error: "invalid_request" }, 400);
  if (url.pathname === "/v1/google") return status(env, caller.shop);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !hasExactly(body, route.keys ?? [])) return json({ error: "invalid_request" }, 400);
  switch (url.pathname) {
    case "/v1/google/connect":
      return connect(request, env, caller, config);
    case "/v1/google/disconnect":
      return disconnect(env, caller, config, fetchImpl);
    default:
      return books(env, caller, body.month, options);
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// What the owner's app shows about the shop's Google connection.
export type GoogleStatus = {
  connected: boolean;
  connection: null | {
    id: string;
    connectedAt: string;
    state: "working" | "broken";
    broken?: { at: string; reason: string; words: string };
    sheet: null | { id: string; title: string; tab: string; url: string | null };
  };
};

async function status(env: GoogleRouteEnv, shop: string): Promise<Response> {
  const connection = await googleConnectionOf(env, shop);
  if (connection === undefined) return json({ error: "vault_unavailable" }, 503);
  if (connection === null) return json({ connected: false, connection: null } satisfies GoogleStatus);
  const sheet = connection.sheet;
  return json({
    connected: true,
    connection: {
      id: connection.id,
      connectedAt: connection.createdAt,
      state: connection.brokenAt ? "broken" : "working",
      ...(connection.brokenAt ? { broken: { at: connection.brokenAt, reason: connection.brokenReason ?? "refused",
        words: brokenWords(connection.brokenReason) } } : {}),
      sheet: sheet ? { id: sheet.id, title: sheet.title, tab: sheet.tab, url: sheet.url ?? null } : null,
    },
  } satisfies GoogleStatus);
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

/// `POST /v1/google/connect`: a new sign-in for the owner's browser. A person's own sign-in acts for their own tenant,
/// which is no pilot shop: 404 `not_found`, as on the owner's other routes.
async function connect(request: Request, env: GoogleRouteEnv, caller: Extract<Caller, { role: "owner" }>,
  config: GoogleConfig): Promise<Response> {
  try {
    if (!(await readShop(env, caller.shop))) return json({ error: "not_found" }, 404);
  } catch {
    return json({ error: "shop_unavailable" }, 503);
  }
  const state = newState(caller.shop);
  const pkce = await pkcePair();
  const token = bearer(request);
  const started = await googleVaultCall(env, caller.shop, "/google/flows", {
    stateHash: await sha256Hex(state),
    verifier: pkce.verifier,
    startedBy: caller.accountId ?? OWNER_SESSION,
    // An owner session (`mos1.`) is held by its hash in the shop's people record, so the callback can check it still
    // holds. The shop's own session is the lifted auth's, held by its token alone.
    sessionHash: isShopSession(token) ? await sha256Hex(token) : null,
  });
  if (!started || started.status !== 200 || typeof started.body.expiresAt !== "string") {
    return json({ error: "vault_unavailable" }, 503);
  }
  return json({ url: authorizationUrl(config, state, pkce.challenge), expiresAt: started.body.expiresAt });
}

/// The short page the owner's browser is shown after Google sends it back. Plain words, no script, no outside resource,
/// no referrer, and never cached.
function page(status: number, title: string, lines: readonly string[]): Response {
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    `<title>${escape(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;` +
    "padding:0 16px;color:#1b1b1b;background:#fff}@media (prefers-color-scheme:dark){body{color:#eee;" +
    `background:#161616}}</style></head><body><h1>${escape(title)}</h1>` +
    `${lines.map((line) => `<p>${escape(line)}</p>`).join("")}</body></html>`;
  return new Response(html, { status, headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "x-content-type-options": "nosniff",
  } });
}

const START_AGAIN = "Open Manut AI and connect Google again.";

/// `GET /v1/google/callback?state=&code=` (or `?state=&error=` when the owner said no). See the module note.
async function callback(request: Request, url: URL, env: GoogleRouteEnv, config: GoogleConfig | null,
  fetchImpl: FetchImpl): Promise<Response> {
  // Off, the callback answers as every Google route does. No sign-in can have started then, since connecting is off too.
  if (!config) return json({ error: "google_not_configured" }, 503);
  if (request.method !== "GET") return page(405, "This page only opens from Google", [START_AGAIN]);
  const state = url.searchParams.get("state") ?? "";
  const shop = stateShop(state);
  if (!shop) return page(400, "This link did not come from Manut AI", [START_AGAIN]);
  const taken = await googleVaultCall(env, shop, "/google/flows/take", { stateHash: await sha256Hex(state) });
  if (!taken) return page(503, "Manut AI could not finish connecting Google", [START_AGAIN]);
  if (taken.status === 404) {
    return page(400, "This link was already used", ["Each link to connect Google works once.", START_AGAIN]);
  }
  if (taken.status === 410) return page(410, "This link is too old", ["It works for ten minutes.", START_AGAIN]);
  const { verifier, startedBy, sessionHash } = taken.body;
  if (taken.status !== 200 || typeof verifier !== "string" || typeof startedBy !== "string") {
    return page(503, "Manut AI could not finish connecting Google", [START_AGAIN]);
  }
  // From here the sign-in is used up, whatever happens next: a second callback with this state finds nothing.
  const actor: AuditActor = { kind: "owner", id: startedBy };
  if (url.searchParams.has("error")) {
    await appendAudit(env, shop, { actor, action: "google.connected", subject: {}, outcome: "declined",
      reason: "access_denied" });
    return page(200, "Google was not connected", ["You did not let Manut AI into your Google Drive, so nothing changed.",
      "You can close this window."]);
  }
  const code = url.searchParams.get("code") ?? "";
  if (code.length === 0 || code.length > CODE_MAX) return page(400, "Google sent no sign-in back", [START_AGAIN]);
  if (typeof sessionHash === "string") {
    // The owner session that started the sign-in must still hold: an owner whose account was unlinked from the shop
    // meanwhile connects nothing.
    const checked = await peopleCall(env, shop, "/people/owner-session-check", { tokenHash: sessionHash })
      .catch(() => null);
    const session = checked?.ok ? ((await checked.json().catch(() => null)) as OwnerSessionCheck | null) : null;
    if (!session?.ok || session.accountId !== startedBy) {
      return page(401, "Your Manut AI session ended", ["Sign in to Manut AI again, then connect Google."]);
    }
  }
  const exchanged = await exchangeCode(fetchImpl, config, code, verifier);
  if (!exchanged.ok) {
    return exchanged.error === "unreachable"
      ? page(503, "Google did not answer", [START_AGAIN])
      : page(400, "Google did not accept this sign-in", [START_AGAIN]);
  }
  if (!exchanged.scopes.includes(DRIVE_FILE_SCOPE)) {
    return page(400, "Manut AI was not given access to its files",
      ["Ton needs to make and fill one sheet in your Google Drive. Allow that when Google asks.", START_AGAIN]);
  }
  const stored = await googleVaultCall(env, shop, "/google/connections",
    { refreshToken: exchanged.refreshToken, scopes: [DRIVE_FILE_SCOPE] });
  const id = stored?.body.id;
  if (!stored || stored.status !== 200 || typeof id !== "string") {
    return page(503, "Manut AI could not save the connection", [START_AGAIN]);
  }
  const replaced = Array.isArray(stored.body.replaced) ? stored.body.replaced.filter((one) => typeof one === "string") : [];
  await appendAudit(env, shop, { actor, action: "google.connected", subject: { connectionId: id,
    ...(replaced[0] ? { previousConnectionId: replaced[0] as string } : {}) }, outcome: "ok" });
  return page(200, "Google is connected", [
    "Ton can now put each month's books in a sheet in your Google Drive. Ton asks you first, every time.",
    "You can close this window and go back to Manut AI.",
  ]);
}

// ---------------------------------------------------------------------------
// Disconnecting
// ---------------------------------------------------------------------------

/// `POST /v1/google/disconnect`: the refresh token is revoked at Google, which ends Manut AI's access to the owner's
/// Drive, then forgotten in the vault (its sealed secret wiped, the record kept as a tombstone, as every revoked
/// connection is). It is forgotten even when Google cannot be reached; `revoked: false` then tells the app to send the
/// owner to their Google account's settings to remove the access there.
async function disconnect(env: GoogleRouteEnv, caller: Extract<Caller, { role: "owner" }>, config: GoogleConfig,
  fetchImpl: FetchImpl): Promise<Response> {
  const connection = await googleConnectionOf(env, caller.shop);
  if (connection === undefined) return json({ error: "vault_unavailable" }, 503);
  if (connection === null) return json({ error: "not_connected" }, 404);
  let revoked = false;
  try {
    revoked = await revokeToken(fetchImpl, config, await readConnectionSecret(env, connection.id, caller.shop));
  } catch {
    revoked = false;
  }
  const forgotten = await credStub(env, caller.shop).fetch(new Request(
    `https://cred/connections/${encodeURIComponent(connection.id)}`, { method: "DELETE",
      headers: { "x-tenant": caller.shop, "x-google": "1" } })).catch(() => null);
  await forgotten?.body?.cancel();
  if (!forgotten?.ok) return json({ error: "vault_unavailable" }, 503);
  await appendAudit(env, caller.shop, { actor: ownerActor(caller), action: "google.disconnected",
    subject: { connectionId: connection.id }, outcome: "ok", ...(revoked ? {} : { reason: "not_revoked" }) });
  return json({ disconnected: true, revoked });
}

// ---------------------------------------------------------------------------
// Asking Ton for a month
// ---------------------------------------------------------------------------

/// `POST /v1/google/books` with exactly `{ month }`: the owner asks Ton to append that month of the books. It runs Ton's
/// job as the operator's start does (`runWorker`), with the same rule for Pause everyone and a member the shop's
/// template left off, and the owner named as starting it. The answer is the run's: `asked` with the request, `done`
/// with a practice draft, or why it failed.
async function books(env: GoogleRouteEnv, caller: Extract<Caller, { role: "owner" }>, month: unknown,
  options: GoogleRouteOptions): Promise<Response> {
  if (!isBooksMonth(month)) return json({ error: "invalid_month" }, 400);
  const routines = await readRoutines(env, caller.shop);
  if (!routines) return json({ error: "unavailable" }, 503);
  if (routines.team.paused) return json({ error: "team_paused" }, 409);
  if (!memberOn(routines.team, "ton")) return json({ error: "member_off" }, 409);
  const run = await runWorker(env, { tenant: caller.shop, member: "ton", job: { kind: "books_sheet", month },
    startedBy: ownerActor(caller) }, { flags: options.flags, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  if (!run.ok) return json({ error: run.error, ...(run.feature ? { feature: run.feature } : {}) }, run.status);
  const { ok: _ok, ...answer } = run;
  return json(answer);
}
