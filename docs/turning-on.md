# Turning things on

Several parts of Manut AI are built, tested and deployed to dev, and stay off until the owner turns them on. Each one
waits for something only the owner can give: a yes, an account, money, or a decision. This page lists every switch in
one place. Every route behind a switch answers plainly that it is not on (for example 400 `email_not_configured` or 503
`google_not_configured`) until it is turned on, so a switch can be turned on in dev first and checked there.

Secrets go in with `wrangler secret put <NAME>` from `apps/api`, for one environment at a time (`--env dev`, and later
staging and production). They never go in a file in the repository. Vars go in that environment's `vars` in
`apps/api/wrangler.jsonc`. The dev deploy check refuses any config that sets a test-only var (`TEST_…`), or a
`PUBLIC_API_ORIGIN` under `.test`, in any block, staging and production included; and the API honours the test-only
settings only where `PUBLIC_API_ORIGIN` is under `.test`, so one set as a secret does nothing.

## Built, and off until the owner says

**The security review of 24 Nov 2026, now fixed:** a review of the API surface added that day found ways a stranger
could misuse email sign-in and self-serve once they are on (sending codes without a real limit, making shops without
one, and more). December item 41 fixed the front door: a body must be JSON, every limit counts per address or IPv6 /64,
codes are capped per address, per source and in all (`docs/pilot-api.md`, "Signing in by email"), an email sign-in is
refused on the lifted routes and on every shop route of its own tenant, and the test keys work only on a `.test`
origin. Item 42 fixed sessions and self-serve: ended sessions are swept and a wipe reads only its own tenant's, a
deletion is limited per address and opening shop sessions per person, a helper keeps at most 10 sessions, the web
app's shop cookies need the sign-in, every page has a script policy, at most 20 shops are made in a day by all accounts
together, and a shop its owner made does no work and spends nothing until an operator counts it in. Neither switch
waits on the review any more: each waits only for what its row below needs from the owner.

