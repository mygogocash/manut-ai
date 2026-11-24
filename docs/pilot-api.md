# Pilot API (week 1)

The contract between `apps/api` (the backend lifted from GoSpark's `cloud/`) and `apps/web` (the owner's
approval page and the operator console). Both sides build to this file. Change it only together.

All bodies are JSON. Times are ISO 8601 strings in UTC. Money is in satang (integer, 100 satang = 1 baht).

## Who is who in the pilot

- **Operator**: a Manut AI staff member running the concierge pilot. Reads customer messages, drafts replies,
  sends the owner an approval link, confirms PromptPay slips. Uses `/v1/admin/pilot/*`.
- **Owner**: the shop owner. Has no account in week 1. Approves or declines one reply through a signed,
  single-use link: `/v1/pilot/approvals/{token}`. Confirms or refuses the deletion of a live shop's data the same
  way: `/v1/pilot/deletions/{token}`. From the several-shops slice, the operator can also link the account the owner
  signs in with to the shop, and that account then decides with an owner session ("Several shops", below).
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
  decidedByHelper?: string;  // the name the owner gave the helper who approved or declined it, when a helper did
  expiresAt: string;
  needsConsent: boolean;
};
```

`decidedByHelper` comes from approval-core's settled decision: only when the server recorded the role `helper` from
the deciding session is a name looked up, in the shop's people record, which keeps the names of removed helpers too.
The owner's own decisions (this link, the shop's session, a linked account) carry no name, and a name that cannot be
read is left out, so the page then says only when the reply was answered. `decidedAt` falls back to the time
approval-core settled the request, so a reply a helper declined has one too.

### `GET /v1/pilot/deletions/{token}`

Returns `DeletionView`: the owner's confirmation of deleting one shop's data. Errors: 404
`{ "error": "link_invalid" }` (not a deletion link this backend signed, or a confirmation it does not hold), 410
`{ "error": "link_expired" }`. A confirmation and its record outlive the deleted shop, so the link keeps saying
what happened until it expires.

### `POST /v1/pilot/deletions/{token}/decision`

Body `{ "approve": true }` or `{ "approve": false }`, else 400 `invalid_request`. Approving settles the decision,
then runs the tenant deletion and completes the deletion record, and answers the view as `deleted`; if the wipe
stops before the shop's data is gone the decision still stands, the view answers `deleting`, and the operator's same
deletion request finishes it. Declining deletes nothing and answers `declined`. A second decision answers 409
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
- `deleted`: the shop's data is deleted. The wipe's very last step, taking the shop off the operator's list, may still
  be left; the operator's same request finishes it ("Export and deletion", below).
- `declined`: the owner kept the data; nothing was deleted.
- `expired`: nobody answered in 24 hours; nothing was deleted.

## Operator routes (all under the admin gate)

| Method and path | Body or query | Answer |
| --- | --- | --- |
| `POST /v1/admin/pilot/shops` | `{ name, ownerName, template? }` | `{ tenant, name, ownerName, template? }`. 400 `{ "error": "unknown_template" }`, making no shop, for a template that is not one ("Shop templates", below) |
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
| `GET /v1/admin/workers/drafts` | `?tenant=&before=&limit=` | `WorkerJobsPage`: one page of the shop's worker jobs, newest first, drafts and handovers included ("Workers' drafts", below) |

The console's **Shops** page, first in its side menu, adds no route. It lists every pilot shop from routes in this table and
reads them all at once, one request each: `GET /v1/admin/pilot/shops` for the rows, `GET /v1/admin/pilot/gate` for each
shop's trial day, whether it has paid and whether it is active, `GET /v1/admin/model/usage` (this Bangkok month) for its
spend against its cap, and `GET /v1/admin/audit?limit=1` for when its log last changed. A request that fails is said to
have failed, in its cell and, with the shop's name, in a banner, and every other cell stays; the gate failing as a whole
says so and leaves the rest. Each row links to the shop's Messages, Drafts, Audit, Memory and Model spend pages.

Secrets (`channelSecret`, `channelAccessToken`) go straight into the encrypted credential vault and are never
returned. `webhookUrl` is `${PUBLIC_API_ORIGIN}/v1/inbound/line/{connectionId}`; `approvalUrl` is
`${WEB_ORIGIN}/approve/{token}`; `confirmUrl` is `${WEB_ORIGIN}/delete/{token}`. Both origins are Worker vars.

```ts
type Shop = {
  tenant: string;
  name: string;
  ownerName: string;            // "" once a deletion has removed the shop's own record (below)
  lineConnectionId?: string;
  template?: string;            // the shop template it was made from, if any ("Shop templates", below)
  consent: boolean;
  deletion?: DeletionRequest;   // the shop's latest deletion put to its owner, if any
  deleting?: Deleting;          // its deletion started and has not finished ("Export and deletion", below)
};

// A deletion under way: running, or stopped part way, for a shop that never went live or one whose owner said yes.
// The operator's same deletion request finishes it, and the shop leaves the list once it has. `shopRecord` is false
// once the deletion has removed the shop's own record: the row is then only what the record of the deletion kept,
// `{ tenant, name, ownerName: "", consent: false, deleting: { shopRecord: false } }`.
type Deleting = { shopRecord: boolean };

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
// ("Memory", below). `signIns` and `outposts` are the vault's site sign-ins and the outposts, as the operator lists
// them, never a password or a credential ("Vault sign-ins and outposts", below). `deletedAt` is there once the shop
// was deleted.
// Saved whole.
// If any part cannot be read, the answer is 500 `{ "error": "export_incomplete", "failed": [...] }` naming
// the parts ("index", a task id, "connections", "signIns", "outposts", "consent", "attention", "pilot", "model",
// "audit", "memory", "schedules", "tombstone"),
// never a 200 that quietly leaves them out. A deleted shop with nothing left answers 404 `tenant_deleted`.
// Every export answer, whole or not, carries `cache-control: no-store`: it holds customers' words.
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
  again), and last of all the shop's registry row. The owner's approval links answer `link_invalid` afterwards and the
  webhook answers 404.
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
    asking the owner again: 200 `DeletedShop`, or 500 `wipe_incomplete` while something still fails. For a shop
    that never went live, the same request finishes its stopped deletion as it was asked for, keeping who asked and
    when; if the shop has gone live since, its owner is asked instead.
  - **A stopped deletion stays on the list.** The wipe runs in a fixed order: the tasks, the vault and the
    schedules; the sessions and the other global rows that name the shop; the shop's own object, ending with its
    tombstone; and last of all its registry row. So the shop leaves `GET /v1/admin/pilot/shops` only once the rest is
    gone. Until then it is listed with `deleting`, and the same request finishes it. If the wipe stopped after it
    had removed the shop's own record, the row is only what the record of the deletion kept (`Deleting`, above),
    the same request still finishes it, and `confirmName` is checked against the name that record kept. A shop
    whose record or deletion cannot be read fails the list with 503 `shops_unavailable` rather than drop off it.
  - The console shows such a shop as the list does: "Deleting" under its name in the side menu, "Deletion not
    finished" in its header, and in its Shop data tab what stopped with "Finish deleting", which sends the same
    request. A shop whose own record is gone cannot be opened, so no page lists it; the note above the shop's page
    says its deletion did not finish and offers the same button. The practice fake lists and finishes a deletion
    that did not finish by the same rules, though a practice wipe never stops part way.
  - Every step answers again after its own wipe: the task index reads as empty once the shop's own object is wiped,
    and each wipe finds nothing more to remove. So the same request runs to the end after a stop at any step,
    including one after the tombstone, when only taking the shop off the list is left.
  - A record of the deletion outlives the shop: who asked (`deletedBy`: the operator's Access identity, or
    `null` for a service token), when, the owner confirmation for a live shop, and once the wipe finished, when
    and what was removed. It is written before anything is wiped, and for a live shop before any link is handed
    out; a request that cannot be recorded does nothing: 503 `audit_unavailable`. A shop whose consent cannot
    be read is never guessed to be not live: 503 `consent_unavailable`.
  - Without `WEB_ORIGIN` or `APPROVAL_LINK_SECRET`, asking a live shop's owner answers 503 `not_configured`
    with the `setting`, deleting nothing.
  - Afterwards every operator route naming the shop answers 404 `{ "error": "tenant_deleted", "deletedAt",
    "deletedBy" }`. If the wipe finished but completing its record did not, `deletedAt` is the tenant's
    tombstone, which the wipe writes last of the shop's data. Once the tombstone is written, every route but the
    deletion request already answers so, though taking the shop off the list may still be left, and the owner's page
    says `deleted`, since none of the shop's data is left.
  - A partial wipe answers 500 `{ "error": "wipe_incomplete", "failed": [...] }`, naming the step that stopped it
    (`index-read`, a task id, `connections`, `schedules`, `sessions`, `index` for the shop's own object, or `registry`
    for taking it off the list); sending the same request again finishes it.

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
  | { kind: "outpost"; id: string }              // an outpost, by its id, with its own credential
  | { kind: "system" };                          // the control plane or the broker, on its own

