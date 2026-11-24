import type { Fact } from "@manut/shop-memory";

/// The shapes in docs/pilot-api.md, word for word. Both sides build to that file, so a change here starts
/// there. Times are ISO 8601 strings in UTC; money is integer satang. A fact's times are the one exception: epoch
/// milliseconds, as `@manut/shop-memory` keeps them (see "Memory" there).

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
  /// The name the owner gave the helper who approved or declined this reply, when a helper did. Absent when the owner
  /// decided, wherever from: this is the owner's own page.
  decidedByHelper?: string;
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

/// A shop's deletion that started and has not finished: it is running, or it stopped part way. The same deletion
/// request finishes it, and the API keeps the shop on its list until it has. `shopRecord` is false once the deletion
/// has removed the shop's own record: the row then holds only its tenant and the name the deletion recorded, with no
/// owner name and no consent, and the shop can no longer be opened.
export type Deleting = { shopRecord: boolean };

export type Shop = {
  tenant: string;
  name: string;
  ownerName: string;
  lineConnectionId?: string;
  /// The shop template it was made from, when it was.
  template?: string;
  /// Its owner made it in the app, signed in, with no operator (docs/pilot-api.md, "Making a shop of your own").
  selfServe?: true;
  consent: boolean;
  deletion?: DeletionRequest;
  deleting?: Deleting;
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
  /// Its owner made it in the app, with no operator.
  selfServe?: true;
  /// Whether it is counted once its day 14 has passed: false for a shop its owner made that an operator has not added. An
  /// API from before shops could be made that way leaves it out, which reads as counted.
  inCohort?: boolean;
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

/// `template` is a shop template's id (`GET /v1/admin/templates`); left out, the shop starts with none.
export type NewShop = { name: string; ownerName: string; template?: string };
export type CreatedShop = { tenant: string; name: string; ownerName: string; template?: string };

/// A shop template a new shop can start from, in the API's own words (`@manut/shop-templates`): the members it turns
/// on, its routines (each made paused until the owner turns it on), and what Buddy asks the owner in the first week.
export type ShopTemplate = {
  id: string;
  name: string;
  /// One line saying which shops it fits.
  fits: string;
  team: string[];
  routines: { when: string; does: string; asksFirst: boolean }[];
  questions: string[];
};

/// One first-week question and its answer as the team now knows it: the owner's fact, whose words are null once the
/// owner had the team forget it.
export type ShopQuestion = {
  id: string;
  text: string;
  answer: { factId: string; text: string | null; answeredAt: string } | null;
};
export type ShopQuestions = { tenant: string; template: string | null; questions: ShopQuestion[] };
export type NewAnswer = { tenant: string; questionId: string; text: string };

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
  /// Only for a shop that had a Google connection: how many were ended at Google before the vault forgot their tokens, and how
  /// many could not be (Google did not answer), which the owner removes in their Google account's settings.
  googleRevoked?: number;
  googleNotRevoked?: number;
  deletedAt: string;
};

/// The answer to deleting a live shop (202): nothing is deleted yet, and `confirmUrl` is the link to send the owner.
/// Asking again while that confirmation waits answers the same link.
export type AwaitingOwner = { status: "awaiting_owner"; confirmUrl: string; expiresAt: string };

/// Who an audit entry says acted: an operator by their Cloudflare Access identity (null for a service token, and in
/// practice mode), the shop's owner (through a link, or with the id of their signed-in device), a helper, a worker by
/// its attempt, an outpost (a machine that runs the team's browser) by its id, or Manut AI's own system.
export type AuditActor =
  | { kind: "operator"; email: string | null }
  | { kind: "owner"; id?: string }
  | { kind: "helper"; id: string }
  | { kind: "worker"; attemptId: string }
  | { kind: "outpost"; id: string }
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
  /// `previousConnectionId`, `confirmationId`, `factId`, `inviteId`, `helperId`, `signInId`, `outpostId`, `stepId`,
  /// `grantId`.
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

