/// Sign in with Apple's REST API, for deleting an account (item 124; docs/pilot-api.md, "Deleting your own account").
///
/// App Review asks an app that offers Sign in with Apple to end the person's Apple tokens when they delete their account:
/// "Apps that support Sign in with Apple should use the Sign in with Apple REST API to revoke user tokens" ("Offering
/// account deletion in your app", read 26 Nov 2026). Revoking takes a token Apple gave us: "In order to revoke
/// authorization for a user, you must obtain a valid refresh token or access token. If you don't have either token for the
/// user, you can generate tokens when validating an authorization code" (Token revocation). Until this item the sign-in
/// kept neither: `POST /v1/auth/exchange` verified the identity token and stored nothing of Apple's. So from now on an
/// exchange that carries the authorization code Apple gave the app with that identity token exchanges it here for a
/// refresh token, which AuthObject keeps sealed under the vault's key (cred-crypto.ts) until the account is deleted, when
/// it is revoked and forgotten (account-store.ts).
///
/// What each call is, from Apple's documentation (read 26 Nov 2026):
/// - Token validation, `POST https://appleid.apple.com/auth/token`, a form of `client_id`, `client_secret`, `code` and
///   `grant_type=authorization_code`; `redirect_uri` only "if the application provided a `redirect_uri` in the initial
///   authorization request", which an app's own sign-in does not. It answers `access_token`, `refresh_token` and
///   `id_token`.
/// - Token revocation, `POST https://appleid.apple.com/auth/revoke`, a form of `client_id`, `client_secret`, `token` and
///   `token_type_hint=refresh_token`. It "returns a `200` response code without a response body after the server
///   invalidates the `token` value, or if the `token` value was previously invalidated", so revoking twice is safe.
/// - The client secret ("Creating a client secret"): a JWT signed with ES256 (ECDSA on P-256 with SHA-256) by the private
///   key from the developer account, its header `alg` "ES256" and `kid` the key's 10-character id, its claims `iss` the
///   10-character Team ID, `iat`, `exp` ("an error to request an expiration time more than `15777000` seconds (six
///   months) in the future"), `aud` "https://appleid.apple.com", and `sub` the same id as `client_id`. This file makes a
///   new one for each call, good for five minutes, so no long-lived secret is ever kept.
///
/// Nothing here throws, and no token, code, secret or Apple answer body is ever logged, returned to a client or put in an
/// error: a failure is a status number alone.

import { TEST_ORIGIN, testWorker } from "./test-origin";

export type AppleRestEnv = {
  /// The app's identifier for Sign in with Apple, as the exchange already checks (auth-object.ts).
  APPLE_CLIENT_ID?: string;
  /// The 10-character Team ID of the owner's developer account: the client secret's `iss`.
  APPLE_TEAM_ID?: string;
  /// The 10-character id of the Sign in with Apple private key: the client secret's `kid`.
  APPLE_KEY_ID?: string;
  /// A Wrangler secret: that private key, the `.p8` file's text as Apple gives it, or its body alone in base64.
  APPLE_PRIVATE_KEY?: string;
  /// The vault's keys (cred-crypto.ts), which seal the refresh token while it is kept.
  CRED_KEY?: string;
  CRED_KEY_PREVIOUS?: string;
  /// Test only, set in wrangler.test.json alone, honoured only on a test Worker (test-origin.ts): a made-up key that signs
  /// the client secret, and one origin standing in for appleid.apple.com, served by the tests. The dev deploy check refuses
  /// any `TEST_` var (.github/scripts/check-dev-deploys.mjs).
  TEST_APPLE_PRIVATE_KEY?: string;
  TEST_APPLE_ORIGIN?: string;
  PUBLIC_API_ORIGIN?: string;
};

export type AppleRestConfig = {
  clientId: string;
  teamId: string;
  keyId: string;
  /// The private key's PKCS #8 body.
  key: Uint8Array;
  tokenUrl: string;
  revokeUrl: string;
  credKey: string;
  credKeyPrevious?: string;
};

/// Apple's own host; a test Worker may name a stand-in under `.test` instead.
export const APPLE_ORIGIN = "https://appleid.apple.com";
/// How long one call to Apple may take before it counts as unanswered.
const TIMEOUT_MS = 15_000;
/// How long a client secret this file signs is good for. Apple allows up to six months; each call signs its own.
const SECRET_SECONDS = 300;
/// The most of Apple's token answer read: it is three short tokens.
const MAX_ANSWER_BYTES = 64 * 1024;
/// What an authorization code, a team id and a key id look like. Apple's codes are a few hundred characters of these.
const CODE_SHAPE = /^[A-Za-z0-9._-]{1,1024}$/;
const ID_SHAPE = /^[A-Z0-9]{10}$/;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;

/// Whether `value` can be an authorization code. The exchange refuses any other value rather than drop it.
export function isAuthorizationCode(value: unknown): value is string {
  return typeof value === "string" && CODE_SHAPE.test(value);
}

