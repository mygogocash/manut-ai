import type { ApprovalKind } from "@manut/approval-core";
import { inPracticeMode, type Connection } from "./connection";
import { DEFAULT_ROSTER, isApprovalKind, ownerOf, type Roster } from "./roster";

export type Refusal = "unknown_member" | "unknown_capability" | "unknown_kind";

export type Decision =
  /// A read: no approval needed.
  | { readonly answer: "allowed" }
  /// A write: it waits for an approval of this kind.
  | { readonly answer: "ask"; readonly kind: ApprovalKind }
  /// Practice mode: make a draft, send nothing. `kind` says what the approval would have been.
  | { readonly answer: "draft_only"; readonly kind: ApprovalKind }
  /// The job belongs to someone else.
  | { readonly answer: "not_my_job"; readonly member: string }
  | { readonly answer: "not_connected" }
  /// Something unknown or malformed in the data: refused, never guessed.
  | { readonly answer: "refused"; readonly reason: Refusal };

/// Whether `member` may do `capability` on `connection` at `now`.
///
/// Rules no roster data can change: a write never answers `allowed`, so money and public posts always
/// ask (or draft in practice); a write whose approval kind is not a known kind is refused.
export function decide(
  member: string,
  capability: string,
  connection: Connection | null | undefined,
  now: number,
  roster: Roster = DEFAULT_ROSTER,
): Decision {
  const who = roster.find((m) => m.id === member);
  if (!who) return { answer: "refused", reason: "unknown_member" };

  const mine = who.capabilities.find((c) => c.id === capability);
  if (!mine) {
    const owner = ownerOf(roster, capability);
    if (!owner) return { answer: "refused", reason: "unknown_capability" };
    return { answer: "not_my_job", member: owner.id };
  }

  if (mine.access === "write" && !isApprovalKind(mine.kind)) return { answer: "refused", reason: "unknown_kind" };

  if (mine.needsConnection && (!connection || !connection.connected || !Number.isFinite(connection.connectedAt))) {
    return { answer: "not_connected" };
  }

  if (mine.access === "read") return { answer: "allowed" };
  // A job that needs no connection has no practice clock, so it asks as usual.
  if (mine.needsConnection && connection && inPracticeMode(connection, now)) {
    return { answer: "draft_only", kind: mine.kind };
  }
  return { answer: "ask", kind: mine.kind };
}