/// What Buddy's team knows about a shop (docs/pilot-api.md, "Memory"). The facts, where each came from and the owner's
/// say over them are `@manut/shop-memory`'s own shapes, so the console, the practice-mode fake and the API cannot
/// disagree about them.
export type { Fact, FactSource, FactStatus } from "@manut/shop-memory";

/// Every fact the team holds for the shop, waiting ones included and oldest first, and how many texts it was told to
/// forget. The fingerprints of those are never sent.
export type Memory = { tenant: string; facts: Fact[]; forgottenCount: number };

/// The owner's own fact, confirmed at once. `text` is 1 to 280 characters.
export type NewFact = { tenant: string; text: string };

/// A fact the owner has a say over: "It's true" or Forget.
export type FactRef = { tenant: string; id: string };

/// The owner's correction: new words for a fact.
export type FactCorrection = { tenant: string; id: string; text: string };

/// The one account an invite or a helper is bound to (docs/pilot-api.md, "Helpers"): a LINE account id, compared exactly,
/// or an email, compared without case.
export type Identity = { kind: "line"; id: string } | { kind: "email"; address: string };

/// `expired` is an invite never used in its 7 days. The API reads it from the clock, so a pending invite turns expired
/// by itself.
export type InviteStatus = "pending" | "used" | "revoked" | "expired";

export type InviteView = {
  id: string;
  /// The name the owner gave, carried to the helper who joins through the invite.
  name: string;
  identity: Identity;
  status: InviteStatus;
  createdAt: string;
  /// 7 days after `createdAt`.
  expiresAt: string;
  /// The link to copy, for a pending invite only, and only when the API can make links. Nothing sends it.
  inviteUrl?: string;
};

export type PeopleHelper = {
  id: string;
  name: string;
  identity: Identity;
  joinedAt: string;
  /// Sessions open now, one for each device signed in.
  devices: number;
};

/// Cover while the owner is away: `helperId` covers messages until `until`. It is `inForce` until that time exactly; after
/// it the cover stays on record, no longer in force, until an operator clears it.
export type AwayView = { helperId: string; name: string; until: string; inForce: boolean };

/// A note a helper passed on to the owner with a request they may not decide. `kind` is the request's approval-core kind;
/// a kind this console does not know yet is shown as it is, so it is kept a string.
export type PassedOnItem = { requestId: string; kind: string; by: string; name: string; note: string; at: string };

/// The account linked as a shop's owner (docs/several-shops.md), as the people list shows it: the link's id, which the audit
/// log and the owner's decisions name; when the operator linked it; and how many devices have it signed in, one owner session
/// for each. Never the account's own identity.
export type OwnerAccountView = { id: string; linkedAt: string; devices: number };

/// `GET /v1/admin/people`: the owner with the account linked as theirs (`null` until the operator links one), the helpers,
/// every invite, the cover, the notes helpers passed on, and the helpers who were removed, so what they did in the activity
/// log still has their name.
export type People = {
  tenant: string;
  owner: { name: string; account: OwnerAccountView | null };
  helpers: PeopleHelper[];
  invites: InviteView[];
  away: AwayView | null;
  passedOn: PassedOnItem[];
  removed: { id: string; name: string }[];
};

/// `name` is 1 to 80 characters once trimmed.
export type NewInvite = { tenant: string; name: string; identity: Identity };
export type InviteRef = { tenant: string; inviteId: string };
export type HelperRef = { tenant: string; helperId: string };
/// `until` is any time the API can read, in the future.
export type NewAway = { tenant: string; helperId: string; until: string };

/// The invite as it now stands, and the link for the operator to copy: the API never sends it.
export type CreatedInvite = { invite: InviteView; inviteUrl: string };

/// What a removal did: the helper's sessions it ended, their pending invites it revoked (by id), and whether they were the
/// one covering.
export type HelperRemoval = { removed: string; sessionsEnded: number; invitesRevoked: string[]; coverEnded: boolean };

