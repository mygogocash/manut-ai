# Connectors: access, cost and blockers

1. Only LINE is certain for 7 December. It needs no review: each shop turns on the Messaging API and gives us its channel credentials.
2. A reply token lasts about one minute, so every owner-approved reply is a push message, which counts against the shop's monthly quota. Replies are free.
3. LINE cost sits with each shop's plan: Free allows 300 counted messages a month and cannot buy more, Basic is ฿1,280 for 15,000, Pro is ฿1,780 for 35,000, before 7% VAT.
4. Shopee chat is closed to third parties and its rules prohibit chatbot replies. Lazada chat is open, but going live needs a Service Market listing and possibly two weeks of test calls.
5. Facebook and Instagram need business verification and App Review. A reply later than 24 hours is allowed only as a manual human reply within 7 days.

All sources were read on 23 November 2026; bracketed codes point to the list at the end. "Not stated" means the official pages read do not say.

## 1. LINE Official Account and Messaging API (Thailand)

### Reply versus push

- A reply token works once and "must be used within one minute after receiving the webhook" [L1].
- Replies are not counted. Push, multicast, broadcast and narrowcast are [L2]. Chat typed by hand in LINE's own chat screen and auto-replies are not counted either [T3].
- One counted message is one recipient per request: a push with up to five message objects to one customer counts once [L2].
- Over quota, the API answers 429 and nothing is sent [L2].

### Thailand plans [T1]

| Plan | Monthly fee | Counted messages | Extra message |
| --- | --- | --- | --- |
| Free | none | 300 | not offered |
| Basic | ฿1,280 | 15,000 | ฿0.10 |
| Pro | ฿1,780 | 35,000 | ฿0.06 |

Prices exclude 7% VAT. Two older LINE pages show ฿0.08 and ฿0.04 per extra message [T2] and 500 free messages [T3]. A notice of 18 June 2024 set Free at 300 and Pro's extra price at ฿0.06 from 1 August 2024 [T4], so the table looks current; confirm in each shop's account. Free allows about 10 late replies a day.

### What a shop must do

1. Turn on the Messaging API in LINE Official Account Manager, which creates the channel. The Developers Console no longer creates channels [L3].
2. Choose a provider at that step. It cannot be changed, and LINE warns against a provider owned by a tool company [L3], so each shop should create its own.
3. Hand over the channel ID and channel secret (visible to the channel Admin only), or invite our developer as channel Admin [L4].
4. Set the webhook URL and enable "Use webhook" and "Webhook redelivery". A channel has one webhook URL, so a shop using another chat tool must choose [L5, L6].

Tokens [L7]: long-lived never expires, one per channel. Short-lived lasts 30 days. Version 2.1 (signed JWT, up to 30 days) is the one LINE recommends [L5]. Stateless lasts 15 minutes, cannot be revoked, and is issued from the channel ID and secret alone [L1].

One provider for many shops: a module channel attaches to many accounts through OAuth, but only corporate customers who apply may use it, and only as a paid extension on LINE Marketplace, a Japanese-language site. Thailand availability is not stated [L8]. Plan on per-shop credentials.

### Webhook, retries and limits

- Signature: `x-line-signature` is the Base64 HMAC-SHA256 of the request body under the channel secret [L9].
- Redelivery is off by default. When on, LINE resends if the server did not answer 2xx; the count and interval are not disclosed. Duplicates are found by `webhookEventId` [L6].
- Rate limits are per channel: push and reply 2,000 requests a second, multicast 200 [L1].
- `X-Line-Retry-Key` is a UUID, accepted on push, multicast, narrowcast and broadcast but not reply, valid 24 hours. A repeat answers 409 [L10].

### Terms

- A shop "may grant authority necessary for operation of the Accounts to third parties and may consign operation" (article 6.4). Lending or sharing the account itself is prohibited (article 17) [L11].
- Under the API terms the shop may name an "Operator" and is liable for it. No other third party may use the credentials or receive user information without LINE's written consent, and users must see the shop's name and a privacy policy (articles 4 and 5) [L12]. Manut AI and its human operators should act as each shop's named operator.
- Telling users that a bot or an AI is answering: not stated in the LINE terms read [L11, L12, L13].

