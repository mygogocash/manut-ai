/// The shapes in docs/pilot-api.md, word for word. Both sides build to that file, so a change here starts
/// there. Times are ISO 8601 strings in UTC; money is integer satang.

export type ApprovalState =
  | "proposed"
  | "approved"
  | "rejected"
  | "expired"
  | "dispatching"
  | "confirmed"
  | "failed"
  | "unknown";

export type ApprovalView = {
  shopName: string;
  memberName: string;
  memberRole: string;
  kind: "line.reply";
  customerName: string;
  customerMessage: string;
  replyText: string;
  state: ApprovalState;
  decidedAt?: string;
  expiresAt: string;
  needsConsent: boolean;
};

/// Where the owner's confirmation of a shop's deletion stands. `deleting` means the owner said yes and the wipe has
/// not finished: it is running, or it stopped part way and the operator's same request finishes it.
export type DeletionState = "awaiting_owner" | "deleting" | "deleted" | "declined" | "expired";

/// What a deletion takes from a shop.
export type DeletionGoes = { messages: number; replies: number; payments: number; lineConnected: boolean };

/// The owner's deletion page. `goes` is counted afresh while the shop's data is there and, once it is gone, is what
/// the shop held when the operator asked.
export type DeletionView = {
  shopName: string;
  goes: DeletionGoes;
  state: DeletionState;
  expiresAt: string;
  decidedAt?: string;
};

/// A shop's latest deletion request, as the shop list carries it. The link is re-minted on each read at the same
/// expiry.
export type DeletionRequest = {
  state: DeletionState;
  confirmUrl: string;
  expiresAt: string;
  decidedAt?: string;
};

export type Shop = {
  tenant: string;
  name: string;
  ownerName: string;
  lineConnectionId?: string;
  consent: boolean;
  deletion?: DeletionRequest;
};

export type InboundMessage = {
  id: string;
  connectionId: string;
  lineUserId: string;
  displayName?: string;
  text: string;
  receivedAt: string;
  replyActionId?: string;
};

export type ReplyAction = {
  taskId: string;
  actionId: string;
  messageId: string;
  replyText: string;
  state: ApprovalState;
  proposedAt: string;
  decidedAt?: string;
  dispatchedAt?: string;
  approvalUrl: string;
};

export type Payment = {
  id: string;
  tenant: string;
  orderRef: string;
  amountSatang: number;
  promptPayId: string;
  slipNote?: string;
  confirmedAt: string;
};

export type NewShop = { name: string; ownerName: string };
export type CreatedShop = { tenant: string; name: string; ownerName: string };

export type NewLineConnection = {
  tenant: string;
  channelId: string;
  botUserId: string;
  channelSecret: string;
  channelAccessToken: string;
};
export type CreatedLineConnection = { connectionId: string; webhookUrl: string };

export type NewReply = { tenant: string; messageId: string; text: string };
export type ProposedReply = { taskId: string; actionId: string; approvalUrl: string; expiresAt: string };

export type NewPayment = {
  tenant: string;
  orderRef: string;
  amountSatang: number;
  promptPayId: string;
  slipNote?: string;
};

/// Everything stored for one shop, as the backend's tenant export answers it. Only the fields every export
/// has are named; the rest is kept exactly as the backend sent it, so a saved export is complete.
export type ShopExport = { tenant: string; exportedAt: string } & Record<string, unknown>;

/// `confirmName` must be the shop's exact name: a deletion cannot be undone, so an id pasted for the wrong
/// shop must delete nothing.
export type ShopDeletion = { tenant: string; confirmName: string };

export type DeletedShop = {
  tasksWiped: number;
  connectionsWiped: number;
  schedulesWiped: number;
  occurrencesWiped: number;
  sessionsWiped: number;
  deletedAt: string;
};

/// The answer to deleting a live shop (202): nothing is deleted yet, and `confirmUrl` is the link to send the owner.
/// Asking again while that confirmation waits answers the same link.
export type AwaitingOwner = { status: "awaiting_owner"; confirmUrl: string; expiresAt: string };

