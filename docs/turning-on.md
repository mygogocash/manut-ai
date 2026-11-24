# Turning things on

Several parts of Manut AI are built, tested and deployed to dev, and stay off until the owner turns them on. Each one
waits for something only the owner can give: a yes, an account, money, or a decision. This page lists every switch in
one place. Every route behind a switch answers plainly that it is not on (for example 400 `email_not_configured` or 503
`google_not_configured`) until it is turned on, so a switch can be turned on in dev first and checked there.

Secrets go in with `wrangler secret put <NAME>` from `apps/api`, for one environment at a time (`--env dev`, and later
staging and production). They never go in a file in the repository. Vars go in that environment's `vars` in
`apps/api/wrangler.jsonc`. The dev deploy check refuses any config that sets a test-only var (`TEST_…`).

## Built, and off until the owner says

**Not yet, whatever the owner decides:** a security review of the API surface added on 24 Nov 2026 found ways a stranger
could misuse email sign-in and self-serve once they are on (sending codes without a real limit, making shops without
one, and more). Leave `EMAIL_SIGN_IN` off until December item 41 has merged. Self-serve no longer waits for item 42, whose
fixes are in (a day's cap on makes for all accounts together, and a shop its owner made does no work and spends nothing
until an operator counts it in), but it needs email sign-in on first, so `SELF_SERVE_SHOPS` stays off until item 41 has
merged too.

| What | The switch | What it needs from the owner | Details |
| --- | --- | --- | --- |
| Sign-in by a code sent by email (the API, the desktop's Settings › Developer, the web's join page) | var `EMAIL_SIGN_IN` set to `"on"`, the `send_email` binding `EMAIL`, and vars `EMAIL_FROM_ADDRESS` and `EMAIL_FROM_NAME` | A yes; the Workers Paid plan; a sending domain onboarded to Cloudflare Email Service, with the sender's address and name; the Thai words for the email | `docs/sign-in-options.md`; `docs/pilot-api.md`, "Signing in by email" |
| Sign in with Apple | var `APPLE_CLIENT_ID` | The Apple Developer Program as an organization ($99 a year), the app's identifier, and the Mac app signed by that team | `docs/sign-in-options.md` |
| Self-serve onboarding (a person makes their own shop) | var `SELF_SERVE_SHOPS` set to `"on"` | Who may sign up; whether self-serve shops are their own cohort, and their price; the Thai words; whether 20 new shops a day, all accounts together, is right (`SELF_SERVE_MAKES_PER_DAY`); and someone to count each new shop in (the console's Count it) before its team does any work. Sign-in must be on first | `docs/several-shops.md`; `docs/pilot-api.md` |
| Google Sheets for Ton's books | secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` | A Google Cloud project of the owner's: the Sheets API on; the consent screen named Manut AI and published out of Testing (in Testing, refresh tokens end after 7 days); a Web client whose one redirect is `https://<API host>/v1/google/callback` | `docs/connectors.md`, 4b |
| Real models for the AI team | secret `ANTHROPIC_API_KEY`; vars `MODEL_SATANG_PER_USD` (default 3500, ฿35.00 a dollar) and `MODEL_DEFAULT_CAP_SATANG` (default 20000, ฿200 a shop a month) | A paid Anthropic account; the exchange rate; each shop's monthly cap | `docs/model-gateway.md` |
| Routines running, and the team's cloud work | `PUT /v1/admin/flags` with `officeRoutines` and `officeCloud` (the console's operator key) | The owner's go. Each shop also gives its own consent to cloud work, from the owner's app or link | `docs/handoff.md`; `docs/pilot-api.md` |
| Any write that leaves the app (a reply sent, a form submitted, a sheet appended) | `PUT /v1/admin/flags` with `officeExternalWrites`, as well as each write's own approval | The owner's go-ahead, and for the first browser write on a real site (a Shopee chat reply, say) a supervised trial | `docs/browser-control.md` |
| LINE messages coming in | `PUT /v1/admin/flags` with `officeInbound` | LINE is parked by the owner; it needs a LINE Official Account for a test shop first | `docs/connectors.md`, 1 |

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