type AuditSubject = Partial<Record<"taskId" | "actionId" | "messageId" | "attemptId" | "requestId" | "paymentId" |
  "connectionId" | "previousConnectionId" | "confirmationId" | "factId" | "inviteId" | "helperId" | "signInId" |
  "outpostId" | "stepId" | "grantId", string>>;

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
| `approval.decided` | owner or helper, with the id they decided as (`owner-session` for the shop's own session, the linked account's id for an owner session, the helper's id for a helper session) | the same | `approved`, `declined`, or `refused` with approval-core's refusal as the `reason` (`already_decided`, `not_permitted`, `attempt_ended`, `expired` and so on) |
| `approval.superseded` | system | the same | `superseded`, reason `attempt_ended` |
| `memory.remembered`, `memory.confirmed`, `memory.corrected`, `memory.forgotten` | operator | `factId` | `ok` |
| `memory.proposed` | a worker (by its attempt) or the system, as the caller of `proposeFact` says | `factId` | `ok`, or `awaiting_owner` for a customer's words, which wait for the owner |
| `invite.created`, `invite.revoked` | operator | `inviteId` | `ok` |
| `helper.joined` | helper | `inviteId`, `helperId` | `ok` |
| `helper.session_opened` | helper | `helperId` | `ok` |
| `helper.session_ended` | helper, ending their own shop session (`POST /v1/shops/session/end`) | `helperId` | `ok` |
| `owner.session_ended` | the owner's linked account, by its id, ending its own shop session | `ownerAccountId` | `ok` |
| `helper.removed` | operator | `helperId` | `ok` |
| `away.set`, `away.cleared` | operator | `helperId` (who covers, or covered) | `ok` |
| `request.passed_on` | helper | `requestId`, `taskId` | `ok` |
| `signin.created`, `signin.password_replaced`, `signin.removed` | operator | `signInId` | `ok` |
| `outpost.registered` | operator | `outpostId` | `ok` |
| `signin.requested` | worker | `signInId`, `outpostId`, `taskId`, `attemptId`, and `grantId` when a grant was issued | `ok`, or `refused` with the vault's refusal as the `reason` |
| `signin.broken` | worker | `signInId`, `taskId`, `attemptId` | `ok`, or `refused` (`member_not_allowed`, `sign_in_not_found`) |
| `signin.redeemed` | outpost | `outpostId`; for a grant the vault found, also `signInId`, `taskId`, `attemptId`, `grantId` | `ok`, or `refused` with the refusal as the `reason` |
| `outpost.removed`, `outpost.credential_rotated` | operator | `outpostId` | `ok` |
| `browser_step.queued` | worker | `outpostId`, `taskId`, `attemptId`, and `stepId` when it was queued; a sign-in step's `signInId` and `grantId` | `ok`, or `refused` with the refusal as the `reason` |
| `browser_step.fetched` | outpost | `stepId`, `outpostId`, `taskId`, `attemptId`; a sign-in step's `signInId` and `grantId` | `ok` when it was handed out, or `refused` with why (`attempt_ended`, `consent_required`, `origin_not_allowed` and so on); an empty fetch writes nothing |
| `browser_step.reported` | outpost | `outpostId`; for a step the vault found, also `stepId`, `taskId`, `attemptId`, and a sign-in step's `signInId` and `grantId` | `done`, `failed` with the outpost's code (or `text_withheld`) as the `reason`, or `refused` with the refusal |

The job flow's entries (`attempt.*`, `approval.*`) come from the worker adapter contract (`docs/phase-0-spikes.md`,
section 3); a pilot shop has none until a worker runs for it. A reply decided through the owner's link keeps its
`reply.*` entries and writes no `approval.*` one; a reply decided from a session ("Deciding from a session", below)
writes `approval.decided`, naming the shop's own session, the owner's linked account or the helper. The people entries
name invites, helpers and requests by id only: never a name, a note, or an identity's value. The several-shops entries
(`owner.linked`, `owner.unlinked`, `owner.session_opened`, `owner.session_ended`) name the owner's linked account by its id
(`ownerAccountId`), never the account itself or a code.

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
  (`turnStarted`, `spend` with the call's `costSatang`, `turnCompleted`, and a `handoffNote` `{ from, to, job }` when a
  job was passed on), and the draft is kept beside it, one per attempt. The draft's words are on the task only.
- **Audit.** Metadata only: `attempt.started` for each attempt (by the operator's Access identity, or by the system
  for the member a job was passed to), and `attempt.ended` with its outcome and reason. No entry holds a customer's
  words, a draft or a secret.

### Workers' drafts: `GET /v1/admin/workers/drafts`

What the team did for a shop, newest first, a page at a time: the console's Drafts page reads it. Under the admin gate,
as an exact `ADMIN_METHODS` entry. It only reads: it writes nothing, calls no model and sends nothing, so a draft stays a
draft, and a reply reaches a customer only through `POST /v1/admin/pilot/replies` and the owner's approval. The answer
holds the words of drafts, so it carries `cache-control: no-store`.

- `tenant` (required, else 400 `tenant_required`). A tenant that is no pilot shop answers 404 `shop_not_found`; a shop
  with no jobs answers an empty page.
