# Pilot API (week 1)

The contract between `apps/api` (the backend lifted from GoSpark's `cloud/`) and `apps/web` (the owner's
approval page and the operator console). Both sides build to this file. Change it only together.

All bodies are JSON. Times are ISO 8601 strings in UTC. Money is in satang (integer, 100 satang = 1 baht).

## Who is who in the pilot

- **Operator**: a Manut AI staff member running the concierge pilot. Reads customer messages, drafts replies,
  sends the owner an approval link, confirms PromptPay slips. Uses `/v1/admin/pilot/*`.
- **Owner**: the shop owner. Has no account in week 1. Approves or declines one reply through a signed,
  single-use link: `/v1/pilot/approvals/{token}`.
- **Shop**: one tenant in the backend. `tenant` is its id.

## Security rules (unchanged from the lifted backend)

- `/v1/admin/*` keeps the existing double check: a Cloudflare Access context whose audience matches
  `ADMIN_ACCESS_AUD`, plus `Authorization: Bearer <CLOUD_API_KEY>`, plus an exact entry in `ADMIN_METHODS`.
  Every route below is added to `ADMIN_METHODS` as an exact `METHOD path` string, so ids travel in the query
  string or the body, never in the admin path.
- The approval link is a capability: an HMAC-SHA256 over the tenant, task id, action id and expiry with the
  Wrangler secret `APPROVAL_LINK_SECRET`, base64url, verified in constant time. It names exactly one action and
  expires after 24 hours. It can never approve anything else.
- Approving an external write still needs the shop's consent (`cloudWork`), recorded from the owner through
  the link (`/consent` below), never by an operator.
- A decision settles once. The task object already refuses a second decision; the link routes keep that.
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

Secrets (`channelSecret`, `channelAccessToken`) go straight into the encrypted credential vault and are never
returned. `webhookUrl` is `${PUBLIC_API_ORIGIN}/v1/inbound/line/{connectionId}`; `approvalUrl` is
`${WEB_ORIGIN}/approve/{token}`. Both origins are Worker vars.

```ts
type Shop = { tenant: string; name: string; ownerName: string; lineConnectionId?: string; consent: boolean };

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
  operator prune. Shops, reply records and payments stay until the shop is deleted.
- **Rate limits.** `LINE_INBOUND_LIMITER` (300 a minute) and `PILOT_APPROVAL_LIMITER` (120 a minute).
- **CORS.** The approval routes answer CORS for `WEB_ORIGIN` only and are never cached. The operator routes do
  not answer CORS: the console must be served from the same origin as the API (see `docs/plan.md`).
- **Other answers.** 503 when storage is unavailable or configuration is missing, 413 for an oversized body.

Not built yet: an operator route to export or delete one shop's pilot data (the functions exist and are tested).

## The send itself

A reply is one action proposal on the shop's task with `operationType: "line.message.push"`:

- `connectionId`: the shop's LINE connection; `providerAccountId`: the LINE channel id;
  `targetResourceId`: the bot user id (the connection's only granted resource).
- `recipients`: `[lineUserId]` of the customer who wrote the message being answered.
- `payload`: `{ "text": string }`, 1 to 5,000 characters.

The broker pushes it with the LINE Messaging API, sending the action id as the retry key so a retry can never
send twice, and settles `confirmed`, `failed` or `unknown` as it does for every provider.
