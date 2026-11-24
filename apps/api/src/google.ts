/// Google, for Ton's books in a Google Sheet (docs/connectors.md, 4b): the owner's own OAuth client, the sign-in that
/// gives the shop a refresh token, refreshing an access token when one is needed, revoking, and the three Sheets calls
/// the books need. Every call here takes its fetch from the caller, so tests hand in a fake Google and production the
/// global fetch, and nothing here keeps a token: the caller passes one in for one call and drops it.
///
/// The flow is OAuth 2.0 for web server applications, checked on Google's own pages on 24 Nov 2026:
///
/// - Authorization: `GET https://accounts.google.com/o/oauth2/v2/auth` with `client_id`, `redirect_uri`,
///   `response_type=code`, `scope`, `access_type=offline` (so the first exchange also returns a refresh token),
///   `state`, and PKCE's `code_challenge` with `code_challenge_method=S256`
///   (https://developers.google.com/identity/protocols/oauth2/web-server, "Step 1: Set authorization parameters";
///   the S256 challenge is `BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))`,
///   https://developers.google.com/identity/protocols/oauth2/native-app, "Step 1: Generate a code verifier and
///   challenge"). `prompt=consent` is added because Google returns a refresh token only on the first consent unless it
///   is asked again, and a second connect must get one ("Prompting re-consent",
///   https://developers.google.com/identity/openid-connect/openid-connect).
/// - Exchange and refresh: `POST https://oauth2.googleapis.com/token`, form-encoded, with `grant_type`
///   `authorization_code` (`code`, `code_verifier`, `redirect_uri`) or `refresh_token` (`refresh_token`), and the
///   client's id and secret. A refresh refused with `invalid_grant` means the grant is gone: revoked, expired, or the
///   account deleted or disabled (web-server page, "Refreshing an access token" and "invalid_grant").
/// - Revocation: `POST https://oauth2.googleapis.com/revoke` with the token as a form field in the body, never in the
///   URL; 200 is done and 400 carries an error code. It ends the whole grant for the project, every token the account
///   gave it included (web-server page, "Token revocation").
///
/// The scope is `https://www.googleapis.com/auth/drive.file` alone, which Google counts as non-sensitive and which
/// reaches only files the app made or the user opened with it (https://developers.google.com/workspace/sheets/api/scopes).
/// `spreadsheets.create`, `spreadsheets.get` and `spreadsheets.values.append` all accept it
/// (https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create, `.../get`, and
/// `.../spreadsheets.values/append`). The read-write `spreadsheets` scope is sensitive, needs Google's review, and is
/// never asked for.

import type { AppendRequest } from "@manut/sheets-rows";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/// The one scope Manut AI asks Google for.
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/// How long one call to Google may take before it counts as unanswered.
const TIMEOUT_MS = 15_000;
/// The most of a Google answer read as JSON. A token answer or a new spreadsheet is a few kilobytes.
const MAX_ANSWER_BYTES = 256 * 1024;
/// What a spreadsheet id is: letters, digits, `-` and `_` (`@manut/sheets-rows` checks the same before an append).
export const SPREADSHEET_ID = /^[A-Za-z0-9_-]{1,128}$/;

/// Where Google lives for one environment. Production always uses Google's own hosts; only a test configuration may
/// name a fake one (`GOOGLE_TEST_ORIGIN`, below).
export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  /// This Worker's callback, which the owner registers on their OAuth client exactly as written here.
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  /// The Sheets API's origin; a request's path goes after it.
  sheetsOrigin: string;
};

export type GoogleEnv = {
  /// The owner's OAuth client (`wrangler secret put GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`). Until both are set
  /// every Google route answers `google_not_configured`, and nothing reaches Google.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /// Test only, set in wrangler.test.json and nowhere else: one origin standing in for every Google host, served by the
  /// tests themselves. It must be an https origin under `.test`, a name no network resolves, so even a value set by
  /// mistake can never send a token anywhere real; any other value is ignored and Google's own hosts are used.
  GOOGLE_TEST_ORIGIN?: string;
  /// This Worker's public origin, which the callback's address is built from.
  PUBLIC_API_ORIGIN?: string;
};

const TEST_ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.test$/;

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    // Google accepts an http redirect only for a local address; every real one is https.
    return url.protocol === "https:" || (url.protocol === "http:" && local) ? url.origin : null;
  } catch {
    return null;
  }
}

