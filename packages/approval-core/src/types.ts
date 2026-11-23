/// The shared vocabulary of approvals: what an AI teammate asks, what the person chose, and who
/// they are. The desktop app, the web approval page, the phone and the server all read these
/// same shapes, so a request means the same thing wherever it is decided.
///
/// Times are milliseconds since the Unix epoch, as plain numbers, so they compare without
/// parsing and store unchanged as an integer column or a Durable Object value.

/// What an approved action does in the world. The kind decides who may decide it
/// (`mayDecide`), so it is fixed for the life of a request: a revision may change what is asked,
/// never what kind of thing it is.
///
/// - `message`: a private message the team starts, to a customer or a supplier.
/// - `reply`: a private answer in a conversation someone else started. A reply anyone can read,
///   such as an answer to a public review, is a `public_post`, because what decides the kind is
///   who sees it.
/// - `money`: spends, refunds or moves the shop's money.
/// - `public_post`: anything the public can see, such as a post, a listing or a public answer.
/// - `payment_confirmation`: tells a customer their payment arrived, which releases the goods.
/// - `command`: changes the shop's own records or systems.
export const APPROVAL_KINDS = ["message", "reply", "money", "public_post", "payment_confirmation", "command"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/// Who is deciding. The owner may decide everything. A helper is staff the owner trusts with
/// conversations but not with money or anything public (`mayDecide`).
export const ROLES = ["owner", "helper"] as const;
export type Role = (typeof ROLES)[number];

/// What choosing an option does. It is kept apart from the label so the record says whether the
/// action was approved without anyone parsing a label, which may be in any language. There is
/// deliberately no "approve always" effect: every decision covers exactly one request at one
/// revision, so a standing approval cannot be expressed, let alone slip through.
export const OPTION_EFFECTS = ["approve", "decline"] as const;
export type OptionEffect = (typeof OPTION_EFFECTS)[number];

/// One choice a request offers. Only an option the request offers at the revision the person saw
/// can be chosen (`not_offered`).
export interface ApprovalOption {
  readonly id: string;
  readonly label: string;
  readonly effect: OptionEffect;
}

/// The turn and attempt a request was asked in, or that are running now. Either may be missing:
/// a request asked between turns has no turn, and work outside a task has no attempt. A stored
/// row may hold `null` where a value is missing, so `null` and an absent key mean the same thing.
export interface Stamp {
  readonly turnId?: string | null;
  readonly attemptId?: string | null;
}

/// The turn and attempt the runtime is running now, read from the runtime itself and never from
/// the surface that sends a decision, so a client cannot claim a turn to revive a stale request.
export type Running = Stamp;

/// What an AI teammate asks the person to decide, at its current revision.
export interface ApprovalRequest extends Stamp {
  readonly id: string;
  readonly kind: ApprovalKind;
  /// The choices offered at this revision, in the order to show them.
  readonly options: readonly ApprovalOption[];
  /// Starts at 1 and goes up by one each time what is asked changes. A decision names the
  /// revision the person saw and counts only for that one.
  readonly revision: number;
  /// When the request was first asked. A revision keeps it.
  readonly createdAt: number;
  /// The first instant at which the request can no longer be decided. Absent means it waits
  /// until it is decided or withdrawn.
  readonly expiresAt?: number;
  /// What the person is shown: the text of a post, an amount, a recipient. The rules never read
  /// it. It must be structured-cloneable (plain data), as Durable Object storage requires.
  readonly detail?: unknown;
}

/// What a person chose, as a surface sends it.
export interface Decision {
  readonly requestId: string;
  readonly optionId: string;
  /// The revision the person was shown when they chose. A decision on any other revision is
  /// refused, because it would decide something the person never saw.
  readonly seenRevision: number;
  /// Who decided: an account or device id, recorded so every surface can say who decided.
  readonly decidedBy: string;
  /// The decider's role. The server sets it from the signed-in session, never from the body a
  /// client sent, or a helper could claim to be the owner.
  readonly role: Role;
}

/// A decision the store accepted. It is the first and only one the request will ever have.
export interface SettledDecision extends Decision {
  readonly decidedAt: number;
}

/// Everything the store knows about one request. A request leaves `pending` at most once, into
/// `decided` or `withdrawn`, and never comes back, which is what makes it settle once.
export type ApprovalRecord =
  | { readonly status: "pending"; readonly request: ApprovalRequest }
  | { readonly status: "decided"; readonly request: ApprovalRequest; readonly decision: SettledDecision }
  | { readonly status: "withdrawn"; readonly request: ApprovalRequest; readonly withdrawnAt: number };

/// Why a request the person saw can no longer be decided while nothing decided it.
/// - `turn_ended`: it was asked in a turn other than the one running now.
/// - `attempt_ended`: it was asked in an attempt other than the one running now.
/// - `withdrawn`: the team took it back.
/// - `not_found`: the store has no such request.
export type SupersededReason = "turn_ended" | "attempt_ended" | "withdrawn" | "not_found";

/// Where the request a person is looking at stands, read without deciding anything. A surface
/// asks while it shows a request, so its buttons go away before anyone presses one that would be
/// refused. Every state carries a reason code for the surface to put into words, such as "This
/// question is no longer available." for anything superseded.
export type Standing =
  | { readonly state: "open"; readonly reason: "waiting" }
  | { readonly state: "decided"; readonly reason: "decided"; readonly decision: SettledDecision }
  | { readonly state: "changed"; readonly reason: "revised"; readonly currentRevision: number }
  | { readonly state: "superseded"; readonly reason: SupersededReason }
  | { readonly state: "expired"; readonly reason: "expired"; readonly expiredAt: number };

/// What became of a decision. Only `ok: true` settled the request; every refusal left it exactly
/// as it was, so a refused decision never blocks the next valid one.
export type DecideResult =
  | { readonly ok: true; readonly decision: SettledDecision }
  | { readonly ok: false; readonly refused: "not_found" }
  /// Someone already decided this request, from this surface or another one. The first decision
  /// comes back so the surface can say who decided and when.
  | { readonly ok: false; readonly refused: "already_decided"; readonly decision: SettledDecision }
  | { readonly ok: false; readonly refused: "not_permitted" }
  | { readonly ok: false; readonly refused: "superseded"; readonly reason: Exclude<SupersededReason, "not_found"> }
  | { readonly ok: false; readonly refused: "expired"; readonly expiredAt: number }
  /// The request moved on to another revision since the person saw it. The surface shows the
  /// current one so the person can decide what is now asked.
  | { readonly ok: false; readonly refused: "changed"; readonly currentRevision: number }
  | { readonly ok: false; readonly refused: "not_offered" };

/// A new request as the runtime asks it. The store gives it revision 1 and its creation time.
export interface NewApprovalRequest extends Stamp {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly options: readonly ApprovalOption[];
  readonly expiresAt?: number;
  readonly detail?: unknown;
}

/// What a request asks once it changes. It replaces the whole of what was asked, stamps
/// included: where a request was asked is the runtime's to say again each time it asks, so a
/// stamp missing here clears the old one rather than keeping it.
export interface RequestRevision extends Stamp {
  readonly options: readonly ApprovalOption[];
  readonly expiresAt?: number;
  readonly detail?: unknown;
}

export type OpenResult =
  | { readonly ok: true; readonly request: ApprovalRequest }
  /// Ids are never reused. Opening an id again, even one already decided, is refused, so a
  /// second open can never reset a decided request back to pending.
  | { readonly ok: false; readonly refused: "already_exists" }
  | { readonly ok: false; readonly refused: "invalid"; readonly problem: string };

export type ReviseResult =
  | { readonly ok: true; readonly request: ApprovalRequest }
  | { readonly ok: false; readonly refused: "not_found" }
  | { readonly ok: false; readonly refused: "already_decided"; readonly decision: SettledDecision }
  | { readonly ok: false; readonly refused: "withdrawn" }
  | { readonly ok: false; readonly refused: "invalid"; readonly problem: string };

export type WithdrawResult =
  | { readonly ok: true; readonly withdrawnAt: number }
  | { readonly ok: false; readonly refused: "not_found" }
  | { readonly ok: false; readonly refused: "already_decided"; readonly decision: SettledDecision };