/// The code the owner's app shows (`XXXX-XXXX`), as the operator typed it, and the shop it links the owner's account to. The
/// API reads any case, with or without the dash or spaces, and O, I and L as 0, 1 and 1.
export type NewOwnerLink = { tenant: string; code: string };

/// What linking answered: the link, which the people list then shows. The account itself is never named.
export type LinkedOwner = { tenant: string; ownerAccount: { id: string; linkedAt: string } };

/// What unlinking did: the link that ended, and how many of the account's sessions ended with it.
export type UnlinkedOwner = { tenant: string; unlinked: string; sessionsEnded: number };

/// `POST /v1/auth/email/code` answered: a code of six digits went to the email service for the address. The answer is the
/// same for every address, so it never says whether anyone knows it. `expiresIn` is how many seconds the code works (600),
/// and `resendIn` how many seconds until the address may have another (60).
export type EmailCodeSent = { sent: true; expiresIn: number; resendIn: number };

/// `POST /v1/auth/exchange` with `provider: "email"`. `deviceId` is 1 to 128 characters; the code is six digits.
export type EmailExchange = { email: string; code: string; deviceId: string };

/// A signed-in session of the lifted auth, the same as Sign in with Apple's: the access token is sent as
/// `Authorization: Bearer <accessToken>` and lasts `expiresIn` seconds (3600). `tenant` is the identity's own,
/// `email:` and the address's SHA-256.
export type EmailSignIn = { accessToken: string; refreshToken: string; csrf: string; expiresIn: number; tenant: string };

/// A helper session for one shop (docs/people.md, "The helper's session"): `mhs1.` and the shop, 30 days, no refresh.
export type HelperSession = { accessToken: string; expiresAt: string };

/// What a signed-in accept of an invite may hear (docs/pilot-api.md, "A helper's own routes"). Only `joined` and
/// `wrong_account` name the shop, and `wrong_account` says only which kind of account the invite is for, never its value.
export type JoinAnswer =
  | {
    answer: "joined";
    shop: { id: string; name: string; ownerName: string };
    helper: { id: string; name: string };
    session: HelperSession;
  }
  | { answer: "wrong_account"; shop: { name: string; ownerName: string }; invitedOn: "line" | "email" }
  | { answer: "already_used" }
  | { answer: "expired" }
  | { answer: "revoked" }
  | { answer: "unknown" };

/// The two credentials an accept needs: the person's signed-in session, and the invite token from the link. The token
/// travels only in the body, as `{ token }`, never in a URL.
export type InviteAcceptance = { accessToken: string; inviteToken: string };

/// The owner's web app (docs/web-app.md; docs/pilot-api.md, "The web app's session"). Its session lives in cookies the
/// API sets and the page cannot read, so nothing here carries or answers a credential.

/// A sign-in with a code sent by email, exactly as `POST /v1/web/sign-in` takes it.
export type WebSignIn = { email: string; code: string };

/// One shop the signed-in person is in, as `POST /v1/web/shops` names it: its owner, the person's role there, the id their
/// decisions there name (the linked account's or the helper's), and whether a session for it is ready.
export type WebShop = {
  id: string;
  name: string;
  ownerName: string;
  role: "owner" | "helper";
  you: string | null;
  ready: boolean;
};

/// Who the browser's session is, as `POST /v1/web/shops` answers: signed in, with their shops; or signed out, with whether
/// signing in by email is on at all, so the app can say on opening that it is not.
export type WebSession = { signedIn: true; shops: WebShop[] } | { signedIn: false; emailSignIn: boolean };

/// Which of a shop's approvals to read: the ones still waiting, or the newest of the others.
export type WebApprovalsState = "open" | "recent";

/// A decision on one of a shop's requests: the request, and the option and revision the person saw.
export type WebDecision = { shop: string; requestId: string; optionId: string; seenRevision: number };

