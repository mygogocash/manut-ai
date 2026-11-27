# Model gateway

The one way Manut AI calls a language model for a shop (roadmap Phase 2, "the model gateway with spending caps,
and cost per shop"). Every call is priced before it is made, held against the shop's monthly cap, made, and then
settled at what the provider bills. So cost per shop is measured call by call, and no shop can spend past its cap.
The worker adapter contract's "Cost" rule (`docs/phase-0-spikes.md`) is built on this: a worker never holds a
provider key and never calls a model itself.

All amounts are integers. Money shown to people is in satang (100 satang = 1 baht). Spend is kept in
**millisatang** (1,000 millisatang = 1 satang) so that a month of small calls is not rounded up a whole satang
each time. Months are calendar months in Bangkok.

Code: `apps/api/src/model-provider.ts` (providers), `model-price.ts` (prices, money, months, settings),
`model-meter.ts` (the per-shop ledger in the TenantObject, and the sweep its alarm runs), `model-alerts.ts` (the
cross-shop record of shops near their caps) and `model-gateway.ts` (the call and the operator routes). The
TenantObject's alarm is in `tenant-object.ts`. Tests: `apps/api/test/model-*.test.ts`.

## What the owner must decide or provide

Nothing here can reach a real provider until the owner acts. Until then every call is refused with 503
`not_configured`, before anything is held or sent.

| Setting | Kind | Until it is set | What it decides |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | Wrangler secret (`wrangler secret put ANTHROPIC_API_KEY`) | Every call answers 503 `not_configured` naming it | Which Anthropic account pays. A paid account is the owner's to open |
| `MODEL_SATANG_PER_USD` | Worker var, whole satang per US dollar | 3500 (฿35.00 a dollar) | How dollar prices become satang. Mid-market was about ฿33.3 to ฿34.0 in mid-November 2026, and a card charged in dollars costs a little more, so the default overstates. **The owner's decision** |
| `MODEL_DEFAULT_CAP_SATANG` | Worker var, whole satang per shop per month | 20000 (฿200) | Each shop's monthly cap unless an operator overrides it. ฿200 is about two fifths of the pilot's ฿499 price. **The owner's decision** |
| `MODEL_PROVIDER` | Worker var | Anthropic | `stand-in` makes every call answer from the deterministic stand-in, for local runs only |

A var that is set but cannot be read as a plain whole number (`33.90`, `3,390`, an empty string) stops the
gateway with 503 `not_configured` naming it, rather than pricing calls at some other number. Vars go in each
environment's `vars` in `apps/api/wrangler.jsonc`, or `.dev.vars` for `wrangler dev`. The secret never goes in a
file in the repository.

Other calls left to the owner, none needed to start:

- Which models the AI team may use. The price table below lists three. Adding or removing one is one line.
- Whether to turn on prompt caching, streaming or Anthropic's refusal fallbacks later (see "Not built yet").
- How long metering records are kept. Today they stay until the shop is deleted, like payments.
- Whether 80% and 100% are the right moments to tell an operator, and whether a crossing should also send a message
  once LINE or email sending is on ("Alerts near the cap"). Today it is noted and listed, and nothing is sent.

## The provider interface

One kind of call: a chat completion.

```ts
type ChatRequest = {
  model: string;                 // a model in the price table
  system?: string;               // instructions for the whole conversation
  messages: { role: "user" | "assistant"; content: string }[];  // starts with "user"
  maxOutputTokens: number;       // 1 to 16,000; a model's thinking counts against it
};
type ChatResult = { text: string; stopReason: string; usage: { inputTokens: number; outputTokens: number } };
interface ModelProvider {
  readonly id: string;
  readonly missing: string | null;   // the setting it still needs, or null when ready
  complete(request: ChatRequest): Promise<ChatResult>;
}
```

A provider knows nothing of prices, caps or shops. A failure is a `ProviderError` that carries only status codes,
never the provider's message, so no prompt text can reach a log or an answer through an error. It says whether
the call may be retried, and whether the provider may have billed for it.

- **Stand-in** (`standInProvider()`): never leaves the Worker. It echoes the last customer message, so the same
  request always gets the same answer. It counts one token per character, and stops at the output allowance with
  `stopReason: "max_tokens"`. Tests use it, and so can local runs (`MODEL_PROVIDER=stand-in`).
- **Anthropic** (`anthropicProvider(key)`): the Messages API over `fetch`, as the `claude-api` skill documents it
  for raw HTTP (checked 23 November 2026). It sends `POST https://api.anthropic.com/v1/messages` with `x-api-key`,
  `anthropic-version: 2026-10-21` and a body of `model`, `max_tokens`, `messages` and the optional `system`. It
  sends no `temperature`, `top_p` or `top_k`, which version 2026-10-21 refuses. It reads the text from the `text`
  blocks, ignores `thinking` blocks, and returns the stop reason as given. A refusal is HTTP 200 with
  `stop_reason: "refusal"` and is billed, so it is settled like any answer. It waits up to ten minutes.
  - It uses `fetch` rather than Anthropic's SDK because the gateway adds no dependency. The SDK would replace this
    one function.
  - Error answers are not billed and are released. A failure is retryable when Anthropic's `x-should-retry` header
    says so, and otherwise for 408, 409, 429 and 5xx. No answer at all (a network failure or the timeout) is
    released as retryable.
  - An HTTP 200 whose usage cannot be read is treated as billed: the call is charged its worst case.
  - It asks for no prompt caching, so the cache counts are zero. Should one appear, a cache write is counted as
    two input tokens and a read as one. A write costs up to twice an input token and a read about a tenth, so the
    meter can only overstate.

`modelProvider(env)` picks Anthropic unless `MODEL_PROVIDER` is `stand-in`. Any other value is refused, so a typo
can never send traffic somewhere unintended.

## The price table

Anthropic's first-party prices per million tokens, from the `claude-api` skill's model table (cached
3 November 2026). Re-check them against Anthropic's pricing page before the key goes in. A model that is not in
the table is refused with 400 `unknown_model`: a call the gateway cannot price, it cannot cap.

| Model | Input $/M tokens | Output $/M tokens |
| --- | --- | --- |
| `claude-haiku-5-5` | $0.10 (prompts over 100,000 tokens: $0.50) | $0.50 (prompts over 100,000 tokens: $2.50) |
| `claude-sonnet-5-5` | $2.00 | $10.00 |
| `claude-opus-5-5` | $4.00 | $20.00 |

Prices are stored in millionths of a dollar per million tokens (`2_000_000` is $2.00). For Claude Haiku 5.5, a
prompt over 100,000 tokens puts the whole call at the higher price, which is the reading that costs more.

A call's cost, in millisatang, rounded up once for the whole call:

```
ceil( (input tokens × input price + output tokens × output price) × satang per dollar ÷ 1,000,000,000 )
```

The products pass 2^53 on a large call, so the arithmetic is BigInt and only the small result becomes a number.
Example: 1,000 input and 500 output tokens on Sonnet 5.5 cost $0.007. At ฿35 a dollar that is 24,500
millisatang, shown as 25 satang. Spend is shown rounded up and what is left rounded down, so no page ever shows a
shop more room than it has.

## The cap rules

- **Months.** Calendar months in Bangkok, which turn at midnight Bangkok time (17:00 UTC the day before).
  Thailand keeps no daylight saving, so a fixed seven-hour offset is exact. A call counts in the month its budget
  was reserved, even if it finishes after midnight.
- **The cap.** Each shop's cap is its operator-set override when there is one, else `MODEL_DEFAULT_CAP_SATANG`.
  An override of zero stops every call.
- **Reserve the worst case.** Before a call, the gateway reserves the input estimate plus the whole output
  allowance, at the model's price. The input estimate is one token per UTF-8 byte of the system prompt and
  messages, plus 512 tokens for the request and 16 per message. A token always covers at least one byte, so the
  provider's own count stays below the estimate. Thai, three bytes a character, is where the margin is smallest.
- **Refuse past the cap.** The reservation is refused with 402 `budget_exceeded` when the month's spend, the
  reservations still open in it and this worst case together would pass the cap. Reaching the cap exactly is
  allowed. A refused call never reaches the provider and is counted in the month's `refused`.
- **Nothing for a shop that waits.** A shop its owner made, which no operator has counted in yet, is refused every
  call before anything is held, in the same transaction, with 403 `not_counted_in` (`apps/api/src/shop-waits.ts`):
  anyone can make a shop once sign-ups open, so no stranger's shop spends on the owner's key or sends what the team
  knows to a model until someone at Manut AI has looked at it.
- **Atomic per shop.** The ledger lives in the shop's TenantObject. Each write runs in `transactionSync` with the
  synchronous KV API of SQLite-backed objects: it reads the month, the open reservations and the cap, decides and
  writes, with no await in between. Cloudflare's input gates make reads followed by writes atomic only when no
  other I/O comes between them. Here nothing does, so no other request can run in between, and two calls racing
  for the last of a budget are checked one after the other. A test races two reservations and two calls at the
  edge, and only one passes.
- **Settle once.** Every call ends exactly one way:
  - `ok`: settled at the provider's own token counts, and the rest of the reservation released. The provider's
    count is charged even if it were ever above the reservation, because it is what the provider bills.
  - `failed`: the provider failed, and the whole reservation is released. Nothing is charged.
  - `unreadable`: the provider answered (so it may have billed) but its usage could not be read. The worst case
    is charged.
  - `abandoned`: nothing settled the call within 15 minutes, longer than the provider is allowed to take. The
    worst case is charged by whichever comes first: the next write for the shop, or the sweep below. Until then it
    stays counted against the cap as held.

  A second settlement of the same call answers 409 `not_reserved`, so nothing is charged twice.
- **The sweep.** The shop's TenantObject has an alarm, set a minute after its earliest open reservation expires. The
  alarm charges every reservation past its expiry as `abandoned`, in one `transactionSync`, exactly as the next write
  does, so a shop that stops making calls still has its abandoned call charged on time. Whichever of the two runs first
  closes a reservation and the other finds nothing: a call still ends one way, nothing is charged twice, and a provider
  answer that arrives after the sweep gets 409 `not_reserved`. The minute's margin lets a settle that arrives just after
  the expiry settle at the provider's own count, which is more exact than the worst case. The alarm is then set for the
  next open reservation, or cleared when none is left, and a shop's deletion clears it.
  - A Durable Object has one alarm. The TenantObject had none before the sweep: nothing else it keeps schedules
    anything (routines' clocks are the ScheduleObject's alarm, and the session sweep is AuthObject's). Its alarm now
    serves a list of jobs: the sweep, and sending crossings of the cap (below). It is always set for the soonest moment
    any job has work, runs every job with work when it fires, and one job's failure never stops the other.
  - It is never set sooner than a minute from now, so work that is already late, or keeps failing, comes back once a
    minute rather than in a loop. An object that wakes with work and no alarm sets one.

## Alerts near the cap

Each month notes the first time its charged spend reaches **80%** of the shop's cap, and the first time it reaches
**100%**, so an operator hears of a shop before its calls are refused. Nothing is sent to anyone: LINE is parked and
email sending is off. The crossing is noted, logged and listed.

- **Measured in integers.** A threshold is reached when `spent × 100 ≥ cap × 1,000 × percent`, all in millisatang,
  in BigInt. ฿160.00 of a ฿200 cap is 80%; ฿159.999 is not.
- **Only what was charged counts.** Held reservations do not: a hold is a worst case that mostly settles for less, and
  a crossing it caused could not be taken back. An abandoned call's worst case counts once it is charged.
- **Against the month's own cap.** Each month keeps the effective cap it was last measured against (`capSatang` on its
  total): its latest reservation records it, and so does an operator's cap change. So the alarm, which has no Worker
  to ask for the default cap, measures as a write does, and a month's late charge is measured against its own cap.
- **Once, until a cap change.** A crossing is noted once, in the same `transactionSync` as the charge or the cap
  change that got the month there, with an audit entry (`model.cap_near` or `model.cap_reached`, by the system, naming
  the `month` and carrying the cap as `amountSatang`, metadata only). A lowered cap notes at once a threshold the spend
  is already past. A raised cap takes off a crossing the spend is back under, and the month notes it again, against the
  new cap, if the spend reaches it. Spend never falls within a month, so a raised cap is the only way back under one.
- **A cap of zero notes nothing**, and takes nothing off. Zero is an operator's stop, not a budget: every call is
  refused before anything is held, and any spend would otherwise be "past" it.
- **Across shops, from one read.** Each crossing is also queued, in the same transaction, as a notice for a small
  record kept in AuthObject beside the shops' registry (`model-alerts.ts`). The shop's object sends it at once after
  the write, and its alarm sends it again a minute after a failure, until AuthObject has it. AuthObject keeps one row
  per listed shop, for the shop's latest month with a crossing; a numbered notice older than the one kept changes
  nothing, and a notice that takes every crossing off removes the row. A late charge to an earlier month stays in that
  month's total and the audit log and changes no row. A row is written only for a shop on the registry, checked in the
  same transaction, and the registry row's removal, the last step of a shop's deletion, takes it in the same
  transaction, so a deleted shop is never listed, even when a notice it sent arrives after.

## The metering record

One record per call, stored under the shop: `id`, `at` (when the budget was reserved), `model`, `inputTokens`,
`outputTokens`, `millisatang`, `satang` (rounded up, for reading) and `outcome` (`ok`, `failed`, `unreadable` or
`abandoned`). Token counts are zero for the last three. Each month also keeps a total: millisatang spent, calls by
outcome, `refused`, tokens, the cap it was last measured against (`capSatang`) and its `crossings` of it. The records
are metadata only. No prompt or answer text is ever sent to the ledger, and a test checks that the export holds
neither.

Tenant export includes the meter as `model`: `{ capOverride, months, calls, holds }`, each month with its cap and
crossings. Tenant deletion wipes it with the rest of the TenantObject, before the tombstone, along with the notice
waiting to be sent, and clears the object's alarm; AuthObject's row goes with the registry row, last.

## Calling a model from code

```ts
const result = await callModel(env, tenant, {
  model: "claude-haiku-5-5",
  system: "You are Nam, the shop's sales chat.",
  messages: [{ role: "user", content: "มีไซซ์ M ไหมคะ" }],
  maxOutputTokens: 600,
});
```

`result` is one of:

- `{ ok: true, callId, text, stopReason, usage, costMillisatang, costSatang }`. Check `stopReason` before using
  the text: `refusal` and `max_tokens` are answers too.
- 400 `invalid_request` or `unknown_model`: the request could not be sent. Nothing is held.
- 402 `budget_exceeded` with `month`, `capSatang`, `spentSatang`, `heldSatang` and `neededSatang`. Under the worker
  contract, this ends the attempt with the reason `budget`.
- 403 `not_counted_in`: the shop's owner made it (self-serve) and no operator has counted it in yet, so its team
  spends nothing on the model, whatever its cap. Nothing is held or sent, and it is not counted in the month's
  `refused`. Under the worker contract the attempt fails with the reason `not_counted_in`.
- 503 `not_configured` with the `setting` that is missing or unreadable. Nothing is held or sent.
- 503 `meter_unavailable`: the ledger could not hold the call, so it was not made.
- 502 or 503 `provider_error` with `retryable` and `callId`.

One HTTP route makes a model call, and no other may: Buddy's chat, `POST /v1/chat/messages` (item 102l-1;
`docs/pilot-api.md`, "Chat"). Everything else calls `callModel` in code, as the Phase 4 workers do. The rule was that a
route would let anyone holding the operator key spend money from outside, and the chat keeps what it protected:

