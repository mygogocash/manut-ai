/// Sign in with Apple verification. Pure functions over injected key material
/// so the same code path qualifies in tests (committed test JWKS) and in
/// production (Apple's JWKS endpoint). Identity is the verified provider
/// subject, never a user-supplied email.

export type VerifiedIdentity = {
  tenant: string;
  provider: "apple";
  exp: number;
};

export type AppleConfig = {
  clientId: string;
  /// Test-only key source. Production fetches Apple's endpoint instead; the
  /// key source is the only thing that differs between the two paths.
  jwksJson?: string | undefined;
  jwksUrl?: string | undefined;
  nowSeconds?: number | undefined;
};

export function base64UrlDecode(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) throw new Error("malformed");
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  // Require the canonical unpadded JWT representation. Alternate pad bits
  // must not turn one signed identity into multiple consumption digests.
  if (btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== input) {
    throw new Error("malformed");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/// A cheap structural rejection before an unauthenticated request reaches AUTH.
/// This never authenticates a token; signature and claims remain the object's job.
export function hasAppleTokenShape(token: unknown, allowTestES256 = false): boolean {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]!))) as unknown;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]!))) as unknown;
    base64UrlDecode(parts[2]!);
    if (!header || typeof header !== "object" || Array.isArray(header) ||
        !payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const fields = header as { alg?: unknown; kid?: unknown };
    return typeof fields.kid === "string" && fields.kid.length > 0 &&
      (fields.alg === "RS256" || (allowTestES256 && fields.alg === "ES256"));
  } catch { return false; }
}

type Jwks = { keys?: { kid?: string; alg?: string; use?: string; kty?: string; crv?: string; x?: string; y?: string; n?: string; e?: string }[] };

/// Production JWKS cache: Apple's key set rotates rarely, and fetching it
/// per exchange would add latency plus a failure mode to every sign-in.
/// Cached per URL for one hour; test JWKS (jwksJson) bypasses the cache.
const jwksCache = new Map<string, { at: number; keys: Jwks }>();
const JWKS_TTL_MS = 3600 * 1000;

async function loadJwks(config: AppleConfig): Promise<Jwks> {
  if (config.jwksJson) return JSON.parse(config.jwksJson) as Jwks;
  const url = config.jwksUrl ?? "https://appleid.apple.com/auth/keys";
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys;
  const response = await fetch(url);
  if (!response.ok) {
    // Serve stale keys on a transient fetch failure rather than failing
    // every sign-in; a rotation during the outage retries at next TTL.
    if (cached) return cached.keys;
    throw new Error("jwks_unavailable");
  }
  const keys = (await response.json()) as Jwks;
  jwksCache.set(url, { at: Date.now(), keys });
  return keys;
}

/// JWT ES256 uses the raw R||S format (RFC 7518 section 3.4). Older explicit
/// test fixtures encoded DER instead; normalize those only on the test-key path.
function derToRaw(signature: Uint8Array): Uint8Array {
  if (signature.length === 64) return signature;
  try {
    let offset = 0;
    if (signature[offset++] !== 0x30) throw new Error("signature");
    let length = signature[offset++]!;
    if (length & 0x80) {
      const count = length & 0x7f;
      length = 0;
      for (let i = 0; i < count; i++) length = (length << 8) | signature[offset++]!;
    }
    const takeInteger = (): Uint8Array => {
      if (signature[offset++] !== 0x02) throw new Error("signature");
      const size = signature[offset++]!;
      const part = signature.slice(offset, offset + size);
      if (part.length !== size) throw new Error("signature");
      offset += size;
      let start = 0;
      while (start < part.length - 1 && part[start] === 0) start++;
      const cut = part.slice(start);
      if (cut.length > 32) throw new Error("signature");
      const padded = new Uint8Array(32);
      padded.set(cut, 32 - cut.length);
      return padded;
    };
    const raw = new Uint8Array(64);
    raw.set(takeInteger(), 0);
    raw.set(takeInteger(), 32);
    if (offset !== signature.length) throw new Error("signature");
    return raw;
  } catch (error) {
    if (error instanceof Error && error.message !== "signature") throw error;
    if (signature.length === 64) return signature;
    throw new Error("signature");
  }
}
export async function verifyAppleToken(
  token: string,
  nonce: string,
  config: AppleConfig,
): Promise<VerifiedIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed");
  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) throw new Error("malformed");
  let header: { alg?: string; kid?: string };
  let payload: { iss?: string; aud?: string; sub?: string; exp?: number; nonce?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    throw new Error("malformed");
  }
  if (typeof header.kid !== "string" || !header.kid ||
      (header.alg !== "RS256" && !(header.alg === "ES256" && config.jwksJson))) {
    throw new Error("algorithm");
  }
  const jwks = await loadJwks(config);
  const jwk = (jwks.keys ?? []).find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("unknown_key");
  if (jwk.alg !== header.alg) throw new Error("algorithm");
  if (jwk.use !== undefined && jwk.use !== "sig") throw new Error("unknown_key");
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);
  let valid: boolean;
  if (header.alg === "RS256") {
    if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") throw new Error("unknown_key");
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, data);
  } else {
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
      throw new Error("unknown_key");
    }
    const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, alg: "ES256" },
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(signature), data);
  }
  if (!valid) throw new Error("signature");
  const now = config.nowSeconds ?? Date.now() / 1000;
  if (payload.iss !== "https://appleid.apple.com") throw new Error("issuer");
  if (payload.aud !== config.clientId || typeof payload.sub !== "string" || !payload.sub) throw new Error("audience");
  if (typeof payload.exp !== "number" || !Number.isSafeInteger(Math.ceil(payload.exp * 1_000)) || payload.exp <= now) throw new Error("expired");
  // The request carries the raw nonce; Apple's signed claim must bind its hash.
  if (payload.nonce !== (await sha256Hex(nonce))) {
    throw new Error("nonce");
  }
  return { tenant: `apple:${payload.sub}`, provider: "apple", exp: payload.exp };
}