/// A shop route's answer as the web routes pass it on: its status and its JSON body, which the app reads field by field
/// (src/app/asks.ts), since every answer of the decision route's table is one to show.
export type WebAnswer = { status: number; body: unknown };

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

/// A threshold a month's charged spend reached, as the API noted it (docs/model-gateway.md, "Alerts near the cap"):
/// `percent` is 80 (near the cap) or 100 (at it), `at` when it was noted, `capSatang` the cap it was measured against, and
/// the spend that reached it, rounded up and exact. Held reservations do not count. A raised cap takes off a threshold the
/// spend is back under, and the API notes it again when the spend reaches the new cap's.
export type ModelCrossing = { percent: number; at: string; capSatang: number; spentSatang: number; spentMillisatang: number };

/// One shop on the list of shops near or at their caps: the highest threshold its month has reached, and each crossing.
export type ModelAlertShop = { tenant: string; percent: number; crossings: ModelCrossing[] };

/// `GET /v1/admin/model/alerts`: this Bangkok month's shops at their caps, then those near them, the latest to cross first
/// within each, across all shops, read from one record. `truncated` is true when the month had more than one read lists.
export type ModelAlerts = { month: string; shops: ModelAlertShop[]; truncated: boolean };

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
  /// The thresholds the month's charged spend has reached, lowest first. Optional, as `calls` is, for an older answer.
  crossings?: ModelCrossing[];
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

/// A shop's vault as the operator reads it (docs/pilot-api.md, "Vault sign-ins and outposts"): its site sign-ins and its
/// outposts. No answer holds a password. A sign-in says only that its password is set, and when; an outpost's credential is in
/// the one answer that gives a new one, this once, and in no other.

/// The members a sign-in may name, in the order the API lists them: those of `@manut/member-grants`' roster whose jobs run
/// through a connection. Buddy routes work and never signs in to a site. This app does not depend on that package, so a test
/// holds this list to the roster.
export const SIGN_IN_MEMBERS: readonly string[] = ["nam", "pim", "ton", "kit"];

/// One account on one site, kept in the shop's vault with the members who may use it. `state` is `broken` once a member
/// reported that the site refused the saved password, and a new password, which only the owner gives, mends it. A member is
/// an id such as `nam`; one this console does not know yet is shown as it is.
export type SignIn = {
  id: string;
  /// The name people use: "Shopee Seller Centre".
  site: string;
  /// 1 to 5 https origins: the only places the vault types this sign-in's password.
  origins: string[];
  /// The account on the site.
  username: string;
  members: string[];
  state: "working" | "broken";
  /// The only thing any answer says about the password.
  passwordSet: true;
  passwordSetAt: string;
  /// When it broke (the first report) and the member who reported it.
  brokenAt: string | null;
  brokenBy: string | null;
  /// When an outpost last redeemed a grant for it, and the member whose step that was.
  lastUsedAt: string | null;
  lastUsedBy: string | null;
  createdAt: string;
};

/// A machine that runs the team's browser: a Mac with the desktop app, or a cloud outpost. It is `online` while its last
/// heartbeat is under 90 seconds old, and `asleep` otherwise, before its first beat included.
export type Outpost = {
  id: string;
  name: string;
  kind: "this_mac" | "cloud";
  status: "online" | "asleep";
  lastHeartbeatAt: string | null;
  createdAt: string;
};

/// Who may use a sign-in from now on: one or more of `SIGN_IN_MEMBERS`, no repeat, in the order they are sent.
export type NewSignInMembers = { tenant: string; signInId: string; members: string[] };
export type SignInRef = { tenant: string; signInId: string };
export type OutpostRef = { tenant: string; outpostId: string };

/// What removing a sign-in answers. The password is deleted with it, and a grant issued for it is refused at its redeem.
export type SignInRemoval = { removed: true; signInId: string };