/// The private key's PKCS #8 body from the `.p8` text or from its base64 alone, or null when it is neither.
function pkcs8(text: string): Uint8Array | null {
  const body = text.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  try {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/// This environment's settings for Apple's REST API, or null while any is missing: the client id, team id, key id and
/// private key, and the vault's key to seal a token with. Null means no token is ever asked for, so none is kept, and an
/// account deleted then says Apple's link could not be ended by us.
export function appleRestConfig(env: AppleRestEnv): AppleRestConfig | null {
  const test = testWorker(env);
  const clientId = env.APPLE_CLIENT_ID?.trim() ?? "";
  const teamId = env.APPLE_TEAM_ID?.trim() ?? "";
  const keyId = env.APPLE_KEY_ID?.trim() ?? "";
  const keyText = env.APPLE_PRIVATE_KEY?.trim() || (test ? env.TEST_APPLE_PRIVATE_KEY?.trim() : "") || "";
  const key = keyText ? pkcs8(keyText) : null;
  const credKey = env.CRED_KEY ?? "";
  if (!clientId || !ID_SHAPE.test(teamId) || !ID_SHAPE.test(keyId) || !key || !HEX_KEY.test(credKey)) return null;
  const fake = test && env.TEST_APPLE_ORIGIN && TEST_ORIGIN.test(env.TEST_APPLE_ORIGIN) ? env.TEST_APPLE_ORIGIN : null;
  const origin = fake ?? APPLE_ORIGIN;
  const previous = env.CRED_KEY_PREVIOUS && HEX_KEY.test(env.CRED_KEY_PREVIOUS) ? { credKeyPrevious: env.CRED_KEY_PREVIOUS } : {};
  return { clientId, teamId, keyId, key, tokenUrl: `${origin}/auth/token`, revokeUrl: `${origin}/auth/revoke`, credKey,
    ...previous };
}

function base64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/// A client secret for one call, as "Creating a client secret" describes it. WebCrypto's ECDSA signature is the two
/// 32-byte numbers side by side, which is the form a JWT's ES256 signature takes. Null when the key cannot sign.
export async function clientSecret(config: AppleRestConfig, nowSeconds = Math.floor(Date.now() / 1_000)):
  Promise<string | null> {
  try {
    const key = await crypto.subtle.importKey("pkcs8", config.key, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const head = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
    const claims = base64url(JSON.stringify({ iss: config.teamId, iat: nowSeconds, exp: nowSeconds + SECRET_SECONDS,
      aud: APPLE_ORIGIN, sub: config.clientId }));
    const signed = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${head}.${claims}`));
    return `${head}.${claims}.${base64url(new Uint8Array(signed))}`;
  } catch {
    return null;
  }
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/// One form POST to Apple, or the status that stands for no answer (0).
async function postForm(url: string, form: Record<string, string>, fetchImpl: FetchImpl): Promise<Response | 0> {
  try {
    return await fetchImpl(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
      accept: "application/json" }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return 0;
  }
}

/// The `sub` claim of the id token Apple's token answer carries. It came straight from Apple over TLS, so its claims are
/// read without checking its signature again; it only confirms the code was the same person's as the identity token.
function idTokenSubject(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const part = idToken.split(".")[1];
  if (!part || !/^[A-Za-z0-9_-]+$/.test(part)) return null;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: unknown };
    return typeof json.sub === "string" && json.sub ? json.sub : null;
  } catch {
    return null;
  }
}

/// Exchanges an authorization code for the person's refresh token. Null when Apple refused the code or did not answer, or
/// when the token answer is for another person than `subject`: the sign-in still stands, and nothing is kept.
export async function exchangeCode(config: AppleRestConfig, code: string, subject: string, fetchImpl: FetchImpl = fetch):
  Promise<string | null> {
  const secret = await clientSecret(config);
  if (!secret) return null;
  const response = await postForm(config.tokenUrl, { client_id: config.clientId, client_secret: secret, code,
    grant_type: "authorization_code" }, fetchImpl);
  if (response === 0) return null;
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_ANSWER_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const answer = (await response.json().catch(() => null)) as { refresh_token?: unknown; id_token?: unknown } | null;
  const token = answer?.refresh_token;
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) return null;
  return idTokenSubject(answer?.id_token) === subject ? token : null;
}

/// What revoking came to: Apple's 200, or the status it answered (0 for no answer, -1 for a secret that could not be
/// signed). A failure is retried by the caller; revoking a token Apple already ended answers 200 too.
export type RevokeResult = { ok: true } | { ok: false; status: number };

/// Ends the person's refresh token at Apple, and with it the app's authorization (Token revocation).
export async function revokeToken(config: AppleRestConfig, token: string, fetchImpl: FetchImpl = fetch): Promise<RevokeResult> {
  const secret = await clientSecret(config);
  if (!secret) return { ok: false, status: -1 };
  const response = await postForm(config.revokeUrl, { client_id: config.clientId, client_secret: secret, token,
    token_type_hint: "refresh_token" }, fetchImpl);
  if (response === 0) return { ok: false, status: 0 };
  await response.body?.cancel();
  return response.status === 200 ? { ok: true } : { ok: false, status: response.status };
}