## 2. Shopee Open Platform (Thailand)

- Registration: sign up at open.shopee.com and submit a profile. Seller accounts serve only their own shop and in Thailand must be Mall or Managed sellers. Third parties register as a Third-party Partner Platform [S1].
- Third-party criteria: a registered business whose "business product has to be live, with existing ecommerce integrations", shown through a trial account on HTTPS with security rating "A" [S1].
- Review: third-party profile 10 working days, seller profile 3. Go-live review takes 24 hours [S1, S2].
- App types: ERP System ("All API except Chat API and Ads API"), Product, Order, Accounting, Marketing, Customer Service and Seller In-house ("All API including Chat API"). No account type is ticked for Customer Service [S2].
- Chat: restricted. "The Chat feature is no longer available for Third-party Partner Platform (ISV) developers" [S3]. Customer Service app applications from third parties "have been closed since November 18, 2024" [S4]. The partner rules list "chatbot replies" as abuse of the Chat API [S5].
- Orders and products: open to an ERP System app [S2]. Buyer name, phone and address stay masked until a penetration test report is approved, typically within 10 working days [S6].
- Seller authorisation: the seller logs in through our link, valid up to 365 days. Access tokens last 4 hours, refresh tokens 30 days [S7].
- Sandbox: yes, with test shops, orders and push [S8]. Rate limits and fees: not stated.

## 3. Lazada Open Platform (Thailand)

- Registration: partner type "Enterprises Commercial", with a business registration document, reviewed within 3 business days [Z1]. Then the Software Developer role and the Service Provider role, which is irreversible [Z2].
- App categories for third parties: ERP System and ERP IM Chat, usually approved the same day [Z3].
- Chat: open. The permission is "held only by IM-type Apps (ERP IM Chat / In-house IM Chat)" [Z4]. Seven APIs list sessions and messages, send, recall, mark read and open a session; webhooks push new messages after a 24-hour start-up [Z4, Z5].
- Sending late: a seller may open a new conversation only while the buyer's order is at most 7 days old. A time limit for replying in an existing session is not stated [Z5].
- Seller authorisation: in test, the seller logs in and authorises. Once a commercial app is online, Thai sellers must first subscribe to it in Lazada Service Market [Z6], whose steps are each reviewed in 1 to 3 working days [Z7].
- Tokens: test apps about 1 day. Online apps 30 days, refresh 180 days. Subscription tokens last the subscription, up to 18 months [Z4].
- Going online: one page dated 2024 requires more than 1,000 calls a day at 95% success for two weeks first [Z8].
- Sandbox: test accounts and orders [Z8]. Limits: 10,000 calls a day in test, 10,000,000 online [Z4]. Buyer data is masked until a security review [Z9]. Fees: not stated.

## 4. Facebook Pages, Messenger and Instagram