/// What removing an outpost answers: its credential stops working at once, and how many of its waiting steps were refused and
/// how many of its grants not yet redeemed were used up in the same step.
export type OutpostRemoval = { removed: true; outpostId: string; stepsRefused: number; grantsRefused: number };

/// An outpost and its new credential (`mo1_` and 43 base64url characters), in this answer and nowhere else: the vault keeps
/// only its SHA-256, so a credential that is lost is given again.
export type OutpostCredential = { outpost: Outpost; credential: string };

/// Buddy's team members who run as workers, as the API names them (docs/pilot-api.md, "Workers' drafts").
export type WorkerMember = "nam" | "pim" | "ton";

/// What a job is: a reply to a customer's message, a post about a topic, yesterday's sales summary, or a month of the books
/// appended to the owner's Google Sheet once the owner approves its rows.
export type WorkerJobKind = "reply" | "post" | "daily_summary" | "books_sheet";

/// How a worker's job stands. `failed` carries the code the job ended with, which this console puts in words and shows as it
/// is when it does not know the code yet. `handed_over` is a job passed on to a member who has not taken it up; a job passed
/// on and taken up shows the member who took it up, and its ending is theirs.
export type WorkerJobEnding =
  | { state: "running" }
  | { state: "done" }
  | { state: "failed"; reason: string }
  | { state: "awaiting_owner" }
  | { state: "handed_over"; to: WorkerMember }
  | { state: "cancelled" };

/// What a member wrote for the owner to read. It is a draft: it has not been sent to anyone. `about` names the message a
/// reply answers or the day a summary covers. `send` says what sending a reply would take: `draft_only` while the shop's LINE
/// connection is in practice mode, `ask` once it is over, when the owner's approval is needed.
export type WorkerDraft = {
  text: string;
  at: string;
  about?: { messageId?: string; date?: string };
  send?: { answer: "draft_only" | "ask"; kind: string };
};

/// One job of a shop's team (docs/pilot-api.md, "Workers' drafts"). `member` is who has the job now, and `passedFrom` who
/// passed it to them. `draft` is the newest the job wrote, or null. `costSatang` is what the job's model calls cost, in
/// whole satang, and is absent for a job that called none.
export type WorkerJobEntry = {
  taskId: string;
  member: WorkerMember;
  passedFrom?: WorkerMember;
  job: WorkerJobKind;
  /// When the job started.
  at: string;
  ending: WorkerJobEnding;
  draft: WorkerDraft | null;
  costSatang?: number;
};

/// One page of a shop's jobs, newest first. `next` is the cursor for the page after it, null when nothing is older. A page
/// can hold fewer than asked, or none, while `next` says there is more.
export type WorkerJobsPage = { tenant: string; jobs: WorkerJobEntry[]; next: string | null };

