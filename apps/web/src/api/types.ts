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

/// The shop's own payment to Manut AI, recorded once the money is seen in Manut AI's bank account. `slipRef` is the
/// reference printed on the bank slip; one slip is recorded once per shop.
export type SubscriptionPayment = {
  id: string;
  tenant: string;
  amountSatang: number;
  slipRef: string;
  slipNote?: string;
  confirmedAt: string;
};

export type NewSubscriptionPayment = {
  tenant: string;
  amountSatang: number;
  slipRef: string;
  slipNote?: string;
};

/// "not_yet" before day 14, and on day 14 until a decision in its window arrives or the day ends.
export type ActiveOnDay14 = "yes" | "no" | "not_yet";

/// One shop in the Phase 1 gate (docs/pilot-api.md, "The pilot gate").
export type GateShop = {
  tenant: string;
  name: string;
  /// Null until the shop's LINE account is connected, which starts the trial.
  trialStartedAt: string | null;
  /// Today's day of the trial, counted on Bangkok's calendar from 1; null before it starts.
  day: number | null;
  /// Day 14 has passed. Only these shops are counted.
  trialEnded: boolean;
  paid: boolean;
  /// When the shop's subscription payments first reached the price.
  paidAt?: string;
  paidSatang: number;
  activeOnDay14: ActiveOnDay14;
  lastDecisionAt?: string;
};

/// One of the gate's two shares: `percent` is rounded down, and null while no shop is counted. `met` compares the
/// exact counts with the line.
export type GateMeasure = { count: number; percent: number | null; thresholdPercent: number; met: boolean };

export type GateStatus = "not_enough_data" | "on_track" | "below_line";