- Access: standard access reaches only people with a role on the app or Page. Real customers need advanced access, which needs App Review and business verification [M1, M2].
- Messenger permissions: `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `pages_read_engagement`, `business_management`. Instagram through a linked Page adds `instagram_basic` and `instagram_manage_messages` [M1]. The Instagram Login route uses `instagram_business_basic` and `instagram_business_manage_messages` [M3].
- Publishing: Page posts need `pages_manage_posts` and `pages_read_engagement` [M4]. Instagram needs `instagram_content_publish` or `instagram_business_content_publish`, with 100 API posts per 24 hours [M5].
- Window: 24 hours after most user actions [M6]. After it, the Human Agent tag lets "a business representative" reply manually within 7 days; it needs App Review and business verification [M7, M8]. The three update tags have returned an error since 27 April 2026 [M8].
- Whether an AI draft that a person approved counts as a manual reply: not stated.
- Bot disclosure: required where law requires it, otherwise recommended [M6].
- Review: an App Review decision "within a week" [M9]. Business verification time: not stated [M2].
- Limits: Messenger allows 200 calls per engaged user per 24 hours; Instagram's Send API allows 100 text calls a second [M10]. Fee per message: none stated.

## 4a. FlowAccount (the books)

Checked 24 Nov 2026 on FlowAccount's developer pages [F1-F4]. Ton's "Send the books to FlowAccount" needs it.

- **Access is not self-serve.** A company asks for Open API access through a form (form.flowaccount.com/request-openapi).
  FlowAccount's staff answer in 1 to 2 business days and set up a sandbox account with client credentials. The sandbox
  works for 30 days from when it is made [F2].
- **Production costs money.** The company subscribes to a package through FlowAccount's staff, who email the client
  credentials to the business's main owner within 3 business days [F2]. Each FlowAccount user who connects through
  the OpenID flow must hold an annual Pro Business subscription; the pricing page lists Pro Business at ฿457 a month,
  or ฿5,490 a year paid annually, with a 30-day free trial, and names "Connect your business with FlowAccount via Open
  API" among its features [F2, F4].
- **Two ways to connect.** Client credentials, for a company connecting its own system (`grant_type`
  `client_credentials`, scope `flowaccount-api`, a token that lasts about a day; sandbox token URL
  `https://openapi.flowaccount.com/test/token`) [F1]. Or the OpenID flow, for a partner app: the user signs in to
  FlowAccount, picks a business, and the app receives a code, with `offline_access` for a refresh token that lasts
  about 30 days from the last use [F3]. Partners apply through OpenAPI support with their scope of use and redirect URL
  [F2]. The client-credentials page's example sends `grant_type=refresh_token` while its table says
  `client_credentials`; confirm with FlowAccount before building. No page read gives the production token URL.
- **Documents.** The Document API creates tax invoices, receipts, quotations, billing notes, cash invoices, purchase
  orders and receiving inventory, by `documentType` (tax invoice 7, receipt 9, cash invoice 35) [F2]. No page read lists
  an expense document, though the product has expense notes; the "Supplier Invoice" pages may be the nearest.
- **For Manut AI:** the partner route (the OpenID flow) fits many shops: each shop signs in to its own FlowAccount and
  picks its business, and no shop's client secret is ever typed into Manut AI. It needs the owner to apply as an app
  partner, and each shop needs its own Pro Business plan. Until then Ton only drafts the books.

## 4b. Google Sheets (Ton's rows)

Checked 24 Nov 2026 on Google's pages [G1, G2]. `@manut/sheets-rows` already builds the append request.

- **The scope decides the review.** The read-write scope `https://www.googleapis.com/auth/spreadsheets` is sensitive:
  no ordinary account can grant it until Google has verified the app, which needs every scope declared, a written
  reason and a demo video for each sensitive one, and can take up to 10 days after a brand check [G1, G2].
- **`drive.file` avoids it.** Google recommends the non-sensitive `https://www.googleapis.com/auth/drive.file`, which
  reaches only the files the user opens or makes with the app [G1]. With the Google Picker, the owner picks the one
  sheet Ton writes to, and Manut AI can reach that sheet and nothing else in their Drive. That is also the smaller
  promise to make an owner.
- **For Manut AI:** an OAuth client in a Google Cloud project of the owner's, with `drive.file` only, an OAuth consent
  screen naming Manut AI, and the Picker's API key. The token goes into the credential vault, as LINE's does.

**Built, off until the owner's OAuth client exists** (December item 34; the routes are `docs/pilot-api.md`, "Google
Sheets for Ton's books"). The owner connects their Google account from their own session (OAuth for web server apps,
with PKCE and a one-use state), the refresh token is sealed in the vault, and on first use Ton makes one spreadsheet,
"Manut AI books: {shop}" with a `Books` tab, which the app can reach under `drive.file`. Each month's append is asked
through approval-core, owner-only, naming the sheet, the month, the rows and their totals, and sent once on approval. The
sheet's record in the vault keeps what was appended to it (the month, when, how many rows and how it ended, never the
rows), so a month already sent, or sent with no answer learnt, is asked for again only with that said first, and two
requests for one month cannot both write it unannounced. Deleting a shop's data revokes its Google token at Google before the
vault forgets it, and says when Google could not be reached. On the desktop, Customize › Connections has the owner's Google
Sheets row (Connect opens Google's page in the system browser; Send a month's books asks Ton, who asks the owner in Needs you
with the whole text), and says that Google Sheets isn't set up for Manut AI yet while the API answers `google_not_configured`.
Until `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are Wrangler secrets every Google route answers
`google_not_configured`; no environment sets them. The Picker (the owner choosing an existing sheet) comes later.

What the owner makes to turn it on, in a Google Cloud project of their own [G3, G4, G5]:

1. **The project**, with the Google Sheets API enabled in its API Library.
2. **The consent screen** (the Branding page in the Cloud Console): app name "Manut AI", a support email, the privacy
   policy and home page links, and the API's domain (`manut.xyz`), for External users. The app asks for the one scope
   `https://www.googleapis.com/auth/drive.file`, which Google counts as non-sensitive, so no scope verification is
   needed. Then **publish the app** out of Testing: while it is in Testing only listed test users can sign in, and their
   refresh tokens end after 7 days, which would break the connection every week. Google shows "Manut AI" and its logo
   on its consent page only after brand verification, a lighter check than the sensitive-scope review [G5].