/// Which page to read: the jobs before the cursor `before` (a job's task id), at most `limit` of them (1 to 25; the API
/// reads 10 when the console does not say).
export type WorkerJobsQuery = { before?: string; limit?: number };

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

  /// Rejects with 400 `unknown_template`, making no shop, for a template that is not one of the API's.
  createShop(input: NewShop): Promise<CreatedShop>;
  listShops(): Promise<Shop[]>;
  /// `GET /v1/admin/templates`: the shop templates a new shop can start from.
  listTemplates(): Promise<ShopTemplate[]>;
  /// `GET /v1/admin/questions`: what Buddy asks a shop's owner in the first week, from its template, with each answer.
  getQuestions(tenant: string): Promise<ShopQuestions>;
  /// `POST /v1/admin/questions/answer`: the owner's answer, relayed by the operator, becomes the owner's own fact. Rejects
  /// with 409 `already_answered`, 404 `not_found`, 400 `invalid_text`, or memory's 409 `already_known` or `full`.
  answerQuestion(input: NewAnswer): Promise<ShopQuestion>;
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
  /// `POST /v1/admin/pilot/gate/cohort`: counts a shop its owner made in the gate's cohort, or leaves it out again. Rejects
  /// with 409 `not_self_serve` for a shop an operator made, which is always counted.
  setGateCohort(tenant: string, counted: boolean): Promise<{ tenant: string; counted: boolean }>;

  /// `GET /v1/admin/audit`: one page of a shop's audit log, newest first. Rejects with 400 `invalid_request` for a
  /// cursor that is not an entry's id or a size out of range.
  listAudit(tenant: string, query?: AuditQuery): Promise<AuditPage>;

  /// `GET /v1/admin/memory`: everything the team holds for the shop, waiting facts included.
  getMemory(tenant: string): Promise<Memory>;
  /// The owner's say over what the team knows, relayed by the operator (docs/pilot-api.md, "Memory"). Each rejects with
  /// the API's refusal, changing nothing: 400 `invalid_text`, 404 `not_found`, 409 `already_known` or `full`.
  /// The owner's own fact, confirmed at once; the same words as a waiting fact confirm that fact instead.
  rememberFact(input: NewFact): Promise<Fact>;
  /// "It's true": a waiting fact becomes one the team uses. Confirming a confirmed fact changes nothing.
  confirmFact(input: FactRef): Promise<Fact>;
  /// New words for a fact, confirmed, marked as corrected.
  correctFact(input: FactCorrection): Promise<Fact>;
  /// Forget: the fact and its words are gone, and only a fingerprint is kept so the team does not learn them again.
  forgetFact(input: FactRef): Promise<{ id: string }>;

  /// `GET /v1/admin/people`: who can use Manut AI for the shop, with each pending invite's link. Rejects with 400
  /// `tenant_required`, 404 `shop_not_found` and 503 `people_unavailable`.
  getPeople(tenant: string): Promise<People>;
  /// The owner's say over who helps, relayed by the operator (docs/pilot-api.md, "Helpers"). Each rejects with the API's
  /// refusal, changing nothing: 400 `invalid_request`, `bad_identity` or `bad_date`, 404 `shop_not_found`,
  /// `unknown_invite` or `not_a_helper`, 409 `already_invited`, `already_helper` or `not_pending`, 503 `not_configured`
  /// (naming the setting a link needs) or `people_unavailable`.
  /// An invite for one LINE account or email, for 7 days, once. The API sends nothing: the link is for the operator to send.
  createInvite(input: NewInvite): Promise<CreatedInvite>;
  /// An invite that was not used yet stops working.
  revokeInvite(input: InviteRef): Promise<{ invite: InviteView }>;
  /// The helper is signed out on every device in the same step; their pending invites and any cover of theirs end.
  removeHelper(input: HelperRef): Promise<HelperRemoval>;
  /// One helper covers messages until `until`. Money and public posts still wait for the owner.
  setAway(input: NewAway): Promise<{ away: AwayView }>;
  /// The owner is back. Clearing when nobody covers changes nothing.
  clearAway(input: { tenant: string }): Promise<{ away: null }>;
  /// `POST /v1/admin/shops/owner`: links the account a code names as the shop's owner, after the operator has checked that
  /// the code came from the owner (docs/several-shops.md). A code is used up the first time it is tried, whatever the
  /// answer. Rejects with 400 `tenant_required` or `invalid_request`, 404 `shop_not_found` or `unknown_code`, 409
  /// `already_linked` (unlink the first account), 410 `code_expired`, and 503 `shops_unavailable`, or `index_unavailable`:
  /// the link was made but the owner's list could not be written, and linking the same account again with a new code puts
  /// the shop there.
  linkOwner(input: NewOwnerLink): Promise<LinkedOwner>;
  /// `POST /v1/admin/shops/owner/unlink`: the account is signed out of the shop on every device in the same step. Rejects
  /// with 400 `tenant_required` or `invalid_request`, 404 `shop_not_found` or `not_linked`, and 503 `shops_unavailable`.
  unlinkOwner(input: { tenant: string }): Promise<UnlinkedOwner>;

  /// `GET /v1/admin/model/usage`: a shop's model spend, cap and calls for one Bangkok month (`YYYY-MM`), the current
  /// one when none is given. Rejects with 400 `tenant_required`, 400 `invalid_request` for a month that is not one, 503
  /// `not_configured` naming the setting it could not read (`ApiError.setting`), and 503 `meter_unavailable`.
  getModelUsage(tenant: string, month?: string): Promise<ModelUsage>;
  /// `PUT /v1/admin/model/cap`: sets a shop's monthly cap, or clears its override with `capSatang: null`. A new cap
  /// applies from the next call; calls already holding budget keep it. Rejects with 400 `tenant_required`, 400
  /// `invalid_request` for a cap that is missing, not whole or out of range, 503 `not_configured` naming the setting,
  /// and 503 `meter_unavailable`, which does not say whether the cap was written.
  setModelCap(input: NewModelCap): Promise<ModelCap>;
  /// `GET /v1/admin/model/alerts`: the shops whose model spend has reached 80% or 100% of their cap this Bangkok month,
  /// across all shops, from one read that asks no shop's own meter. Rejects with 503 `alerts_unavailable`.
  getModelAlerts(): Promise<ModelAlerts>;

  /// The shop's vault (docs/pilot-api.md, "Vault sign-ins and outposts"). The operator reads it and may do four things to it:
  /// remove a sign-in, change who may use one, remove an outpost and give an outpost a new credential. There is no route here to
  /// type a site's password: adding a sign-in and giving it a new password are the owner's, from their own app. Each
  /// rejects with 400 `tenant_required` and 503 `vault_unavailable`, which does not say whether a change was made.
  /// `GET /v1/admin/vault/sign-ins?tenant=`: the shop's sign-ins, oldest first, those removed left out.
  listSignIns(tenant: string): Promise<SignIn[]>;
  /// `POST /v1/admin/vault/sign-ins/members`: who may use the sign-in from now on, and nothing else about it changes. A member
  /// taken off loses it at once. Answers the sign-in as it now stands. Rejects with 400 `invalid_members` (none, a repeat, or one
  /// that is not Nam, Pim, Ton or Kit) and 404 `sign_in_not_found`, also for one already removed.
  setSignInMembers(input: NewSignInMembers): Promise<SignIn>;
  /// `POST /v1/admin/vault/sign-ins/remove`: the sign-in and its password are gone, and a grant issued for it is refused at its
  /// redeem. Rejects with 404 `sign_in_not_found`, also when it was already removed.
  removeSignIn(input: SignInRef): Promise<SignInRemoval>;
  /// `GET /v1/admin/outposts?tenant=`: the shop's outposts, oldest first, each `online` or `asleep` as of now.
  listOutposts(tenant: string): Promise<Outpost[]>;
  /// `POST /v1/admin/outposts/remove`: the outpost's credential stops working at once, and its waiting steps and grants are
  /// refused in the same step. Rejects with 404 `outpost_not_found`, also when it was already removed.
  removeOutpost(input: OutpostRef): Promise<OutpostRemoval>;
  /// `POST /v1/admin/outposts/credential`: a new credential, in this answer and nowhere else (the answer is `no-store`, and the
  /// request asks the browser to keep nothing). The old one stops working at once, and the outpost is `asleep` until the holder
  /// of the new one beats. Rejects with 404 `outpost_not_found`.
  replaceOutpostCredential(input: OutpostRef): Promise<OutpostCredential>;

  /// `GET /v1/admin/workers/drafts`: one page of what Nam, Pim and Ton did for a shop, newest first, drafts and handovers
  /// included. It only reads: a draft in it has not been sent. Rejects with 400 `tenant_required`, 400 `invalid_request` for a
  /// cursor that is not one of the shop's jobs or a size out of range, 404 `shop_not_found`, and 503 `shop_unavailable` or
  /// `drafts_unavailable`.
  listWorkerJobs(tenant: string, query?: WorkerJobsQuery): Promise<WorkerJobsPage>;

  /// The join page's routes (docs/pilot-api.md, "Signing in by email" and "A helper's own routes"). None carries the
  /// operator key or a cookie: the credentials are the ones passed in, held by the page in memory only.
  /// `POST /v1/auth/email/code` with exactly `{ email }`. Rejects with 429 `too_many_codes` (`ApiError.retryAfter`, whole
  /// seconds), 429 `rate_limited` (too many asks from one network; its wait is the `retry-after` header's), 400
  /// `invalid_request`, 400 `email_not_configured` while signing in by email is off, and 503 `rate_limit_unavailable`.
  requestEmailCode(email: string): Promise<EmailCodeSent>;
  /// `POST /v1/auth/exchange` with exactly `{ provider: "email", email, code, deviceId }`. Rejects with 401 `wrong_code`
  /// (`ApiError.triesLeft`; at 0 the code has ended), 401 `code_ended`, 400 `invalid_request`, 400 `email_not_configured`,
  /// and 429 `rate_limited`.
  exchangeEmailCode(input: EmailExchange): Promise<EmailSignIn>;
  /// `POST /v1/people/accept` with exactly `{ token }` and the signed-in session. Every answer of the route's table resolves,
  /// whatever its status (200, 403, 404, 409 or 410); it rejects only with what is not an answer: 401 `unauthorized` (no
  /// session, or one that ended), 400 `invalid_request`, and 503 `people_unavailable`.
  acceptInvite(input: InviteAcceptance): Promise<JoinAnswer>;
  /// `POST /v1/shops/session/end` with exactly `{}` and the shop session itself: ends that one session.
  endShopSession(accessToken: string): Promise<void>;
  /// `DELETE /v1/auth/session` with the signed-in session: ends it, and its refresh with it.
  signOut(accessToken: string): Promise<void>;

  /// The owner's web app's routes (docs/pilot-api.md, "The web app's session"): the only ones that send the browser's
  /// cookies, each with the app's header. None carries or answers a token.
  /// `POST /v1/web/sign-in` with exactly `{ email, code }`. Rejects as the exchange does: 401 `wrong_code`
  /// (`ApiError.triesLeft`), 401 `code_ended`, 400 `invalid_request`, 400 `email_not_configured`, 429 `rate_limited`.
  webSignIn(input: WebSignIn): Promise<void>;
  /// `POST /v1/web/shops` with `{}`: the person's shops, each with a session ready where one could be opened, or that
  /// nobody is signed in (401 `signed_out`), which is a state and not a failure. Rejects with 503 `shops_unavailable`.
  webShops(): Promise<WebSession>;
  /// `GET /v1/web/approvals?shop=&state=`: every answer with a JSON body resolves, as it is; only no answer, or one that is
  /// not JSON, rejects.
  webApprovals(shop: string, state: WebApprovalsState): Promise<WebAnswer>;
  /// `POST /v1/web/approvals/{requestId}/decision` with exactly `{ shop, optionId, seenRevision }`: resolves as
  /// `webApprovals` does, since a refusal (already decided, expired, not permitted) is an answer to show.
  webDecide(input: WebDecision): Promise<WebAnswer>;
  /// `POST /v1/web/sign-out` with `{}`: ends every session the browser holds and clears its cookies.
  webSignOut(): Promise<void>;
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
  /// Whole seconds to wait before asking again: a 429 `too_many_codes` says it in its body, and a 429 `rate_limited` in
  /// its `retry-after` header.
  retryAfter?: number;
  /// How many more tries a sign-in code takes, on a 401 `wrong_code`. At 0 the code has ended.
  triesLeft?: number;
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
  readonly retryAfter: number | undefined;
  readonly triesLeft: number | undefined;

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
    this.retryAfter = details.retryAfter;
    this.triesLeft = details.triesLeft;
  }
}