- It takes the shop's owner's own session and nothing else. The operator key, a helper's session, a link's token and an
  outpost's credential are refused before the gateway is asked, so nothing is held, called or counted for them.
- The shop is the session's, never a field, so an owner spends only on their own shop, inside that shop's own cap, and
  every refusal of the gateway's (`budget_exceeded`, `not_counted_in`, `not_configured`) reaches the owner as it is.
- It is behind its own switch (`buddyChat`), off by default; it needs the shop's consent to cloud work; and it allows 60
  messages an hour per shop, so even the owner's session cannot run up calls faster than a person types.
- It sends, posts, pays, deletes and starts nothing: Buddy only talks.

Each message is one call, held and settled like any other, so the shop's ledger shows one record per message. A new route
that calls a model needs the same: the owner's session, the shop's own cap, its own switch and its own tests that every
other credential is refused first.

## Operator routes

All three sit behind the admin gate (Cloudflare Access plus the operator key) as exact `ADMIN_METHODS` entries. The
tenant travels in the query or the body, never the path.

### `GET /v1/admin/model/usage?tenant=&month=`

A shop's spend, cap and calls for one Bangkok month: the current one, unless `month` (`YYYY-MM`) names another.

```json
{
  "tenant": "pilot:baan-somtam", "month": "2026-11",
  "capSatang": 20000, "capSource": "default", "capOverride": null,
  "spentSatang": 49, "spentMillisatang": 49000,
  "heldSatang": 0, "heldMillisatang": 0,
  "remainingSatang": 19951,
  "counts": { "ok": 2, "failed": 0, "unreadable": 0, "abandoned": 0, "refused": 0 },
  "tokens": { "input": 2000, "output": 1000 },
  "crossings": [],
  "calls": [{ "id": "call-…", "at": "2026-11-23T03:00:01.000Z", "model": "claude-sonnet-5-5",
              "inputTokens": 1000, "outputTokens": 500, "millisatang": 24500, "satang": 25, "outcome": "ok" }],
  "holds": []
}
```