/// The reply text the broker accepts: 1 to 5,000 characters.
export const REPLY_MAX_LENGTH = 5000;

/// States in which the send has begun but not settled. The owner's page polls while a view is in one.
export function isSending(state: ApprovalState): boolean {
  return state === "approved" || state === "dispatching";
}

/// Whether a shop is live: its owner has allowed sending or its LINE account is connected. Deleting a live shop
/// needs the owner's confirmation; a shop that never went live is deleted by the operator alone.
export function isLiveShop(shop: Pick<Shop, "consent" | "lineConnectionId">): boolean {
  return shop.consent || Boolean(shop.lineConnectionId);
}

export function isAwaitingOwner(answer: DeletedShop | AwaitingOwner): answer is AwaitingOwner {
  return "status" in answer && answer.status === "awaiting_owner";
}

/// Every route in the contract. The real client and the in-memory fake both implement it, so every screen
/// runs, and is tested, the same way against either.
export interface PilotApi {
  /// `POST /v1/inbound/line/{connectionId}`. Called by LINE, not by these pages; here so local tools and
  /// tests can deliver a signed webhook. Resolves on 200, rejects with 401 or 404.
  deliverLineWebhook(connectionId: string, rawBody: string, signature: string): Promise<void>;

  getApproval(token: string): Promise<ApprovalView>;
  giveConsent(token: string): Promise<ApprovalView>;
  decide(token: string, approve: boolean): Promise<ApprovalView>;

  createShop(input: NewShop): Promise<CreatedShop>;
  listShops(): Promise<Shop[]>;
  createLineConnection(input: NewLineConnection): Promise<CreatedLineConnection>;
  listMessages(tenant: string): Promise<InboundMessage[]>;
  proposeReply(input: NewReply): Promise<ProposedReply>;
  listActions(tenant: string): Promise<ReplyAction[]>;
  recordPayment(input: NewPayment): Promise<Payment>;
  listPayments(tenant: string): Promise<Payment[]>;
  exportShop(tenant: string): Promise<ShopExport>;
  /// Rejects with 409 `name_mismatch`, deleting nothing, unless `confirmName` is the shop's exact name. A live shop
  /// is not deleted yet: the answer is `AwaitingOwner`, with the link to send its owner. Once the owner has said yes,
  /// the same request finishes a deletion that stopped part way.
  deleteShop(input: ShopDeletion): Promise<DeletedShop | AwaitingOwner>;

  /// The owner's deletion link: `GET /v1/pilot/deletions/{token}` and its decision.
  getDeletion(token: string): Promise<DeletionView>;
  decideDeletion(token: string, approve: boolean): Promise<DeletionView>;
}

/// What an error answer carried besides its code, kept so the screens can say exactly what happened.
export type ApiErrorDetails = {
  /// The settled deletion page, on a 409 `already_decided` from a deletion link.
  deletionView?: DeletionView;
  /// What a deletion could not wipe, on a 500 `wipe_incomplete`.
  failed?: string[];
  /// When and by whom a shop was deleted, on a 404 `tenant_deleted`. `deletedBy` is null for a service token.
  deletedAt?: string;
  deletedBy?: string | null;
};

/// An answer other than success. `status` is 0 when the request never got an answer. `code` is the
/// contract's `error` string (`link_invalid`, `already_decided`, ...) or `http_<status>` when the body had
/// none. `view` is set on a 409 `already_decided` from an approval link, and the details on the answers they name.
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly view: ApprovalView | undefined;
  readonly deletionView: DeletionView | undefined;
  readonly failed: string[] | undefined;
  readonly deletedAt: string | undefined;
  readonly deletedBy: string | null | undefined;

  constructor(status: number, code: string, view?: ApprovalView, details: ApiErrorDetails = {}) {
    super(`${status} ${code}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.view = view;
    this.deletionView = details.deletionView;
    this.failed = details.failed;
    this.deletedAt = details.deletedAt;
    this.deletedBy = details.deletedBy;
  }
}
