# Manut AI

One app for Thai shop owners: a chat with Buddy, an AI team that does the work and asks before anything public,
costly or irreversible, and a code editor. This repository starts with the pilot (December 2026): a concierge
service over LINE, where operators play the team and owners approve each reply from a link.

The plan this follows is the implementation plan doc ("Manut AI: implementation plan (reuse first)"). The screen
spec is the Manut AI design canvas.

## Layout

| Path | What it is | Started from |
| --- | --- | --- |
| `apps/api` | Cloudflare Workers backend: tenants, members, tasks with exact-action approvals, a one-use dispatch broker, an encrypted credential vault, schedules, retention | GoSpark's `cloud/` at `a7537c80`, lifted whole |
| `apps/web` | The owner's approval page (`/approve/:token`) and the operator console (`/ops`), served by `apps/api`'s Worker from the API's own origin | The design canvas's classes and states |
| `apps/desktop` | The desktop app, from week 2 | A fork of Oh My Hermes (`apps/omher`) |
| `packages/approval-core` | Settle-once approval rules shared by every client | GoSpark's decision binding and Orca's settle-once journal |
| `packages/agent-events` | The one event contract every agent reports through, with tolerant decoders and a timeline reducer | GoSpark's provider events (`ProviderSession.swift`) and their tests |
| `packages/promptpay` | PromptPay QR payloads for manual payments | dtinth/promptpay-qr's format and test vectors |
| `packages/ui-kit` | Design tokens and component classes | The design canvas (`app.css`, `tokens.json`) |
| `docs/pilot-api.md` | The contract between `apps/api` and `apps/web` | |

## Run it

```bash
pnpm install          # only esbuild and workerd may run install scripts (pnpm-workspace.yaml)
pnpm test             # every package's tests
pnpm typecheck
pnpm --filter @manut/web dev    # the web app against an in-memory fake of the API
pnpm --filter @manut/api dev    # the Worker on localhost:8787: the API and the web app on one origin
```

Set `VITE_API_ORIGIN` to point the web app at a running backend, or to `same-origin` for the API that served
the page. The backend's tests run in real workerd (`pnpm --filter @manut/api test`), followed by two contracts
on a local Worker: the admin gate, and the one-origin routing and headers (`docs/pilot-api.md`). Nothing here
deploys anything.

## Deploying

Nothing is deployed yet. Before the first deploy of `apps/api`: create the Wrangler secrets (`CLOUD_API_KEY`,
`APPROVAL_LINK_SECRET`, and the vault key `CRED_KEY`); put `/ops` and `/v1/admin/*`, and nothing else, behind
one Cloudflare Access application and set `ADMIN_ACCESS_AUD` to its audience; set `WEB_ORIGIN` and
`PUBLIC_API_ORIGIN`, both the Worker's own origin because it serves the web app too; and turn on the feature
flags the pilot needs. `wrangler deploy` builds the web app first. The worker names are `manut-api-*`, so a
deploy from here can never replace one of GoSpark's services.

## Credits

Code lifted from other projects keeps its notice here: GoSpark (`mygogocash/gospark`, our own); Oh My Hermes
(MIT) and Orca (MIT) as their code arrives; dtinth/promptpay-qr (MIT) for the PromptPay format and test vectors.
