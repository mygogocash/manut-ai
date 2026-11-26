/// The owner's links (docs/pilot-api.md, "Security rules"). The owner has no
/// account in the pilot, so a link itself is the credential: a capability
/// naming exactly one thing the owner may decide, with an expiry, signed with
/// the Wrangler secret `APPROVAL_LINK_SECRET`. There are three kinds:
///
/// - an approval link names one reply: one action on one task of one shop;
/// - a deletion link names one owner confirmation of deleting one shop's data;
/// - an invite link names one invite the owner made for a helper (people.ts).
///   It decides nothing by itself: joining also needs a signed-in session
///   whose verified identity is the one the invite was made for.
///
/// Token form: `<payload>.<mac>`, both base64url without padding. The payload
/// is a JSON array whose first element is its version, 1; the MAC is
/// HMAC-SHA256 under the secret over the kind's domain tag plus the payload
/// text. Each kind has its own tag, so a MAC this backend minted for one kind
/// can never pass as another, whatever its payload says: a reply link can
/// never delete a shop, a deletion link can never approve a reply, and neither
/// can join a shop. The reply link's payload also differs in length from the
/// other two, which is a second, independent refusal.
/// Nothing in the payload is read until the MAC verifies, the comparison is
/// `crypto.subtle.verify` (constant time), and a token is refused unless both
/// halves are in their one canonical encoding, so one link has exactly one
/// spelling.
///
/// Minting is deterministic: the same claim always gives the same token,
/// which is how the operator console re-mints a link on every read without
/// extending it.
///
/// The same secret also keeps sign-in codes sent by email (email-code.ts),
/// which are not links: a code is stored only as its HMAC under a fourth
/// domain tag, `manut-ai/email-code/v1.`, so no new secret has to be set, and
/// no code's MAC can pass as a link's, or the reverse. Where the asks for codes
/// come from is counted under a fifth, `manut-ai/email-code-source/v1.`.

const APPROVAL_DOMAIN = "manut-ai/pilot-approval/v1.";
const DELETION_DOMAIN = "manut-ai/pilot-deletion/v1.";
const INVITE_DOMAIN = "manut-ai/pilot-invite/v1.";
const EMAIL_CODE_DOMAIN = "manut-ai/email-code/v1.";
const EMAIL_SOURCE_DOMAIN = "manut-ai/email-code-source/v1.";
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

export type InviteClaim = {
  tenant: string;
  inviteId: string;
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

/// Whether `secret` can sign: set, and long enough not to be guessed. Email sign-in asks it too, because without it no
/// code can be kept (email-code.ts).
export function usableSecret(secret: string | undefined): secret is string {
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

/// Mints the link for one invite. The invite's expiry is its 7 days (`@manut/people-rules`), and minting is
/// deterministic, so the console's people list shows the same link again while the invite waits.
export async function mintInviteToken(secret: string | undefined, claim: InviteClaim): Promise<string> {
  if (!usableSecret(secret)) throw new Error("approval_link_secret_unset");
  if (!bounded(claim.tenant) || !bounded(claim.inviteId) || !validExpiry(claim.expiresAtMs)) {
    throw new Error("invite_claim_invalid");
  }
  return sign(secret, INVITE_DOMAIN, [1, claim.tenant, claim.inviteId, claim.expiresAtMs]);
}

/// What an invite token this secret signed names, or null for anything else. Unlike the owner's links it answers a
/// genuine token past its expiry too: whether an invite still works is `@manut/people-rules`' answer from the invite the
/// shop holds, whose expiry is the token's, so a revoked, used and expired invite are told apart in the order those
/// rules check them, and every one of them shows nothing about the shop.
export async function openInviteToken(secret: string | undefined, token: string): Promise<InviteClaim | null> {
  const fields = await open(secret, INVITE_DOMAIN, token);
  if (!fields || fields.length !== 4) return null;
  const [, tenant, inviteId, expiresAtMs] = fields;
  if (!bounded(tenant) || !bounded(inviteId) || !validExpiry(expiresAtMs)) return null;
  return { tenant, inviteId, expiresAtMs };
}

/// What a sign-in code sent by email is kept as (email-code.ts): never the code, but its HMAC under the secret. Six
/// digits have only a million values, so a plain SHA-256 of a code is undone by trying them all; this needs the secret
/// too. The MAC covers the address's account (the SHA-256 of the address) beside the code, so a code is good for the one
/// address it was sent to, and it is signed under the code's own domain tag, so it can never pass as a link of any
/// kind. Throws when the secret is unusable, as minting a link does. The auth object compares two of these in constant
/// time inside the storage transaction that settles the try.
export async function macEmailCode(secret: string | undefined, account: string, code: string): Promise<string> {
  if (!usableSecret(secret)) throw new Error("approval_link_secret_unset");
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"),
    new TextEncoder().encode(EMAIL_CODE_DOMAIN + JSON.stringify([1, account, code])));
  return base64url(new Uint8Array(mac));
}

/// What a source of asks for sign-in codes is counted as (email-code.ts): never its address, but an HMAC under the secret
/// of its source group (an IPv4 address or an IPv6 /64, relay.ts), in a domain of its own. A plain hash of an IPv4
/// address is undone by trying all four billion; this needs the secret too. With an `account` (the SHA-256 of an
/// address) the tag counts that source's asks for that one address, and differs for every address, so two addresses'
/// records cannot be joined by where their asks came from; without one it counts the source's asks for every address,
/// in the day's record. Throws when the secret is unusable, as `macEmailCode` does.
export async function macCodeSource(secret: string | undefined, group: string, account?: string): Promise<string> {
  if (!usableSecret(secret)) throw new Error("approval_link_secret_unset");
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"),
    new TextEncoder().encode(EMAIL_SOURCE_DOMAIN + JSON.stringify([1, account ?? null, group])));
  return base64url(new Uint8Array(mac));
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