/// The environment's Google settings, or null while any of them is missing: the client's id and secret, and the
/// Worker's public origin for the callback. Null means every Google route answers `google_not_configured`.
export function googleConfig(env: GoogleEnv): GoogleConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const origin = originOf(env.PUBLIC_API_ORIGIN);
  if (!clientId || !clientSecret || !origin) return null;
  const fake = env.GOOGLE_TEST_ORIGIN && TEST_ORIGIN.test(env.GOOGLE_TEST_ORIGIN) ? env.GOOGLE_TEST_ORIGIN : null;
  return {
    clientId,
    clientSecret,
    redirectUri: `${origin}/v1/google/callback`,
    authUrl: fake ? `${fake}/o/oauth2/v2/auth` : "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: fake ? `${fake}/token` : "https://oauth2.googleapis.com/token",
    revokeUrl: fake ? `${fake}/revoke` : "https://oauth2.googleapis.com/revoke",
    sheetsOrigin: fake ?? "https://sheets.googleapis.com",
  };
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/// PKCE's S256 challenge for a verifier.
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/// A new PKCE pair. The verifier is 32 random bytes in base64url, 43 characters, all of them from the set PKCE allows.
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await pkceChallenge(verifier) };
}

/// The address the owner's browser opens to let Manut AI into their Drive: the one scope, offline access, consent asked
/// again so a refresh token comes back, the state, and the PKCE challenge.
export function authorizationUrl(config: GoogleConfig, state: string, challenge: string): string {
  const url = new URL(config.authUrl);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: DRIVE_FILE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/// One call to Google, answered or not: a thrown fetch, a timeout and a body that is not JSON all come back as null
/// JSON with the status, so each caller classifies its own answers.
type Answered = { status: number; body: Record<string, unknown> | null } | null;

async function call(fetchImpl: FetchImpl, url: string, init: RequestInit): Promise<Answered> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
  let body: Record<string, unknown> | null = null;
  try {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength <= MAX_ANSWER_BYTES && text.length > 0) {
      const parsed = JSON.parse(text) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    }
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function form(fields: Record<string, string>): RequestInit {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString() };
}

/// What asking Google for tokens came to. `invalid_grant` is Google refusing the grant itself (a code used or expired,
/// a refresh token revoked or expired), `refused` any other refusal (a client misconfigured, say), and `unreachable` no
/// answer that could be read.
export type TokenError = "invalid_grant" | "refused" | "unreachable";

function tokenError(answered: Answered): TokenError {
  if (!answered || answered.status >= 500) return "unreachable";
  return answered.body?.error === "invalid_grant" ? "invalid_grant" : "refused";
}

/// The scopes a token answer says were granted, as Google lists them, space-delimited.
function scopesOf(body: Record<string, unknown>): string[] {
  return typeof body.scope === "string" ? body.scope.split(" ").filter((scope) => scope.length > 0) : [];
}

export type Exchanged =
  | { ok: true; refreshToken: string; accessToken: string; scopes: string[] }
  | { ok: false; error: TokenError | "no_refresh_token" };

/// Exchanges the code the callback received, with the PKCE verifier its flow kept. A token answer without a refresh
/// token is no connection (`no_refresh_token`): with `access_type=offline` and `prompt=consent` Google sends one.
export async function exchangeCode(fetchImpl: FetchImpl, config: GoogleConfig, code: string, verifier: string):
  Promise<Exchanged> {
  const answered = await call(fetchImpl, config.tokenUrl, form({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  }));
  if (!answered || answered.status !== 200 || !answered.body) return { ok: false, error: tokenError(answered) };
  const { access_token: accessToken, refresh_token: refreshToken } = answered.body;
  if (typeof accessToken !== "string" || accessToken.length === 0) return { ok: false, error: "unreachable" };
  if (typeof refreshToken !== "string" || refreshToken.length === 0) return { ok: false, error: "no_refresh_token" };
  return { ok: true, refreshToken, accessToken, scopes: scopesOf(answered.body) };
}

export type Refreshed = { ok: true; accessToken: string } | { ok: false; error: TokenError };

/// A new access token from the shop's refresh token, for the call about to be made. It is never stored: each use asks
/// again, which costs one call and leaves nothing to leak or go stale.
export async function refreshAccess(fetchImpl: FetchImpl, config: GoogleConfig, refreshToken: string):
  Promise<Refreshed> {
  const answered = await call(fetchImpl, config.tokenUrl, form({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  }));
  if (!answered || answered.status !== 200 || !answered.body) return { ok: false, error: tokenError(answered) };
  const accessToken = answered.body.access_token;
  return typeof accessToken === "string" && accessToken.length > 0 ? { ok: true, accessToken }
    : { ok: false, error: "unreachable" };
}

/// Revokes a token at Google, which ends the whole grant. True when Google revoked it, or answered that the token was
/// already no good (`invalid_token`), since either way it can no longer be used; false when Google could not be asked or
/// refused for another reason, so the caller can tell the owner to remove access in their Google account.
export async function revokeToken(fetchImpl: FetchImpl, config: GoogleConfig, token: string): Promise<boolean> {
  const answered = await call(fetchImpl, config.revokeUrl, form({ token }));
  if (!answered) return false;
  return answered.status === 200 || (answered.status === 400 && answered.body?.error === "invalid_token");
}

