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

export type Shop = {
  tenant: string;
  name: string;
  ownerName: string;
  lineConnectionId?: string;
  consent: boolean;
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

/// The reply text the broker accepts: 1 to 5,000 characters.
export const REPLY_MAX_LENGTH = 5000;

/// States in which the send has begun but not settled. The owner's page polls while a view is in one.
export function isSending(state: ApprovalState): boolean {
  return state === "approved" || state === "dispatching";
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
}

/// An answer other than success. `status` is 0 when the request never got an answer. `code` is the
/// contract's `error` string (`link_invalid`, `already_decided`, ...) or `http_<status>` when the body had
/// none. `view` is set on a 409 `already_decided`.
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly view: ApprovalView | undefined;

  constructor(status: number, code: string, view?: ApprovalView) {
    super(`${status} ${code}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.view = view;
  }
}
