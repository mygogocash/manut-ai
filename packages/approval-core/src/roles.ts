import { APPROVAL_KINDS, type ApprovalKind, type Role } from "./types";

/// The kinds a helper may decide. It is a list of what is allowed rather than of what is not, so
/// a kind added later is owner-only until someone decides otherwise here.
const HELPER_KINDS: ReadonlySet<string> = new Set<ApprovalKind>(["message", "reply"]);

const KNOWN_KINDS: ReadonlySet<string> = new Set<string>(APPROVAL_KINDS);

/// Whether someone in `role` may decide a request of `kind`, approving or declining alike.
///
/// The owner decides everything. A helper decides private messages and replies only: money,
/// public posts, payment confirmations and commands need the owner, and a helper may not decline
/// them either, because a refusal is a decision about the shop's money or public face too.
/// Anything this function does not recognise, a role or a kind arriving from a newer client for
/// example, is refused rather than guessed.
export function mayDecide(role: Role, kind: ApprovalKind): boolean {
  if (!KNOWN_KINDS.has(kind)) return false;
  if (role === "owner") return true;
  if (role === "helper") return HELPER_KINDS.has(kind);
  return false;
}
