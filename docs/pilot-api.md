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
  signs in with to the shop, and that account then decides with an owner session, and with it manages what the team
  knows, the shop's consent and export, and its helpers ("Several shops", below).
- **Helper**: someone the owner trusts with conversations (the canvas's Mint). Invited by the operator on the owner's
  word, signs in with Apple (or with a code sent by email, once the owner turns that on: "Signing in by email", below),
  and approves private messages and replies with a helper session, never money, public posts, payment confirmations or
  commands ("Helpers", below; `docs/people.md`).
- **Shop**: one tenant in the backend. `tenant` is its id. A shop is **live** once its owner has answered about consent
  (`cloudWork`), giving it or withdrawing it from their session later, or a LINE connection exists.

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
- A sign-in code sent by email, once the owner turns that on, is kept only as an HMAC-SHA256 with the same secret under
  a domain tag of its own (`manut-ai/email-code/v1.`), never as the code, so no code's MAC can pass as a link's
  ("Signing in by email", below).
- Deleting a live shop's data needs its owner's yes through the deletion link (owner's decision, 23 Nov 2026). The
  confirmation runs through `packages/approval-core`: an owner-only kind (`command`), opened and decided by its
  transitions in one AuthObject storage transaction each, so it settles once however many answers arrive, and
  the decision is stored before any data is wiped. A shop that never went live is deleted by the operator alone.
- Approving an external write still needs the shop's consent (`cloudWork`), recorded from the owner through
  the link (`/consent` below) or their own shop session ("Several shops", below), never by an operator.
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
| `POST /v1/admin/pilot/shops` | `{ name, ownerName, template? }` | `{ tenant, name, ownerName, template? }`. 400 `{ "error": "unknown_template" }`, making no shop, for a template that is not one ("Shop templates", below). 503 `{ "error": "shop_unavailable" }` when the shop could not be made whole and listed: nothing is listed, and the same request, with the same names and template, finishes that very shop instead of making another ("A make that stops part way", below) |
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
| `POST /v1/admin/pilot/gate/cohort` | `{ tenant, counted }` | `{ tenant, counted }`: a shop its owner made counted in the gate's cohort, or left out again (below). 409 `{ "error": "not_self_serve" }` for a shop an operator made, which is always counted; 400 `invalid_request` for a body that is not exactly that with a boolean `counted` |
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
says so and leaves the rest. Each row links to the shop's Messages, Drafts, Audit, Memory and Model spend pages. A shop its
owner made in the app (`selfServe`, "Making a shop of your own", below) is marked "Made by its owner" under its name, so an
operator sees where it came from; the Pilot gate page marks it the same way and says whether it is counted.

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
  selfServe?: true;             // made by its owner in the app, with no operator ("Making a shop of your own", below)
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
  // Only for a shop that had a Google connection: how many were ended at Google before the vault forgot their tokens, and
  // how many could not be. The shop's data is deleted either way; the second is for the owner to end in their Google
  // account ("Google Sheets for Ton's books", below). The deletion's record keeps both with the other counts.
  googleRevoked?: number;
  googleNotRevoked?: number;
  deletedAt: string;
};
```

## Rules settled while building (23 Nov 2026)

- **One open reply per message.** Proposing a second reply while one is still waiting answers 409
  `{ "error": "reply_pending" }`. After a reply is declined, expires or fails, the operator may propose again.
- **Connecting LINE again** revokes the shop's previous connection; its webhook URL stops receiving.
- **Consent cannot be withdrawn through the link.** `/consent` accepts only `{ "cloudWork": true }`. The owner
  withdraws it from their own shop session (`PUT /v1/consent/cloud`, "Several shops", below), and the shop stays live,
  so deleting it still needs the owner's yes.
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
    whose record or deletion cannot be read fails the list with 503 `shops_unavailable` rather than drop off it,
    and a deletion request for it answers 503 `shop_unavailable`, deleting nothing, rather than take it for one
    whose record is gone (which would skip asking the owner of a shop that went live since its deletion stopped).
  - The console shows such a shop as the list does: "Deleting" under its name in the side menu, "Deletion not
    finished" in its header, and in its Shop data tab what stopped with "Finish deleting", which sends the same
    request. A shop whose own record is gone cannot be opened, so no page lists it; the note above the shop's page
    says its deletion did not finish and offers the same button. The practice fake lists and finishes a deletion
    that did not finish by the same rules, though a practice wipe never stops part way.
  - **Google.** A shop's Google connection is revoked at Google before its vault forgets the token, as `POST
    /v1/google/disconnect` does it, in every deletion: the operator's of a shop that never went live, the owner's yes on
    their link, and a person's own tenant. Google not answering, or the secret not opening, or Google not being set up on
    this Worker, never stops the deletion: the answer counts the connection as `googleNotRevoked`. The vault is listed
    first, and a vault that cannot be listed is not wiped (`connections` in `failed`), so no token is forgotten that was
    not looked at. A run that stops after the vault was wiped carries the same counts on its `wipe_incomplete`, since the
    run that finishes it has no connection left to revoke. No token is in any answer, record or log.
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
- **Self-serve shops.** A shop its owner made in the app ("Making a shop of your own", below) is listed with `selfServe:
  true` and `inCohort: false`, and left out of the cohort's counts, however it does, unless an operator adds it with
  `POST /v1/admin/pilot/gate/cohort` and `{ tenant, counted: true }`, which they can take back with `counted: false`. The
  pilot's cohort is the shops chosen for it and spoken with; a stranger who signs up on their own is another measure, which
  the owner has not set, so an operator adds one only after speaking with its owner as the pilot's owners were. Each change
  is one write to the shop's record (`addedToCohortAt`) with `cohort.added` or `cohort.removed` in its log, and asking for
  what already holds writes nothing. Every shop an operator made is `inCohort: true`. The console's Pilot gate page offers
  "Count it" and "Leave it out" on a self-serve shop's row.

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
  selfServe?: true;               // made by its owner in the app, with no operator
  inCohort: boolean;              // counted once day 14 has passed: false for a self-serve shop an operator has not added
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
| `shop.created` | operator; for a shop its owner made, the owner's linked account by its id | none | `ok` |
| `cohort.added`, `cohort.removed` | operator | none | `ok` |
| `shop.made_by_owner` | the owner's linked account, by its id, in the write that makes the shop, beside `owner.linked` and `owner.session_opened` by the same account ("Making a shop of your own") | `ownerAccountId` | `ok` |
| `line.connected` | operator | `connectionId`, and `previousConnectionId` when it replaced one | `ok` |
| `reply.proposed` | operator | `taskId`, `actionId`, `messageId` | `ok` |
| `payment.recorded`, `subscription_payment.recorded` | operator | `paymentId`, with `amountSatang` | `ok` |
| `model.cap_set`, `model.cap_cleared` | operator | none; a cap set carries `amountSatang` | `ok` |
| `deletion.requested` | operator | `confirmationId` for a live shop | `awaiting_owner` for a live shop; `ok` for one deleted at once, which the deletion then wipes with the rest |
| `consent.given`, `consent.withdrawn` | owner: through a link or the lifted session (no id), or an owner session (the linked account's id) | none | `ok` |
| `reply.decided` | owner | `taskId`, `actionId` | `approved` or `declined` |
| `deletion.decided` | owner | `confirmationId` | `approved` or `declined` |
| `dispatch.started` | system | `taskId`, `actionId` | `ok`; a browser write's when its step is handed out |
| `dispatch.settled` | system | `taskId`, `actionId` | `confirmed`, `failed` or `unknown`; a browser write's from its step's report, or `failed` when it was begun but could not be handed out |
| `attempt.started` | system | `taskId`, `attemptId` | `ok` |
| `attempt.ended` | the worker (its own finish), the system (`budget`, `silent`, `deadline`), or whoever cancelled it | `taskId`, `attemptId` | `done`, `failed` with a `reason`, or `cancelled` |
| `approval.requested` | worker | `taskId`, `attemptId`, `requestId`, `actionId`; a browser write's `signInId`, and no `requestId` or `actionId` when none was opened | `ok`; for a browser write or an append of Ton's books also `refused` with why (`not_my_job`, `not_connected`, `unknown_member`, `invalid_write`, `member_not_allowed`, `month_not_over`, `google_broken` and so on), or `skipped` with `draft_only` in practice mode |
| `approval.decided` | owner or helper, with the id they decided as (`owner-session` for the shop's own session, the linked account's id for an owner session, the helper's id for a helper session) | the same | `approved`, `declined`, or `refused` with approval-core's refusal as the `reason` (`already_decided`, `not_permitted`, `attempt_ended`, `expired` and so on) |
| `approval.superseded` | system | the same | `superseded`, reason `attempt_ended` |
| `memory.remembered`, `memory.confirmed`, `memory.corrected`, `memory.forgotten` | operator, or the owner from a session (the linked account's id; `owner-session` for the shop's own session) | `factId` | `ok` |
| `memory.proposed` | a worker (by its attempt) or the system, as the caller of `proposeFact` says | `factId` | `ok`, or `awaiting_owner` for a customer's words, which wait for the owner |
| `invite.created`, `invite.revoked` | operator, or the owner from a session (as for memory) | `inviteId` | `ok` |
| `helper.joined` | helper | `inviteId`, `helperId` | `ok` |
| `helper.session_opened` | helper | `helperId` | `ok` |
| `helper.session_ended` | helper, ending their own shop session (`POST /v1/shops/session/end`) | `helperId` | `ok` |
| `owner.session_ended` | the owner's linked account, by its id, ending its own shop session | `ownerAccountId` | `ok` |
| `helper.removed` | operator, or the owner from a session | `helperId` | `ok` |
| `away.set`, `away.cleared` | operator, or the owner from a session | `helperId` (who covers, or covered) | `ok` |
| `request.passed_on` | helper | `requestId`, `taskId` | `ok` |
| `signin.created`, `signin.password_replaced` | operator, or the owner from a session (the linked account's id; `owner-session` for the shop's own session) | `signInId` | `ok` |
| `signin.removed` | operator | `signInId` | `ok` |
| `signin.members_changed` | the owner from a session (as above), choosing who may use the sign-in | `signInId` | `ok` |
| `outpost.registered` | operator, or the owner from a session registering this Mac | `outpostId` | `ok` |
| `outpost.renamed` | the owner from a session | `outpostId` | `ok` |
| `signin.requested` | worker | `signInId`, `outpostId`, `taskId`, `attemptId`, and `grantId` when a grant was issued | `ok`, or `refused` with the vault's refusal as the `reason` |
| `signin.broken` | worker | `signInId`, `taskId`, `attemptId` | `ok`, or `refused` (`member_not_allowed`, `sign_in_not_found`) |
| `signin.redeemed` | outpost | `outpostId`; for a grant the vault found, also `signInId`, `taskId`, `attemptId`, `grantId` | `ok`, or `refused` with the refusal as the `reason` |
| `outpost.removed` | operator, or the owner from a session | `outpostId` | `ok` |
| `outpost.credential_rotated` | operator | `outpostId` | `ok` |
| `browser_step.queued` | worker | `outpostId`, `taskId`, `attemptId`, and `stepId` when it was queued; a sign-in step's `signInId` and `grantId`; a write step's `signInId`, `requestId` and `actionId` | `ok`, or `refused` with the refusal as the `reason` |
| `browser_step.fetched` | outpost | `stepId`, `outpostId`, `taskId`, `attemptId`; a sign-in step's `signInId` and `grantId`; a write step's `signInId`, `requestId` and `actionId` | `ok` when it was handed out, or `refused` with why (`attempt_ended`, `consent_required`, `origin_not_allowed` and so on); an empty fetch writes nothing |
| `browser_step.reported` | outpost | `outpostId`; for a step the vault found, also `stepId`, `taskId`, `attemptId`, and a sign-in step's `signInId` and `grantId` | `done`, `failed` with the outpost's code (or `text_withheld`) as the `reason`, or `refused` with the refusal |
| `google.connected` | owner, by the linked account's id (`owner-session` for the shop's own session) that started the sign-in | `connectionId`, and `previousConnectionId` when it replaced one; none when the owner said no | `ok`, or `declined` with `access_denied` |
| `google.disconnected` | owner, as above | `connectionId` | `ok`, with `not_revoked` when Google could not be reached to revoke the token |
| `google.broken` | system | `connectionId` | `refused`, reason `invalid_grant`; once, for the call that broke it |
| `google.sheet_created` | system | `connectionId` | `ok` |
| `google.appended` | system | `taskId`, `actionId`, `connectionId` | `confirmed`, or `failed` or `unknown` with a code (`google_404`, `google_503`, `no_answer`, `google_broken` and so on) |

The job flow's entries (`attempt.*`, `approval.*`) come from the worker adapter contract (`docs/phase-0-spikes.md`,
section 3); a pilot shop has none until a worker runs for it. A reply decided through the owner's link keeps its
`reply.*` entries and writes no `approval.*` one; a reply decided from a session ("Deciding from a session", below)
writes `approval.decided`, naming the shop's own session, the owner's linked account or the helper. The people entries
name invites, helpers and requests by id only: never a name, a note, or an identity's value. A change the owner makes
from their session names the linked account by its id, never its subject, an email or a name. The several-shops entries
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
  next page. It says who acted: an operator by their Access email, the owner by name (with "the shop's own session"
  for `owner-session` and "linked account" and its id for an account's id, and by name alone for a signed link), a
  helper by the name the owner gave them, an outpost or a worker by the start of its id. It tells a browser write's
  entries from any other's by the ids they carry (an ask that names a sign-in; a step that names a request, or a
  grant for a sign-in's) and says what a write's failed report means for the form: not submitted, not known, or
  settled all the same. The People page reads the newest 200 entries for the changes to the people and shows the
  newest ten, each tagged as the owner's or an operator's. A test reads this file's lists (`AUDIT_ACTIONS`, the actor
  kinds, `AUDIT_OUTCOMES` and `AUDIT_SUBJECT_KEYS`) and fails when the console lacks words for one. The practice-mode
  fake keeps the same log for its sample shops, by the same rules, and Baan Mali's sample log holds an entry for each
  kind above.

## Memory

What Buddy's team knows about each shop: facts, where each came from, and the owner's say over them. The rules are
the pure functions of `packages/shop-memory` (`@manut/shop-memory`); `apps/api/src/memory-store.ts` stores their
state, one record per shop in the shop's TenantObject (the facts, the fingerprints of the texts the owner had the team
forget, and the counter for the next id), and `apps/api/src/memory.ts` has the routes. The owner says their word from
their own shop session once the operator has linked their account ("The owner's own routes", below), and an operator
relays it through the console's Memory page whenever the owner asks, linked or not: the owner's own fact, "It's true"
on a waiting fact, Correct and Forget. A worker never does these: it proposes what it learned (below).

The operator's five routes are under the admin gate, each an exact `ADMIN_METHODS` entry (the shop travels in the query
or the body). A shop is any valid tenant, as in the audit and model routes; a shop that was deleted is not looked up
first.

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

**The owner's own routes** are the same reads and changes from a shop session, for the session's own shop
(`docs/several-shops.md`, slice 4), with no `tenant`:

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /v1/memory` | none | `Memory` |
| `POST /v1/memory/remember` | `{ text }` | `Fact` |
| `POST /v1/memory/confirm` | `{ id }` | `Fact` |
| `POST /v1/memory/correct` | `{ id, text }` | `Fact` |
| `POST /v1/memory/forget` | `{ id }` | `{ id }` |

- **Who.** An owner session of the account linked to the shop is its owner, and so is the shop's own session (the lifted
  auth's, whose tenant is the shop); a person's own sign-in reads and changes their own tenant's memory only. A helper's
  session answers 403 `owner_only` on all five: what the team knows can hold the owner's costs and suppliers, and a
  helper's work is the conversations.
- **Exact.** A body is exactly the fields above: any other field, a `tenant`, a `shop` or a `role` above all, answers 400
  `invalid_request`, and so does a query that names `shop`, `tenant` or `role`. Each path takes one method (405
  `method_not_allowed` for another). No route leads to a proposal: `/v1/memory/propose`, and any other path under
  `/v1/memory/`, answers 404 `not_found`.
- **Answers.** The same facts and the same refusals as the operator's routes (the table above). No session, or the
  operator key, answers 401 `unauthorized`; an unlinked owner's session 401 `unlinked`, a removed helper's 401
  `removed`; and 503 `people_unavailable` when the session cannot be checked.

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
  ("Audit log", above). The operator routes record the operator's Access identity (none for a service token); the
  owner's routes record the linked account by its id, or `owner-session` for the shop's own session. A refusal changes
  nothing and writes nothing, and neither does a confirm of a fact already confirmed.
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
the job's own task for the owner to read. No worker sends, posts, pays or refunds by itself. The one job that asks for
an external write is Ton's append of a month's books to the owner's Google Sheet ("Google Sheets for Ton's books",
below): it asks through approval-core with the exact rows, and only the owner's decision sends them.

