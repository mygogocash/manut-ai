import { base64UrlDecode } from "./auth";
import { base64url } from "./relay";

/// Web Push for the relay (item 78d, docs/remote-access.md, "Push"): a push with no content that wakes a paired phone,
/// whose service worker then says only "Your Mac needs you". The relay object (relay-object.ts) keeps each phone's push
/// address and calls `sendWebPush` when its Mac sends `push`.
///
/// - **No payload.** RFC 8030 lets a push message carry nothing, and a push with no payload needs no encryption (RFC
///   8291 encrypts only a payload), so the request body is empty and the push service, Apple, Google or Mozilla, learns
///   nothing but that this phone was woken.
/// - **VAPID (RFC 8292).** Each request carries `Authorization: vapid t=<JWT>, k=<public key>`: a JWT signed with ES256
///   whose `aud` is the push service's origin, whose `exp` is at most 24 hours away (12 here, as the web's examples
///   do, to leave room for clocks that differ) and whose `sub` is this Worker's own https origin, and the key pair's
///   uncompressed public point. The pair is ours: the private half is the Wrangler secret `WEB_PUSH_PRIVATE_KEY`
///   (base64url of the 32-byte scalar `d`), the public half `WEB_PUSH_PUBLIC_KEY` (base64url of the 65-byte point),
///   the same key the phone subscribed with. No outside account (docs/remote-access.md, "Push key").
/// - **Only known push services** (`webPushAddress`): the same rule as `@manut/remote-channel`'s `pushAddressOk`, whose
///   list the relay's tests hold this one to.
///
/// The signing is GoSpark's (`docs/plans/worker-apns-spike-probe.ts` at `a7537c80`, `fakeTokenOnce`): WebCrypto's ECDSA
/// signature is already the raw 64-byte `r || s` a JWS ES256 signature is, so nothing is unwrapped. Nothing here logs a
/// key, a token or an address.

/// The push services' hosts, as `@manut/remote-channel`'s `PUSH_HOSTS` (packages/remote-channel/src/push.ts).
export const WEB_PUSH_HOSTS: readonly string[] = ["web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com"];
export const MAX_WEB_PUSH_ADDRESS = 2_048;

/// How long a message waits at the push service for a phone that is off: an hour, after which "Your Mac needs you" is
/// no longer news worth waking a phone for.
export const WEB_PUSH_TTL_SECONDS = 3_600;
/// The push services' coalescing key (RFC 8030 section 5.4): a newer push replaces one still waiting, so a phone that
/// was off hears once.
export const WEB_PUSH_TOPIC = "manut-mac";
/// A JWT lasts this long, and one is signed again once less than an hour of it is left. Apple asks for a new one no more
/// often than once an hour.
const JWT_SECONDS = 12 * 3_600;
const JWT_REFRESH_SECONDS = 3_600;
/// How long one push service has to answer.
const SEND_TIMEOUT_MS = 10_000;

/// Whether `value` is a push address the relay may send to: an https URL on one of the push services' hosts at the
/// default port, with a path, no user and no fragment, already in the URL parser's own form.
export function webPushAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_WEB_PUSH_ADDRESS) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.href === value && url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" &&
    url.hash === "" && url.pathname.length > 1 && WEB_PUSH_HOSTS.includes(url.hostname);
}

export type WebPushEnv = { WEB_PUSH_PUBLIC_KEY?: string; WEB_PUSH_PRIVATE_KEY?: string; PUBLIC_API_ORIGIN?: string };

export type WebPushConfig = {
  /// The uncompressed public point, base64url: the phone's `applicationServerKey` and the header's `k`.
  readonly publicKey: string;
  readonly jwk: JsonWebKey;
  /// The JWT's `sub`: this Worker's own https origin.
  readonly subject: string;
};

/// The push key as configured, or null while either half is missing or unreadable, or this Worker has no https origin
/// to name as the sender. Nothing is pushed, and no key is offered to a phone, until all three are there.
export function webPushConfig(env: WebPushEnv): WebPushConfig | null {
  const publicKey = env.WEB_PUSH_PUBLIC_KEY?.trim() ?? "";
  const d = env.WEB_PUSH_PRIVATE_KEY?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey) || !/^[A-Za-z0-9_-]{43}$/.test(d)) return null;
  let point: Uint8Array;
  try {
    point = base64UrlDecode(publicKey);
    if (point.byteLength !== 65 || point[0] !== 0x04 || base64UrlDecode(d).byteLength !== 32) return null;
  } catch {
    return null;
  }
  let subject: string;
  try {
    const origin = new URL(env.PUBLIC_API_ORIGIN ?? "");
    if (origin.protocol !== "https:") return null;
    subject = origin.origin;
  } catch {
    return null;
  }
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", d, x: base64url(point.slice(1, 33)), y: base64url(point.slice(33)), ext: false };
  return { publicKey, jwk, subject };
}

/// The key a phone subscribes with, as the API's public health answer offers it (index.ts), or null when pushes cannot
/// be sent.
export function webPushKey(env: WebPushEnv): string | null {
  return webPushConfig(env)?.publicKey ?? null;
}

/// Signed tokens kept for this isolate, by push service and key, so each relay object does not sign one per push.
/// Only the token is kept, never the key, and it signs nothing: it names one push service and runs out by itself.
const tokens = new Map<string, { jwt: string; exp: number }>();

/// The `Authorization` value for a push to `audience` (a push service's origin), signed now or reused while more than an
/// hour of it is left.
export async function vapidAuthorization(config: WebPushConfig, audience: string, now = Math.floor(Date.now() / 1_000)): Promise<string> {
  const cacheKey = `${audience}|${config.publicKey}|${config.subject}`;
  let token = tokens.get(cacheKey);
  if (!token || token.exp - now < JWT_REFRESH_SECONDS) {
    const encoder = new TextEncoder();
    const exp = now + JWT_SECONDS;
    const head = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = base64url(encoder.encode(JSON.stringify({ aud: audience, exp, sub: config.subject })));
    const key = await crypto.subtle.importKey("jwk", config.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${head}.${claims}`));
    token = { jwt: `${head}.${claims}.${base64url(signature)}`, exp };
    tokens.set(cacheKey, token);
  }
  return `vapid t=${token.jwt}, k=${config.publicKey}`;
}

/// What became of one push: taken by the push service; `gone`, the subscription no longer exists (404 or 410, RFC 8030
/// section 7.3 and every service's own page), so its address is forgotten; or `failed` for anything else, which keeps
/// the address.
export type WebPushOutcome = "sent" | "gone" | "failed";

/// Sends one push with no payload to `address`, which the caller already checked with `webPushAddress`.
export async function sendWebPush(config: WebPushConfig, address: string, fetchImpl: typeof fetch = fetch): Promise<WebPushOutcome> {
  try {
    const authorization = await vapidAuthorization(config, new URL(address).origin);
    const response = await fetchImpl(address, {
      method: "POST",
      headers: {
        authorization,
        ttl: String(WEB_PUSH_TTL_SECONDS),
        urgency: "high",
        topic: WEB_PUSH_TOPIC,
      },
      // An empty body of known length: the request says `content-length: 0`, which a push service may require.
      body: new Uint8Array(0),
      redirect: "manual",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    // Its body says nothing the relay acts on, and is not read.
    await response.body?.cancel();
    if (response.status === 404 || response.status === 410) return "gone";
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