`calls` lists the month's newest 200 records first. `holds` lists the reservations still open, each with its
`worstMillisatang` and when it `expiresAt`. `crossings` lists the thresholds the month's charged spend has reached,
lowest first, each `{ percent, at, capSatang, spentSatang, spentMillisatang }`: 80 or 100, when it was noted, the cap
it was measured against, and the spend then ("Alerts near the cap"). Errors: 400 `tenant_required`, 400
`invalid_request` (a month that is not one), 503 `not_configured` (a setting cannot be read).

### `PUT /v1/admin/model/cap`

`{ "tenant": "…", "capSatang": 15000 }` sets the shop's monthly cap in whole satang (0 to 1,000,000,000).
`"capSatang": null` clears the override, so the default applies again. `capSatang` must be present, so a body that
forgot it never clears a cap by accident. The answer is the effective cap:
`{ tenant, capSatang, capSource, capOverride }`, where `capOverride` records `setAt` and `setBy` (the operator's
Access identity, when Access gives one). A new cap applies from the next reservation; calls already holding budget
keep it. The current month is measured against the new cap in the same write: a lowered cap notes a threshold the
spend is already past, and a raised one takes off a crossing the spend is back under ("Alerts near the cap"). Errors:
400 `tenant_required`, 400 `invalid_request`.