- `before`: the `taskId` of a job on an earlier page, usually the `next` the last page gave. Anything else, or a job
  that is not the shop's, is 400 `invalid_request`.
- `limit`: 1 to 25, 10 when absent. Anything else is 400 `invalid_request`.

```ts
type WorkerJobsPage = {
  tenant: string;
  jobs: WorkerJobEntry[];       // newest first
  next: string | null;          // `before` for the page after this one; null when there is nothing older
};

type WorkerJobEntry = {
  taskId: string;               // the job's own task
  member: "nam" | "pim" | "ton";            // who has the job now: the member of its newest attempt
  passedFrom?: "nam" | "pim" | "ton";       // who passed it to them, when it was not theirs ("Passed to Ton")
  job: "reply" | "post" | "daily_summary";
  at: string;                   // when the job started: when its first attempt was claimed
  ending: WorkerJobEnding;
  draft: { text: string; at: string; about?: { messageId?: string; date?: string };
           send?: { answer: "draft_only" | "ask"; kind: "reply" } } | null;   // the newest draft; not sent
  costSatang?: number;          // what the job's model calls cost, in whole satang; absent when it called none
};

type WorkerJobEnding =
  | { state: "running" }                          // its attempt can still act
  | { state: "done" }
  | { state: "failed"; reason: string }           // the code the attempt ended with (see "Workers", above)
  | { state: "awaiting_owner" }                   // a worker that asked and stopped until the owner answers
  | { state: "handed_over"; to: "nam" | "pim" | "ton" }   // passed on to a member who has not taken it up
  | { state: "cancelled" };
```

- **Jobs.** A job is a task the runner made (`worker-task-…`) that has at least one attempt, so a task a refused start left
  behind is not listed. A task that is not the shop's, or whose title or executors the runner never gives, is not listed
  either. `limit` counts jobs, a job passed on counting once; a page reads on past anything that is not a job, so it can
  come back short or empty while `next` says there is more.
- **Handovers.** A job passed to the member whose job it is shows that member and `passedFrom`; its ending, draft and
  cost are theirs. `handed_over` is for a job passed on that nobody has taken up. A handoff note that does not name one of
  the team is not a handover.
- **Endings.** An attempt still marked active whose lease or deadline has passed can no longer act, so it reads as the
  sweep will settle it, `failed` with the reason `deadline` or `silent`; the read ends nothing. A finished attempt with no
  recorded outcome predates outcomes and reads as `failed` with the reason `unknown`, never as a success.
- **Cost.** The sum of the `costSatang` on the job's `spend` reports: the gateway's own price for each call, rounded up
  to whole satang as the meter's record is. A call the provider failed reports no spend, so a job shows no cost for it;
  the shop's Model spend page still counts it.
- **Failures.** A task that cannot be read fails the whole page with 503 `{ "error": "drafts_unavailable" }`, as does the
  shop's index of tasks; a shop record that cannot be read answers 503 `shop_unavailable`. A job is never left out of a
  page in silence.
- **The console** has a Drafts page in the side menu, beside Audit and Memory: the shop is chosen on the page, each job
  shows its draft in full under "Not sent", and "Show older jobs" reads the next page. It has no send button.

## Vault sign-ins and outposts

