# Sign-in: the options, what each costs, and what each unblocks

Real sign-in is the one decision that holds up the most: the desktop answering for a real owner, helpers joining
through an invite (the join page, December item 10), a phone version of the owner's pages (item 17) and phone apps,
and a first run against a live API with real shop sessions. Today the backend has the lifted Sign in with Apple
(`apps/api/src/auth.ts`), which works only with a test key, because a real one needs an Apple developer team. This note
lays out the three ways to a real sign-in, checked 24 Nov 2026, so the owner can choose. Codes by email are now built
in the backend and off until the owner turns them on (below); nothing is bought.

## The three ways

| | Sign in with Apple | A code sent by email | LINE Login |
| --- | --- | --- | --- |
| Who it suits | Owners and helpers with an Apple ID | Everyone with an email address | Everyone with LINE, most of Thailand |
| What it needs | The Apple Developer Program, as an organization; the app signed by that team; `APPLE_CLIENT_ID` on the Worker | Sending email from the Worker: Cloudflare Email Service, in public beta since 16 April 2026, on the Workers Paid plan | A LINE Login channel on the owner's LINE account |
| What it costs | $99 a year [A1] (one report of ฿3,590 in Thailand [A2]) | About 3,000 emails a month with the plan, then $0.35 a thousand [C1, C2]; a code per sign-in, so a pilot's use is free | Free |
| Built today | Yes, with a test key | Built, off until the owner turns it on: the route for a code, its check and its limits (24 Nov 2026); the app's screens are not | No |
| What it unblocks | The Mac app signed in; helpers whose Apple ID verifies the invited email | Every person on every device, the phone included, and email invites as the canvas draws them | Invites to a LINE account, as the canvas draws them ("sign in with their own LINE or email") |
| What holds it back | A helper who hides their email from Apple cannot accept an email invite | Emails may land in spam until the sending domain is set up; Email Service is a beta | The owner parked LINE work |

## Recommendation

Codes by email first, Apple second. Codes by email reach owners and helpers on every device at almost no cost, on
the platform the backend already runs on, and match the canvas's "their own LINE or email". Apple stays for the signed
Mac app and for App Store builds later; the lifted code is ready for it the day the team exists. LINE Login can follow
when LINE work resumes.

If the owner agrees, building codes by email is engineering that needs nothing else from them: a one-time code of six
digits, sent once a minute at most and good for ten minutes, kept only as its hash, five tries, then a new code; the
verified email becomes the person's identity, as Apple's verified email is matched against an invite today
(`docs/people.md`). Sending needs the plan and a sending domain the owner controls.

**Built, off until the owner turns it on (24 Nov 2026).** The backend has it as that paragraph says, with the code kept
as an HMAC rather than a plain hash (six digits have only a million values) and at most ten codes an address in any 24
hours: `POST /v1/auth/email/code`, and `POST /v1/auth/exchange` with `provider: "email"` (`docs/pilot-api.md`,
"Signing in by email"). Both answer `email_not_configured` in every environment today. Turning it on needs:

- the owner's yes;
- the Workers Paid plan, if the account is not on it;
- a sending domain the owner controls, onboarded to Cloudflare Email Service, and the sender's address on it and name,
  which owners see.

Then the environment gets the Email Service binding and `EMAIL_SIGN_IN: "on"`. The app's screens for it (the desktop's
first run, the web pages) are still to build, and the email is in English until the owner's writer does the Thai.

## What needs the owner

- Which way, or which first.
- For Apple: enrolling the business in the Apple Developer Program ($99 a year) and adding the app's identifier.
- For codes by email, which are built and off: the owner's yes to turn them on, the Workers Paid plan, if the account
  is not on it, and a domain to send from (the sender's name and address are what owners see).
- For LINE Login: resuming LINE work, and a LINE Login channel.

## Sources

- A1 https://studio.adalo.com/blog/apple-developer-program-guide (a guide; Apple's own membership page is the authority)
- A2 https://developer.apple.com/forums/thread/816012 (one developer's charge, February 2026)
- C1 https://developers.cloudflare.com/email-service/platform/pricing/
- C2 https://www.cloudflare.com/en-ca/rates/ and https://developers.cloudflare.com/changelog/product/email-service/index.md