3. **The OAuth client** (the Clients page, Create client): type "Web application", with one authorised redirect URI,
   exactly `https://<the API's host>/v1/google/callback` (for dev, `https://dev.manut.xyz/v1/google/callback`).
4. **The two secrets**, per environment: `wrangler secret put GOOGLE_CLIENT_ID` and `wrangler secret put
   GOOGLE_CLIENT_SECRET` in `apps/api`. Nothing else changes: the routes start answering, and nothing reaches Google
   until an owner connects.

A refresh token also stops working after six months unused, which a monthly append keeps from happening, or when the
owner removes Manut AI in their Google account; the connection then reads as broken and the owner connects again [G4].

## 5. Comparison

| Channel | Read | Send after a delay | Approval | Stated lead time | Cost per message | Biggest risk |
| --- | --- | --- | --- | --- | --- | --- |
| LINE | Yes, webhook | Yes, as push | None; shop's credentials | None | Reply free; push within plan, then ฿0.10 or ฿0.06 | Free plan stops at 300 |
| Shopee | No | No | Closed to third parties | 10 working days (orders only) | Not stated | No chat route |
| Lazada | Yes | Yes; limit not stated | ERP IM Chat app, Service Market | Days, plus two weeks of tests | Not stated | Go-live rule and subscription step |
| Facebook, Instagram | Yes | 24 hours; 7 days manual | App Review, business verification | A week; verification not stated | None stated | Late replies need Human Agent |

## 6. What to apply for this week

1. LINE, per shop (manager.line.biz, developers.line.biz/console): the account ID, its plan, whether another tool holds the webhook, a signed appointment of Manut AI as operator, a privacy policy URL.
2. Lazada (open.lazada.com/apps/user/register): company registration document, legal name, owner's name, address, a mobile number and email never used for a Lazada store, a 200 by 200 logo [Z1, Z2]. Then apply for ERP IM Chat and the Service Market qualification, with an English service description [Z7].
3. Meta (developers.facebook.com): start business verification, then submit App Review for the permissions above and Human Agent: a screen recording and description for each, a privacy policy URL, a 1024 by 1024 icon [M9].
4. Shopee (open.shopee.com), orders and products only: business documents, a live product with a trial account, later a penetration test report [S1, S6]. Ask Shopee in writing whether any chat route exists.
5. FlowAccount (form.flowaccount.com/request-openapi): ask for Open API access as an app partner, with the scope of use
   and the redirect URL, for the OpenID flow; a sandbox comes first, and each shop needs its own Pro Business plan.
6. Google Cloud: a project of the owner's with an OAuth client and consent screen for `drive.file` only (no
   verification needed for that scope), published to production, with the redirect URI in 4b; then the two Wrangler
   secrets. The Google Picker's API key is for the later step that lets the owner choose an existing sheet.

## Sources

Shopee and Lazada pages are JavaScript apps; their text was read from the data each page loads.