### `POST /v1/admin/workers/run`

Under the admin gate, as an exact `ADMIN_METHODS` entry. The body is `{ tenant, member, job }`:

- `member`: `nam`, `pim` or `ton`.
- `job`, one of:
  - `{ kind: "reply", messageId }`: a reply to a customer's message the shop holds (`GET /v1/admin/pilot/messages`).
  - `{ kind: "post", topic }`: a post about the topic, 1 to 500 characters once trimmed.
  - `{ kind: "daily_summary" }`: yesterday's sales in Bangkok, from the order payments the shop has recorded
    (`POST /v1/admin/pilot/payments`), each counted as a LINE sale at the time it was confirmed.
  - `{ kind: "books_sheet", month }`: a month (`YYYY-MM`) of the shop's books appended to the owner's Google Sheet, asked
    first ("Google Sheets for Ton's books", below). The owner starts the same job from their session
    (`POST /v1/google/books`).

A reply is Nam's job, a post Pim's, and a summary and an append Ton's. A job asked of another member is passed to the member whose job
it is, and the answer says who did it.

While the shop's team is paused (Pause everyone), nothing new starts: 409 `team_paused`. A member the shop's template
did not turn on takes no job: 409 `member_off`. These are the same rules, with the same reasons, as a routine's run
that will not start, so "Starts nothing new" holds whoever starts the job. A team that cannot be read answers 503
`unavailable`, and nothing starts.

```ts
type WorkerRun = {
  taskId: string;                      // the job's own task: in the shop's export, gone with the shop's deletion
  member: "nam" | "pim" | "ton";       // who did the job
  passedFrom?: "nam" | "pim" | "ton";  // who passed it on, when it was not theirs
  outcome: "done" | "failed" | "asked";
  reason?: string;                     // why it failed, as a code (below)
  draft?: Draft;                       // when done
  requestId?: string;                  // when asked: the approval-core request the owner decides
  kind?: string;                       // when asked: the request's kind ("command" for an append)
};

type Draft = {
  attemptId: string;                   // the attempt that wrote it: one draft per attempt
  member: string;                      // "nam", "pim" or "ton"
  job: string;                         // "reply", "post", "daily_summary" or "books_sheet"
  text: string;                        // the words, for the owner to read
  about?: { messageId?: string; date?: string; month?: string };  // the message a reply answers; the day a summary
                                       // or the month an append covers
  send?: { answer: "draft_only" | "ask"; kind: "reply" | "command" };  // what sending would take (below)
  at: string;
};
```

A refusal answers `{ "error": code }`. The 400s, 403s and 404s come before anything is created; a 503 can leave the
job's task behind with no attempt on it, which holds nothing.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `tenant_required` | No valid tenant |
| 400 | `unknown_member` | `member` is not `nam`, `pim` or `ton` |
| 400 | `invalid_job` | `job` is missing, of another kind, has a field its kind does not, its topic or message id is blank or too long, or its month is not `YYYY-MM` |
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
`vault_unavailable`, `empty_draft`, an append's own codes ("Google Sheets for Ton's books", below), or a code of the job
flow's own.

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
- A **browser step** is one thing a worker asks an outpost's browser to do in its attempt: open a page, read it, sign
  in with a grant, or submit a write the owner approved. A worker queues it through the port; the outpost asks for its
  steps and reports how each went, and the outcome lands in the attempt's events. A write step (`submit`) can be queued
  only for an approved approval-core request naming the exact write ("Submitting through a browser", below).

The operator's routes are under the admin gate, each an exact `ADMIN_METHODS` entry, with the tenant and ids in the
query or the body. The outposts' routes are public paths that need the outpost's credential as
`Authorization: Bearer <credential>`, and nothing else opens them: not the operator's key, not an owner's session.
They share one ingress limit per source address (`OUTPOST_LIMITER`, 300 a minute), checked before the credential or
the body is read: over it they answer 429 `{ "error": "rate_limited" }` with `Retry-After: 60`, and without a working
limiter, or a source address, 503 `{ "error": "rate_limit_unavailable" }`. One route under `/v1/outposts/` is the
owner's instead: the desktop registering this Mac (`POST /v1/outposts/register`), which takes the owner's session and
no outpost's credential. The owner's Connections take the owner's session too, under `/v1/vault/` ("The owner's vault
and outposts", below): the shop's sign-ins and outposts, adding a sign-in, a new password, who may use a sign-in, and
renaming or removing an outpost.

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
  kind: "open" | "read" | "sign_in" | "submit";
  outpostId: string;
  // queued until its outpost takes it, taken while it runs (and until its report has landed in the attempt's events),
  // then how it ended; expired when it did not end within its time
  state: "queued" | "taken" | "done" | "failed" | "refused" | "expired";
  queuedAt: string;
  expiresAt: string;             // two minutes after it was queued, or its grant's end if sooner
  url?: string;                  // open: the page; submit: the approved write's page
  selector?: string;             // read: the part of the page; absent reads the whole page
  signInId?: string;             // sign_in: the grant's sign-in; submit: the write's sign-in
  requestId?: string;            // submit: the approved request it carries
  code?: string;                 // failed or refused: why
  text?: string;                 // a read that is done: what it read
};