function bearer(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

export type MadeSheet = { id: string; title: string; tab: string; url: string | null };

/// Makes the books' spreadsheet in the owner's Drive, with one tab for the rows: `POST /v4/spreadsheets` with a
/// `Spreadsheet` naming its title and its one sheet's title. Under `drive.file` a file the app makes is one it may
/// reach later. Null when Google did not make it, or when what it answered does not name a spreadsheet; a create whose
/// answer was lost may still have made one, which is left in the owner's Drive, empty, and is never written to.
export async function createSheet(fetchImpl: FetchImpl, config: GoogleConfig, accessToken: string, title: string,
  tab: string): Promise<MadeSheet | null> {
  const answered = await call(fetchImpl, `${config.sheetsOrigin}/v4/spreadsheets`, {
    method: "POST",
    headers: { ...bearer(accessToken), "content-type": "application/json" },
    body: JSON.stringify({ properties: { title }, sheets: [{ properties: { title: tab } }] }),
  });
  if (!answered || answered.status !== 200 || !answered.body) return null;
  const { spreadsheetId, spreadsheetUrl } = answered.body;
  if (typeof spreadsheetId !== "string" || !SPREADSHEET_ID.test(spreadsheetId)) return null;
  const url = typeof spreadsheetUrl === "string" && spreadsheetUrl.startsWith("https://") ? spreadsheetUrl : null;
  return { id: spreadsheetId, title, tab, url };
}

/// What reading a spreadsheet's own metadata found: its title and its tabs' titles as they are now, or that it is gone
/// for this account (deleted, or not one the app may reach), or no answer.
export type SheetRead =
  | { state: "found"; title: string; tabs: string[] }
  | { state: "gone" }
  | { state: "unreachable" };

/// `GET /v4/spreadsheets/{id}`, which by default answers the spreadsheet's properties and its sheets' properties and no
/// cell, so nothing the owner typed in it is read.
export async function readSheet(fetchImpl: FetchImpl, config: GoogleConfig, accessToken: string,
  spreadsheetId: string): Promise<SheetRead> {
  if (!SPREADSHEET_ID.test(spreadsheetId)) return { state: "gone" };
  const answered = await call(fetchImpl, `${config.sheetsOrigin}/v4/spreadsheets/${spreadsheetId}`,
    { headers: bearer(accessToken) });
  if (!answered) return { state: "unreachable" };
  if (answered.status === 404 || answered.status === 403) return { state: "gone" };
  if (answered.status !== 200 || !answered.body) return { state: "unreachable" };
  const properties = answered.body.properties as { title?: unknown } | undefined;
  const sheets = Array.isArray(answered.body.sheets) ? answered.body.sheets as { properties?: { title?: unknown } }[] : [];
  return {
    state: "found",
    title: typeof properties?.title === "string" ? properties.title : "",
    tabs: sheets.map((sheet) => sheet.properties?.title).filter((name): name is string => typeof name === "string"),
  };
}

/// How an append went. Only an answer that says so is `confirmed`, and only an answer refusing the request before it
/// was applied is `failed`; every other way it can end, no answer, a timeout, a server error, leaves it unknown whether
/// the rows landed, and is `unknown`, never confirmed and never sent again.
export type Appended =
  | { outcome: "confirmed"; updatedRange: string | null; updatedRows: number | null }
  | { outcome: "failed"; code: string }
  | { outcome: "unknown"; code: string };

/// Google's answers that refuse a request before applying it: a request it could not take (a range naming a tab that is
/// not there), a token it did not accept, a file this account may not reach or that is gone, and too many requests.
const REFUSED_BEFORE_APPLYING: ReadonlySet<number> = new Set([400, 401, 403, 404, 429]);

/// Sends one approved append, exactly as `@manut/sheets-rows` built it: `POST` to the request's path with its query and
/// its body.
export async function appendRows(fetchImpl: FetchImpl, config: GoogleConfig, accessToken: string,
  request: AppendRequest): Promise<Appended> {
  const query = new URLSearchParams(request.query).toString();
  const answered = await call(fetchImpl, `${config.sheetsOrigin}${request.path}?${query}`, {
    method: request.method,
    headers: { ...bearer(accessToken), "content-type": "application/json" },
    body: JSON.stringify(request.body),
  });
  if (!answered) return { outcome: "unknown", code: "no_answer" };
  if (answered.status >= 200 && answered.status < 300) {
    const updates = answered.body?.updates as { updatedRange?: unknown; updatedRows?: unknown } | undefined;
    return {
      outcome: "confirmed",
      updatedRange: typeof updates?.updatedRange === "string" ? updates.updatedRange : null,
      updatedRows: typeof updates?.updatedRows === "number" ? updates.updatedRows : null,
    };
  }
  if (REFUSED_BEFORE_APPLYING.has(answered.status)) return { outcome: "failed", code: `google_${answered.status}` };
  return { outcome: "unknown", code: `google_${answered.status}` };
}