How the team signs in to the sites a shop uses, such as Shopee Seller Centre, without any AI holding a password. The
design, and what comes next, is `docs/browser-control.md`; the code is `apps/api/src/sign-in-vault.ts` (the records, in
the shop's vault object) and `apps/api/src/browser-control.ts` (the routes).

- A **sign-in** is one account on one site, kept in the shop's vault with the members who may use it. Its password is
  sealed with the vault's keys and answered by one route only: a redeem, to the outpost a grant names.
- An **outpost** is a machine that runs the team's browser: this Mac (through the desktop app) or a cloud outpost. It
  has a credential of its own, given once when it is registered.
- A **grant** is one outpost's permission to type one sign-in for one worker's attempt, once, within 60 seconds. A
  worker asks for it through the job flow's port (below); there is no route to ask for one.
- A **browser step** is one thing a worker asks an outpost's browser to do in its attempt: open a page, read it, or
  sign in with a grant. Reading only, for now. A worker queues it through the port; the outpost asks for its steps and
  reports how each went, and the outcome lands in the attempt's events.

The operator's routes are under the admin gate, each an exact `ADMIN_METHODS` entry, with the tenant and ids in the
query or the body. The outposts' routes are public paths that need the outpost's credential as
`Authorization: Bearer <credential>`, and nothing else opens them: not the operator's key, not an owner's session.
They share one ingress limit per source address (`OUTPOST_LIMITER`, 300 a minute), checked before the credential or
the body is read: over it they answer 429 `{ "error": "rate_limited" }` with `Retry-After: 60`, and without a working
limiter, or a source address, 503 `{ "error": "rate_limit_unavailable" }`.

```ts
type SignIn = {
  id: string;
  site: string;                  // the name people use: "Shopee Seller Centre"
  origins: string[];             // 1 to 5 https origins, written exactly as a browser writes `location.origin`
  username: string;              // the account on the site; shown to the owner, never given to a model
  members: string[];             // who may use it: "nam", "pim", "ton", "kit"
  state: "working" | "broken";   // broken: a member reported that the site refused the saved password
  passwordSet: true;             // the only thing any answer says about the password
  passwordSetAt: string;
  brokenAt: string | null;       // when it broke: the first report
  brokenBy: string | null;       // the member who reported it
  lastUsedAt: string | null;     // when an outpost last redeemed a grant for it
  lastUsedBy: string | null;     // the member whose step that was
  createdAt: string;
};

type Outpost = {
  id: string;
  name: string;                  // "This Mac", "Cloud outpost"
  kind: "this_mac" | "cloud";
  status: "online" | "asleep";   // online while its last heartbeat is under 90 seconds old; asleep before its first
  lastHeartbeatAt: string | null;
  createdAt: string;
};

// A browser step as the worker that queued it sees it.
type BrowserStep = {
  stepId: string;
  kind: "open" | "read" | "sign_in";
  outpostId: string;
  // queued until its outpost takes it, taken while it runs (and until its report has landed in the attempt's events),
  // then how it ended; expired when it did not end within its time
  state: "queued" | "taken" | "done" | "failed" | "refused" | "expired";
  queuedAt: string;
  expiresAt: string;             // two minutes after it was queued, or its grant's end if sooner
  url?: string;                  // open: the page
  selector?: string;             // read: the part of the page; absent reads the whole page
  signInId?: string;             // sign_in: the grant's sign-in
  code?: string;                 // failed or refused: why
  text?: string;                 // a read that is done: what it read
};

// A browser step as its outpost is handed it.
type OutpostStep = {
  stepId: string;
  kind: "open" | "read" | "sign_in";
  url?: string;                  // open
  selector?: string;             // read, when it reads part of the page
  grantId?: string;              // sign_in: redeem it, then type into the page that is open
  origins: string[];             // the origins its browser may be on for this step; anywhere else stops it
  expiresAt: string;
};
```

Any route here can also answer 503 `vault_unavailable` when the shop's vault does not answer, and a route with a body
400 `invalid_json`, 400 `invalid_request` (not a JSON object) or 413 `body_too_large` (over 16 KB).

### `GET /v1/admin/vault/sign-ins?tenant=`

`{ tenant, signIns: SignIn[] }`, oldest first: the shop's sign-ins, not those removed. 400 `tenant_required`.

### `POST /v1/admin/vault/sign-ins`

`{ tenant, site, origins, username, password, members }` answers `{ signIn: SignIn }`.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `tenant_required` | No valid tenant |
| 400 | `invalid_site` | Blank once trimmed, over 80 characters, or holding a control character |
| 400 | `invalid_origins` | Not 1 to 5 distinct origins, or one that is not `https`, or not written as a browser writes an origin (a path, an account, a default port or capital letters in it) |
| 400 | `invalid_username` | Blank, over 256 characters, or holding a control character |
| 400 | `invalid_password` | Not text of 1 to 1,024 characters |
| 400 | `invalid_members` | None, a repeat, or one who is not Nam, Pim, Ton or Kit |
| 409 | `too_many_sign_ins` | The shop already has 50 |
| 503 | `vault_not_configured` | The vault's key (`CRED_KEY`) is not set |

The members a sign-in may name come from `@manut/member-grants`' roster: those whose jobs run through a connection.
Buddy routes work and never signs in to a site.

### `POST /v1/admin/vault/sign-ins/password`

`{ tenant, signInId, password }` seals the new password in place of the old and answers `{ signIn: SignIn }`. It also
mends a broken sign-in: `state` is `working` again and `brokenAt` and `brokenBy` are null. 404 `sign_in_not_found`,
400 `invalid_password`, 503 `vault_not_configured`.

### `POST /v1/admin/vault/sign-ins/remove`

`{ tenant, signInId }` answers `{ removed: true, signInId }`. The record stays as a tombstone with no username and no
seal, as a revoked connection does, so a restored backup cannot bring the password back. A grant waiting for it is
refused. 404 `sign_in_not_found`, also when it was already removed.

### `POST /v1/admin/outposts`

`{ tenant, name, kind }` answers `{ outpost: Outpost, credential: string }`. The credential (`mo1_` and 43 base64url
characters) is in this answer and nowhere else: the vault keeps only its SHA-256, so an outpost that loses it is
registered again. 400 `tenant_required`, `invalid_name` (blank once trimmed, over 80 characters, or holding a control
character), `invalid_kind`; 409 `too_many_outposts` (20 per shop).

### `GET /v1/admin/outposts?tenant=`

`{ tenant, outposts: Outpost[] }`, oldest first, each `online` or `asleep` as of now. 400 `tenant_required`.

### `POST /v1/admin/outposts/credential`

`{ tenant, outpostId }` answers `{ outpost: Outpost, credential: string }`, with `Cache-Control: no-store`: a new
credential, in this answer and nowhere else, kept as its SHA-256 like the first. The old one stops working at once,
and the outpost is `asleep` until the holder of the new one beats. Grants and steps waiting for it stay, for the new
credential. 400 `tenant_required`; 404 `outpost_not_found` (also another shop's, or one removed).
`POST /v1/admin/outposts` answers with `no-store` too.

### `POST /v1/admin/outposts/remove`

`{ tenant, outpostId }` answers `{ removed: true, outpostId, stepsRefused: number, grantsRefused: number }`. The
outpost is deleted, so its credential stops working at once; in the same step each of its steps still waiting or
running is refused (`outpost_removed`), and each of its grants not yet redeemed and on time is used up. 400
`tenant_required`; 404 `outpost_not_found`, also when it was already removed.

### `POST /v1/outposts/heartbeat`

With the outpost's credential, `{ tenant, outpostId }` answers `{ outpost: Outpost }`, now `online`. An outpost beats
every 30 seconds while it is awake. A missing or wrong credential, another shop's outpost and an unknown outpost all
answer 401 `unauthorized` alike, and record nothing. Beats are not written to the audit log.

### `POST /v1/outposts/redeem`

With the outpost's credential, `{ tenant, outpostId, grantId }` answers, with `Cache-Control: no-store`:

```ts
type Redeemed = { signInId: string; site: string; origins: string[]; username: string; password: string };
```

The outpost types the username and password into a page whose origin is one of `origins`, and keeps them nowhere.

| Status | `error` | When |
| --- | --- | --- |
| 401 | `unauthorized` | The outpost's own credential is missing or wrong. Nothing is used up and nothing is logged |
| 404 | `grant_not_found` | The shop has no such grant |
| 403 | `wrong_outpost` | The grant names another outpost. It stays for its own |
| 409 | `grant_used` | It was redeemed before, whatever came of that |
| 409 | `grant_expired` | Its 60 seconds are over |
| 404 | `sign_in_not_found` | The sign-in was removed since |
| 403 | `member_not_allowed` | The member is no longer named on the sign-in |
| 409 | `sign_in_broken` | A member reported the password broken since |
| 403 | `feature_disabled` with `feature: "officeCloud"`, or `consent_required` | The kill switch is off, or the owner withdrew consent |
| 409 | `attempt_ended` | The attempt it was issued to ended, its lease or deadline lapsed, or its task settled |
| 503 | `task_unavailable`, `vault_not_configured` | The task or the vault's key could not be read |

From `sign_in_not_found` down the table, the vault had found the grant to be the outpost's own, unused and on time, and
the redeem used it up there: whatever the answer, it cannot be redeemed again. Every answer after the vault checked
the outpost's credential is written to the audit log; a 401, a malformed body, and a vault that did not answer that
check are not.

### `POST /v1/outposts/steps`

With the outpost's credential, `{ tenant, outpostId }` answers `{ steps: OutpostStep[] }`, with
`Cache-Control: no-store`: the browser steps waiting for this outpost, oldest first, five at most. Each is handed out
once; ask again for the next. An outpost asks every few seconds while it is awake (the ingress limit is sized for every
3). It sees only its own steps: another outpost's, and another shop's, are not there for it.

Before a step is handed out, the switches (`officeCloud`) and the owner's consent are read, and the task object is read
to see that the step's attempt still runs. A step whose attempt ended is refused (`attempt_ended`) and left out; a step
whose task cannot be read waits for the next ask. Each step's `origins` are read from the sign-ins as it is handed out,
so a sign-in removed or broken since it was queued takes its origins with it, and a step left with none, or a
`sign_in` step whose grant was used or ran out, is refused and left out.

| Status | `error` | When |
| --- | --- | --- |
| 401 | `unauthorized` | The outpost's own credential is missing or wrong. Nothing is read or written |
| 403 | `feature_disabled` with `feature: "officeCloud"`, or `consent_required` | The kill switch is off, or the owner withdrew consent. Every step that was waiting is refused for good, with this code |

With no step waiting the answer is `{ steps: [] }`, and the switches, consent and the audit log are not touched.

### `POST /v1/outposts/steps/report`

With the outpost's credential, `{ tenant, outpostId, stepId, outcome, code?, text? }` reports how a step it was handed
went, once, and answers `{ step: { stepId, state: "done" | "failed" } }`.

- `outcome: "done"`: for a `read`, `text` is what it read, at most 4 KB once written as JSON in UTF-8 (`""` for a page
  with no text); the other kinds carry no text.
- `outcome: "failed"` with `code`, one of `origin_not_allowed` (a page was, or went, off the step's origins, and the
  outpost stopped there), `page_unavailable`, `selector_not_found`, `sign_in_refused` (the site refused the saved
  password), `grant_refused` (the redeem was refused), `timed_out`, `browser_error`; and no text.

The outcome lands in the attempt's events as two agent events, a tool call in the agent event contract:
`{ type: "toolStarted", id: stepId, call: { kind: "web", title, output: "", status: "running", edits: [], startedAt } }`
(the title says what was asked, such as "Open https://seller.shopee.co.th/portal/sale/order", "Read .order-status" or
"Sign in to Shopee Seller Centre") and `{ type: "toolUpdated", id: stepId, update: { status, output } }`, where `status`
is `completed` or `failed` and `output` is the read's text or the failure's code. They are appended by the control
plane only while the attempt runs (active, its lease and deadline not passed, its task not settled), and they never
extend its lease. The worker sees the outcome only once it has landed.

A read whose text holds the password of any of the shop's sign-ins is taken as `failed` with `text_withheld`, and the
text is kept nowhere: the answer is `{ step: { stepId, state: "failed" } }`.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_report` | An outcome other than `done` or `failed`, a failure without a known code, a code or text where none goes, a read reported done without its text, or a text that is not a string. Nothing is used up |
| 400 | `text_too_long` | A read's text over 4 KB as JSON. Nothing is used up: cut it and report again |
| 401 | `unauthorized` | The outpost's own credential is missing or wrong. Nothing is read or written |
| 404 | `step_not_found` | The shop has no such step |
| 403 | `wrong_outpost` | The step is another outpost's. It stays for its own |
| 409 | `step_not_fetched` | The outpost was never handed the step |
| 409 | `step_reported` | It was reported before, whatever came of that |
| 409 | `step_expired` | Its time is over |
| 403 | `feature_disabled` with `feature: "officeCloud"`, or `consent_required` | The kill switch is off, or the owner withdrew consent |
| 409 | `attempt_ended` | The attempt ended, its lease or deadline lapsed, or its task settled |
| 503 | `task_unavailable` | The attempt's events could not be written |

From `feature_disabled` down the table, the vault had taken the report; the outcome is then taken back, the step reads
`refused` with that code, and what it read is dropped. A step reported once cannot be reported again. Every answer
after the vault checked the outpost's credential is written to the audit log (`browser_step.reported`); a 401 and a
malformed report are not.

### The worker's side

No route: a worker holds only the job flow's port (`apps/api/src/job-flow.ts`), and the port has two steps for this.

- `signIn(signInId, outpostId)` answers `{ grantId, signInId, site, outpostId, expiresAt }`. The control plane reads
  the switches (`officeCloud`) and the owner's consent, then the attempt's own heartbeat, which also gives the member
  the attempt was started for, from the task object's record. The vault then issues the grant if the member is named
  on the sign-in, it is working, and the outpost is online. Refusals: the port's own (`feature_disabled`,
  `consent_required`, and the attempt's, with `ended`), `sign_in_not_found`, `member_not_allowed`, `sign_in_broken`,
  `outpost_not_found`, `outpost_asleep`, `vault_unavailable`. The model asks for a sign-in by its site's name only; it
  never sees a username, a password or a grant.
- `signInBroken(signInId)` answers `{ signInId, state: "broken" }`: the site refused the saved password, and no grant
  is issued for the sign-in until a new password is typed. Only a member named on it can report it
  (`member_not_allowed`). A second report keeps the first's time and member.
- `browserStep(step)` answers a `BrowserStep`, `queued`. The step is `{ kind: "open", outpostId, url }`,
  `{ kind: "read", outpostId, selector? }` or `{ kind: "sign_in", outpostId, grantId }`. The port reads the switches,
  consent and the attempt's own heartbeat as for `signIn`, and the member is the task object's record of the attempt.
  Refusals: the port's own; `step_kind_not_allowed` (any other kind: a step that submits is the next slice);
  `invalid_request` (a field another kind takes); `outpost_not_found`, `outpost_asleep`; `invalid_url` (not https, an
  account in it, a space, over 2,048 characters); `origin_not_allowed` (an `open` whose origin is not one of a working
  sign-in the member is named on, or a `read` for a member named on none); `invalid_selector` (blank, over 256
  characters, or a control character); for `sign_in`, `grant_not_found` (also another attempt's or member's),
  `wrong_outpost`, `grant_used`, `grant_expired`, `grant_queued` (another step carries it), and the sign-in's
  `sign_in_not_found`, `member_not_allowed`, `sign_in_broken`; `too_many_steps` (the outpost holds 20 waiting or
  running); `vault_unavailable`. A `sign_in` step expires with its grant.
- `browserStepOutcome(stepId)` answers the `BrowserStep` as it stands, with `code` once it failed or was refused and
  `text` once a read is done; `step_not_found` for another attempt's step. A step whose outpost reported
  `sign_in_refused` carries its `signInId`, for `signInBroken`.

**Rules**

- **No password anywhere else.** No answer, task event, browser step, log line, audit entry or export holds a
  password, except the redeem's answer to the outpost its grant names. A read whose text holds one is withheld. The
  tests search every answer, the vault's records and the export for it.
- **Reading by default.** Browser steps open, read and sign in. A step that would submit anything other than a read
  (an order, a reply, a refund, a post) is refused (`step_kind_not_allowed`) until it can go through member-grants'
  `decide` and an approval-core request naming the exact action first, as every write does
  (`docs/browser-control.md`).
- **Audit.** `signin.*`, `outpost.*` and `browser_step.*`, with ids only ("Audit log", above).
- **Export and deletion.** The tenant export carries `signIns` and `outposts` as the operator lists them. The tenant
  deletion wipes every sign-in (tombstones too), outpost, grant and browser step with the shop's vault. Grants and
  steps are not exported: they live a minute or two, the audit log keeps their history, and a step's outcome that
  landed is in its task's events, which are.

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
helper the owner removed, 401 `unlinked` with `unlinkedAt` for an owner session whose account the operator unlinked
("Several shops", below), 400 `invalid_state`, 400 `invalid_limit`, 400 `invalid_request` for a query naming `shop`,
`tenant` or `role` (the session decides those, so they are refused rather than read), 405 `method_not_allowed` for
anything but `GET`, and 503 `approvals_unavailable` when the shop's index, one of its tasks or its people cannot be read,
never a partial list.

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
  `owner`, `decidedBy: "owner-session"`); an owner session ("Several shops", below) as the owner too, with `decidedBy`
  the id of the account linked to the shop (`owner-<uuid>`); a helper session as that helper (role `helper`, `decidedBy`
  the helper's id).
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
| 401 | `{ error: "unlinked", unlinkedAt }` | An owner session whose account the operator unlinked ("Several shops") |
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
  owner: { name: string; account: OwnerAccountView | null };   // the account linked as the owner's ("Several shops")
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
never acts as the shop. The team's routines (`/v1/routines`, `/v1/team/*`, "Routines", below) answer it 403
`owner_only` instead, so a helper's app does not read its session as ended. The shop keeps only its SHA-256. The helper's
app ends its own session with `POST /v1/shops/session/end` ("Several shops", below); removal ends every one at once.

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

## Routines

What Buddy's team does on its own schedule, per shop (`apps/api/src/routines.ts`, `routine-store.ts`,
`routine-setup.ts`), on `@manut/routine-rules`: a morning brief every day at 08:00, a weekly growth brief, the books on
the last day of the month. A run only ever makes a worker's draft for the owner to read: nothing is sent, posted or
paid by a routine, and a routine that would reply, send, pay or delete always asks first.

### Routes

An operator's, under the admin gate as exact `ADMIN_METHODS` entries. The tenant travels in the query or the body, and a
change needs an existing pilot shop (404 `shop_not_found` otherwise), as the console's other writes do.

| Method and path | Body or query | Answer |
| --- | --- | --- |
| `GET /v1/admin/routines` | `?tenant=` | `RoutinesView` |
| `POST /v1/admin/routines` | `{ tenant, name, action, trigger, timeZone?, asksFirst?, member? }` | `{ routine: Routine }`, switched on |
| `POST /v1/admin/routines/pause` | `{ tenant, routineId }` | `{ routine }`. Pausing a paused routine changes nothing and logs nothing |
| `POST /v1/admin/routines/resume` | `{ tenant, routineId }` | `{ routine }`, its next run worked out from now |
| `POST /v1/admin/routines/remove` | `{ tenant, routineId }` | `{ removed: routineId }`: the routine, its runs and its clock go |
| `POST /v1/admin/team/pause` | `{ tenant }` | `{ team: Team }`: Pause everyone |
| `POST /v1/admin/team/resume` | `{ tenant }` | `{ team }` |

The shop's own session (the lifted auth's, whose tenant is the shop) has the same routes for its own shop, with no
`tenant` in the body (a body that names one is refused): `GET /v1/routines`, `POST /v1/routines`,
`POST /v1/routines/pause`, `POST /v1/routines/resume`, `POST /v1/routines/remove` (each `{ routineId }`), and
`POST /v1/team/pause` and `POST /v1/team/resume` (`{}`). No session answers 401 `unauthorized`, and so does the operator
key; a helper's session answers 403 `owner_only`, because the team's routines are the owner's. A pilot shop's tenant can
never be a session, so its routines are the operator's until the operator links the owner's account: that account's
owner session then has these routes for its shop ("Several shops", below), and the log names the account's id.

Making, pausing, resuming or removing a routine needs neither a switch nor the owner's consent: nothing runs then. Every
run reads both.

```ts
type Trigger =
  | { kind: "daily"; at: string }                          // "08:00"
  | { kind: "weekly"; weekdays: number[]; at: string }     // 0 is Sunday
  | { kind: "monthly"; day: number | "last"; at: string }  // a day from 1 to 28, or the last day
  | { kind: "window"; from: string; to: string }           // may cross midnight: 21:00 to 08:00
  | { kind: "stockBelow"; threshold: number };             // a whole number from 1

type Routine = {
  id: string;                    // "rt-…": sorts by when it was made, so the list reads in that order
  name: string;                  // 1 to 80 characters, trimmed
  action: "brief" | "draft" | "reply" | "send" | "pay" | "delete";
  trigger: Trigger;
  timeZone: string;              // "Asia/Bangkok" unless the body says another IANA zone
  asksFirst: boolean;
  member: "nam" | "pim" | "ton"; // whose job each run starts
  when: string;                  // describeTrigger: "Every day at 08:00", "When stock drops under 5"
  paused: boolean;
  next: string | null;           // nextRun; null while it or the team is paused, its member is off, or it waits on stock
  waitsFor?: "stock_feed";       // a stock routine: there is no stock feed yet, so it never runs
  template?: string;             // the shop template it came from
  createdAt: string;
  lastRun: RoutineRun | null;
};

type RoutineRun = {
  routineId: string;
  instant: string;               // the instant the run was meant for, never when an alarm came
  status: "running" | "done" | "failed" | "skipped" | "missed";
  reason?: string;               // a code (below)
  member: "nam" | "pim" | "ton";
  taskId?: string;               // the job's task, for a run that started one
  at: string;
};

type Team = {
  paused: boolean;               // Pause everyone
  since: string | null;
  members: ("nam" | "pim" | "ton")[];  // the members on: all three, unless a shop template turned on fewer
};

type RoutinesView = { tenant: string; team: Team; routines: Routine[] };
```

A refusal answers `{ "error": code }`, and nothing is kept:

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_name`, `invalid_action`, `invalid_time_zone`, `invalid_trigger`, `invalid_time`, `invalid_weekdays`, `invalid_day`, `invalid_window`, `invalid_threshold` | routine-rules' own refusals |
| 400 | `must_ask_first` | `asksFirst: false` for a routine that replies, sends, pays or deletes: refused, never quietly changed |
| 400 | `unknown_member` | `member` is not `nam`, `pim` or `ton` |
| 400 | `wrong_member` | The routine is not that member's work (below) |
| 400 | `invalid_request`, `tenant_required` | Another field, a `routineId` that is not one, no valid tenant |
| 404 | `not_found` | The shop has no routine with that id |
| 409 | `full` | The shop already has 50 routines |
| 503 | `clock_unavailable`, `routines_unavailable` | The schedule object or the shop's object could not be reached |

**Rules**

- **Asks first.** Left out, `asksFirst` is true for a reply, a send, a payment or a deletion, and false for a brief or a
  draft, which only the owner sees. A brief or a draft may still be made to ask.
- **Who runs it.** Nam drafts replies (`reply`); Pim drafts posts (`draft`, or `send` for a post that sending will ask
  for); Ton drafts the owner's briefs and the books (`brief`, `draft`, `send`, `pay`, `delete`). Left out, the member
  is Nam for a reply and Ton for the rest.
- **Clocks.** A daily or weekly routine is a schedule on the shop's lifted schedule object, through routine-rules'
  `toSchedule` (its `ScheduleJSON` carries `routineId`, and the public `/v1/schedules` routes answer 409
  `routine_schedule` to saving over it or deleting it). A monthly or window routine is a timer in the same object, timed
  by `nextRun`, and swept by the same alarm; a window runs once a day, at its start. A stock routine has no clock. A
  clock is made before its routine and removed after it, so a change that stops part way leaves at most a clock with no
  routine, which removes itself at its first instant.
- **One run per instant.** Each run is claimed in the shop's object by the routine and the instant it was meant for, so
  a duplicate alarm or a clock saved again never runs it twice. An alarm more than 15 minutes late records the run
  `missed` and does not run it. Only the latest instant is considered: older ones are not caught up, and a new clock
  never opens with old misses.
- **Skipped, and why.** A run does not start, and says so as `skipped` with a reason, while the routine is paused
  (`routine_paused`), everyone is paused (`team_paused`), its member is not on the team (`member_off`), routines or cloud
  work are off by the environment's default with no switch set (`routines_off`, `cloud_off`), or the owner has not
  consented to cloud work (`consent_required`). A template's routines start paused, so they record `skipped` at each
  time they would have run until the owner turns them on.
- **Kill switches.** An operator's `officeRoutines` or `officeCloud` switch set off stops every clock, as it stops every
  schedule: nothing runs and nothing is recorded while it is off, and a withdrawn consent does the same. Once it is on
  again, the latest instant is recorded `missed` if it is past the grace.
- **A run.** The job flow's own worker (`runWorker`, "Workers", above), started by the system: Ton's summary of
  yesterday's sales, Pim's post about the routine's name, or Nam's reply to the newest customer message with no reply
  that came in since the routine last ran (`skipped` with `nothing_to_answer` when there is none). It ends `done` with
  its task, or `failed` with its task when it had one and the job's reason (`not_configured`, `budget`,
  `shop_not_found`, ..., or `job_error` when the job broke part way). A claimed run is never run again, whatever its
  end. The draft is on the job's task, and nothing on it is sent.
- **Audit.** `routine.created`, `routine.paused`, `routine.resumed` and `routine.removed` by whoever made the change (the
  operator's Access identity, or the owner's session as `owner-session`); `routine.ran` by the system, with the run's
  outcome (`done`, `failed`, `skipped` or `missed`) and its reason; `team.paused` and `team.resumed`. Each names the
  routine by id (and the job's task for a run that started one), never its name.
- **Export and deletion.** The shop's export carries `routines`: the team, every routine, the first-week questions
  (below) and every run kept (the newest 30 of each routine). Deleting the shop removes them with its other records,
  and its clocks with its schedules.

## Shop templates

A new shop can start from one of `@manut/shop-templates`' three templates: `handmade` ("Handmade and gifts"),
`fashion` ("Clothes and accessories") or `food` ("Packaged food and drinks"). The console's new-shop form offers them.

**`GET /v1/admin/templates`** answers `{ templates: ShopTemplate[] }`, in the package's own words:

```ts
type ShopTemplate = {
  id: string;
  name: string;
  fits: string;                  // one line saying which shops it fits
  team: string[];                // the members it turns on; Buddy is always on
  routines: { when: string; does: string; asksFirst: boolean }[];
  questions: string[];           // what Buddy asks the owner in the first week
};
```

**`POST /v1/admin/pilot/shops`** takes `template` (an id, or null or left out for none). A template must be one of the
three, with no problem `checkTemplate` finds; anything else answers 400 `unknown_template` before anything is made.
Applying one:

- records the template on the shop (`Shop.template` in the shop list);
- turns on its members (`Team.members`): a routine whose member is not on is skipped (`member_off`);
- makes its routines, each **paused** until the owner turns it on, so nothing runs by surprise. Each trigger is read
  from the template's words; "When a size drops under 3" is kept as stock below 3, and the routine's name keeps what it
  is for. A reminder is a `brief`, and a post is a `send`, which asks first. Pim drafts the new-arrivals post; Ton runs
  the rest;
- keeps its first-week questions, `q1` onwards, for Buddy to ask the owner.

All of it is one write to the shop's object, after the clocks and before the shop is listed: a shop whose setup could
not be written answers 503 `shop_unavailable` and is never listed, and asking again makes a whole one. The log has
`template.applied` (naming the template by id) and one `routine.created` for each routine.

**`GET /v1/admin/questions?tenant=`** answers `{ tenant, template, questions: Question[] }`: the template the shop was
made from (null for none), and each question with its answer as the team now knows it.

```ts
type Question = {
  id: string;                    // "q1", "q2", ...
  text: string;
  answer: { factId: string; text: string | null; answeredAt: string } | null;
};
```

**`POST /v1/admin/questions/answer`** with `{ tenant, questionId, text }`: the owner's answer, relayed by the
operator. It becomes the owner's own fact through memory's `remember` (confirmed at once, the owner its source), and the
question keeps the fact's id, in one transaction. Write it as a sentence that stands on its own ("Free shipping on
orders over ฿1,000"), as any fact the team is told to remember. Answers `{ question, fact }`.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_text` | Blank, or over 280 characters (memory's limit) |
| 400 | `invalid_request`, `tenant_required` | Another field, or no valid tenant |
| 404 | `shop_not_found` | The tenant is not a pilot shop |
| 404 | `not_found` | The shop has no such question |
| 409 | `already_answered` | A question is answered once: a change is a correction of its fact on the Memory page |
| 409 | `already_known`, `full` | Memory's own refusals: the team knows exactly these words, or holds 200 facts |

The answer's words live only in the fact. The owner's Forget removes them, and the question then reads as answered with
`text: null`. The log has `memory.remembered` (the fact by id) and `question.answered` (the question and the fact by
id), by the operator's Access identity, never the question or the answer.

## Several shops

One signed-in person can own some pilot shops and help at others (`docs/several-shops.md`). Each shop's own people
record decides who may act for it and as what; each person's index of their shops, in AuthObject, only finds them. To act
for a shop, a person asks for a **shop session** for it with their signed-in session, and uses that shop session on the
approval routes ("Approvals for a session", "Deciding from a session"). No route takes a shop or a role from a request
where the session decides it.

### A person's own routes

Each needs the lifted signed-in session (`Authorization: Bearer <access token>` from `POST /v1/auth/exchange`): no
session, a shop session and the operator key all answer 401 `unauthorized`. A wrong method answers 405
`method_not_allowed`, after the session is checked, and 503 `shops_unavailable` means a shop's records or the person's
index could not be read.

**`GET /v1/shops`**: the shops the person is in, with their role at each: the ones they own first, then the ones they
help at, each by name. Every shop is read again from its own record, so a shop whose owner account was unlinked, where
the person's helper was removed, or that was deleted, is not listed. A shop that cannot be read fails the whole answer
with 503, never a shorter list.

```ts
type Shops = { shops: { id: string; name: string; ownerName: string; role: "owner" | "helper" }[] };
```

**`POST /v1/shops/session`** with exactly `{ shop }`: a shop session for one shop. The shop's record decides the role:
the owner's session while the person's account is the one linked to the shop, else a helper's while a current helper has
the identity they signed in with.

| Status | Body | When |
| --- | --- | --- |
| 200 | `{ shop: { id, name, ownerName }, role: "owner", account: { id }, session: ShopSession }` | The person's account is the shop's linked owner account; `account.id` is what their decisions name |
| 200 | `{ shop, role: "helper", helper: { id, name }, session: ShopSession }` | The person is a current helper: the same helper session `POST /v1/people/session` gives |
| 404 | `{ error: "not_found" }` | The person is in the shop neither way, or there is no such pilot shop: one answer for both, so nobody learns which shops exist |
| 400 | `{ error: "invalid_request" }` | The body is not exactly `{ shop }` with a shop id; a `role` above all |

```ts
type ShopSession = {
  accessToken: string;   // "mos1.<shop, base64url>.<64 hex>" for an owner, "mhs1.<…>" for a helper: send as `Authorization: Bearer <accessToken>`
  expiresAt: string;     // 30 days on; open the shop again with the signed-in session after that
};
```

An owner session is accepted by `GET /v1/approvals` and `POST /v1/approvals/{requestId}/decision`, and by the team's
routines (`/v1/routines`, `/v1/team/*`, "Routines", above), for its own shop only, as the owner: those routes take who is
calling from one place (`callerOf`), and the routines' own rule is that they are the owner's. Decisions and routine
changes name the linked account's id. `POST /v1/approvals/{requestId}/pass-on` answers it 403 `not_a_helper`, as it
answers the shop's own session. Every other session route answers it 401, so it never acts as the shop: not the tasks,
consent, export, deletion, connections or schedules. The shop keeps only its SHA-256. Unlinking the owner's account ends every owner session of that shop at once, and from then
on each answers 401 `unlinked` with `unlinkedAt`. Opening one writes `owner.session_opened` to the shop's audit log,
naming the account by its id; the app ends its own with `POST /v1/shops/session/end` ("Ending a shop session", below),
which writes `owner.session_ended`.

**`POST /v1/shops/owner-code`** with no body, or `{}`: a code the owner sends their operator so the operator can link this
account to their shop ("Operator routes", below). 200 `{ code, expiresAt }`: `code` is eight characters of Crockford's
base 32, shown as `XXXX-XXXX`. It names only the account that asked for it, works once, for 15 minutes, and asking again
replaces it. Only its SHA-256 is kept. A body with any field, an account above all, answers 400 `invalid_request`.

### Ending a shop session

**`POST /v1/shops/session/end`** with exactly `{}` and the shop session itself as the bearer (`mos1.` for an owner,
`mhs1.` for a helper): the app ends its own session of one shop when the person signs out of that device. It ends exactly
that session, in one write to the shop's people record with its audit entry. The person's other devices at the shop, their
other shops and their own sign-in are untouched, and they can open the shop again with the sign-in. The same token answers
401 `unauthorized` on every route from then on, as any session the shop's record no longer holds does. The shop keeps no
mark of it: nothing removed the helper or unlinked the account, so the token reads as unknown, never as `removed` or
`unlinked`.

| Status | Body | When |
| --- | --- | --- |
| 200 | `{ ended: { shop, role } }` | The session worked and is ended; `role` is `"owner"` or `"helper"` |
| 401 | `{ error: "unauthorized" }` | No credential, the operator key, a token no shop holds, a session already ended by signing out, or one past its 30 days. Two devices sending one token at once: one gets 200, the other this |
| 401 | `{ error: "removed", removedAt }` or `{ error: "unlinked", unlinkedAt }` | A session that removal or unlinking ended, answered as every shop-session route answers it. Nothing is written |
| 403 | `{ error: "not_a_shop_session" }` | The credential is a person's sign-in or the shop's own pilot session (the lifted auth's). Nothing is ended. It is 403 and not 401 so an app that sent the wrong one does not read its sign-in as ended |
| 405 | `{ error: "method_not_allowed" }` | Anything but `POST` |
| 400 | `{ error: "invalid_request" }` | A body that is not exactly `{}`: any field (a shop, a role or an account above all), an array, or a value that is not an object |
| 400 | `{ error: "invalid_json" }` | A body that is not JSON, or none |
| 503 | `{ error: "people_unavailable" }` | The shop's record could not be read or written. Nothing is known to have ended: the session still works |

- **Order.** Who is asking comes first, as on every session route, so a caller with no session learns nothing about the route,
  not even its method: the session (401), then its kind (403), then the method (405), then the body (400). The session is
  checked with the same check every shop-session route makes (`callerOf`), so a token ends here exactly while it still
  works there. The shop's record checks it again where it ends it, so a second device sending the same token is never
  recorded twice.
- **What is ended.** An owner session leaves `ownerSessions` and a helper session leaves `sessions`, and its id leaves the
  helper's open sessions in the rules' state (`endSession` in `@manut/people-rules`), so a later removal reports and ends
  only the sessions still open. The helper stays a helper, with their cover and their notes, and the owner's account stays
  linked. `GET /v1/admin/people` counts one device fewer (`devices`).
- **The log.** `owner.session_ended` (the actor is the account, by its id; the subject is `ownerAccountId`) or
  `helper.session_ended` (the actor is the helper, by their id; the subject is `helperId`), outcome `ok`. Ids only: never the
  token, the account's subject, an email or a name. Nothing is written for a refusal.
- **What the app does.** On sign-out it calls this once for each shop session it holds, then drops them and their cached
  data. A call that cannot be made leaves that session running to its 30 days (there is no refresh), or until the account is
  unlinked or the helper removed; the person's sign-in is ended by the lifted auth's own `DELETE /v1/auth/session`, which
  this route does not call.

### Operator routes

Under the admin gate, as exact `ADMIN_METHODS` entries. Each names an existing pilot shop (else 404 `shop_not_found`;
400 `tenant_required` without a tenant), checked before a code is used, and each change is written to the shop's audit
log under the operator's Access identity, naming the link by its id, never the account itself or the code.

| Method and path | Body | Answer |
| --- | --- | --- |
| `POST /v1/admin/shops/owner` | `{ tenant, code }` | `{ tenant, ownerAccount: { id, linkedAt } }`; the log gets `owner.linked` |
| `POST /v1/admin/shops/owner/unlink` | `{ tenant }` | `{ tenant, unlinked, sessionsEnded }`; the log gets `owner.unlinked` |

- **Linking.** The operator first checks that the code came from the shop's owner, through the channel they already use
  for the shop. `code` may be typed in any case, with or without the dash or spaces, and O, I and L are read as 0, 1 and
  1. The code is used up first, whatever follows: 404 `unknown_code` for a code never made, already used or replaced,
  and for text that cannot be a code; 410 `code_expired` past its 15 minutes. Then the shop's record links the account:
  409 `already_linked` while another account is linked (unlink it first). Linking the account already linked changes
  nothing, writes no entry, answers the same link, and writes the account's index row again. 503 `index_unavailable`
  means the link was made but the account's index could not be written: the shop is not on the owner's list yet, and
  linking the same account again with a new code puts it there. 400 `invalid_request` for a body that is not exactly
  `{ tenant, code }` with a string `code`.
- **Unlinking** ends every owner session of the shop in the same write, takes the shop off the account's list, and
  answers how many sessions it ended. 404 `not_linked` when no account is linked; 400 `invalid_request` for a body that
  is not exactly `{ tenant }`.
- **People.** `GET /v1/admin/people` shows the link as `owner.account`, or `null`:

```ts
type OwnerAccountView = { id: string; linkedAt: string; devices: number };   // devices: owner sessions open now
```

- **Export and deletion.** The shop's export carries the link in `people.ownerAccount`: `{ id, subject, linkedAt }` or
  `null`, where `subject` is the account's verified Apple subject; never a session's hash. Deleting the shop wipes the
  link and every owner session with the rest of its people, and takes the shop out of every person's index. A person who
  deletes their own data keeps their links, which are their shops' records, and loses a code they had not used yet.