// A browser step as its outpost is handed it.
type OutpostStep = {
  stepId: string;
  kind: "open" | "read" | "sign_in" | "submit";
  url?: string;                  // open; submit: the page the write is made on
  selector?: string;             // read, when it reads part of the page
  grantId?: string;              // sign_in: redeem it, then type into the page that is open
  action?: SubmitAction;         // submit: what the write is ("Submitting through a browser", below)
  form?: string;                 // submit: the form it submits, or the control (a button) it presses, as a selector
  values?: { field: string; value: string }[];  // submit: each field (a selector) and exactly what goes in it, in order
  origins: string[];             // the origins its browser may be on for this step; anywhere else stops it; submit: the
                                 // page's origin alone
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

### `POST /v1/admin/vault/reseal`

Exactly `{ tenant }`. Seals the shop's connection secrets and its site sign-ins' passwords again under the vault's
current key, and answers `{ connections, signIns }`, each `{ resealed, current, unreadable, remaining }`: how many it
sealed again, how many already were under the current key, the ids of any that neither configured key opens (a secret
nobody can recover, which its owner must give again), and how many live records still need the previous key. A record
revoked, removed or given a new secret while it was being sealed is left as it now is. 503 `vault_not_configured`
when the vault has no key, 503 `vault_unavailable` when it did not answer. Writes `vault.resealed`, by the operator,
with no ids (it is the shop's whole vault; the counts are in the answer).

**Re-sealing the vault after a key rotation.** A secret opens under `CRED_KEY`, or under `CRED_KEY_PREVIOUS` while
that is set, and nothing else. To rotate:

1. Set `CRED_KEY_PREVIOUS` to the current key, then `CRED_KEY` to a new one (`wrangler secret put`). Every secret
   still opens.
2. Send `POST /v1/admin/vault/reseal` for every shop, and send it again for any shop whose `remaining` is not 0.
3. Only when every shop answers `remaining` 0 in both, delete `CRED_KEY_PREVIOUS`. A secret listed in `unreadable` was
   sealed under a key neither setting holds: its owner gives it again.

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

### `POST /v1/outposts/register`

The desktop registers the Mac it runs on, with the owner's session as `Authorization: Bearer`: an owner session of the
shop's linked account (`mos1.`), or the shop's own signed-in session. `{ name, kind: "this_mac" }` answers, with
`Cache-Control: no-store`:

```ts
type RegisteredMac = { tenant: string; outpost: Outpost; credential: string };
```

`tenant` is the shop the session acts for, which the outpost's own routes then name. The credential is in this answer
and nowhere else, kept as its SHA-256 as at the operator's registration; the desktop keeps it in the login keychain and
never shows it to its page. It writes `outpost.registered` with the outpost's id, by `{ kind: "owner", id }`: the linked
account's id, or `owner-session` for the shop's own session. Unlike the outposts' own routes it is not behind their
ingress limit: it needs a session, and a shop holds 20 outposts at most.

| Status | `error` | When |
| --- | --- | --- |
| 401 | `unauthorized`, `unlinked` | No session, or not one (an operator's key and an outpost's credential are neither); an owner session whose account the operator unlinked |
| 403 | `owner_only` | A helper's session: an outpost receives the shop's passwords, so only the owner adds one |
| 400 | `invalid_request` | Not a JSON object, or one that names a `tenant`: the shop is the session's |
| 400 | `invalid_kind` | Anything but `this_mac`: a cloud outpost is the operator's to register |
| 400 | `invalid_name` | Blank once trimmed, over 80 characters, or holding a control character |
| 409 | `too_many_outposts` | The shop already has 20 |
| 503 | `people_unavailable` | The shop's record could not be read to check a shop session |

### The owner's vault and outposts

The desktop's Customize › Connections reads and changes the shop's vault with the owner's own session
(`ownerVaultRoute` in `apps/api/src/browser-control.ts`; `docs/browser-control.md`, "The owner's Connections"). Each
route takes, as `Authorization: Bearer`, an owner session of the shop's linked account (`mos1.`) or the shop's own
signed-in session, and the shop is the session's: no route reads one from a body or a query.

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /v1/vault/sign-ins` | none | `{ tenant, signIns: SignIn[] }`, as the operator's list answers it for the shop |
| `POST /v1/vault/sign-ins` | `{ site, origins, username, password, members }` | `{ signIn: SignIn }`, added to the shop's vault as the operator's route adds it, with the password sealed |
| `POST /v1/vault/sign-ins/password` | `{ signInId, password }` | `{ signIn: SignIn }`, with the new password sealed; a broken sign-in is `working` again |
| `POST /v1/vault/sign-ins/members` | `{ signInId, members }` | `{ signIn: SignIn }` with its new members; nothing else about it changes |
| `GET /v1/vault/outposts` | none | `{ tenant, outposts: Outpost[] }`, as the operator's list answers it for the shop |
| `POST /v1/vault/outposts/rename` | `{ outpostId, name }` | `{ outpost: Outpost }` with the name trimmed; nothing else about it changes |
| `POST /v1/vault/outposts/remove` | `{ outpostId }` | `{ removed: true, outpostId, stepsRefused, grantsRefused }`, as the operator's removal answers |

- **Who and in what order.** Who is asking comes first (401 `unauthorized` for no session, the operator's key or an
  outpost's credential; 401 `unlinked` with `unlinkedAt`, or `removed`; 503 `people_unavailable` when the session cannot
  be checked), then the role (a helper's session: 403 `owner_only`), then the method (405 `method_not_allowed`; the shop's
  sign-ins take `GET` and `POST`, every other route one method), then the query (a `shop`, `tenant` or `role` in it: 400
  `invalid_request`) and the body. So a caller with no session learns nothing about a route, not even its methods.
- **Exact.** A body is exactly the keys above. An id, a new password and a name are strings. Anything more, a `tenant`,
  a `shop` or a `role` above all, a key missing, or an id, password or name of another type answers 400
  `invalid_request`; a body that is not JSON, 400 `invalid_json`; over 16 KB, 413 `body_too_large`. Every other value
  (a new sign-in's `site`, `origins`, `username`, `password` and `members`, and the `members` chosen) is the vault's to
  check, as it is on the operator's route, so a value of the wrong kind gets that field's refusal.
- **Through the vault's own operations.** A new sign-in goes through the vault's `/sign-ins`, the operator's, so it is
  checked, sealed under `CRED_KEY` and kept exactly as the operator's is, with the operator's refusals
  (`POST /v1/admin/vault/sign-ins` above: 400 `invalid_site`, `invalid_origins`, `invalid_username`, `invalid_password`,
  `invalid_members`; 409 `too_many_sign_ins`; 503 `vault_not_configured`). A new password goes through the vault's
  `/sign-ins/password`, the operator's, and is sealed the same way. Who may use a sign-in goes through the vault's
  `/sign-ins/members`, whose members are checked as at creation (400 `invalid_members`: none, a repeat, or one who is not
  Nam, Pim, Ton or Kit) and which changes nothing else: not its password, whether it works, or when it was last used. A
  member taken off loses it at once: a grant not yet redeemed for them, and any new one, is refused `member_not_allowed`,
  and no step of theirs goes to its origins. A removal is the operator's removal, so the outpost's credential stops
  working at once and its waiting steps and grants are refused in the same step; a rename is the vault's
  `/outposts/rename`, with the name rule registration uses. The vault's own refusals pass through: those above, 400
  `invalid_password` (not text of 1 to 1,024 characters), 400 `invalid_name` (blank once trimmed, over 80 characters, or
  holding a control character), 404 `sign_in_not_found` (also another shop's or a removed one), 404 `outpost_not_found`
  (also another shop's, or one already removed), 503 `vault_not_configured` and `vault_unavailable`.
- **The password** goes from the body straight into the vault, a new sign-in's as a new password. It is never kept,
  logged or answered: the answer is the sign-in's public view, which says only when its password was set.
- **The log.** `signin.created`, `signin.password_replaced`, `signin.members_changed`, `outpost.renamed` and
  `outpost.removed`, by `{ kind: "owner", id }` (the linked account's id, or `owner-session` for the shop's own session),
  with the record's id only: never a password, an account's name, who may use a sign-in, or the name typed. A refusal
  writes nothing, as the operator's do not.
- Like the registration, none of these is behind an ingress limit, the two added on 24 November included: each needs a
  session first, and the vault bounds what a shop keeps (50 sign-ins, 20 outposts). The owner registers no cloud outpost
  and removes no sign-in here; an operator does.

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

A write step (`submit`) is checked further before it leaves. It needs `officeExternalWrites` too: while that switch is
off it is refused for good (`feature_disabled`), and the outpost's read steps are still handed out. Its `origins` are
its page's origin alone, while that is still an origin of the write's sign-in, working and naming the step's member
(otherwise `sign_in_not_found`, `member_not_allowed`, `sign_in_broken` or `origin_not_allowed`). Once the vault has
taken it, the task object's one-use begin gate, the one the broker uses, moves the approved write to dispatching, in one
step with checking that its request is still approved at the revision the step names (`not_approved`,
`request_changed`), that the write is neither begun nor past its time (`dispatch_in_flight`, `already_settled`,
`action_expired`), and that the step's attempt still runs and holds the task (`attempt_ended`). A step the gate refuses
is refused for good and never handed out; the write it carried stays approved, and a new step can carry it. Only a begun
write's step is handed out, and its `action`, `url`, `form` and `values` are the approved copy's that the gate hands
back, so the outpost gets exactly what the owner approved and nothing else.

### `POST /v1/outposts/steps/report`

With the outpost's credential, `{ tenant, outpostId, stepId, outcome, code?, text? }` reports how a step it was handed
went, once, and answers `{ step: { stepId, state: "done" | "failed" } }`.

- `outcome: "done"`: for a `read`, `text` is what it read, at most 4 KB once written as JSON in UTF-8 (`""` for a page
  with no text); the other kinds carry no text.
- `outcome: "failed"` with `code`, one of `origin_not_allowed` (a page was, or went, off the step's origins, and the
  outpost stopped there), `page_unavailable`, `selector_not_found`, `sign_in_refused` (the site refused the saved
  password), `grant_refused` (the redeem was refused), `submit_refused` (a write step's site refused what was submitted
  and kept the form), `not_run` (the outpost did not do what the step asks: a kind it does not know, a step missing what
  its kind needs, or a stop before the step began or, for a write, before anything was typed), `timed_out`,
  `browser_error`; and no text.

This Mac's outpost runs a write step as `docs/browser-control.md` says ("The outpost running write steps"): it types
nothing until the form and every field are found, presses once, and reports `done` or `submit_refused` from what the
page shows, or `not_run` for a step it did nothing for.

A write step's report also settles its write, first, once the vault holds the report: `done` is `confirmed` (the step's
id is its `providerOperationId`), a failure the outpost reports only before it submits (`page_unavailable`,
`selector_not_found`, `sign_in_refused`, `grant_refused`, `submit_refused`, `not_run`) is `failed`, and any other is
`unknown`, since the site may have taken it. The write stands as the outpost said even when its outcome can no longer land in the
attempt (the step then reads refused, as below). A write step brings back no text.

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

No route: a worker holds only the job flow's port (`apps/api/src/job-flow.ts`), and these are its browser methods.

- `signIn(signInId, outpostId)` answers `{ grantId, signInId, site, outpostId, expiresAt }`. The control plane reads
  the switches (`officeCloud`) and the owner's consent, then the attempt's own heartbeat, which also gives the member
  the attempt was started for, from the task object's record. The vault then issues the grant if the member is named
  on the sign-in, it is working, and the outpost is online. Refusals: the port's own (`feature_disabled`,
  `consent_required`, and the attempt's, with `ended`), `sign_in_not_found`, `member_not_allowed`, `sign_in_broken`,
  `outpost_not_found`, `outpost_asleep`, `vault_unavailable`. The model asks for a sign-in by its site's name only; it
  never sees a username, a password or a grant.
- `signIns()` answers `{ signIns: [{ signInId, site, origins, state }] }`: the shop's live sign-ins this attempt's
  member is named on, oldest first, `state` `working` or `broken`, after the same switches, consent and heartbeat as
  `signIn`. It is how a worker finds a sign-in by its site's name before asking for a grant. Never the account, the
  password or who else may use it, and nothing is written to the audit log: a list changes nothing.
- `signInBroken(signInId)` answers `{ signInId, state: "broken" }`: the site refused the saved password, and no grant
  is issued for the sign-in until a new password is typed. Only a member named on it can report it
  (`member_not_allowed`). A second report keeps the first's time and member.
- `browserStep(step)` answers a `BrowserStep`, `queued`. The step is `{ kind: "open", outpostId, url }`,
  `{ kind: "read", outpostId, selector? }`, `{ kind: "sign_in", outpostId, grantId }`, or a write,
  `{ kind: "submit", outpostId, requestId, revision }` ("Submitting through a browser", below). The port reads the
  switches, consent and the attempt's own heartbeat as for `signIn`, and the member is the task object's record of the
  attempt. Refusals: the port's own; `step_kind_not_allowed` (any other kind);
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
- `askSubmit(write)` asks to submit a write through a browser, and `browserStep({ kind: "submit", ... })` queues it once
  it is approved: "Submitting through a browser", below.

**Rules**

- **No password anywhere else.** No answer, task event, browser step, log line, audit entry or export holds a
  password, except the redeem's answer to the outpost its grant names. A read whose text holds one is withheld. The
  tests search every answer, the vault's records and the export for it.
- **Reading by default.** Browser steps open, read and sign in from what a worker asks. A step that would submit
  anything other than a read (an order, a reply, a refund, a post, a setting) goes through member-grants' `decide` and
  an approval-core request naming the exact write first, as every write does, and the outpost submits it once, through
  the broker's one-use begin gate ("Submitting through a browser", below; `docs/browser-control.md`).
- **Audit.** `signin.*`, `outpost.*` and `browser_step.*`, with ids only ("Audit log", above).
- **Export and deletion.** The tenant export carries `signIns` and `outposts` as the operator lists them. The tenant
  deletion wipes every sign-in (tombstones too), outpost, grant and browser step with the shop's vault. Grants and
  steps are not exported: they live a minute or two, the audit log keeps their history, and a step's outcome that
  landed is in its task's events, which are.

### Submitting through a browser

A step that writes (`docs/browser-control.md`, "Reading by default, and asking before submitting"). The code is
`apps/api/src/browser-writes.ts`. There is no route: a worker asks and queues through the job flow's port, the owner
decides through the approval routes ("Deciding from a session", below), and the outpost takes and reports a write step
through its step routes (above).

```ts
type SubmitAction = "send_reply" | "place_order" | "change_order" | "refund" | "publish_post" | "change_setting";

// What a worker asks to submit. Every field is required, and a field a write does not have is refused.
type SubmitWrite = {
  action: SubmitAction;
  signInId: string;              // the site: one of the shop's sign-ins
  url: string;                   // the page: https, on one of the sign-in's origins, as the URL parser writes it
  form: string;                  // the form it submits, or the control (a button) it presses, as a selector
  values: { field: string; value: string }[];  // 0 to 20: each field a distinct selector (1 to 256 characters, no
                                 // control character), each value at most 5,000 characters (tabs and line breaks
                                 // allowed), the whole write at most 12 KB as JSON
};
```

**The action decides the kind**, through a fixed table in the control plane, never through the worker's word. A write
naming a kind, or any other field, is refused (`invalid_write`), and an action off the list has no kind at all
(`unknown_action`).

| Action | Member-grants job | Approval kind | Who may approve |
| --- | --- | --- | --- |
| `send_reply`: a private answer in a conversation a customer started, such as the site's chat | Nam, `reply_customers` | `reply` | the owner or a helper; from a notification too |
| `place_order` | Nam, `place_orders` | `money` | the owner |
| `change_order`: its items, its address, or cancelling it | Nam, `change_orders` | `money` | the owner |
| `refund` | Ton, `ask_refund` | `money` | the owner |
| `publish_post`: anything the public sees, an answer to a public review included | Pim, `publish_posts` | `public_post` | the owner |
| `change_setting`: one of the shop's own settings on the site | Kit, `run_command` | `command` | the owner |

Anything the table does not know is `command`, the owner's only. Each job's kind in member-grants' roster is the table's
kind for its action, and a disagreement is refused (`kind_mismatch`) rather than settled either way.

**`askSubmit(write)`** answers `{ outcome: "asked", requestId, kind, revision, expiresAt }`, or
`{ outcome: "draft_only", kind, draft }`. In order:

1. The port's own checks, with `officeExternalWrites` as well as `officeCloud`, then the attempt's own heartbeat, which
   gives the member.
2. The write's shape: `invalid_write`, `unknown_action`.
3. Member-grants' `decide` for the member and the action's job, through the write's sign-in as the connection: practice
   mode runs three days from when the sign-in was added, and a sign-in the site refused, removed or never made is no
   connection. `not_my_job` answers `{ ok: false, error: "not_my_job", member }` with the member whose job it is;
   `not_connected` and `refused` (`unknown_member`, `unknown_capability`, `unknown_kind`) stop there too.
4. The sign-in's own rules: the member is named on it (`member_not_allowed`), and the page is on one of its origins
   (`origin_not_allowed`).
5. In practice mode (`draft_only`), the write's text is kept as the attempt's draft, `{ member, job: action, text,
   about: { signInId }, send: { answer: "draft_only", kind } }`, and no request is raised; a second in the same attempt
   answers `draft_exists`, as for every draft.
6. Otherwise the task object stores the exact write as an immutable proposal (`operationType: "browser.submit"`, its
   payload the write with the site's name, hashed) and opens its approval-core request in the same step, stamped with
   the attempt, of the table's kind, expiring with the proposal in 24 hours, its detail a `SubmitDetail` (below). Only
   the attempt that holds the task may ask (`stale_attempt`).

**`browserStep({ kind: "submit", outpostId, requestId, revision })`** queues the write for an outpost once it is
approved, and answers a `BrowserStep`, `queued`, with `url`, `signInId` and `requestId`. The step carries no values: the
outpost gets them from the approved write as it is begun. The port's own checks come first, with `officeExternalWrites`.
Then: `invalid_request` (any other field, or a revision that is not a whole number from 1); `request_not_found` (no such
request in the task, or one that is not a browser write); `not_approved` (still waiting, declined or withdrawn);
`request_changed` (approved at another revision than the step names); `already_begun`; `action_expired`; and the
vault's: `outpost_not_found`, `outpost_asleep`, `sign_in_not_found`, `member_not_allowed`, `sign_in_broken`,
`origin_not_allowed`, `request_queued` (another step waiting or running carries the request), `too_many_steps`,
`vault_unavailable`. A step lives two minutes.

**Begun once, only as it is handed out.** The begin gate refuses a browser write from anywhere but the control plane at
a hand-out (`409 begin_by_step`): a session's `POST /v1/tasks/:id/actions/:actionId/dispatch`, the broker's send after a
decision, and a worker's read of how its request stands all leave it `approved`. Settling one is the control plane's
too, from its step's report (`409 settle_by_report`). The begin gate reads the action again and moves it in one storage
transaction, so of any number of begins at once one moves it (this holds for every action the broker sends).

```ts
// What a browser write's request names (`record.request.detail`). Its id is the write's action id.
type SubmitDetail = {
  actionId: string;
  operationType: "browser.submit";
  action: SubmitAction;
  site: string;                  // the sign-in's name: "Shopee Seller Centre"
  signInId: string;
  origin: string;                // the page's origin
  url: string;
  form: string;
  values: { field: string; value: string }[];
  text: string;                  // what the owner reads, below
  payloadHash: string;
};
```

`text` is the control plane's own sentence and names every value exactly as it will be typed, each quoted as JSON so
that quotes, line breaks and spaces at either end show: `Make a refund on Shopee Seller Centre
(https://seller.shopee.co.th). On https://seller.shopee.co.th/portal/sale/return/2291, set input[name="amount"] to
"500.00", set select[name="reason"] to "damaged", then submit form#refund.` A write with no values reads `On {url},
submit {form}.`

The desktop shows a browser write's `text` as it came, in every language, on the chat's card, on Home and on Needs you,
whole: never cut, and never in a block that scrolls. A notification offers Approve only when its body is that text,
unchanged and short enough to be seen whole, which a sentence holding links never is (`docs/browser-control.md`,
"The desktop showing a browser write").

## One origin

The pages and the API share one origin, so the console needs no CORS and one Cloudflare Access application
covers the console and the operator routes. They are two Workers, both deployed from `apps/api`:

- **The API Worker** (`wrangler.jsonc`) is the front door. It answers `/v1/*` and `/relay/*` and hands every
  other path to the pages Worker over its `WEB` service binding. It must never have static assets: Cloudflare
  runs a Worker with assets behind an internal router that does not pass `ctx.access`, and the admin gate needs
  it ([Cloudflare's note](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#ctxaccess-limitations)).
- **The pages Worker** (`wrangler.web.jsonc`, `src/pages.ts`) serves `apps/web`'s build: a file when one
  matches, otherwise the app's one page, which picks the screen from the path (`/approve/{token}`,
  `/delete/{token}`, `/join/{token}`, `/ops`). The owner's web app has a page of its own at `/app/`, with its manifest,
  icons and service worker (`docs/web-app.md`).
  `wrangler dev` and `wrangler deploy` build the web app first with `VITE_API_ORIGIN=same-origin`, so the pages
  call the API that served them and a deploy never ships a missing or stale web app.
- **Page headers**, set in `src/pages.ts`: no framing (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), so
  no other site can trick an owner into pressing Approve; `Referrer-Policy: no-referrer`;
  `X-Content-Type-Options: nosniff`; `X-Robots-Tag: noindex, nofollow`; approval, deletion and join pages also
  `Cache-Control: no-store`, since each carries a token in its path. Everything under `/app/` gets a policy of its own
  that runs only this origin's scripts (`src/app-policy.ts`). They never apply to the API's answers.
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
  a LINE reply (`line.message.push`) is `reply`; a worker's `linear.issue.create` is `command`; a worker's browser
  write (`browser.submit`) takes the kind its action has in the control plane's table ("Submitting through a browser",
  above). Its detail is a `SubmitDetail`, which names the site, the page, the form and every value. An append of Ton's
  books (`google.sheets.append`) is `command`, the owner's only; its detail is a `BooksDetail` ("Google Sheets for
  Ton's books", below).
- **A helper sees no books.** A helper's session lists every approval too, so a helper can pass on what they may not
  decide, but an append's detail is replaced for them by a `HelperBooksDetail`: that it waits for the owner, for which
  month and which sheet's title, and none of its rows or totals. A month's books are sales, which helpers do not see.
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
  LINE has it). A reply approved here is never sent again by its link, and the reverse. An approved browser write is
  not sent here: it is begun only as its write step is handed to an outpost, so `action` answers `approved`.
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

## Signing in by email

Built, and off until the owner turns it on (`docs/sign-in-options.md`). A person asks for a code of six digits at an
address and gives it back to `POST /v1/auth/exchange`, which signs them in with the lifted auth's own session, as Sign
in with Apple does (`apps/api/src/email-code.ts`, `email-sender.ts`, `auth-object.ts`). The desktop's screen for it is
Settings › Developer (`docs/sign-in-options.md`, "The desktop"); the web's is the join page an invite link opens
(`docs/people.md`, "Invites"), which signs in for one visit and accepts the invite with that sign-in.

**Off unless configured.** Both routes answer 400 `{ error: "email_not_configured" }`, as Apple's exchange answers
`identity_not_configured` without a client id, unless all three hold: the var `EMAIL_SIGN_IN` is exactly `"on"`; a
sender is bound, which is Cloudflare Email Service's `send_email` binding named `EMAIL` and the var `EMAIL_FROM_ADDRESS`
(an address on the sending domain), with `EMAIL_FROM_NAME`, "Manut AI" when unset; and `APPROVAL_LINK_SECRET` is set.
No environment sets any of them. A body that is not the route's is answered 400 `invalid_request` first, as Apple's
exchange checks its body before its configuration. The Worker answers both without waking the auth object, which
checks both again.

Turning it on needs the owner's yes, the Workers Paid plan, and a sending domain the owner controls, onboarded to Email
Service. Then the environment's block in `wrangler.jsonc` gets `"send_email": [{ "name": "EMAIL" }]`, `EMAIL_FROM_ADDRESS`,
`EMAIL_FROM_NAME` and `EMAIL_SIGN_IN: "on"`.

### `POST /v1/auth/email/code`

Body exactly `{ email }`. It is limited per source IP before anything is read (`AUTH_CODE_LIMITER`, 10 a minute, keyed
and configured as the exchange's limiter): 429 `rate_limited` with `retry-after: 60`, or 503 `rate_limit_unavailable`
without the binding. The address is normalized as Apple's verified email is: trimmed and lower-cased, at most 254
characters, one `@` between two parts with no spaces.

| Status | Body | When |
| --- | --- | --- |
| 200 | `{ sent: true, expiresIn: 600, resendIn: 60 }` | A code went to the email service for the address. The same for every address: nothing here looks the address up, so the answer cannot say whether Manut AI or any shop knows it, and it never waits for the email or says what the service did with it |
| 429 | `{ error: "too_many_codes", retryAfter }`, with `retry-after` | The address had a code in the last minute, or ten in the last 24 hours. `retryAfter` is whole seconds until it may have another |
| 400 | `{ error: "invalid_request" }` | The body is not exactly `{ email }` with an address |
| 400 | `{ error: "email_not_configured" }` | Email sign-in is off, above |
| 411, 413 | `length_required`, `body_too_large` | As the exchange |

A new code replaces the one before, which stops working. The email is plain English: the subject "Your Manut AI sign-in
code", never with the code in it, so a lock screen does not show it; the body gives the code, says it works for 10
minutes and not to share it, and that the person can ignore the email if they did not ask. Thai waits for the owner's
writer.

### `POST /v1/auth/exchange` with `provider: "email"`

Body exactly `{ provider: "email", email, code, deviceId }`: `code` is six digits as a string, and `deviceId` 1 to 128
characters, as Apple's.

| Status | Body | When |
| --- | --- | --- |
| 200 | `{ accessToken, refreshToken, csrf, expiresIn: 3600, tenant }` | The right code within its 10 minutes. The session is Apple's in every way: the same tokens, lifetimes, refresh (`POST /v1/auth/refresh`), sign-out (`DELETE /v1/auth/session`) and tenant wipe |
| 401 | `{ error: "wrong_code", triesLeft }` | A wrong code. `triesLeft` is how many more tries this code takes; at 0 it has ended |
| 401 | `{ error: "code_ended" }` | No code to try: none was asked for, it was used, its 10 minutes passed, or five wrong tries ended it. Ask for a new one |
| 400 | `{ error: "invalid_request" }` | The body is not exactly that, or the code is not six digits, which does not count as a try |
| 400 | `{ error: "email_not_configured" }` | Email sign-in is off, above |

- **The identity.** The tenant is `email:` and the SHA-256, in hex, of the normalized address, so it never equals an
  Apple tenant (`apple:<sub>`) and the address itself names nothing that is stored. The session's email is the
  address, carried through every refresh, so an email invite matches it (`POST /v1/people/accept`, below).
- **One code, one session.** A right code is used up in the same storage transaction that stores the session, so of
  several devices racing with one code, one is signed in and the others are answered `code_ended`.
- **Apple and email are two identities, even for one address** (`docs/decisions.md`, 24 Nov 2026), as two Apple
  accounts are never joined by an email. What the owner sees: their own shop answers to the one account the operator
  linked, so signing in the other way opens no owner session and lists none of their shops. A helper is known in a shop
  by the address the owner invited, so either sign-in that verified it opens their helper sessions: the owner sees one
  helper, the other sign-in arrives as a new device ("Mint signed in on a new device"), and removing the helper ends
  both. The helper's own list of shops (`GET /v1/shops`) is per sign-in until they open the shop with the other.
- **What answers can tell.** Every answer is the same for an address Manut AI or a shop knows as for one nobody knows.
  What they do show is whether someone asked for a code for the address lately (a 429, or `wrong_code` rather than
  `code_ended`), whoever asked.

### What is kept, and where the code never is

- In the auth object, under `email-code:<SHA-256 of the address>`: the live code's HMAC-SHA256 under
  `APPROVAL_LINK_SECRET`, in a domain tag of its own (`manut-ai/email-code/v1.`, over the address's hash and the code),
  when it ends and its wrong tries; and when each code of the last 24 hours was sent. Never the code, never the address.
  The alarm deletes the record a day after its last send, and a tenant wipe of the email identity deletes it with the
  sessions. Changing `APPROVAL_LINK_SECRET` ends every live code, as it ends every link.
- The code is never in a log, the audit log, an error, an answer or a URL: it goes only into the email. A send the email
  service refuses is logged as the service's error code alone (`E_RECIPIENT_SUPPRESSED` and the like), never its
  message, which may name the address.
- The test configuration sends to an in-memory outbox instead (`TEST_EMAIL_OUTBOX` in `wrangler.test.json`), as the test
  Apple key stands in for Apple's. The dev deploy check refuses any config that sets a `TEST_` var
  (`.github/scripts/check-dev-deploys.mjs`).

## Sessions

Every sign-in's session, Apple's and email's alike, lives in the one global auth object (`apps/api/src/auth-object.ts`,
`session-index.ts`), so it is kept small and never read whole (`docs/decisions.md`, 24 Nov 2026, item 42):

- **Each tenant's sessions are found by its own rows.** Every grant chain, an access record and its refresh grant, has
  one row under its tenant, `tenant-session:<tenant>:<refresh hash>` with the access record's hash and the wipe
  generation it was minted at. The row is written and deleted in the same transaction as the chain's own records: minted
  with them, moved on by each refresh, and gone when the chain is signed out, ends at a check, is wiped or is swept. A
  tenant's wipe (`DELETE /v1/tenant/data`, a shop's deletion) lists only its own rows and ends every chain older than the
  wipe, with both of its records; a sign-in just after the wipe stays. It reads no one else's session.
- **Ended sessions are swept.** The auth object's alarm, which already deletes used Apple tokens and old email code
  records, also sweeps sessions: each run reads at most 256 session records from where the last run stopped and deletes
  the access records past their hour, and the grants past their 30 days or their chain's 90 together with their access
  record and their row. A grant refreshed just before its chain's 90 days waits until its last access record's hour is
  over. A pass part way through runs again ten seconds on; a finished pass starts the next an hour later while sessions
  are left, and none is set when none are. Every sign-in and refresh makes sure an alarm is due by the time its access
  record ends.
- **Sessions made before the rows.** The sweep's first full pass gives every live grant made before the rows existed the
  row it would have been minted with, a page at a time, and then marks the index filled. Until it has, a wipe also looks
  for its tenant's records the old way, a page at a time, so no old session outlives its tenant's deletion.
- **The shop indexes are read a page at a time** (`shops-store.ts`): a shop's deletion takes it out of every person's
  rows and every maker's made shops 128 rows at a time, and a make looks for itself on the journal of makes the same way.
  A person's own deletion reads neither index: a person's tenant (`apple:` or `email:`) never names a shop, which the
  Worker always makes as `pilot:<uuid>`.
- **A person's own deletion is limited per address.** `DELETE /v1/tenant/data` counts every try against
  `TENANT_DELETE_LIMITER`, 10 a minute per source address, in the ingress gate before the session is read: 429
  `rate_limited` with `retry-after: 60`, or 503 `rate_limit_unavailable` without the binding. Per address, not per person:
  the deletion ends every session of the person, so each try needs a sign-in of its own, and only an address is shared by
  tries from many accounts.

### Opening a shop session

`POST /v1/shops/session` and `POST /v1/people/session` (below), and through the first the web app's `POST /v1/web/shops`,
each write a session into a shop's one people record, and a helper's is a new device the owner is told of. So:

- **Every try counts per person.** Once the signed-in person is known, and before the body or the shop is read, each try
  counts against `SHOP_SESSION_LIMITER`, 20 a minute per person (the sign-in's verified subject), one bucket for both
  routes whatever address the person comes from (`apps/api/src/session-limits.ts`): 429 `rate_limited` with
  `retry-after: 60`, or 503 `rate_limit_unavailable` without the binding. A shop the web app cannot open a session for is
  listed with `ready: false`, as before.
- **Ten sessions at a time.** A helper keeps at most 10 helper sessions open (`MAX_HELPER_SESSIONS` in
  `@manut/people-rules`), and the owner's linked account at most 10 owner sessions (`MAX_OWNER_SESSIONS`,
  `people-store.ts`). Opening one more ends the oldest, as signing out of that device would: it leaves the shop's record,
  and its token is answered 401 from then on, so that device opens the shop again with the sign-in. The audit log keeps
  the opening's entry; the session that ended has none of its own.

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

### The owner's own routes

The same changes from the owner's own shop session, for the session's own shop (`docs/several-shops.md`, slice 4), with
no `tenant`. Each makes its change through the same operation of the shop's record as the operator's route (one
`transactionSync` with its audit entry, on `@manut/people-rules`), and answers the same.

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /v1/people` | none | `People` |
| `POST /v1/people/invites` | `{ name, identity }` | `{ invite: InviteView, inviteUrl }` |
| `POST /v1/people/invites/revoke` | `{ inviteId }` | `{ invite: InviteView }`; 404 `unknown_invite`; 409 `not_pending` |
| `POST /v1/people/remove` | `{ helperId }` | `{ removed, sessionsEnded, invitesRevoked, coverEnded }`; 404 `not_a_helper` |
| `POST /v1/people/away` | `{ helperId, until }` | `{ away: AwayView }`; 400 `bad_date`; 404 `not_a_helper` |
| `POST /v1/people/away/clear` | `{}` | `{ away: null }` |

- **Who.** An owner session of the account linked to the shop, and the shop's own session (the lifted auth's, whose
  tenant is the shop). A helper's session answers 403 `owner_only` on all six, its own removal included. A person's own
  sign-in acts for their own tenant, which is no pilot shop: 404 `not_found`.
- **Exact.** A body is exactly the fields above, and an `identity` exactly `{ kind: "line", id }` or
  `{ kind: "email", address }`: anything more, a `tenant`, a `shop` or a `role` above all, answers 400 `invalid_request`,
  and so does a query that names `shop`, `tenant` or `role`. Each path takes one method (405 `method_not_allowed`).
- **Only its own shop.** A helper or an invite of another shop, even one the same person owns, is not found here
  (`not_a_helper`, `unknown_invite`).
- **Removal** ends every session of the helper's at once, in the same write, as the operator's does.
- **Nothing is sent.** The answer's `inviteUrl` is for the owner to send the helper themselves.
- **The log** names the owner's linked account by its id (`owner-session` for the shop's own session), never its
  subject, an email or a name. No session, or the operator key, answers 401 `unauthorized`; an unlinked owner's session
  401 `unlinked`; 503 `people_unavailable` when the session or the shop's record cannot be read.

**`GET /v1/people/devices`** with no body: the sign-ins helpers made lately, for the owner's app to tell them once of a
new device (`docs/people.md`, "A helper's new device"). It is one entry for each helper session opened, a join included,
newest first. It is not part of `People`, so the console reads what it read before.

```ts
type Devices = { devices: { id: string; helperId: string; name: string; openedAt: string }[] };
```

- **What it says.** `id` is the session's own id, stable, which the app keeps to know it has already said so. It is no
  credential: a session is its token, which only its device holds, and the shop keeps only the token's hash. `helperId`
  is the helper's id, `name` the name the owner gave them, and `openedAt` when the session was opened, by the shop's
  clock. Nothing else: never a token, a hash, an email, a LINE id or the account a helper signed in with.
- **Still signed in or not.** A sign-in stays listed after its device signs out, so an owner whose app was closed still
  hears of it. It is dropped when it is older than a session lasts (30 days) and beyond the newest 50. The sign-ins of a
  helper the owner removed are not listed. A shop whose record was written before sign-ins were kept lists none, and
  starts at the next one.
- **Who.** The same as the rest of this section: an owner session and the shop's own session. A helper's session answers
  403 `owner_only`, a person's own sign-in 404 `not_found`, no session or the operator key 401 `unauthorized`, an
  unlinked owner's session 401 `unlinked` and a removed helper's 401 `removed`. It has one method (405
  `method_not_allowed`), takes no `shop`, `tenant` or `role` in the query (400 `invalid_request`), and answers 503
  `people_unavailable` when the session or the shop's record cannot be read, never a shorter list.
- Reading it writes nothing, not even to the audit log.

### A helper's own routes

**`POST /v1/people/accept`** with `{ token }` (the invite link's last segment, in the body, never in a URL) and a
signed-in session of the lifted auth. Today that is Sign in with Apple (`POST /v1/auth/exchange`): the session keeps
the email Apple verified, and that email is the account the invite is checked against. A code sent by email does the
same once the owner turns it on: its session keeps the address the code went to ("Signing in by email", above).
Nothing signs in as a LINE account yet, so a LINE invite answers `wrong_account` to every session until a LINE sign-in
exists.

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
for any shop or none, 403 `not_a_helper`. Every try counts against the person's own limit on opening sessions, and an
eleventh open session ends the helper's oldest ("Opening a shop session", above).

```ts
type HelperSession = {
  accessToken: string;   // "mhs1.<shop, base64url>.<64 hex>": send as `Authorization: Bearer <accessToken>`
  expiresAt: string;     // 30 days on; open the shop again with the signed-in session after that
};
```

A helper session is accepted by `GET /v1/approvals`, `POST /v1/approvals/{requestId}/decision` and
`POST /v1/approvals/{requestId}/pass-on`, for its own shop only. The owner's routes that take a shop session (the team's
routines, `/v1/routines` and `/v1/team/*`, "Routines", below; what the team knows, `/v1/memory`; the shop's consent and
export, "Several shops", below; and `/v1/people`, above) answer it 403 `owner_only`, so a helper's app does not read its
session as ended. Every other session route answers it 401: a helper never acts as the shop. The shop keeps only its SHA-256. The helper's
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

All of it is in the one write to the shop's object that makes the shop (`pilot-store.ts`), after the clocks and before the
shop is listed, so the shop's object holds the shop with its setup or nothing of it. A shop whose setup could not be
written answers 503 `shop_unavailable` and is never listed, and asking again finishes it ("A make that stops part way",
below). The log has `shop.created`, then `template.applied` (naming the template by id) and one `routine.created` for each
routine.

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
approval routes ("Approvals for a session", "Deciding from a session") and, as its owner, on the shop's routines, memory,
consent, export, people and vault ("What an owner session reaches", below). No route takes a shop or a role from a request
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
the identity they signed in with. Every try counts against the person's own limit (429 `rate_limited`), and an eleventh
open session ends the oldest ("Opening a shop session", in "Sessions" above).

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

An owner session is accepted by `GET /v1/approvals` and `POST /v1/approvals/{requestId}/decision`, by the team's
routines (`/v1/routines`, `/v1/team/*`, "Routines", above), by what the team knows (`/v1/memory`, "Memory", above), by the
shop's consent and export ("What an owner session reaches", below), by the shop's people (`/v1/people`, "Helpers",
above) and by the shop's vault and outposts (`/v1/vault/*`, "The owner's vault and outposts", above, and
`POST /v1/outposts/register`), for its own shop only, as the owner: those routes take who is calling from one place
(`callerOf`), and the owner's rule is that the routines, the memory, the consent, the export, the people and the vault
are theirs. Decisions and changes
name the linked account's id. `POST /v1/approvals/{requestId}/pass-on` answers it 403 `not_a_helper`, as it answers the
shop's own session. Every other session route answers it 401, so it never acts as the shop: not the tasks, deletion,
connections or schedules. The shop keeps only its SHA-256. Unlinking the owner's account ends every owner session of that shop at once, and from then
on each answers 401 `unlinked` with `unlinkedAt`. Opening one writes `owner.session_opened` to the shop's audit log,
naming the account by its id; the app ends its own with `POST /v1/shops/session/end` ("Ending a shop session", below),
which writes `owner.session_ended`.

**`POST /v1/shops/owner-code`** with no body, or `{}`: a code the owner sends their operator so the operator can link this
account to their shop ("Operator routes", below). 200 `{ code, expiresAt }`: `code` is eight characters of Crockford's
base 32, shown as `XXXX-XXXX`. It names only the account that asked for it, works once, for 15 minutes, and asking again
replaces it. Only its SHA-256 is kept. A body with any field, an account above all, answers 400 `invalid_request`.

### Making a shop of your own

Built, and off until the owner opens sign-ups (`apps/api/src/self-serve.ts`; docs/several-shops.md, "A shop its owner
makes"). A signed-in person makes their own shop, from one of the three shop templates or none, and is its owner from the
first write, with no operator and no link code. It is the roadmap's Phase 5 gate, onboarding that converts without an
operator. Who may sign up, the pilot's customers and any price are the owner's calls, and none of them is built in: a
self-serve shop has no payment step, since billing is parked.

**Off unless opened.** `POST /v1/shops/new` answers every request 403 `{ error: "sign_ups_closed" }`, whatever its method,
credential or body, and reads nothing (not the session, not the rate limit), unless the var `SELF_SERVE_SHOPS` is exactly
`"on"`. No environment sets it; the test configuration does. Opening sign-ups is the owner's call: the environment's block
in `wrangler.jsonc` gets `"SELF_SERVE_SHOPS": "on"`.

**`POST /v1/shops/new`** with exactly `{ name, ownerName, template }` and the person's own signed-in session (Apple's or
email's). `template` is `handmade`, `fashion`, `food` or `null` for none. While sign-ups are open, every try counts against
`SELF_SERVE_SHOP_LIMITER` first, per source address, before anything is read (10 a minute; 429 `rate_limited` with
`retry-after: 60`, or 503 `rate_limit_unavailable` without the binding).

| Status | Body | When |
| --- | --- | --- |
| 201 | `{ shop: { id, name, ownerName, template }, role: "owner", account: { id }, session: ShopSession }` | The shop is made, listed and the person's: `account.id` is what their decisions name, and `session` is this device's owner session, as `POST /v1/shops/session` answers an owner. `template` is the id, or `null` |
| 403 | `{ error: "sign_ups_closed" }` | Sign-ups are not open, above |
| 401 | `{ error: "unauthorized" }` | No signed-in session: none, the operator key, a shop session (`mos1.`) or a helper's (`mhs1.`). Making a shop takes the person's own sign-in |
| 405 | `{ error: "method_not_allowed" }` | Anything but `POST`, after the session is checked |
| 400 | `{ error: "invalid_request" }` | The body is not exactly those three keys: an owner, a tenant, a role or anything else is refused, not dropped |
| 400 | `{ error: "invalid_json" }` | The body is not JSON |
| 400 | `{ error: "invalid_name" }`, `{ error: "invalid_owner_name" }` | The shop's name, or the person's own, is empty, longer than 80 characters once its outer spaces are off, or holds a control character (a helper's name's rule, `keptName` in `people-store.ts`) |
| 400 | `{ error: "unknown_template" }` | `template` is not one of the three, or `null` |
| 409 | `{ error: "too_many_shops", limit: 3 }` | The account has made 3 shops that still exist |
| 503 | `{ error: "shop_unavailable" }` | The shop could not be made, listed or counted. Nothing is listed, the slot is given back, and asking again with the same name, owner name and template finishes that very shop, never a second one ("A make that stops part way", below) |

- **The same shop the operator's route makes.** Both go through `writeNewShop` in `pilot.ts`: the shop's record with
  `shop.created` and the template's setup ("Shop templates", above: its members, its routines each paused, its
  first-week questions, `template.applied` and one `routine.created` each) in one write.
- **Owned from the first write.** For a shop its owner makes, that first write to the shop's object also links the person's
  account as its owner (`owner.account` on the People answer, `{ id, subject, linkedAt }` in the export) and opens this
  device's owner session, with `shop.made_by_owner`, `owner.linked` and `owner.session_opened`. Every entry of the making,
  `shop.created` and the template's included, names the owner's linked account by its id (`owner-<uuid>`), never its subject
  or an email. The shop is marked `selfServe: true` on its record and in the console's shop list.
- **Listed last, in one write.** Once the shop and its setup are written, one AuthObject transaction puts it on the
  console's list (the pilot registry) and in the person's index as theirs, so `GET /v1/shops` and `GET
  /v1/admin/pilot/shops` list it together or not at all. A shop whose setup or listing could not be written is never listed,
  and its session's token, which only the answer would carry, is never sent.
- **At most 3 made shops per account.** A slot is reserved in AuthObject before anything is made, in the same transaction
  that puts the make on the journal, so requests racing for the last slot cannot pass it. A shop that was deleted no longer
  counts, and a reservation whose make failed is given back at once, and taken again by the request that finishes that
  make, or stops counting after 10 minutes if nobody asks again. Shops an operator linked to the account never count: the
  limit is on making, not owning.
- **The pilot gate** lists a self-serve shop and leaves it out of the cohort unless an operator adds it ("The pilot gate",
  above).

### A make that stops part way

A shop is made by `POST /v1/admin/pilot/shops` and by `POST /v1/shops/new`, both through `writeNewShop` in `pilot.ts`, and a
make writes to more than one object. It cannot be one write, so it is made to be finished instead, as a deletion is
("Export and deletion", above): a deletion that stops part way keeps the shop on the console's list until the same request
finishes it, and a make that stops part way keeps the shop **off** the list until the same request finishes it. In order,
and each step safe to run again:

1. **Begin.** AuthObject puts the make on its *journal of makes* (`pilot-making:<tenant>`, `{ tenant, name, ownerName,
   template, by, at }`, where `by` is the person making their own shop, or null for an operator) before anything of the shop
   is written. For a person's own make the same transaction takes one of their slots (409 `too_many_shops`, writing
   nothing). If the same shop is already on the journal, an earlier try stopped part way and this one finishes it: the
   answer is that shop's tenant, not a new one. The same shop is the same name, owner name and template, from the same
   person, or from an operator. Another name, owner name or template, or another person, is another shop, and leaves this
   one where it is. Two asks at once for the same shop find each other the same way, and make one.
2. **Look.** The shop's own object says whether the shop is already there; if an earlier try wrote it, it is left as it is,
   with nothing set up again.
3. **Clocks**, for a shop made from a template.
4. **The shop's own write**: the shop's record, its people record when its owner makes it, its template's setup, and an
   audit entry for each, in one storage write (`createShop` in `pilot-store.ts`). The shop's object holds the shop whole or
   nothing of it, and its log (`shop.created`, then `shop.made_by_owner`, `owner.linked` and `owner.session_opened` for an
   owner's own, then `template.applied` and a `routine.created` each) never says more than was written, and says each
   thing once however many tries it took. A shop already there answers 409 `already_exists` and changes nothing.
5. **A session of its own**, for a person's own make that found the shop already written: that try's first owner session has
   a token only its answer would have carried, which went nowhere, so this try opens another, as `POST /v1/shops/session`
   does, for the account the first linked. It leaves the person's index to the next step, so the console and the person's own
   list still agree.
6. **List.** The registry row, and the make leaves the journal in that same write (`POST /pilot-shops`); for a person's own
   shop it is `POST /shops-made/finish`, which also puts the shop in the person's index and marks the slot done. Asking
   again answers the same and moves the shop nowhere on the list. It is asked twice if the first try fails, because only the
   answer may have been lost, and the shop is whole.

What a stop leaves, and what asking again does:

| Stopped at | Left | Asking again |
| --- | --- | --- |
| Begin | Nothing. If only the answer was lost, the journal row, and for a person's own make a slot that the make gives back at once | Finishes that shop, on the slot it takes again |
| Look, clocks, or the shop's own write | The journal row, nothing of the shop, and at most clocks for routines that never came to be, which remove themselves at their first instant. If only the answer to the write was lost, the shop whole | Writes the shop, or finds it written, and lists it |
| Opening a session (a person's own make) | The shop whole, the journal row, the slot given back | Opens a session and lists it |
| List | The shop whole in its own object, not listed, and the journal row | Lists it |

So a stop never leaves a half-made shop: a shop's object has the shop with its setup, or none; no stop lists a shop that
cannot be opened, in the console's Shops overview or in the person's own list; and the log says a shop was made only when
its record is there, once. A person's slot is given back by the failure and taken again by the retry, or lapses after 10
minutes (`MADE_RESERVATION_MS`), so no slot is lost; a retry that finds the account at its limit with other shops is refused
409 and changes nothing.

Not built: a make that nobody asks for again is not cleared by itself. Its journal row, and its shop if it got so far, wait.
The shop is on no list, so nobody is shown it, and for a shop its owner makes the token of its first session was never
sent. It holds nothing a customer or an owner gave it. Deleting the shop with `POST /v1/admin/pilot/deletions`, by its id
(on the journal) and exact name, as for any shop that never went live, clears it and takes its row off the journal, and so
does the wipe of any tenant.

### What an owner session reaches

Besides the approvals and the routines, an owner session reaches what the team knows (`/v1/memory`, "Memory") and the
shop's people (`/v1/people`, "Helpers"), and these two routes on the lifted routes' own paths, so an app reads a shop's
consent and export the same way whichever session it holds. Only a token shaped as a shop session (`mos1.`, `mhs1.`) is
answered as below; the shop's own session and a person's sign-in keep the lifted routes as they were, for their own
tenant, and the operator key and no credential answer 401 there as before.

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /v1/consent/cloud` | none | `{ cloudWork, updatedAt }`, or `{ cloudWork: false }` before the owner ever answered |
| `PUT /v1/consent/cloud` | `{ enabled }`, true or false | `{ cloudWork, updatedAt }`; the log gets `consent.given` or `consent.withdrawn`, naming the account by its id |
| `GET /v1/tenant/export` | none | `ShopExport`, the same export the operator's `GET /v1/admin/pilot/export` gives, with `cache-control: no-store` |

- **Consent.** The owner gives it or withdraws it, in one write to the shop's consent record with its audit entry, the
  same record the owner's link writes. Giving it lets the team work; every external write still waits for its own
  approval. Withdrawing it stops the team's work at once (an approval answers `consent_required`, though declining still
  works, and the routines' clocks stop until it is given again, "Routines", above) and keeps the shop live, so deleting
  it still needs the owner's yes. No operator route writes consent.
- **The export** is the answer's body: the app reads it with the session in the `Authorization` header and saves the file
  itself (a save dialog on the Mac), so no download link is made and no token is ever put in a URL, a history or a log.
  A part it cannot read answers 500 `export_incomplete` naming it, as the operator's does; an object it cannot reach at
  all, 503 `export_unavailable`. It is not written to the audit log, as no export is: the desktop reads the export as
  its task list.
- **Deletion stays with the owner's link.** `DELETE /v1/tenant/data` answers a shop session 401, as before. To delete a
  live shop's data, the operator asks and the owner says yes on the confirmation link ("Export and deletion", above).
- **Who and in what order.** Who is asking comes first (401 `unauthorized`, `unlinked` or `removed`; 503
  `people_unavailable` when the session cannot be checked), then the role (a helper's session: 403 `owner_only`), then
  the method (405 `method_not_allowed`), then the query (a `shop`, `tenant` or `role` in it: 400 `invalid_request`) and
  the body (not exactly `{ enabled }` with a boolean: 400 `invalid_request`; not JSON: 400 `invalid_json`). 503
  `consent_unavailable` when the shop's consent cannot be read or written.
- **Schedules and attention stay closed to a shop session.** `GET /v1/schedules` and `GET /v1/inbound/attention` answer a
  shop session 401, owner's and helper's alike, as every lifted session route does. An owner has both through the export,
  which carries the shop's schedules (the team's routine clocks among them, each naming its `routineId`) and its attention
  items, so opening those two lifted routes would add a second way to the same lists, and the schedules path also takes
  writes that must stay closed (`docs/decisions.md`). The desktop reads an owned shop's export and `GET /v1/routines`
  together, with its owner session, each minute (`docs/runtime-adapter.md`, "A shop the person owns").

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

## The web app's session

The owner's web app (`/app/`, `docs/web-app.md`) signs a person in with a code sent by email and keeps the sign-in after
the app is closed, in cookies this API sets and the page's script cannot read (`apps/api/src/web-session.ts`). These five
routes are the only ones in the API that read a cookie. Each hands its request on, with the right bearer from the
cookies, to the route that does the work: the lifted auth to sign in, refresh and sign out, the person's own routes for
their shops ("Several shops"), and the shop's approvals with that shop's own session ("Approvals for a session",
"Deciding from a session"). Every other route keeps taking a bearer and nothing else. Signing in by email is off
(`email_not_configured`) until the owner turns it on, so the app can sign no one in today.

**The cookies.** Each is `__Host-` (this exact host, every path), `Secure`, `HttpOnly` and `SameSite=Strict`:

| Cookie | Value | Lasts |
| --- | --- | --- |
| `__Host-manut-sign-in` | the sign-in's device id (`web-<uuid>`, minted here, never by the page) and refresh token | 30 days, set again by each refresh; the lifted auth ends the chain at 90 days |
| `__Host-manut-access` | the sign-in's access token | its hour, less a minute |
| `__Host-manut-shop-<16 hex>` | one shop session (`mos1.` or `mhs1.`) and the id it decides as; the name is the start of the shop id's SHA-256 | the session's 30 days, less an hour |

**Who may call.** Every route answers 403 `csrf_required` without the header `x-manut-web: 1`, which a page on another
origin can send only after a CORS preflight the API never answers, and 403 `origin_forbidden` for an `Origin` that is
not this origin, a `Sec-Fetch-Site` other than `same-origin`, or a `POST` with no `Origin`. These come before the
method (405 `method_not_allowed`) and the cookies. No answer carries a token, and every answer is
`cache-control: no-store`. A `/v1/web/` path that is none of the five answers 404 `not_found`.

| Method and path | Body or query | Answer |
| --- | --- | --- |
| `POST /v1/web/sign-in` | exactly `{ email, code }` | `{ signedIn: true }` and the sign-in's two cookies. The sessions the browser held before are ended and their cookies cleared first. Refusals as the exchange's: 401 `wrong_code` with `triesLeft`, 401 `code_ended`, 400 `invalid_request` (another field, a `deviceId` above all, or a code that is not six digits), 400 `email_not_configured` |
| `POST /v1/web/shops` | `{}` or none | `{ shops: WebShop[] }`: the person's shops (`GET /v1/shops`), each with a session ready, one kept from its cookie or opened (`POST /v1/shops/session`) and set. A cookie for a shop no longer listed is cleared. Refreshes the sign-in when the access cookie has gone, or the token is refused. 401 `signed_out` with `emailSignIn` (whether signing in by email is on, so the app can say on opening that it is not) when there is no sign-in or the lifted auth ended it (no cookie is cleared then: another tab's refresh may have set the one that works); 503 `shops_unavailable` |
| `GET /v1/web/approvals` | `?shop=&state=open\|recent[&limit=]`, nothing else | `GET /v1/approvals`'s answer to that shop's session, as it is |
| `POST /v1/web/approvals/{requestId}/decision` | exactly `{ shop, optionId, seenRevision }` | `POST /v1/approvals/{requestId}/decision`'s answer to that shop's session with `{ optionId, seenRevision }`, as it is |
| `POST /v1/web/sign-out` | `{}` or none | `{ signedOut: true, shopsEnded }`: every shop session ended (`POST /v1/shops/session/end`) and the sign-in (`DELETE /v1/auth/session`, refreshed first when the access cookie has gone), best effort; every cookie cleared whatever happened |

```ts
type WebShop = {
  id: string; name: string; ownerName: string;
  role: "owner" | "helper";
  you: string | null;   // the id this person's decisions name there: the linked account's (owner-…) or the helper's
  ready: boolean;       // false when its session could not be opened now
};
```

- **The two shop routes** answer 401 `session_ended` with `shop` when the browser holds no session for the shop, or the
  shop no longer holds the one it sent, and clear that cookie: reading the person's shops again opens a new one. A
  session removal or unlinking ended keeps its own answer (`removed` with `removedAt`, `unlinked` with `unlinkedAt`), with
  `shop`, and its cookie is cleared too. A query naming anything but `shop`, `state` and `limit`, or a body naming a
  `role`, is 400 `invalid_request`, as on the shop routes.
- **Limits.** `POST /v1/web/sign-in` counts in the exchange's bucket (`AUTH_EXCHANGE_LIMITER`), and `POST /v1/web/shops`
  and `POST /v1/web/sign-out` in the refresh's (`AUTH_SESSION_LIMITER`), per source address, before anything is read.
- **What the shops see.** Opening a shop session here is opening one anywhere: an owner's writes `owner.session_opened`,
  a helper's is a new device the owner hears of. The app keeps each for its 30 days, so a phone counts as one device.

## Google Sheets for Ton's books

The owner connects their own Google account, and Ton appends a month of the shop's books to a Google Sheet in the
owner's Drive, each append asked first with its exact rows (`apps/api/src/google.ts`, `google-vault.ts`,
`google-connection.ts`, `google-connect.ts`, `books-sheet.ts`, `books-detail.ts`; why and what the owner must set up:
`docs/connectors.md`, 4b). Google is asked for `https://www.googleapis.com/auth/drive.file` alone, which reaches only the
files the app makes, and which needs no Google review.

**Off until the owner's OAuth client exists.** Until `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are both Wrangler
secrets, and `PUBLIC_API_ORIGIN` is set, every route below answers 503 `{ "error": "google_not_configured" }` before it
reads anything else, the callback included, and Ton's append fails with `google_not_configured`. No environment sets
them yet. Tests use a fake Google at `TEST_GOOGLE_ORIGIN`, a setting only `wrangler.test.json` has and that is ignored
unless it is an `https://…test` origin, so even a value set by mistake can send nothing anywhere real.

### The owner's routes

From the owner's own session for the session's own shop (an owner session, or the shop's own session), with no `tenant`,
as on the owner's other routes ("The owner's own routes", above).

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /v1/google` | none | `GoogleStatus` |
| `POST /v1/google/connect` | `{}` | `{ url, expiresAt }`: Google's consent page for the owner's browser, good once until `expiresAt` |
| `GET /v1/google/callback` | none: Google's redirect, `?state&code` or `?state&error` | a short HTML page |
| `POST /v1/google/disconnect` | `{}` | `{ disconnected: true, revoked }` |
| `POST /v1/google/books` | `{ month }`, `YYYY-MM` | a `WorkerRun` ("Workers", above): `asked` with the request, `done` with a draft, or `failed` with why |

```ts
type GoogleStatus = {
  connected: boolean;
  connection: null | {
    id: string;
    connectedAt: string;
    state: "working" | "broken";
    broken?: { at: string; reason: string; words: string };  // words the owner reads, e.g. "… Connect Google again."
    sheet: null | {                // the sheet Ton appends to
      id: string; title: string; tab: string; url: string | null;
      appended: AppendedMonth[];   // what was sent to it, newest first, at most 24: never the rows
    };
  };
};

type AppendedMonth = {
  month: string;                   // YYYY-MM
  at: string;                      // when the send began
  rows: number;                    // after the header row
  outcome: "confirmed" | "unknown"; // unknown: Google's answer left it open whether the rows landed, or never came
};
```

- **Who and in what order.** Configuration first (503 `google_not_configured`), then who is asking (401 `unauthorized`,
  `unlinked` or `removed`; 503 `people_unavailable`), then the role (a helper's session: 403 `owner_only`), the method
  (405 `method_not_allowed`), the query (a `shop`, `tenant` or `role` in it: 400 `invalid_request`) and the body (not
  exactly the fields above: 400 `invalid_request`; not JSON: 400 `invalid_json`). A person's own sign-in acts for their
  own tenant, which is no pilot shop: `connect` answers 404 `not_found`.
- **Connecting.** `connect` makes a `state` (`mgs1.<shop, base64url>.<64 hex characters>`) and a PKCE pair, and the
  shop's vault keeps the state's SHA-256, the verifier sealed under `CRED_KEY`, and which owner session started it, for
  ten minutes. A shop has one sign-in in flight: a new `connect` replaces an unfinished one. The answer is the address of
  Google's consent page: `client_id`, `redirect_uri` (`PUBLIC_API_ORIGIN` + `/v1/google/callback`), `response_type=code`,
  `scope` = `drive.file` only, `access_type=offline`, `prompt=consent` (so a second connect gets a refresh token too),
  the `state`, and `code_challenge` with `code_challenge_method=S256`. Nothing else, and never the client's secret.
- **The callback** is public: the browser Google sends back carries no session, so its ingress limit (30 a minute per
  address, `GOOGLE_CALLBACK_LIMITER`) runs first, and the state is its credential. The vault hands the state's sign-in
  back once and deletes it in the same step: 400 for a state it never made or already used (a replayed callback), 410
  for one past its ten minutes. For an owner session, that session must still hold (401 when the account was unlinked
  meanwhile). `error=access_denied` (the owner said no) connects nothing. Otherwise the code is exchanged at Google's
  token endpoint with the verifier and the client's secret, in the request's body; a token without the `drive.file`
  scope is not kept (400). The refresh token is sealed in the vault as the shop's Google connection (`gsheets`), and any
  earlier one is forgotten in the same write. The earlier one is not revoked at Google: revoking ends the whole grant
  the account gave, and when the same account connects again that would end the new token too. Its sheet is carried
  over, so the books stay in one spreadsheet. The page says what happened in a sentence or two, sends no referrer, runs
  no script and is never cached; it is in English for now.
- **Disconnecting** revokes the refresh token at Google (`POST /revoke`, the token in the body) and then forgets it in
  the vault, whatever Google answered: `revoked: false` means Google could not be reached, and the owner can remove
  Manut AI in their Google account's settings. 404 `not_connected` when there is nothing to disconnect. It is the only
  way to remove a Google connection: the generic `DELETE /v1/connections/:id` answers 409 `disconnect_required` for one,
  since it would forget the token without telling Google.
- **Tokens.** An access token is asked for, from the sealed refresh token, each time an ask or a send needs one, used
  for that ask or send, and never stored. No token is in any answer, page, log, URL or audit entry. The broker sends an
  action only through a connection of its operation's own provider, so the Google token never goes anywhere but Google,
  whatever connection a proposal names (a LINE reply only through a LINE connection, a Linear issue only through a
  Linear one).
- **Broken.** When Google refuses the grant (`invalid_grant`: the access was removed, or ran out), the connection is
  marked broken, `google.broken` is written once, and nothing is asked or sent through it again; the owner connects
  again to mend it. Any other trouble reaching Google changes nothing and fails only that ask or send.

### Asking for a month, and sending it

`POST /v1/google/books` runs Ton's job (`{ kind: "books_sheet", month }`) as the operator's `POST
/v1/admin/workers/run` does, with the same rules for Pause everyone (409 `team_paused`) and a member left off (409
`member_off`), and the owner named as starting it. Ton names only the month; the control plane does the rest:

1. The switches (with `officeExternalWrites`) and consent, then `@manut/member-grants`' `decide` for Ton's job
   `append_books` through the Google connection. Its practice days run from the shop's first Google connection, so
   connecting again does not start them over; in them, Ton keeps a draft of the append (`send: { answer:
   "draft_only", kind: "command" }`) and nothing reaches Google.
2. The month must have ended in Bangkok (`month_not_over`). The rows are `@manut/books`' `monthBooks` over the same
   entries the daily summary counts: each confirmed payment a LINE sale at the time it was confirmed. A month the newest
   500 payments do not reach back past is refused (`month_incomplete`) rather than appended short, and a month with
   nothing in it ends done with a draft that says so.
3. A fresh access token, then the sheet. On first use a new spreadsheet, "Manut AI books: {shop}", is made in the owner's
   Drive with one tab, `Books`, and no rows. One claim on the connection at a time may make it, and only that claim's
   sheet is kept, as the connection's one granted resource under a new grant revision; an ask while another makes it is
   refused (`sheet_in_progress`). A sheet the connection already has is read first (its title as it is now, and that
   its `Books` tab is still there, else `sheet_tab_missing`); one that is gone for this account is made again.
4. **A month sent before is said first, never asked for silently.** The sheet's record in the vault keeps what was
   appended to it (below). When it holds an append of this month, the proposal carries `earlier`: how many times the
   month was sent, and for the latest when (`at`), how many rows and how it ended (`confirmed`, or `unknown` for a send
   Google left open, or one that never reported back). The request's `text` then begins with that: "Already sent: this
   month went to the sheet on 2026-11-03 (41 rows) and Google confirmed it. Approving adds its rows a second time.", or
   for an unknown one "Maybe already sent: … but Google did not say whether the rows arrived. Look in the sheet first:
   approving adds its rows a second time, so they would be there twice if they had arrived." (`again` after more than
   one). The ask is made all the same: the owner's yes is the choice to add the rows again, which an owner who deleted
   them by hand, or who looked and found a lost send's rows missing, needs. `earlier` is part of the payload, so it is
   hashed with the rows and shown with them. Only the record of the sheet the request names counts: a sheet made anew
   because the old one was deleted holds none of the rows, so its first ask has no `earlier`.
5. The task object stores the month's exact rows, `earlier` and the sheet as an immutable proposal (`google.sheets.append`)
   and opens its approval-core request, of kind `command`, which only the owner may decide, expiring after a day.

The owner decides it from their session (`POST /v1/approvals/{requestId}/decision`, "Deciding from a session"). An
approval goes to the broker's one-use begin gate, as every write does, which sends it once: the live grant is checked
(the connection, its provider, its revision, the sheet, not broken), a fresh access token is asked for, the append is
written into the sheet's record, and the approved rows go to `spreadsheets.values.append` exactly as `@manut/sheets-rows`
builds them, `valueInputOption=RAW` (no cell runs as a formula) and `insertDataOption=INSERT_ROWS`, after a header row. It
settles `confirmed` on Google's success, `failed` only when Google refused it before applying it (400, 401, 403, 404, 429)
or when it was never sent, and `unknown` for any other end (no answer, a timeout, a server error), which is never sent
again. `google.appended` records how it settled.

**What the sheet's record keeps.** One entry for each append, with the sheet's binding in the vault and never the rows:
`{ actionId, month, at, rows, outcome }`, oldest first, the newest 120. It is written as `sending` before the request leaves,
so a send the Worker never finished (it stopped part way) still counts as sent, and is finished as `confirmed` or `unknown`
when Google's answer is known; an append Google refused before applying it adds nothing, so its entry is taken out. The
app and the next ask read `sending` as `unknown`. It goes with the sheet when the owner connects again, and a new sheet
starts empty. Writing it is also the send's last check: the vault refuses the begin unless the month was sent exactly as
often as the request said (`earlier.count`, or none), so two requests for one month that were both asked before either was
sent cannot both write it, and a request that did tell of an earlier send goes through. The refused one settles `failed`
with the reason `month_already_sent`, nothing reaches Google, and asked again it says what was sent. Other reasons a
send settles `failed` before Google: `google_broken`, `sheet_changed`, `not_connected`, `already_begun` and
`vault_unavailable`.

```ts
// What an append's request names, in `record.request.detail`. Its id is the append's action id.
type BooksDetail = {
  actionId: string;
  operationType: "google.sheets.append";
  sheet: { id: string; title: string; tab: string };
  month: string;                 // YYYY-MM
  rows: number;                  // rows after the header row
  totals: {                      // text from integer satang, e.g. "฿1,290.33"
    sales: string; salesCount: number;
    refunds: string; refundsCount: number;
    expenses: string; expensesCount: number;
    net: string;                 // sales less refunds
    beforeVat?: string; vat?: string;  // a VAT-registered shop's only
  };
  flags: number;                 // entries Ton flagged for the owner to check
  earlier: null | {              // the month went to this sheet before (the text above says so first)
    count: number;               // how many times, the latest included
    at: string; rows: number;    // the latest: when it began and how many rows it carried
    outcome: "confirmed" | "unknown";
  };
  lines: { date: string; ref: string; kind: "sale" | "refund" | "expense"; channelOrCategory: string;
    amountSatang: number; beforeVatSatang: number | null; vatSatang: number | null }[];  // the exact rows
  text: string;                  // the control plane's sentence naming all of the above
  payloadHash: string;
};

// What a helper is shown of it instead ("Approvals for a session", above).
type HelperBooksDetail = {
  actionId: string;
  operationType: "google.sheets.append";
  month: string;
  sheet: { title: string };
  ownerOnly: true;
  text: string;                  // "Ton asks to append the books for 2026-10 to the owner's Google Sheet. …"
};
```

An append's job ends `failed` with one of these, besides the job flow's own: `google_not_configured`, `invalid_month`,
`not_connected`, `google_broken`, `kind_mismatch`, `month_not_over`, `month_incomplete`, `month_too_long`,
`shop_unavailable`, `shop_not_found`, `payments_unavailable`, `vault_unavailable`, `google_unavailable`,
`sheet_in_progress`, `sheet_not_made`, `sheet_tab_missing`. The owner's route answers 400 `invalid_month` before
anything starts.

**Deleting the shop** revokes the token at Google first, as disconnecting does ("Export and deletion", above).

**The desktop** reads these routes from Customize › Connections, with the viewed shop's own owner session: the Google row (its
status, Connect, Disconnect and Send a month's books) and, in Needs you, Ton's append with its whole text (`apps/desktop`:
`src/pages/GooglePane.tsx`, `src/runtime/http/google.ts`, `books.ts`; `docs/decisions.md`). It reads the 503
`google_not_configured` as Google being off, which needs the API's `error` code on a 5xx.

**Not built yet.** The web's screens; the Google Picker, for the owner to choose an existing sheet; and a monthly schedule for
the append.
