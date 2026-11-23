# Pilot API (week 1)

The contract between `apps/api` (the backend lifted from GoSpark's `cloud/`) and `apps/web` (the owner's
approval page and the operator console). Both sides build to this file. Change it only together.

All bodies are JSON. Times are ISO 8601 strings in UTC. Money is in satang (integer, 100 satang = 1 baht).

## Who is who in the pilot

- **Operator**: a Manut AI staff member running the concierge pilot. Reads customer messages, drafts replies,
  sends the owner an approval link, confirms PromptPay slips. Uses `/v1/admin/pilot/*`.
- **Owner**: the shop owner. Has no account in week 1. Approves or declines one reply through a signed,
  single-use link: `/v1/pilot/approvals/{token}`. Confirms or refuses the deletion of a live shop's data the same
  way: `/v1/pilot/deletions/{token}`.
- **Helper**: someone the owner trusts with conversations (the canvas's Mint). Invited by the operator on the owner's
  word, signs in with Apple, and approves private messages and replies with a helper session, never money, public
  posts, payment confirmations or commands ("Helpers", below; `docs/people.md`).
- **Shop**: one tenant in the backend. `tenant` is its id. A shop is **live** once its owner has given consent
  (`cloudWork`) or a LINE connection exists.

## Security rules (unchanged from the lifted backend)

- `/v1/admin/*` keeps the existing double check: a Cloudflare Access context whose audience matches
  `ADMIN_ACCESS_AUD`, plus `Authorization: Bearer <CLOUD_API_KEY>`, plus an exact entry in `ADMIN_METHODS`.
  Every route below is added to `ADMIN_METHODS` as an exact `METHOD path` string, so ids travel in the query
  string or the body, never in the admin path.
- The approval link is a capability: an HMAC-SHA256 over the tenant, task id, action id and expiry with the
  Wrangler secret `APPROVAL_LINK_SECRET`, base64url, verified in constant time. It names exactly one action and
  expires after 24 hours. It can never approve anything else.
- The deletion link is the same kind of capability: an HMAC-SHA256 with the same secret over the tenant, one owner
  confirmation's id and its expiry. It names exactly one confirmation and expires after 24 hours, with it. Each
  kind of link is signed under its own domain tag (`manut-ai/pilot-approval/v1.`, `manut-ai/pilot-deletion/v1.`),
  so a reply link can never delete a shop and a deletion link can never approve a reply or record consent.
- Deleting a live shop's data needs its owner's yes through the deletion link (owner's decision, 23 Nov 2026). The
  confirmation runs through `packages/approval-core`: an owner-only kind (`command`), opened and decided by its
  transitions in one AuthObject storage transaction each, so it settles once however many answers arrive, and
  the decision is stored before any data is wiped. A shop that never went live is deleted by the operator alone.
- Approving an external write still needs the shop's consent (`cloudWork`), recorded from the owner through
  the link (`/consent` below), never by an operator.
- A decision settles once. The task object already refuses a second decision; the link routes keep that.
- A reply is decided through `packages/approval-core`, as a worker's request and a deletion's confirmation are. Each
  proposed reply is stored with one approval-core request of kind `reply`, opened in the same task object storage
  transaction, which names the exact reply: its action id, the operation, the bot it is sent from, the one customer it
  goes to (`recipient`), the draft (`text`) and the hash the send is checked against. The owner's link decides that
  request as the owner (role `owner`, `decidedBy: "owner-link"`), at its one revision (a reply is never revised; a
  changed reply is a new one with a new link), and only before its expiry, which is the reply's and the link's. The
  request and the reply's action change in one transaction, so of any number of decisions exactly one settles, and no
  route moves a reply's action without its request: the task object's older decision route decides a reply through
  its request too. A reply stored before replies had requests is read as the request it would have opened and stores
  it with its first decision. None of the answers below changed.
- Customer message text is stored for the pilot (the operator must read it to draft a reply) and falls under
  the backend's existing retention and tenant export/delete.

## Public routes

### `POST /v1/inbound/line/{connectionId}`

The LINE Messaging API webhook for one shop's LINE Official Account. Verifies `x-line-signature` (base64
HMAC-SHA256 of the raw body under that connection's channel secret) before reading anything. Text messages
from users become stored inbound messages for the connection's tenant, deduplicated by `webhookEventId`.
Gated by the `officeInbound` flag. Answers with no body: 200 for any correctly signed delivery (including ones
that store nothing), 401 for a bad or missing signature, 404 for an unknown connection or a closed flag.

### `GET /v1/pilot/approvals/{token}`

Returns `ApprovalView`. Errors: 404 `{ "error": "link_invalid" }`, 410 `{ "error": "link_expired" }`.

### `POST /v1/pilot/approvals/{token}/consent`

Body `{ "cloudWork": true }`. Records the owner's consent to let Manut AI send messages for the shop. Returns
`ApprovalView` with `needsConsent: false`.

### `POST /v1/pilot/approvals/{token}/decision`

Body `{ "approve": true }` or `{ "approve": false }`. Approving with consent missing answers 403
`{ "error": "consent_required" }`. Approving begins the send at once (the broker's exactly-once dispatch), so
the view comes back as `dispatching` and the page polls `GET` until `confirmed`, `failed` or `unknown`.
A second decision answers 409 `{ "error": "already_decided", "view": ApprovalView }`.

```ts
type ApprovalView = {
  shopName: string;
  memberName: string;        // "Nam" in the pilot
  memberRole: string;        // "sales chat"
  kind: "line.reply";
  customerName: string;      // LINE display name when known, otherwise "a customer"
  customerMessage: string;   // the message being answered
  replyText: string;         // exactly what will be sent
  state: "proposed" | "approved" | "rejected" | "expired" | "dispatching" | "confirmed" | "failed" | "unknown";
  decidedAt?: string;
  expiresAt: string;
  needsConsent: boolean;
};
```

### `GET /v1/pilot/deletions/{token}`

Returns `DeletionView`: the owner's confirmation of deleting one shop's data. Errors: 404
`{ "error": "link_invalid" }` (not a deletion link this backend signed, or a confirmation it does not hold), 410
`{ "error": "link_expired" }`. A confirmation and its record outlive the deleted shop, so the link keeps saying
what happened until it expires.

### `POST /v1/pilot/deletions/{token}/decision`

Body `{ "approve": true }` or `{ "approve": false }`, else 400 `invalid_request`. Approving settles the decision,
then runs the tenant deletion and completes the deletion record, and answers the view as `deleted`; if the wipe
stops part way the decision still stands, the view answers `deleting`, and the operator's same deletion request
finishes it. Declining deletes nothing and answers `declined`. A second decision answers 409
`{ "error": "already_decided", "view": DeletionView }`. A confirmation past its expiry answers 410 `link_expired`,
a bad link 404 `link_invalid`. Nothing in the request chooses who decides: whoever holds the link is the owner.

```ts
type DeletionView = {
  shopName: string;
  // Counted afresh while the shop's data is there; once it is deleted, what the shop held when the operator asked.
  // `payments` counts both ledgers the deletion takes: customers' order payments and the shop's subscription payments.
  goes: { messages: number; replies: number; payments: number; lineConnected: boolean };
  state: "awaiting_owner" | "deleting" | "deleted" | "declined" | "expired";
  expiresAt: string;
  decidedAt?: string;
};
```

- `awaiting_owner`: open; nothing is deleted.
- `deleting`: the owner said yes and the wipe has not finished: it is running, or it stopped part way.
- `deleted`: the wipe finished.
- `declined`: the owner kept the data; nothing was deleted.
- `expired`: nobody answered in 24 hours; nothing was deleted.

## Operator routes (all under the admin gate)

| Method and path | Body or query | Answer |
| --- | --- | --- |
| `POST /v1/admin/pilot/shops` | `{ name, ownerName }` | `{ tenant, name, ownerName }` |
| `GET /v1/admin/pilot/shops` | none | `{ shops: Shop[] }` |
| `POST /v1/admin/pilot/line-connections` | `{ tenant, channelId, botUserId, channelSecret, channelAccessToken }` | `{ connectionId, webhookUrl }` |
| `GET /v1/admin/pilot/messages` | `?tenant=` | `{ messages: InboundMessage[] }`, newest first |
| `POST /v1/admin/pilot/replies` | `{ tenant, messageId, text }` | `{ taskId, actionId, approvalUrl, expiresAt }` |
| `GET /v1/admin/pilot/actions` | `?tenant=` | `{ actions: ReplyAction[] }`, newest first |
| `POST /v1/admin/pilot/payments` | `{ tenant, orderRef, amountSatang, promptPayId, slipNote? }` | `Payment` |
| `GET /v1/admin/pilot/payments` | `?tenant=` | `{ payments: Payment[] }`, newest first |
| `GET /v1/admin/pilot/export` | `?tenant=` | `ShopExport`: everything stored for the shop, LINE secrets never included |
| `POST /v1/admin/pilot/deletions` | `{ tenant, confirmName }` | A shop that never went live: `DeletedShop`. A live shop: 202 `AwaitingOwner`, deleting nothing. Either way 409 `{ "error": "name_mismatch" }`, deleting nothing, unless `confirmName` is the shop's exact name |
| `POST /v1/admin/pilot/subscription-payments` | `{ tenant, amountSatang, slipRef, slipNote? }` | `SubscriptionPayment`. 409 `{ "error": "slip_already_recorded" }`, recording nothing, for a slip already recorded for the shop |
| `GET /v1/admin/pilot/subscription-payments` | `?tenant=` | `{ payments: SubscriptionPayment[] }`, newest first |
| `GET /v1/admin/pilot/gate` | none | `PilotGate`: every shop's trial, payment and activity, and the cohort against the gate's two lines (below) |
| `GET /v1/admin/audit` | `?tenant=&before=&limit=` | `AuditPage`: one page of the shop's audit log, newest first ("Audit log", below) |
| `GET /v1/admin/memory` | `?tenant=` | `Memory`: every fact the team holds for the shop, waiting ones included, and how many texts it was told to forget ("Memory", below) |
| `POST /v1/admin/memory/remember` | `{ tenant, text }` | `Fact`: the owner's own fact, confirmed at once |
| `POST /v1/admin/memory/confirm` | `{ tenant, id }` | `Fact`: "It's true" on a waiting fact |
| `POST /v1/admin/memory/correct` | `{ tenant, id, text }` | `Fact`: the new words, confirmed |
| `POST /v1/admin/memory/forget` | `{ tenant, id }` | `{ id }`: the fact is gone, and its words with it |
| `POST /v1/admin/workers/run` | `{ tenant, member, job }` | `WorkerRun`: how one member's job for the shop ended, with its draft ("Workers", below) |

Secrets (`channelSecret`, `channelAccessToken`) go straight into the encrypted credential vault and are never
returned. `webhookUrl` is `${PUBLIC_API_ORIGIN}/v1/inbound/line/{connectionId}`; `approvalUrl` is
`${WEB_ORIGIN}/approve/{token}`; `confirmUrl` is `${WEB_ORIGIN}/delete/{token}`. Both origins are Worker vars.

```ts
type Shop = {
  tenant: string;
  name: string;
  ownerName: string;
  lineConnectionId?: string;
  consent: boolean;
  deletion?: DeletionRequest;   // the shop's latest deletion put to its owner, if any
};

// A shop's latest owner confirmation. The link is re-minted on each read, same expiry.
type DeletionRequest = {
  state: DeletionView["state"];
  confirmUrl: string;           // "" when WEB_ORIGIN or APPROVAL_LINK_SECRET is not set
  expiresAt: string;
  decidedAt?: string;
};

// The answer (202) to deleting a live shop: the link to send its owner. Asking again while the confirmation
// waits answers the same link and expiry.
type AwaitingOwner = { status: "awaiting_owner"; confirmUrl: string; expiresAt: string };

type InboundMessage = {
  id: string;
  connectionId: string;
  lineUserId: string;
  displayName?: string;
  text: string;
  receivedAt: string;
  replyActionId?: string;   // set once a reply has been proposed for it
};

type ReplyAction = {
  taskId: string;
  actionId: string;
  messageId: string;
  replyText: string;
  state: ApprovalView["state"];
  proposedAt: string;
  decidedAt?: string;
  dispatchedAt?: string;
  approvalUrl: string;      // re-minted on each read, same expiry
};

type Payment = {
  id: string;
  tenant: string;
  orderRef: string;
  amountSatang: number;
  promptPayId: string;
  slipNote?: string;
  confirmedAt: string;      // the operator confirms the slip against the shop's bank app
};

// The shop's own payment to Manut AI, recorded by an operator once the money is seen in Manut AI's bank account.
// `slipRef` is the reference printed on the bank slip; one slip is recorded once per shop (compared without spaces
// or capitals). Money is a positive whole number of satang; anything else is refused with 400, never rounded.
type SubscriptionPayment = {
  id: string;
  tenant: string;
  amountSatang: number;
  slipRef: string;          // trimmed, 1 to 128 characters
  slipNote?: string;        // up to 1,000 characters
  confirmedAt: string;
};

// The backend's tenant export: tasks with their histories, LINE connection metadata, schedules, consent,
// attention items and `pilot: { shop, messages, replies, payments, subscriptionPayments, displayNames }`, where
// `shop` carries `trialStartedAt` once the trial has started and `displayNames` is the LINE display names cached
// for the shop's customers, `{ lineUserId, displayName }[]`. `audit: { entries, missed }` is the shop's audit log,
// oldest first ("Audit log", below). `memory: { facts, forgottenCount }` is what the team knows about the shop
// ("Memory", below). `deletedAt` is there once the shop was deleted.
// Saved whole.
// If any part cannot be read, the answer is 500 `{ "error": "export_incomplete", "failed": [...] }` naming
// the parts ("index", a task id, "connections", "consent", "attention", "pilot", "model", "audit", "memory",
// "schedules", "tombstone"),
// never a 200 that quietly leaves them out. A deleted shop with nothing left answers 404 `tenant_deleted`.
type ShopExport = { tenant: string; exportedAt: string; deletedAt?: string; [part: string]: unknown };

type DeletedShop = {
  tasksWiped: number;
  connectionsWiped: number;
  schedulesWiped: number;
  occurrencesWiped: number;
  sessionsWiped: number;
  deletedAt: string;
};
```

## Rules settled while building (23 Nov 2026)

- **One open reply per message.** Proposing a second reply while one is still waiting answers 409
  `{ "error": "reply_pending" }`. After a reply is declined, expires or fails, the operator may propose again.
- **Connecting LINE again** revokes the shop's previous connection; its webhook URL stops receiving.
- **Consent cannot be withdrawn through the link.** `/consent` accepts only `{ "cloudWork": true }`.
- **A reply approved but not yet sending** (`approved`) is picked up by the next `GET` of its link, which begins
  the send the owner approved. The begin gate is one-use, so it can never send twice. The page polls `approved`
  the same way it polls `dispatching`.
- **LINE answers.** A 409 with `x-line-accepted-request-id` means an earlier push with the same retry key went
  through: the reply settles `confirmed`. Any other 4xx settles `failed` (LINE sends nothing on an error). A
  5xx, a timeout or a network error settles `unknown` and is never retried automatically.
- **Retention.** Customer messages, duplicate markers and cached display names are removed after 7 days by the
  operator prune. Shops, reply records and both kinds of payment stay until the shop is deleted.
- **Rate limits.** `LINE_INBOUND_LIMITER` (300 a minute) and `PILOT_APPROVAL_LIMITER` (120 a minute), which
  counts the approval and deletion routes together, any method, per source address.
- **CORS.** The approval and deletion routes answer CORS for `WEB_ORIGIN` only and are never cached. The operator
  routes do not answer CORS and need none: the pages and the API share one origin (below).
- **Other answers.** 503 when storage is unavailable or configuration is missing, 413 for an oversized body,
  400 `tenant_required` without a valid tenant, 404 `shop_not_found` for a tenant that was never a pilot shop.
- **Export and deletion.** At a shop's request an operator exports or deletes everything stored for it,
  through the same tenant export and deletion a shop's own session would use. Deletion removes the task and
  every reply, the sealed LINE secrets and the webhook route, messages, order and subscription payments, consent,
  what the team knows about the shop, its people (helpers, invites and every helper session, so no helper can open it
  again) and the shop's registry row. The owner's approval links answer `link_invalid` afterwards and the webhook
  answers 404.
  - It cannot be undone, so the operator sends the shop's name with its id. The name matches when it differs
    only in outer spaces or in how an accented letter was composed; shop names are stored trimmed.
  - **A live shop also needs its owner's yes.** The operator's request deletes nothing: it records who asked
    and opens one owner confirmation, in one write, and answers 202 `AwaitingOwner`. Sent again while that
    confirmation waits, it answers the same link and expiry. After a no or an expiry it opens a new
    confirmation with a new link; a confirmation that expired unanswered is withdrawn as the new one opens, so a
    shop never has two that could be decided. The old links keep answering with what became of them. The
    confirmation names one shop, so it also settles which of two same-named shops is meant.
  - **A shop that never went live** is deleted by the operator's request at once, as before (200 `DeletedShop`).
  - Once the owner has said yes, the operator's same request finishes a wipe that stopped part way, without
    asking the owner again: 200 `DeletedShop`, or 500 `wipe_incomplete` while something still fails.
  - A record of the deletion outlives the shop: who asked (`deletedBy`: the operator's Access identity, or
    `null` for a service token), when, the owner confirmation for a live shop, and once the wipe finished, when
    and what was removed. It is written before anything is wiped, and for a live shop before any link is handed
    out; a request that cannot be recorded does nothing: 503 `audit_unavailable`. A shop whose consent cannot
    be read is never guessed to be not live: 503 `consent_unavailable`.
  - Without `WEB_ORIGIN` or `APPROVAL_LINK_SECRET`, asking a live shop's owner answers 503 `not_configured`
    with the `setting`, deleting nothing.
  - Afterwards every operator route naming the shop answers 404 `{ "error": "tenant_deleted", "deletedAt",
    "deletedBy" }`. If the wipe finished but completing its record did not, `deletedAt` is the tenant's
    tombstone, which the wipe writes last.
  - A partial wipe answers 500 `{ "error": "wipe_incomplete", "failed": [...] }`; sending the same request
    again finishes it.

## The pilot gate (Phase 1)

The roadmap's Phase 1 gate: at least 25% of pilot shops pay ฿499 after 14 free days, and at least 50% are still
active on day 14. Only the owner passes a gate; `GET /v1/admin/pilot/gate` measures it from records the backend
already keeps. The rules live in `apps/api/src/pilot-gate.ts`, each number a named constant there, and the
practice-mode fake in `apps/web` keeps the same rules.

- **Trial start.** A shop's first LINE connection starts its trial, because that is when the service can start
  working for it; creating the shop does not. The first `POST /v1/admin/pilot/line-connections` for a shop sets
  `trialStartedAt` on its record, and a later connection (a rotated token) never moves it. A shop connected
  before this field existed has none on its record; its trial start is the creation time of its first LINE
  connection in the credential vault, a revoked one included.
- **Days.** Day numbers count calendar days in Asia/Bangkok (UTC+7 all year). Day 1 is the Bangkok date the
  trial started on, day 2 begins at the next midnight in Bangkok, and so on. The 14 free days are days 1 to 14;
  the trial has ended once day 15 begins.
- **Paid.** A shop has paid once its subscription payments add up to at least ฿499 (49,900 satang), whenever they
  were made: a shop that pays before its free days run out has paid for the days after them. `paidAt` is when the
  running total, in the order payments were confirmed, first reached ฿499.
- **Active.** A shop is active on day N when its owner decided at least one reply, approving or declining it
  through the link, in the 7 calendar days up to and including day N (`ACTIVE_WINDOW_DAYS`). The decision's time
  is the one the owner's link records on the reply. `activeOnDay14` is `not_yet` before day 14; on day 14 it is
  `yes` once a decision in the window exists and `not_yet` until then; from day 15 it is `yes` or `no`.
- **Cohort.** Only shops whose day 14 has passed (`trialEnded`) are counted. Each share is a whole percent rounded
  down, so it never shows a line it has not reached, and `null` while no shop is counted; `met` compares the exact
  counts with the line. The status is `not_enough_data` while no shop is counted, `on_track` when both shares meet
  their lines, and `below_line` when either does not.
- **Failures.** A shop whose records cannot be read, or a connected shop whose first connection the vault cannot
  answer, fails the whole answer with 503 `{ "error": "gate_unavailable" }`: a shop is never left out of the
  cohort and a trial start is never guessed.
- **Deleted shops** leave the registry, and with it the gate.

```ts
type PilotGate = {
  asOf: string;                                   // when it was measured
  rules: { trialDays: 14; priceSatang: 49900; activeWindowDays: 7 };
  shops: GateShop[];                              // every pilot shop, in the order they were created
  cohort: {
    counted: number;                              // shops whose day 14 has passed
    paid: GateMeasure;                            // line 25
    active: GateMeasure;                          // line 50
    status: "not_enough_data" | "on_track" | "below_line";
  };
};

type GateMeasure = { count: number; percent: number | null; thresholdPercent: number; met: boolean };

type GateShop = {
  tenant: string;
  name: string;
  trialStartedAt: string | null;  // null until LINE is connected
  day: number | null;             // today's trial day; null before the trial starts
  trialEnded: boolean;            // day 14 has passed
  paid: boolean;
  paidAt?: string;                // when the subscription payments first reached ฿499
  paidSatang: number;             // everything the shop has paid Manut AI
  activeOnDay14: "yes" | "no" | "not_yet";
  lastDecisionAt?: string;        // the owner's latest decision on a reply
};
```

## Audit log

Each shop has one append-only log of who did what and when, kept in the shop's TenantObject beside its other
records (`apps/api/src/audit-log.ts`). Operators read it a page at a time, the console's Audit page shows it, the
tenant export carries it, and it goes with the shop when the shop is deleted. The deletion's own record is not in
it: that record outlives the shop in AuthObject ("Export and deletion", above).

### `GET /v1/admin/audit`

Under the admin gate, as an exact `ADMIN_METHODS` entry like the routes above. The query names the shop and the page:

- `tenant` (required, else 400 `tenant_required`). Any tenant can be read, not only pilot shops; one with no log, a
  deleted shop's included, answers an empty page.
- `before`: an entry's `id`; the page holds the entries stored before it. Anything else is 400 `invalid_request`.
- `limit`: 1 to 200, 50 when absent. Anything else is 400 `invalid_request`.

A log that cannot be read answers 503 `{ "error": "audit_unavailable" }`, never an empty page.

```ts
type AuditPage = {
  tenant: string;
  entries: AuditEntry[];        // newest first
  next: string | null;          // `before` for the page before this one; null on the oldest page
  missed: AuditMissed | null;   // what the log could not write; null when it never missed an entry
};

type AuditEntry = {
  id: string;                   // "aud-<time>-<sequence>-<random>": sorts by when the log stored it
  at: string;                   // when the log stored it
  actor: AuditActor;
  action: string;               // one of the actions below
  subject: AuditSubject;        // ids only
  outcome: string;              // one of the outcomes below
  reason?: string;              // a code: why an attempt ended, why a decision was refused
  amountSatang?: number;        // the money it was about: a payment recorded, a cap set
};

type AuditActor =
  | { kind: "operator"; email: string | null }  // the Cloudflare Access identity; null for a service token
  | { kind: "owner"; id?: string }               // through a signed link (no id), or a signed-in device's id
  | { kind: "helper"; id: string }               // staff the owner trusts with conversations
  | { kind: "worker"; attemptId: string }        // a worker, by the attempt it was given
  | { kind: "system" };                          // the control plane or the broker, on its own

type AuditSubject = Partial<Record<"taskId" | "actionId" | "messageId" | "attemptId" | "requestId" | "paymentId" |
  "connectionId" | "previousConnectionId" | "confirmationId" | "factId" | "inviteId" | "helperId", string>>;

type AuditMissed = { count: number; lastAt: string; lastAction: string };
```

What is written, and by whom:

| Action | Actor | Subject | Outcome |
| --- | --- | --- | --- |
| `shop.created` | operator | none | `ok` |
| `line.connected` | operator | `connectionId`, and `previousConnectionId` when it replaced one | `ok` |
| `reply.proposed` | operator | `taskId`, `actionId`, `messageId` | `ok` |
| `payment.recorded`, `subscription_payment.recorded` | operator | `paymentId`, with `amountSatang` | `ok` |
| `model.cap_set`, `model.cap_cleared` | operator | none; a cap set carries `amountSatang` | `ok` |
| `deletion.requested` | operator | `confirmationId` for a live shop | `awaiting_owner` for a live shop; `ok` for one deleted at once, which the deletion then wipes with the rest |
| `consent.given`, `consent.withdrawn` | owner | none | `ok` |
| `reply.decided` | owner | `taskId`, `actionId` | `approved` or `declined` |
| `deletion.decided` | owner | `confirmationId` | `approved` or `declined` |
| `dispatch.started` | system | `taskId`, `actionId` | `ok` |
| `dispatch.settled` | system | `taskId`, `actionId` | `confirmed`, `failed` or `unknown` |
| `attempt.started` | system | `taskId`, `attemptId` | `ok` |
| `attempt.ended` | the worker (its own finish), the system (`budget`, `silent`, `deadline`), or whoever cancelled it | `taskId`, `attemptId` | `done`, `failed` with a `reason`, or `cancelled` |
| `approval.requested` | worker | `taskId`, `attemptId`, `requestId`, `actionId` | `ok` |
| `approval.decided` | owner or helper, with the id they decided as (`owner-session` for the shop's own session, the helper's id for a helper session) | the same | `approved`, `declined`, or `refused` with approval-core's refusal as the `reason` (`already_decided`, `not_permitted`, `attempt_ended`, `expired` and so on) |
| `approval.superseded` | system | the same | `superseded`, reason `attempt_ended` |
| `memory.remembered`, `memory.confirmed`, `memory.corrected`, `memory.forgotten` | operator | `factId` | `ok` |
| `memory.proposed` | a worker (by its attempt) or the system, as the caller of `proposeFact` says | `factId` | `ok`, or `awaiting_owner` for a customer's words, which wait for the owner |
| `invite.created`, `invite.revoked` | operator | `inviteId` | `ok` |
| `helper.joined` | helper | `inviteId`, `helperId` | `ok` |
| `helper.session_opened` | helper | `helperId` | `ok` |
| `helper.removed` | operator | `helperId` | `ok` |
| `away.set`, `away.cleared` | operator | `helperId` (who covers, or covered) | `ok` |
| `request.passed_on` | helper | `requestId`, `taskId` | `ok` |

The job flow's entries (`attempt.*`, `approval.*`) come from the worker adapter contract (`docs/phase-0-spikes.md`,
section 3); a pilot shop has none until a worker runs for it. A reply decided through the owner's link keeps its
`reply.*` entries and writes no `approval.*` one; a reply decided from a session ("Deciding from a session", below)
writes `approval.decided`, naming the shop's own session or the helper. The people entries name invites, helpers and
requests by id only: never a name, a note, or an identity's value.

- **Metadata only.** The log checks every entry it is given rather than trusting the writer: the action, the outcome
  and the subject's keys come from fixed lists, ids and codes may hold only ASCII letters, digits and `._:-`, an
  amount is a whole number of satang, and a field it does not know is refused rather than dropped. A customer's
  words, a draft's text, a note or a secret therefore cannot be written into it, even by mistake.
- **It never blocks or fails the action it records.** When the record an entry describes lives in the shop's
  TenantObject (the shop, its LINE pointer, a reply's record and its decision time, both kinds of payment, consent,
  the model cap, what the team knows), the entry goes into the same storage write, so the two exist together or not at all; an entry that
  cannot be kept as given (a malformed actor) is replaced in that write by a raised miss count, and the action goes
  ahead. When the record lives in another object (a deletion's in AuthObject, a dispatch's and the job flow's in task
  objects), the entry is appended after the action has succeeded, best effort: the action's own record is the
  authority, and the log must not hold it up. An append that fails, or that the log refuses, is counted in `missed`
  by a second, smaller write; if that fails too, the Worker logs the action and the tenant id, nothing else. A log
  with misses says so, rather than letting a gap read as nothing having happened.
- **Export and deletion.** The tenant export carries `audit: { entries, missed }`, oldest first, and names `audit`
  in `export_incomplete` when it cannot be read. The tenant deletion wipes the log and its miss count with the
  shop's other records; entries written while the deletion runs, the owner's yes among them, go with it.
- **The console** shows one shop's log at a time on its Audit page, newest first, with "Show older entries" for the
  next page. The practice-mode fake keeps the same log for its sample shops, by the same rules.

## Memory

What Buddy's team knows about each shop: facts, where each came from, and the owner's say over them. The rules are
the pure functions of `packages/shop-memory` (`@manut/shop-memory`); `apps/api/src/memory-store.ts` stores their
state, one record per shop in the shop's TenantObject (the facts, the fingerprints of the texts the owner had the team
forget, and the counter for the next id), and `apps/api/src/memory.ts` has the routes. The owner has no account in the
pilot, so an operator relays the owner's word through the console's Memory page: the owner's own fact, "It's true" on
a waiting fact, Correct and Forget. A worker never does these: it proposes what it learned (below).

All five routes are under the admin gate, each an exact `ADMIN_METHODS` entry (the shop travels in the query or the
body). A shop is any valid tenant, as in the audit and model routes; a shop that was deleted is not looked up first.

```ts
type Memory = {
  tenant: string;
  facts: Fact[];            // every fact, waiting ones included, oldest first: the order they were made
  forgottenCount: number;   // how many texts the team was told to forget; the fingerprints are never sent
};

type Fact = {
  id: string;               // "f1", "f2", ...: counted per shop and never reused, not even after Forget
  text: string;             // trimmed, 1 to 280 characters (counted by characters, Thai included)
  status: "confirmed" | "waiting";   // a waiting fact is not used until the owner confirms it
  createdAt: number;        // epoch milliseconds, as the package keeps them: not the ISO strings used elsewhere here
  updatedAt: number;
  correctedAt?: number;     // set once the owner corrected it
  source: FactSource;       // "Where it came from"
};

type FactSource =
  | { kind: "owner" }                                    // the owner said it
  | { kind: "document"; name: string; date: number }     // "From your price list, 3 November"
  | { kind: "edits"; count: number }                     // "Learned from 12 of your edits"
  | { kind: "orders"; days: number }                     // "From the last 90 days of orders"
  | { kind: "connection"; name: string; detail: string } // "From your cost sheet in Google Sheets"
  | { kind: "customer"; chat: string };                  // something a customer said, by chat reference
```

**What each route does**

- `GET /v1/admin/memory?tenant=` answers `Memory`. 400 `tenant_required` for a missing or invalid tenant.
- `POST /v1/admin/memory/remember` `{ tenant, text }` adds the owner's own fact, confirmed at once, with source
  `{ kind: "owner" }`. Words that match a waiting fact confirm that fact instead of adding a second. It also lifts an
  earlier Forget of the same words.
- `POST /v1/admin/memory/confirm` `{ tenant, id }` is "It's true": a waiting fact becomes confirmed. Confirming a
  confirmed fact changes nothing and answers the same fact.
- `POST /v1/admin/memory/correct` `{ tenant, id, text }` gives the fact new words, confirmed, with `correctedAt` set.
  The fact keeps its source and its `createdAt`. A correction to the words of a forgotten text lifts that Forget.
- `POST /v1/admin/memory/forget` `{ tenant, id }` removes the fact and keeps only a fingerprint of its words (FNV-1a
  64-bit of the compared form), so the team does not learn them again. The answer is `{ id }`: the words are not sent
  back, and neither they nor the fingerprint reach the export, the audit log or any answer.

Each answers the fact on success (`Fact`, status 200; Forget answers `{ id }`), or the package's refusal as
`{ "error": reason }`:

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_text` | The words are missing, not text, blank or over 280 characters |
| 400 | `invalid_source` | A proposal's source cannot be kept (never from an operator route) |
| 400 | `invalid_request` | The body is not an object, or `id` is missing, not text or over 64 characters |
| 400 | `tenant_required`, `invalid_json` | No valid tenant; a body that is not JSON |
| 404 | `not_found` | The shop has no fact with that id |
| 409 | `already_known` | The shop holds the same words (see below) |
| 409 | `forgotten` | A proposal for words the owner had the team forget (never from an operator route) |
| 409 | `full` | The shop already holds 200 facts. Forget one to make room |
| 413 | `body_too_large` | The body is over 16 KB |
| 503 | `memory_unavailable` | The shop's object could not be reached or did not answer as it should |

**Rules**

- **Same words.** Words are compared after Unicode NFC, trimming, collapsing spaces and lower case, so
  `Closed on  Mondays ` and `closed on mondays` are the same, and Thai text compares the same way.
- **A customer's words wait.** `proposeFact` makes a fact from a customer's chat `waiting`: it is not used until the
  owner confirms it with "It's true" or corrects it. Facts from the owner's own data (`owner`, `document`, `edits`,
  `orders`, `connection`) are confirmed at once. The same words proposed again from the owner's own data confirm a
  waiting fact; a customer repeating them does not.
- **Forget is kept as a fingerprint.** A proposal for forgotten words is refused `forgotten`, in any form. Only the
  owner saying them again (`remember`, or a correction to them) lifts it.
- **At most 200 facts per shop.** Forget makes room.
- **One transaction per change.** The state is read, one rule applied, and the new state and its audit entry written in
  one storage transaction of the shop's object, so two operators' clicks on one shop are decided one after the other
  and neither is lost. Two clicks on the same words give one 200 and one 409 `already_known`. The object's memory paths
  are the Worker's alone (its `x-memory` header, like `x-model` and `x-audit`).
- **Audit.** Every change writes an entry that names the actor, the action and the fact's id, never its words
  ("Audit log", above). The operator routes record the operator's Access identity (none for a service token). A refusal
  changes nothing and writes nothing, and neither does a confirm of a fact already confirmed.
- **Export and deletion.** The tenant export carries `memory: { facts, forgottenCount }`, as the package's
  `exportFacts` gives it: every fact, waiting ones included, and only the number of fingerprints. The tenant deletion
  wipes the shop's memory, the fingerprints included.

**A worker's proposal** is a function, not a route (no operator can make one, and no worker can confirm one):

```ts
proposeFact(env, tenant, text, source, options?: { actor?: AuditActor; now?: () => number }):
  Promise<{ ok: true; fact: Fact } | { ok: false; reason: Refusal | "invalid_request" | "unavailable" }>
```

It never throws, so the job that calls it never fails for the memory. `reason` is one of the package's refusals,
`invalid_request` for a tenant that is not one or a proposal too large to send (over 32 KB), or `unavailable` when the
shop's object cannot be reached or does not answer as it should. `actor` is who the audit entry names:
`{ kind: "worker", attemptId }` when the job flow gives it, and the system otherwise. `now` is the caller's clock, for
tests. The store keeps only the fields of a source's own kind, and refuses with `invalid_source` a name, detail or chat
reference over 256 characters, a count or number of days that is not a whole number, and a document date outside 0 to
8,640,000,000,000,000 milliseconds, so one shop's record stays small.

**What a worker reads** is also a function, not a route:

```ts
usableFacts(env, tenant): Promise<{ ok: true; facts: Fact[] } | { ok: false; error: "invalid_request" | "memory_unavailable" }>
```

It answers only the facts a worker may use, as the package's `usable` decides: confirmed ones, oldest first. A fact
still waiting for the owner is never handed out, so it can never reach a model. A stored fact that is not whole is left
out, and a shop's object that cannot be read is `memory_unavailable`, never an empty memory. Nam, Pim and Ton read it
for every job ("Workers", below).

**The console** has a Memory page in the side menu, beside Audit, laid out as the design canvas's "Customize: memory
and routines" board, newest fact first in each group:

- "What your team knows", with "Where it came from" on its band and, on each fact, where it came from (`source`) and
  Correct and Forget. Correct opens the words in place and sends `correct`; Forget asks once more in the row, because
  the words are gone once it is answered.
- "Waiting for your OK: not used until you confirm", shown only while something waits: each customer's fact tinted
  and tagged "Not confirmed", with "It's true" (`confirm`) and Forget. It has no Correct: correct a fact once the team
  knows it.
- "Tell Buddy something to remember", a box with a "Remember" button that sends `remember`, and a count of the 280
  characters it takes.

The operator relays the owner's word, so the page says to correct or forget a fact only when the owner asks. One change
runs at a time, and each refusal above is said in the board's words. The practice-mode fake keeps the same state with
`@manut/shop-memory`'s own rules: it starts Baan Mali with five facts the team learned and two a customer said, which
wait, and it replaces a practice world saved before memory existed.

## Workers

Nam (sales chat), Pim (content) and Ton (books) are workers on the job flow (`apps/api/src/workers.ts`; how they run
is `docs/phase-0-spikes.md`, section 4). An operator starts one member's job for a shop, and the result is a draft on
the job's own task for the owner to read. No worker sends, posts, pays or refunds, and none asks for an external write.

### `POST /v1/admin/workers/run`

Under the admin gate, as an exact `ADMIN_METHODS` entry. The body is `{ tenant, member, job }`:

- `member`: `nam`, `pim` or `ton`.
- `job`, one of:
  - `{ kind: "reply", messageId }`: a reply to a customer's message the shop holds (`GET /v1/admin/pilot/messages`).
  - `{ kind: "post", topic }`: a post about the topic, 1 to 500 characters once trimmed.
  - `{ kind: "daily_summary" }`: yesterday's sales in Bangkok, from the order payments the shop has recorded
    (`POST /v1/admin/pilot/payments`), each counted as a LINE sale at the time it was confirmed.

A reply is Nam's job, a post Pim's and a summary Ton's. A job asked of another member is passed to the member whose job
it is, and the answer says who did it.

```ts
type WorkerRun = {
  taskId: string;                      // the job's own task: in the shop's export, gone with the shop's deletion
  member: "nam" | "pim" | "ton";       // who did the job
  passedFrom?: "nam" | "pim" | "ton";  // who passed it on, when it was not theirs
  outcome: "done" | "failed";
  reason?: string;                     // why it failed, as a code (below)
  draft?: Draft;                       // when done
};

type Draft = {
  attemptId: string;                   // the attempt that wrote it: one draft per attempt
  member: string;                      // "nam", "pim" or "ton"
  job: string;                         // "reply", "post" or "daily_summary"
  text: string;                        // the words, for the owner to read
  about?: { messageId?: string; date?: string };  // the message a reply answers; the day a summary covers
  send?: { answer: "draft_only" | "ask"; kind: "reply" };  // what sending a reply would take (below)
  at: string;
};
```

A refusal answers `{ "error": code }`. The 400s, 403s and 404s come before anything is created; a 503 can leave the
job's task behind with no attempt on it, which holds nothing.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `tenant_required` | No valid tenant |
| 400 | `unknown_member` | `member` is not `nam`, `pim` or `ton` |
| 400 | `invalid_job` | `job` is missing, of another kind, has a field its kind does not, or its topic or message id is blank or too long |
| 400 | `invalid_request`, `invalid_json` | The body is not a JSON object |
| 403 | `feature_disabled` with `feature: "officeCloud"` | The cloud-work kill switch is off |
| 403 | `consent_required` | The owner has not consented to cloud work |
| 404 | `shop_not_found` | The tenant is not a pilot shop |
| 404 | `message_not_found` | The shop holds no message with that id (customer messages age out after 7 days) |
| 413 | `body_too_large` | The body is over 16 KB |
| 503 | `shop_unavailable`, `message_unavailable`, `task_unavailable`, `meter_unavailable` | An object could not be read or written |

A job that started answers 200, also when it failed, because its task and the audit log record it. `reason` is then
`not_connected` (the LINE connection the customer wrote to is gone), `budget` (the shop's model cap is spent),
`not_configured` (no model key yet), `provider_error`, `memory_unavailable`, `payments_unavailable`,
`vault_unavailable`, `empty_draft`, or a code of the job flow's own.

**Rules**

- **Gates.** `officeCloud` and the owner's consent, read before anything is created. A draft is not an external write,
  so `officeExternalWrites` is not read.
- **Permissions.** `@manut/member-grants`' `decide` answers before the member does anything. A reply goes out through
  the connection the customer wrote to, which starts in practice mode for three days: the answer is `draft_only` then,
  and `ask` after. Either way the reply is only drafted and nothing is asked. To send it, an operator proposes the
  draft's text for its `messageId` through `POST /v1/admin/pilot/replies`, and the owner approves it on the link as for
  any reply.
- **Memory.** Each job reads the facts the team may use (`usableFacts`, above), never a waiting one. A customer's words
  reach the model only as the customer's message, never as instructions.
- **Cost.** One model call per job, through the model gateway and against the shop's cap (`claude-haiku-5-5`). Ton with
  no sales for the day drafts "No sales were recorded on 2026-11-22." and calls no model. Ton reads the newest 500
  payments, as the console lists them.
- **The task.** The job's task is a draft in the cloud location. Its event log holds what each attempt reported
  (`turnStarted`, `spend`, `turnCompleted`, and a `handoffNote` `{ from, to, job }` when a job was passed on), and the
  draft is kept beside it, one per attempt. The draft's words are on the task only.
- **Audit.** Metadata only: `attempt.started` for each attempt (by the operator's Access identity, or by the system
  for the member a job was passed to), and `attempt.ended` with its outcome and reason. No entry holds a customer's
  words, a draft or a secret.

## One origin

The pages and the API share one origin, so the console needs no CORS and one Cloudflare Access application
covers the console and the operator routes. They are two Workers, both deployed from `apps/api`:

- **The API Worker** (`wrangler.jsonc`) is the front door. It answers `/v1/*` and `/relay/*` and hands every
  other path to the pages Worker over its `WEB` service binding. It must never have static assets: Cloudflare
  runs a Worker with assets behind an internal router that does not pass `ctx.access`, and the admin gate needs
  it ([Cloudflare's note](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#ctxaccess-limitations)).
- **The pages Worker** (`wrangler.web.jsonc`, `src/pages.ts`) serves `apps/web`'s build: a file when one
  matches, otherwise the app's one page, which picks the screen from the path (`/approve/{token}`,
  `/delete/{token}`, `/ops`).
  `wrangler dev` and `wrangler deploy` build the web app first with `VITE_API_ORIGIN=same-origin`, so the pages
  call the API that served them and a deploy never ships a missing or stale web app.
- **Page headers**, set in `src/pages.ts`: no framing (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), so
  no other site can trick an owner into pressing Approve; `Referrer-Policy: no-referrer`;
  `X-Content-Type-Options: nosniff`; `X-Robots-Tag: noindex, nofollow`; approval and deletion pages also
  `Cache-Control: no-store`. They never apply to the API's answers.
- **`WEB_ORIGIN` and `PUBLIC_API_ORIGIN`** are both the API Worker's public origin.
- **Cloudflare Access:** one application on that host, covering `/ops` and `/v1/admin/*` and nothing else;
  `ADMIN_ACCESS_AUD` is its audience. The owner's `/approve/*`, `/delete/*` and `/v1/pilot/*`, LINE's
  `/v1/inbound/*` and `/v1/health` stay public.
- **Deploying:** the pages Worker of an environment first (`wrangler deploy -c wrangler.web.jsonc --env dev`),
  then its API Worker (`wrangler deploy --env dev`). Only the API Worker gets the host's route.
- **Locally:** `pnpm --filter @manut/api dev` runs both Workers on one origin.
- **Checks:** `pnpm --filter @manut/api test` checks the hand-off and the headers in workerd
  (`test/pages.test.ts`), then on local Workers the configuration of every environment, the pages, the front
  door (`scripts/one-origin-contract.mjs`) and the admin gate (`scripts/admin-access-contract.mjs`).

## The send itself

A reply is one action proposal on the shop's task with `operationType: "line.message.push"`:

- `connectionId`: the shop's LINE connection; `providerAccountId`: the LINE channel id;
  `targetResourceId`: the bot user id (the connection's only granted resource).
- `recipients`: `[lineUserId]` of the customer who wrote the message being answered.
- `payload`: `{ "text": string }`, 1 to 5,000 characters.

Proposing it opens its approval-core request ("Security rules", above), whichever route proposes it.

The broker pushes it with the LINE Messaging API, sending the action id as the retry key so a retry can never
send twice, and settles `confirmed`, `failed` or `unknown` as it does for every provider.

## Approvals for a session

`GET /v1/approvals?state=open` or `GET /v1/approvals?state=recent`, with a signed-in session
(`Authorization: Bearer <access token>`), answers the shop's approval-core records and where each stands now, for the
desktop's answering slice. The shop's own session reads its own shop; a helper session ("Helpers", below) reads the one
shop it was given for. It only reads: deciding is the next section.

- **What is listed.** Every approval-core request in the tenant's tasks: a worker's request (the job flow) and every
  LINE reply. A proposal that no request decides, such as a session's own `linear.issue.create` through
  `POST /v1/tasks/:id/actions`, is not an approval-core approval and is not listed.
- **The wire format.** Each record is encoded with approval-core's `encodeRecord` and its standing with
  `encodeStanding` (`packages/approval-core/src/wire.ts`), so a client reads both with approval-core's own decoders.
  The standing is read now, at the record's current revision and against the attempt holding its task.
- **Kinds.** The task object sets each request's kind from the operation it decides, never from whoever proposed it:
  a LINE reply (`line.message.push`) is `reply`; a worker's `linear.issue.create` is `command`.
- **`state`**, required: `open` lists every record whose standing is `open`, still waiting for a decision; `recent`
  lists the newest `limit` of the others: decided, expired or superseded. Both are newest first by when they were asked
  (`request.createdAt`), then by id.
- **`limit`**: 1 to 200, 50 when absent. It bounds `recent` only; `open` is never cut short.
- **Scope.** The shop's own, as the tenant export reads it: every task in the shop's index, read with the shop's
  tenant (the session's own, or the one a helper session names) and nothing else. So one shop never reads another's
  approvals, even through a task id planted in its own index or an action planted in its own task. Fellow members' company tasks are not listed:
  reading those takes a verified company assertion, which this route does not make. Like reading a task, it needs no
  feature switch and no consent.
- **A reply stored before replies had requests** and still waiting is listed as the request it would have opened:
  asked when the reply was proposed, expiring with it. A reply decided before then has no record and is not listed;
  its history stays in the export.
- **A note passed on.** A request a helper passed on to the owner comes with `passedOn`: who passed it, their name, the
  note and when. It is shown to whoever lists the shop's approvals.

Errors: 401 `unauthorized` without a session (the operator key is not a session), 401 `removed` with `removedAt` for a
helper the owner removed, 400 `invalid_state`, 400 `invalid_limit`, 405 `method_not_allowed` for anything but `GET`, and
503 `approvals_unavailable` when the shop's index, one of its tasks or its people cannot be read, never a partial list.

```ts
// WireRecord and WireStanding are approval-core's wire JSON (packages/approval-core/src/wire.ts).
type Approvals = {
  state: "open" | "recent";
  approvals: { taskId: string; record: WireRecord; standing: WireStanding; passedOn?: PassedOnNote }[];
};

type PassedOnNote = {
  by: string;     // the helper's id
  name: string;   // the name the owner gave them
  note: string;   // 1 to 500 characters, as the helper wrote it, trimmed
  at: string;
};

// What a LINE reply's request names, in `record.request.detail`. Its id is the reply's action id.
type ReplyDetail = {
  actionId: string;
  operationType: "line.message.push";
  targetResourceId: string;   // the bot user id the reply is sent from
  recipient: string;          // the LINE user id of the customer who wrote
  text: string;               // exactly what will be sent
  payloadHash: string;
};
```

## Deciding from a session

`POST /v1/approvals/{requestId}/decision`, with a signed-in session and the body `{ optionId, seenRevision }`, decides
one of the shop's approval-core requests: the path the desktop's answering slice and a helper's app both use. The
request id is the one the listing above gives (`record.request.id`).

- **Who decides comes from the session, never from the body.** The shop's own session decides as the owner (role
  `owner`, `decidedBy: "owner-session"`); a helper session as that helper (role `helper`, `decidedBy` the helper's id).
  The body is exactly `optionId` (1 to 64 characters) and `seenRevision` (a whole number from 1); a body with any other
  field, a `role` or a `decidedBy` above all, answers 400 `invalid_request` and decides nothing.
- **approval-core decides the rest**, in the request's own task object, as for a worker's request and the owner's
  link: whether that role may decide the request's kind (a helper decides `message` and `reply` only, approving or
  declining), that it is decided once, at the revision the person saw, before it expires, and while the attempt that
  asked still runs, and that the option was offered.
- **The switches and consent of the owner's link**, read first, before anything is recorded: `officeCloud` for any
  decision; for an approval, `officeExternalWrites` and the shop's consent. So with consent missing even a request the
  caller may not decide answers `consent_required` first, as on the link; approval-core's refusal follows once the
  gates pass.
- **Sent once, whichever path approved it.** An approved reply goes to the broker's one-use begin gate, the same gate
  the owner's link sends through, before the answer: the answer's `action` is where it stands then (`confirmed` once
  LINE has it). A reply approved here is never sent again by its link, and the reverse.
- **Nothing settles an action without its request.** Only approval-core requests are found here; a plain proposal no
  request decides answers 404.
- **Scope.** The shop's own requests, found through the shop's index and read with the shop's tenant, so one shop's
  session or helper never decides another shop's request, even one planted in its own index.
- **The audit log** gets the job flow's `approval.decided` entry, naming `owner-session` or the helper's id. A reply
  decided here is not written to the pilot's reply record, so the pilot gate keeps counting the owner's link decisions.

Answers:

| Status | Body | When |
| --- | --- | --- |
| 200 | `{ result: { ok: true, decision }, action }` | Decided. `decision` is approval-core's `SettledDecision`; `action` is the action's state after it (`approved`, `rejected`, `dispatching`, `confirmed`, `failed`, `unknown`) |
| 400 | `{ error: "invalid_request" }` | The body is not exactly `{ optionId, seenRevision }`, or the request id is not one |
| 400 | `{ error: "not_offered", result }` | The request offers no such option |
| 401 | `{ error: "unauthorized" }` | No session, an ended one, or the operator key |
| 401 | `{ error: "removed", removedAt }` | A helper session of a helper the owner removed |
| 403 | `{ error: "feature_disabled", feature }` | `officeCloud` is off, or `officeExternalWrites` for an approval |
| 403 | `{ error: "consent_required" }` | An approval while the shop has not consented |
| 403 | `{ error: "not_permitted", result }` | The caller's role may not decide the request's kind |
| 404 | `{ error: "not_found" }` | The shop holds no such request |
| 405 | `{ error: "method_not_allowed" }` | Anything but `POST` |
| 409 | `{ error: "already_decided", result, action }` | Someone decided first: `result.decision` says who (`decidedBy`, `role`) and when |
| 409 | `{ error: "changed", result }` | The request moved on: `result.currentRevision` is the one to show |
| 409 | `{ error: "superseded", result }` | `result.reason`: `attempt_ended`, `turn_ended` or `withdrawn` |
| 410 | `{ error: "expired", result }` | Past the request's expiry: `result.expiredAt` |
| 503 | `{ error: "approvals_unavailable" }` and others | The shop's index, a task or the shop's people could not be read |

`result` is approval-core's `DecideResult` as the task object answered it. Every refusal of approval-core's also
carries `action`, where the action stands, so a second decision can show what happened to it.

## Helpers

The owner's helpers (`docs/people.md`): an invite for one LINE account or email, once, for 7 days; joining as that
account; helper sessions scoped to one shop; passing a request on with a note; cover while the owner is away; and
removal. The rules are `@manut/people-rules`'; what a helper may decide is approval-core's `mayDecide`. Only pilot
shops have helpers so far.

### Operator routes

Under the admin gate, as exact `ADMIN_METHODS` entries, on the owner's word. Each names an existing pilot shop (else 404
`shop_not_found`; 400 `tenant_required` without a tenant), and each change is written to the shop's audit log under the
operator's Access identity.

| Method and path | Body or query | Answer |
| --- | --- | --- |
| `GET /v1/admin/people` | `?tenant=` | `People` |
| `POST /v1/admin/people/invites` | `{ tenant, name, identity }` | `{ invite: InviteView, inviteUrl }` |
| `POST /v1/admin/people/invites/revoke` | `{ tenant, inviteId }` | `{ invite: InviteView }`; 404 `unknown_invite`; 409 `not_pending` |
| `POST /v1/admin/people/remove` | `{ tenant, helperId }` | `{ removed, sessionsEnded, invitesRevoked, coverEnded }`; 404 `not_a_helper` |
| `POST /v1/admin/people/away` | `{ tenant, helperId, until }` | `{ away: AwayView }`; 400 `bad_date` (not a time in the future); 404 `not_a_helper` |
| `POST /v1/admin/people/away/clear` | `{ tenant }` | `{ away: null }` |

- **Invites.** `identity` is `{ kind: "line", id }` (a LINE account id, compared exactly) or `{ kind: "email", address }`
  (compared without case); `name` is 1 to 80 characters once trimmed. 400 `invalid_request` for another shape or name,
  400 `bad_identity` for an empty id or an address with no `@`, 409 `already_invited` while an open invite names the
  same identity, 409 `already_helper` for a current helper. The answer's `inviteUrl` is `${WEB_ORIGIN}/join/{token}`
  for the operator to copy: **the API never sends it** (LINE and email sending are parked). 503 `not_configured` with
  `setting` when `WEB_ORIGIN` or `APPROVAL_LINK_SECRET` is missing.
- **The invite token** is an HMAC-SHA256 under `APPROVAL_LINK_SECRET` in its own domain, `manut-ai/pilot-invite/v1.`,
  over the shop's tenant, the invite's id and its expiry, so no approval or deletion link passes for an invite, and the
  reverse. Minting is deterministic: `People` shows a pending invite's same link again.
- **Removal** ends every helper session of theirs in the same write that removes them, revokes their pending invites,
  ends their cover, and refuses their decisions from then on. What they did stays in the audit log under their id, and
  `People.removed` keeps their name.
- **Cover** adds no power: approval-core decides whoever covers, so money, public posts, payment confirmations and
  commands wait for the owner.

```ts
type Identity = { kind: "line"; id: string } | { kind: "email"; address: string };

type People = {
  tenant: string;
  owner: { name: string };
  helpers: { id: string; name: string; identity: Identity; joinedAt: string; devices: number }[]; // devices: sessions open now
  invites: InviteView[];
  away: AwayView | null;
  passedOn: { requestId: string; kind: string; by: string; name: string; note: string; at: string }[];
  removed: { id: string; name: string }[];   // helpers who were removed, so their id in the log still has a name
};

type InviteView = {
  id: string;
  name: string;
  identity: Identity;
  status: "pending" | "used" | "revoked" | "expired";   // expired: never used in its 7 days
  createdAt: string;
  expiresAt: string;                                    // 7 days after createdAt
  inviteUrl?: string;                                   // while pending only
};

type AwayView = { helperId: string; name: string; until: string; inForce: boolean };
```

### A helper's own routes

**`POST /v1/people/accept`** with `{ token }` (the invite link's last segment, in the body, never in a URL) and a
signed-in session of the lifted auth. Today that is Sign in with Apple (`POST /v1/auth/exchange`): the session keeps
the email Apple verified, and that email is the account the invite is checked against. Nothing signs in as a LINE
account yet, so a LINE invite answers `wrong_account` to every session until a LINE sign-in exists.

| Status | Body | When |
| --- | --- | --- |
| 200 | `{ answer: "joined", shop: { id, name, ownerName }, helper: { id, name }, session: HelperSession }` | The account the invite names, inside its 7 days, the first time |
| 403 | `{ answer: "wrong_account", shop: { name, ownerName }, invitedOn: "line" \| "email" }` | Another account; the invite stays unused for the right one. The invited value is never shown |
| 409 | `{ answer: "already_used" }` | The invite was used |
| 410 | `{ answer: "expired" }`, `{ answer: "revoked" }` | Past its 7 days, or revoked |
| 404 | `{ answer: "unknown" }` | No such invite, or not an invite token this backend signed |
| 400 | `{ error: "invalid_request" }` | The body is not exactly `{ token }` |
| 401 | `{ error: "unauthorized" }` | No signed-in session (a helper session and the operator key are not one) |

Only `joined` and `wrong_account` name the shop.

**`POST /v1/people/session`** with `{ shop }` (the shop's id from `joined`) and a signed-in session: a helper opens the
shop on another device, as the identity they joined with. 200 `{ shop, helper, session: HelperSession }`; anyone else,
for any shop or none, 403 `not_a_helper`.

```ts
type HelperSession = {
  accessToken: string;   // "mhs1.<shop, base64url>.<64 hex>": send as `Authorization: Bearer <accessToken>`
  expiresAt: string;     // 30 days on; open the shop again with the signed-in session after that
};
```

A helper session is accepted by `GET /v1/approvals`, `POST /v1/approvals/{requestId}/decision` and
`POST /v1/approvals/{requestId}/pass-on`, for its own shop only. Every other session route answers it 401: a helper
never acts as the shop. The shop keeps only its SHA-256.

**`POST /v1/approvals/{requestId}/pass-on`** with `{ note }` and a helper session: the helper hands the owner a request
they may not decide, with a note of 1 to 500 characters (trimmed). It decides nothing: the request keeps waiting for
the owner, and the note is shown with it (`passedOn` in the listing, and in `People`). The note is kept in the shop's
people record, never in the audit log.

| Status | Body | When |
| --- | --- | --- |
| 200 | `{ passedOn: { requestId, kind, by, note, at } }` | Passed on |
| 400 | `{ error: "bad_note" }` | An empty note, or one over 500 characters |
| 400 | `{ error: "invalid_request" }` | The body is not exactly `{ note }` with a string |
| 403 | `{ error: "not_a_helper" }` | The shop's own session: only a helper passes a request on |
| 404 | `{ error: "not_found" }` | The shop holds no such request |
| 409 | `{ error: "decide_yourself" }` | A message or a reply, which the helper decides |
| 409 | `{ error: "already_decided", by, at }` | Someone decided it: who and when |
| 409 | `{ error: "already_passed" }` | A request is passed on once |