export type PilotGate = {
  asOf: string;
  rules: { trialDays: number; priceSatang: number; activeWindowDays: number };
  shops: GateShop[];
  cohort: { counted: number; paid: GateMeasure; active: GateMeasure; status: GateStatus };
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

/// Who an audit entry says acted: an operator by their Cloudflare Access identity (null for a service token, and in
/// practice mode), the shop's owner (through a link, or with the id of their signed-in device), a helper, a worker by
/// its attempt, or Manut AI's own system.
export type AuditActor =
  | { kind: "operator"; email: string | null }
  | { kind: "owner"; id?: string }
  | { kind: "helper"; id: string }
  | { kind: "worker"; attemptId: string }
  | { kind: "system" };

/// One entry of a shop's audit log (docs/pilot-api.md, "Audit log"): who did what and when, metadata only. `action`
/// and `outcome` are the contract's codes; a code this console does not know yet is shown as it is rather than
/// dropped, so they are kept as strings.
export type AuditEntry = {
  id: string;
  at: string;
  actor: AuditActor;
  action: string;
  /// Only ids: `taskId`, `actionId`, `messageId`, `attemptId`, `requestId`, `paymentId`, `connectionId`,
  /// `previousConnectionId`, `confirmationId`.
  subject: Record<string, string>;
  outcome: string;
  reason?: string;
  amountSatang?: number;
};

/// How many entries the log could not write for the shop, and the last one's time and action.
export type AuditMissed = { count: number; lastAt: string; lastAction: string };

/// One page of a shop's log, newest first. `next` is the cursor for the page before it, null on the oldest page.
export type AuditPage = { tenant: string; entries: AuditEntry[]; next: string | null; missed: AuditMissed | null };

/// Which page to read: the entries before the cursor `before` (an entry's id), at most `limit` of them (1 to 200; the
/// API reads 50 when the console does not say).
export type AuditQuery = { before?: string; limit?: number };

/// Who set a shop's monthly model cap, and when. `setBy` is the operator's Cloudflare Access email, and null for a
/// service token (and in practice mode, whose key has no identity).
export type ModelCapOverride = { capSatang: number; setAt: string; setBy: string | null };

/// Where a shop's cap comes from: an operator's override for that shop, or the default every shop without one gets.
export type ModelCapSource = "override" | "default";

/// One model call as the meter records it (docs/model-gateway.md, "The metering record"). `at` is when its budget was
/// reserved. `millisatang` is the exact cost in thousandths of a satang, and `satang` is that rounded up, for reading.
/// Token counts are zero for a call that failed, could not be read or was abandoned. `outcome` is `ok`, `failed`,
/// `unreadable` or `abandoned`; a code this console does not know yet is shown as it is, so it is kept a string.
export type ModelCall = {
  id: string;
  at: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  millisatang: number;
  satang: number;
  outcome: string;
};

/// A reservation still open: a call in progress, counted against the cap at its worst case until it settles.
export type ModelHold = { callId: string; model: string; worstMillisatang: number; at: string; expiresAt: string };

/// Calls by how they ended, and `refused`: calls stopped at the cap, which never reached a provider.
export type ModelCounts = { ok: number; failed: number; unreadable: number; abandoned: number; refused: number };

/// `GET /v1/admin/model/usage`: a shop's spend, cap and calls for one Bangkok month. Spend and holds are rounded up and
/// `remainingSatang` down, so the page never shows a shop more room than it has. `calls` lists the month's newest 200
/// records, newest first. The contract always sends `calls` and `holds`; they are optional here so a page never breaks
/// on an answer that leaves one out.
export type ModelUsage = {
  tenant: string;
  /// `YYYY-MM`, in Bangkok.
  month: string;
  capSatang: number;
  capSource: ModelCapSource;
  capOverride: ModelCapOverride | null;
  spentSatang: number;
  spentMillisatang: number;
  heldSatang: number;
  heldMillisatang: number;
  remainingSatang: number;
  counts: ModelCounts;
  tokens: { input: number; output: number };
  calls?: ModelCall[];
  holds?: ModelHold[];
};

/// `PUT /v1/admin/model/cap`: the cap as it now stands, which is what the page confirms.
export type ModelCap = { tenant: string; capSatang: number; capSource: ModelCapSource; capOverride: ModelCapOverride | null };

/// `capSatang` is whole satang from 0 to `MODEL_CAP_MAX_SATANG`, or null to clear the override so the default applies
/// again. It must be present: a request that forgot it never clears a cap by accident.
export type NewModelCap = { tenant: string; capSatang: number | null };

/// The largest cap the API takes: ฿10 million, far above any shop's month.
export const MODEL_CAP_MAX_SATANG = 1_000_000_000;

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

  /// The shop's own payments to Manut AI. Rejects with 409 `slip_already_recorded`, recording nothing, for a slip
  /// already recorded for the shop.
  recordSubscriptionPayment(input: NewSubscriptionPayment): Promise<SubscriptionPayment>;
  listSubscriptionPayments(tenant: string): Promise<SubscriptionPayment[]>;
  /// The Phase 1 gate: every shop's trial, payment and activity, and the cohort against the gate's two lines.
  getGate(): Promise<PilotGate>;

  /// `GET /v1/admin/audit`: one page of a shop's audit log, newest first. Rejects with 400 `invalid_request` for a
  /// cursor that is not an entry's id or a size out of range.
  listAudit(tenant: string, query?: AuditQuery): Promise<AuditPage>;

  /// `GET /v1/admin/model/usage`: a shop's model spend, cap and calls for one Bangkok month (`YYYY-MM`), the current
  /// one when none is given. Rejects with 400 `tenant_required`, 400 `invalid_request` for a month that is not one, 503
  /// `not_configured` naming the setting it could not read (`ApiError.setting`), and 503 `meter_unavailable`.
  getModelUsage(tenant: string, month?: string): Promise<ModelUsage>;
  /// `PUT /v1/admin/model/cap`: sets a shop's monthly cap, or clears its override with `capSatang: null`. A new cap
  /// applies from the next call; calls already holding budget keep it. Rejects with 400 `tenant_required`, 400
  /// `invalid_request` for a cap that is missing, not whole or out of range, 503 `not_configured` naming the setting,
  /// and 503 `meter_unavailable`, which does not say whether the cap was written.
  setModelCap(input: NewModelCap): Promise<ModelCap>;
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
  /// The API setting that is missing or cannot be read, on a 503 `not_configured` from the model routes.
  setting?: string;
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
  readonly setting: string | undefined;

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
    this.setting = details.setting;
  }
}