### `GET /v1/admin/model/alerts`

The shops whose charged spend has reached 80% or 100% of their cap this Bangkok month, across all shops, from
AuthObject's record alone: one bounded read, and no shop's own object is asked. It takes nothing: the month is always
the API's current one, and a shop is listed only while it is on the registry.

```json
{
  "month": "2026-11",
  "shops": [{ "tenant": "pilot:baan-somtam", "percent": 100,
              "crossings": [{ "percent": 80, "at": "2026-11-20T03:00:00.000Z", "capSatang": 10000,
                              "spentSatang": 8000, "spentMillisatang": 8000000 },
                            { "percent": 100, "at": "2026-11-21T03:00:00.000Z", "capSatang": 10000,
                              "spentSatang": 10000, "spentMillisatang": 10000000 }] }],
  "truncated": false
}
```

`percent` is the highest threshold the shop's month has reached. The shops at their cap come first, then those near
it, the latest to cross first within each. One read lists at most 500 shops, and `truncated` says the month had more.
Errors: 503 `alerts_unavailable` (AuthObject could not be read).

## Not built yet

- **Streaming.** Calls wait for the whole answer, which is why one call may ask for at most 16,000 output tokens.
  A streaming provider would lift that.
- **Prompt caching, tool use and images.** The interface is plain text. Adding caching means pricing cache writes
  and reads properly instead of the conservative counts above.
- **Refusal fallbacks.** Anthropic can re-run a refused request on another model, billed at that model's price.
  The worst-case reservation cannot bound a model it does not know, so the fallback needs the meter to price
  `usage.iterations` first.
- **A message about a crossing.** A shop reaching 80% or 100% of its cap is noted, logged and listed on the
  console's Model spend page, and nothing is sent: LINE is parked by the owner and email sending is off. Sending one
  would read the same notice AuthObject keeps.
- **Earlier months on the list.** AuthObject keeps each shop's latest month only, which is what "this month" needs.
  An earlier month's crossings are in that month's usage and in the audit log.
