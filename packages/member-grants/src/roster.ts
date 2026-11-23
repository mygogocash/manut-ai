import { APPROVAL_KINDS, type ApprovalKind } from "@manut/approval-core";

export const MEMBER_IDS = ["buddy", "nam", "pim", "ton", "kit"] as const;
export type MemberId = (typeof MEMBER_IDS)[number];

/// A capability either reads or writes. Reading includes making a draft or a check inside the app:
/// nothing leaves the app, so nothing needs an approval. Everything that reaches a customer, the
/// public, money or a machine is a write and names the approval kind it needs.
export type Capability =
  | {
      readonly id: string;
      readonly access: "read";
      /// Whether the job runs through a connection (a shop channel, a bank feed, a machine).
      readonly needsConnection: boolean;
    }
  | {
      readonly id: string;
      readonly access: "write";
      readonly kind: ApprovalKind;
      readonly needsConnection: boolean;
    };

export interface Member {
  readonly id: string;
  readonly capabilities: readonly Capability[];
}

export type Roster = readonly Member[];

/// The team as it starts. Buddy is the lead: it routes work and writes nothing outside the app.
export const DEFAULT_ROSTER: Roster = [
  { id: "buddy", capabilities: [{ id: "route_work", access: "read", needsConnection: false }] },
  {
    id: "nam",
    capabilities: [
      { id: "read_orders", access: "read", needsConnection: true },
      { id: "order_status", access: "read", needsConnection: true },
      { id: "reply_customers", access: "write", kind: "reply", needsConnection: true },
      // Orders are Nam's on the shop's sites ("Nam uses it for orders and chat"). Placing or changing one may spend,
      // charge or refund the shop's money, so both ask as money, which only the owner decides.
      { id: "place_orders", access: "write", kind: "money", needsConnection: true },
      { id: "change_orders", access: "write", kind: "money", needsConnection: true },
    ],
  },
  {
    id: "pim",
    capabilities: [
      { id: "draft_posts", access: "read", needsConnection: false },
      { id: "publish_posts", access: "write", kind: "public_post", needsConnection: true },
    ],
  },
  {
    id: "ton",
    capabilities: [
      { id: "read_payments", access: "read", needsConnection: true },
      { id: "check_slips", access: "read", needsConnection: false },
      { id: "draft_books", access: "read", needsConnection: false },
      { id: "confirm_payment", access: "write", kind: "payment_confirmation", needsConnection: true },
      { id: "send_books", access: "write", kind: "message", needsConnection: true },
      { id: "ask_refund", access: "write", kind: "money", needsConnection: true },
    ],
  },
  { id: "kit", capabilities: [{ id: "run_command", access: "write", kind: "command", needsConnection: true }] },
];

export function isApprovalKind(value: unknown): value is ApprovalKind {
  return typeof value === "string" && (APPROVAL_KINDS as readonly string[]).includes(value);
}

/// The first member whose job a capability is, or undefined when nobody does it.
export function ownerOf(roster: Roster, capabilityId: string): Member | undefined {
  return roster.find((m) => m.capabilities.some((c) => c.id === capabilityId));
}