- L1 https://developers.line.biz/en/reference/messaging-api/
- L2 https://developers.line.biz/en/docs/messaging-api/pricing/
- L3 https://developers.line.biz/en/docs/messaging-api/getting-started/
- L4 https://developers.line.biz/en/docs/line-developers-console/managing-roles/
- L5 https://developers.line.biz/en/docs/messaging-api/building-bot/
- L6 https://developers.line.biz/en/docs/messaging-api/receiving-messages/
- L7 https://developers.line.biz/en/docs/basics/channel-access-token/
- L8 https://developers.line.biz/en/docs/partner-docs/module/
- L9 https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
- L10 https://developers.line.biz/en/docs/messaging-api/retrying-api-request/
- L11 https://terms2.line.me/official_account_terms_th?lang=en (updated 18 July 2025)
- L12 https://terms2.line.me/official_account_api_terms_th?lang=en (updated 26 November 2024)
- L13 https://terms2.line.me/official_account_guideline_th?lang=en and https://terms2.line.me/LINE_Developers_Agreement?lang=en
- T1 https://lineforbusiness.com/th/service/line-oa-features
- T2 https://lineforbusiness.com/th/service/line-official-account/additional-message
- T3 https://lineforbusiness.com/th-en/helpcenter/line-oa
- T4 https://lineforbusiness.com/th/news/20240619_1
- S1 https://open.shopee.com/developer-guide/12 (updated 10 September 2026)
- S2 https://open.shopee.com/developer-guide/14
- S3 https://open.shopee.com/faq/716 (updated 10 November 2026)
- S4 https://open.shopee.com/faq/56 (updated 16 November 2026)
- S5 https://open.shopee.com/developer-guide/34
- S6 https://open.shopee.com/developer-guide/718
- S7 https://open.shopee.com/developer-guide/20
- S8 https://open.shopee.com/developer-guide/644
- Z1 https://open.lazada.com/apps/doc/doc?nodeId=10533&docId=121098
- Z2 https://open.lazada.com/apps/doc/doc?nodeId=10533&docId=108001
- Z3 https://open.lazada.com/apps/doc/doc?nodeId=10533&docId=108002
- Z4 https://open.lazada.com/apps/doc/doc?nodeId=10551&docId=239755 (updated 16 September 2026)
- Z5 https://open.lazada.com/apps/doc/doc?nodeId=10544&docId=120971
- Z6 https://open.lazada.com/apps/doc/doc?nodeId=10533&docId=108260
- Z7 https://open.lazada.com/apps/doc/doc?nodeId=10533&docId=121772
- Z8 https://open.lazada.com/apps/doc/doc?nodeId=10432&docId=108444 (updated 19 July 2024)
- Z9 https://open.lazada.com/apps/doc/doc?nodeId=10432&docId=108297
- M1 https://developers.facebook.com/docs/messenger-platform/overview
- M2 https://developers.facebook.com/docs/development/release/business-verification
- M3 https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
- M4 https://developers.facebook.com/docs/pages-api/posts
- M5 https://developers.facebook.com/docs/instagram-platform/content-publishing
- M6 https://developers.facebook.com/docs/messenger-platform/policy/policy-overview
- M7 https://developers.facebook.com/docs/features-reference/human-agent
- M8 https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages
- M9 https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review/submission-guide
- M10 https://developers.facebook.com/docs/graph-api/overview/rate-limiting
- F1 https://developers.flowaccount.com/tutorial/connect/client-credentials-flow
- F2 https://developers.flowaccount.com/tutorial/connect-open-api, https://developers.flowaccount.com/tutorial/document-api/ and https://developers.flowaccount.com/tutorial/document-type/
- F3 https://developers.flowaccount.com/tutorial/connect/open-id-flow
- F4 https://flowaccount.com/en/developers and https://flowaccount.com/en/pricing
- G1 https://developers.google.com/workspace/sheets/api/scopes
- G2 https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
- G3 https://developers.google.com/identity/protocols/oauth2/web-server (checked 24 Nov 2026: the authorization,
  token, refresh and revoke endpoints and parameters) and https://developers.google.com/identity/protocols/oauth2/native-app
  (the PKCE S256 challenge)
- G4 https://developers.google.com/identity/protocols/oauth2 ("Refresh token expiration": 7 days in Testing, six months
  unused, 100 per account per client)
- G5 https://developers.google.com/identity/protocols/oauth2/production-readiness/overview (publishing status and
  verification)
