/// The owner's links (docs/pilot-api.md, "Security rules"). The owner has no
/// account in the pilot, so a link itself is the credential: a capability
/// naming exactly one thing the owner may decide, with an expiry, signed with
/// the Wrangler secret `APPROVAL_LINK_SECRET`. There are two kinds:
///
/// - an approval link names one reply: one action on one task of one shop;
/// - a deletion link names one owner confirmation of deleting one shop's data.
///
/// Token form: `<payload>.<mac>`, both base64url without padding. The payload
/// is a JSON array whose first element is its version, 1; the MAC is
/// HMAC-SHA256 under the secret over the kind's domain tag plus the payload
/// text. Each kind has its own tag, so a MAC this backend minted for one kind
/// can never pass as the other, whatever its payload says: a reply link can
/// never delete a shop and a deletion link can never approve a reply. The
/// payloads also differ in length, which is a second, independent refusal.
/// Nothing in the payload is read until the MAC verifies, the comparison is
/// `crypto.subtle.verify` (constant time), and a token is refused unless both
/// halves are in their one canonical encoding, so one link has exactly one
/// spelling.
///
/// Minting is deterministic: the same claim always gives the same token,
/// which is how the operator console re-mints a link on every read without
/// extending it.

const APPROVAL_DOMAIN = "manut-ai/pilot-approval/v1.";
const DELETION_DOMAIN = "manut-ai/pilot-deletion/v1.";
/// A secret shorter than this is treated as unset. HMAC accepts any length,
/// but a short secret is a guessable one, and a guessed secret approves
/// anything.
const MIN_SECRET_LENGTH = 32;
const MAX_TOKEN_LENGTH = 2048;
const MAX_FIELD_LENGTH = 256;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

/// How long an approval link lives: 24 hours from the proposal. The proposal
/// itself expires at the same instant, so no route, link or not, can approve
/// it later.
export const APPROVAL_LINK_TTL_MS = 24 * 3600 * 1000;

/// How long a deletion link lives: 24 hours from the operator's request. The
/// owner confirmation it names expires at the same instant.
export const DELETION_LINK_TTL_MS = 24 * 3600 * 1000;

export type ApprovalClaim = {
  tenant: string;
  taskId: string;
  actionId: string;
  expiresAtMs: number;
};

export type DeletionClaim = {
  tenant: string;
  confirmationId: string;
  expiresAtMs: number;
};

export type LinkError = "link_invalid" | "link_expired";

export type ApprovalCheck = { ok: true; claim: ApprovalClaim } | { ok: false; error: LinkError };

export type DeletionCheck = { ok: true; claim: DeletionClaim } | { ok: false; error: LinkError };

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

/// Signs `fields` under one kind's domain tag. Throws when the secret is
/// unusable, so a misconfigured environment refuses to hand out links instead
/// of minting ones nobody can verify.
async function sign(secret: string | undefined, domain: string, fields: (string | number)[]): Promise<string> {
  if (!usableSecret(secret)) throw new Error("approval_link_secret_unset");
  const payload = base64url(new TextEncoder().encode(JSON.stringify(fields)));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), new TextEncoder().encode(domain + payload));
  return `${payload}.${base64url(new Uint8Array(mac))}`;
}

/// The fields of a token this secret signed under `domain`, or null for
/// anything else. Only a payload whose MAC verifies is ever parsed.
async function open(secret: string | undefined, domain: string, token: string): Promise<unknown[] | null> {
  if (!usableSecret(secret) || token.length > MAX_TOKEN_LENGTH || !TOKEN_SHAPE.test(token)) return null;
  const [payload = "", macText = ""] = token.split(".");
  const mac = fromBase64url(macText);
  if (!mac || mac.length !== 32 || !fromBase64url(payload)) return null;
  const genuine = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    mac,
    new TextEncoder().encode(domain + payload),
  );
  if (!genuine) return null;
  let fields: unknown;
  try {
    fields = JSON.parse(new TextDecoder().decode(fromBase64url(payload)!));
  } catch {
    return null;
  }
  return Array.isArray(fields) && fields[0] === 1 ? fields : null;
}

function validExpiry(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/// Mints the token for one action. Throws when the secret is unusable or the
/// claim is not one a token can carry.
export async function mintApprovalToken(secret: string | undefined, claim: ApprovalClaim): Promise<string> {
  if (!usableSecret(secret)) throw new Error("approval_link_secret_unset");
  if (!bounded(claim.tenant) || !bounded(claim.taskId) || !bounded(claim.actionId) || !validExpiry(claim.expiresAtMs)) {
    throw new Error("approval_claim_invalid");
  }
  return sign(secret, APPROVAL_DOMAIN, [1, claim.tenant, claim.taskId, claim.actionId, claim.expiresAtMs]);
}

/// Verifies an approval token and returns what it names. Anything that is not
/// an approval token this secret signed answers `link_invalid`; only a
/// genuine token past its expiry answers `link_expired`, so the difference
/// reveals nothing to a forger. An unset secret makes every link invalid.
export async function checkApprovalToken(
  secret: string | undefined,
  token: string,
  nowMs: number,
): Promise<ApprovalCheck> {
  const fields = await open(secret, APPROVAL_DOMAIN, token);
  if (!fields || fields.length !== 5) return { ok: false, error: "link_invalid" };
  const [, tenant, taskId, actionId, expiresAtMs] = fields;
  if (!bounded(tenant) || !bounded(taskId) || !bounded(actionId) || !validExpiry(expiresAtMs)) {
    return { ok: false, error: "link_invalid" };
  }
  if (nowMs >= expiresAtMs) return { ok: false, error: "link_expired" };
  return { ok: true, claim: { tenant, taskId, actionId, expiresAtMs } };
}

/// Mints the token for one owner confirmation of a shop's deletion.
export async function mintDeletionToken(secret: string | undefined, claim: DeletionClaim): Promise<string> {
  if (!usableSecret(secret)) throw new Error("approval_link_secret_unset");
  if (!bounded(claim.tenant) || !bounded(claim.confirmationId) || !validExpiry(claim.expiresAtMs)) {
    throw new Error("deletion_claim_invalid");
  }
  return sign(secret, DELETION_DOMAIN, [1, claim.tenant, claim.confirmationId, claim.expiresAtMs]);
}

/// Verifies a deletion token, with the same answers as `checkApprovalToken`.
export async function checkDeletionToken(
  secret: string | undefined,
  token: string,
  nowMs: number,
): Promise<DeletionCheck> {
  const fields = await open(secret, DELETION_DOMAIN, token);
  if (!fields || fields.length !== 4) return { ok: false, error: "link_invalid" };
  const [, tenant, confirmationId, expiresAtMs] = fields;
  if (!bounded(tenant) || !bounded(confirmationId) || !validExpiry(expiresAtMs)) {
    return { ok: false, error: "link_invalid" };
  }
  if (nowMs >= expiresAtMs) return { ok: false, error: "link_expired" };
  return { ok: true, claim: { tenant, confirmationId, expiresAtMs } };
}