| What | The switch | What it needs from the owner | Details |
| --- | --- | --- | --- |
| Sign-in by a code sent by email (the API, the desktop's Settings › Developer, the web's join page) | var `EMAIL_SIGN_IN` set to `"on"`, the `send_email` binding `EMAIL`, and vars `EMAIL_FROM_ADDRESS` and `EMAIL_FROM_NAME` | A yes; the Workers Paid plan; a sending domain onboarded to Cloudflare Email Service, with the sender's address and name; the Thai words for the email | `docs/sign-in-options.md`; `docs/pilot-api.md`, "Signing in by email" |
| Sign in with Apple | var `APPLE_CLIENT_ID` | The owner's Apple Developer account (the owner has one, the business's, an organization, 25 Nov 2026): the app's identifier and a Services ID for Sign in with Apple, and the Mac app signed by that team. Before it is turned on, Apple's sign-ins (`apple:`) must be refused on the lifted routes as email's are (`REFUSED_PERSON` in `apps/api/src/index.ts`), with the lifted routes' own tests moved off Apple tenants: anyone with an Apple ID could otherwise use them | `docs/sign-in-options.md`; `docs/pilot-api.md`, "What a person's own sign-in reaches" |
| Self-serve onboarding (a person makes their own shop) | var `SELF_SERVE_SHOPS` set to `"on"` | Who may sign up; whether self-serve shops are their own cohort, and their price; the Thai words; whether 20 new shops a day, all accounts together, is right (`SELF_SERVE_MAKES_PER_DAY`); and someone to count each new shop in (the console's Count it) before its team does any work. Sign-in must be on first | `docs/several-shops.md`; `docs/pilot-api.md` |
| Google Sheets for Ton's books | secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` | A Google Cloud project of the owner's: the Sheets API on; the consent screen named Manut AI and published out of Testing (in Testing, refresh tokens end after 7 days); a Web client whose one redirect is `https://<API host>/v1/google/callback` | `docs/connectors.md`, 4b |
| Signed and notarized Mac builds in the release workflow (item 63) | Five Apple secrets in GitHub (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`); without them the workflow still builds, unsigned, and says so | The business's Apple Developer account (an organization): a Developer ID Application certificate, and an app-specific password | `docs/releasing.md`, "Needs the owner" |
| Real models for the AI team | secret `ANTHROPIC_API_KEY`; vars `MODEL_SATANG_PER_USD` (default 3500, ฿35.00 a dollar) and `MODEL_DEFAULT_CAP_SATANG` (default 20000, ฿200 a shop a month) | Not wanted yet: on 25 Nov 2026 the owner said people bring their own model, by their coding agent's CLI login or their own API key in it. When wanted: a paid Anthropic account; the exchange rate; each shop's monthly cap | `docs/model-gateway.md` |
| Routines running, and the team's cloud work | `PUT /v1/admin/flags` with `officeRoutines` and `officeCloud` (the console's operator key) | The owner's go. Each shop also gives its own consent to cloud work, from the owner's app or link | `docs/handoff.md`; `docs/pilot-api.md` |
| Any write that leaves the app (a reply sent, a form submitted, a sheet appended) | `PUT /v1/admin/flags` with `officeExternalWrites`, as well as each write's own approval | The owner's go-ahead, and for the first browser write on a real site (a Shopee chat reply, say) a supervised trial | `docs/browser-control.md` |
| LINE messages coming in | `PUT /v1/admin/flags` with `officeInbound` | LINE is parked by the owner; it needs a LINE Official Account for a test shop first | `docs/connectors.md`, 1 |
| The live feed: a connected desktop shows a change at a shop within seconds instead of at its next one-minute read | `PUT /v1/admin/flags` with `shopFeed` (the console's operator key); var `SHOP_FEED` is its default, and no environment sets it | The owner's go, and a desktop build from `feat/live-feed` or later, whose CSP lets the page reach Manut AI's own API hosts and which opens each socket with a one-use ticket, so no session reaches Cloudflare's request logs. Running apps take it up within an hour, or at their next start. What it costs is below | `docs/pilot-api.md`, "The shop's live feed"; `docs/runtime-adapter.md`, "The live feed" |
| Artifact links: an HTML or Markdown page published as a link anyone with it can open (the API, the desktop's Artifacts page and Settings › Artifacts, item 83) | `PUT /v1/admin/flags` with `artifactLinks` (var `ARTIFACT_LINKS` is its default, and no environment sets it); var `ARTIFACT_ORIGIN`, the links' own web address; and on each Mac, Settings › Artifacts › Allow publishing public artifact links, off by default | A sign-in turned on (a link belongs to a shop's account: email or Apple, rows above); a domain of its own for other people's pages, routed to this Worker as a custom domain, never `manut.xyz` or a host under it (`docs/pilot-api.md`, "The artifact origin"); the words of use for public content, which every person agrees to before their first link; and how a link is taken down on a complaint (today only the shop's owner can remove one, or the operator can switch every link off at once). What it costs is below | `docs/pilot-api.md`, "Artifact links" |

### What the live feed costs on Cloudflare

From Cloudflare's Durable Objects pricing (developers.cloudflare.com/durable-objects/platform/pricing/, read on 25 Nov 2026):

- **Requests.** The Workers Paid plan includes 1 million a month, then $0.15 a million (the Free plan: 100,000 a day). HTTP
  requests, WebSocket messages and alarms all count. A request is needed to create a WebSocket connection; outgoing WebSocket
  messages are not billed, nor are incoming WebSocket protocol pings, and other incoming WebSocket messages count 20 to 1.
- **Duration.** Paid includes 400,000 GB-s a month, then $12.50 a million GB-s (Free: 13,000 GB-s a day). An object is billed
  while it runs, or while it sits idle in memory unable to hibernate; one that is idle and able to hibernate is not billed, even
  before the runtime hibernates it. Messages answered by `setWebSocketAutoResponse` take no wall-clock time and are not charged.

What that makes for the feed, counted from the code (the pilot's figure is an estimate):

| What | Durable Object requests | Duration |
| --- | --- | --- |
| A socket opening, once an hour and after a drop: the desktop's ticket and its upgrade | 4: at the mint, the session checked, the switch read and the ticket kept; at the upgrade, the connection itself, where the shop's object checks the ticket and the session from what it holds. The mint adds the ticket's request, and the upgrade no longer checks the session or reads the switch in the Worker; and 2 Worker requests | Milliseconds |
| The alarm that ends a socket's hour | 1 | Milliseconds |
| A socket's keepalive, every 50 seconds | About 86 a day (1,728 messages, at 20 to 1) | None: the runtime answers it without the object |
| A socket that sits open | None | None: the object hibernates |
| A write the shop's object already takes, while it has sockets | None more | Up to a second more awake, until its ping goes: about 0.125 GB-s at 128 MB |
| A task's own change, while someone follows the shop | 1: its call to the shop's object | Milliseconds, then as above |
| A task's own change, while nobody follows the shop (every shop while the switch is off) | At most 1 a minute for a busy task | Milliseconds |
| The switch, read while a shop pings | At most 1 a minute for each shop with sockets | Milliseconds |
| A ping | None: an outgoing message | None more |

So one socket costs about 6,200 requests a month (5 an hour to keep it open, and about 86 a day for its keepalive), and no
duration while it is idle. The pilot's ten shops with two desktops each, twenty sockets, come to about 124,000 requests a month,
inside the Paid plan's million. What a busy shop adds is reads: each ping makes every desktop that follows the shop read it
again, at most once in 15 seconds each, so a desktop reads a busy shop up to four times a minute instead of once, each read the
same requests the minute's read makes now. A quiet shop is read once a minute, as now.

### What artifact links cost on Cloudflare

They use the shop's own Durable Object and nothing new: no R2, no KV, no new product. From Cloudflare's Durable Objects
pricing (developers.cloudflare.com/durable-objects/platform/pricing/, read on 25 Nov 2026), SQLite storage on the Workers Paid
plan includes 25 billion rows read and 50 million rows written a month (then $0.001 a million read and $1.00 a million
written) and 5 GB-month of stored data (then $0.20 a GB-month); the Free plan allows 5 million rows read and 100,000 written a
day and 5 GB in all. A key-value `get`, `put` or `delete` on a SQLite-backed object counts as rows read or written. Workers
requests: the Paid plan includes 10 million a month, then $0.30 a million (Workers pricing, read the same day). The rate limit
binding's own pricing was not checked.

Counted from the code:

| What | Requests | Storage rows |
| --- | --- | --- |
| A publish | 1 Worker request; Durable Object requests for the session check, the switch, the shop's record and the write | About 4 written (the record, the text, the way in, the audit entry) and one read per link the shop holds, for the cap |
| The owner's list | 1 Worker request; the session, the switch, the shop's record and the read | One read per link |
| A removal | 1 Worker request; the session, the shop's record and the write | 1 read, 4 written |
| A visit to a link | 1 Worker request and 1 request to the shop's object; the switch is read from the AuthObject at most twice a minute per Worker instance | 3 read, none written |

Storage: a shop holds at most 50 links of at most 128 KiB each, 6.25 MiB, so the pilot's ten shops hold at most 62.5 MiB,
inside the included 5 GB-month. A page opened 10,000 times a month is 10,000 Worker requests, 10,000 object requests and
30,000 rows read, inside the Paid plan's inclusions. Visits are limited to 120 a minute from one address.

## Not built, and waiting on the owner

| What | Why it waits | Details |
| --- | --- | --- |
| LINE: approval cards and the morning brief on LINE, the LINE client, LINE Login | Parked by the owner on 23 November (`feat/owner-line-cards` holds the cards and the brief, not merged) | `docs/connectors.md`, 1 |
| Payments: PromptPay billing, payment slips, refunds | Parked by the owner on 23 November | `docs/plan.md` |
| FlowAccount for Ton's books | FlowAccount's Open API is by application, as an app partner, with a 30-day sandbox; each shop needs a Pro Business plan | `docs/connectors.md`, 4a |
| Shopee, Lazada and Meta | Shopee's chat API is closed; Lazada and Meta need applications | `docs/connectors.md` |
| A cloud outpost (a browser in Cloudflare instead of this Mac) | Workers Paid, about $8 a month above the plan for ten pilot shops, and the owner's word that shops' sites may be reached from Cloudflare's addresses | `docs/browser-control.md`, "Next slices" |
| Kit's dial for a coding session in its own terminal (December item 30) | The owner's call on whether Kit's lanes are a chat or a terminal; the dial, the lanes and Rewind reach chat sessions only | `docs/code-editor.md` |
| Staging and production | A separate Cloudflare account, and the owner's go for each deploy | `docs/handoff.md` |
| Phone apps | The roadmap's "Desktop comes first": phone apps wait until the desktop product is complete; the installable web app covers the owner's pages on a phone until then | `docs/plan.md` |

## Checks the owner does by hand

- A real-phone pass of the owner's pages, about ten minutes: `docs/phone-pass.md`.
- The console behind Cloudflare Access: open https://dev.manut.xyz/ops and use "Send login code".
- Notifications on a built app (not `tauri dev`), to see their buttons.
