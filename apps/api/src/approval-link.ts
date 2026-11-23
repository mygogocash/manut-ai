/// The owner's approval link (docs/pilot-api.md, "Security rules"). The owner
/// has no account in the pilot, so the link itself is the credential: a
/// capability naming exactly one action on one task of one shop, with an
/// expiry, signed with the Wrangler secret `APPROVAL_LINK_SECRET`.
///
/// Token form: `<payload>.<mac>`, both base64url without padding. The payload
/// is the JSON array `[1, tenant, taskId, actionId, expiresAtMs]`; the MAC is
/// HMAC-SHA256 under the secret over a domain tag plus the payload text, so a
/// MAC minted for anything else this backend might ever sign cannot pass as
/// an approval. Nothing in the payload is read until the MAC verifies, the
/// comparison is `crypto.subtle.verify` (constant time), and a token is
/// refused unless both halves are in their one canonical encoding, so one
/// link has exactly one spelling.
///
/// Minting is deterministic: the same action and expiry always give the same
/// token, which is how the operator console re-mints a link on every read
/// without extending it.

const DOMAIN = "manut-ai/pilot-approval/v1.";
/// A secret shorter than this is treated as unset. HMAC accepts any length,
/// but a short secret is a guessable one, and a guessed secret approves
/// anything.
const MIN_SECRET_LENGTH = 32;
const MAX_TOKEN_LENGTH = 2048;
const MAX_FIELD_LENGTH = 256;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

/// How long a link lives: 24 hours from the proposal. The proposal itself
/// expires at the same instant, so no route, link or not, can approve it later.
export const APPROVAL_LINK_TTL_MS = 24 * 3600 * 1000;

export type ApprovalClaim = {
  tenant: string;
  taskId: string;
  actionId: string;
  expiresAtMs: number;
};

export type ApprovalCheck =
  | { ok: true; claim: ApprovalClaim }
  | { ok: false; error: "link_invalid" | "link_expired" };

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/// Decodes strict base64url: the text must be what encoding its own bytes
/// gives back, so alternate spellings of the same bytes are refused.
function fromBase64url(text: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return base64url(bytes) === text ? bytes : null;
}

function usableSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);
}

function bounded(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

/// Mints the token for one action. Throws when the secret is unusable, so a
/// misconfigured environment refuses to hand out links instead of minting
/// ones nobody can verify.
export async function mintApprovalToken(secret: string | undefined, claim: ApprovalClaim): Promise<string> {
  if (!usableSecret(secret)) throw new Error("approval_link_secret_unset");
  if (!bounded(claim.tenant) || !bounded(claim.taskId) || !bounded(claim.actionId) ||
      !Number.isSafeInteger(claim.expiresAtMs)) {
    throw new Error("approval_claim_invalid");
  }
  const payload = base64url(
    new TextEncoder().encode(JSON.stringify([1, claim.tenant, claim.taskId, claim.actionId, claim.expiresAtMs])),
  );
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), new TextEncoder().encode(DOMAIN + payload));
  return `${payload}.${base64url(new Uint8Array(mac))}`;
}

/// Verifies a token and returns what it names. Anything that is not a token
/// this secret signed answers `link_invalid`; only a genuine token past its
/// expiry answers `link_expired`, so the difference reveals nothing to a
/// forger. An unset secret makes every link invalid.
export async function checkApprovalToken(
  secret: string | undefined,
  token: string,
  nowMs: number,
): Promise<ApprovalCheck> {
  const invalid: ApprovalCheck = { ok: false, error: "link_invalid" };
  if (!usableSecret(secret) || token.length > MAX_TOKEN_LENGTH || !TOKEN_SHAPE.test(token)) return invalid;
  const [payload = "", macText = ""] = token.split(".");
  const mac = fromBase64url(macText);
  if (!mac || mac.length !== 32 || !fromBase64url(payload)) return invalid;
  const genuine = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    mac,
    new TextEncoder().encode(DOMAIN + payload),
  );
  if (!genuine) return invalid;
  let fields: unknown;
  try {
    fields = JSON.parse(new TextDecoder().decode(fromBase64url(payload)!));
  } catch {
    return invalid;
  }
  if (!Array.isArray(fields) || fields.length !== 5 || fields[0] !== 1) return invalid;
  const [, tenant, taskId, actionId, expiresAtMs] = fields as unknown[];
  if (!bounded(tenant) || !bounded(taskId) || !bounded(actionId) ||
      typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs)) {
    return invalid;
  }
  if (nowMs >= expiresAtMs) return { ok: false, error: "link_expired" };
  return { ok: true, claim: { tenant, taskId, actionId, expiresAtMs } };
}
