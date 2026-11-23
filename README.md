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
| `apps/web` | The owner's approval page (`/approve/:token`) and the operator console (`/ops`) | The design canvas's classes and states |
| `apps/desktop` | The desktop app, from week 2 | A fork of Oh My Hermes (`apps/omher`) |
| `packages/approval-core` | Settle-once approval rules shared by every client | GoSpark's decision binding and Orca's settle-once journal |
| `packages/promptpay` | PromptPay QR payloads for manual payments | dtinth/promptpay-qr's format and test vectors |
| `packages/ui-kit` | Design tokens and component classes | The design canvas (`app.css`, `tokens.json`) |
| `docs/pilot-api.md` | The contract between `apps/api` and `apps/web` | |

## Run it

```bash
pnpm install          # only esbuild and workerd may run install scripts (pnpm-workspace.yaml)
pnpm test             # every package's tests
pnpm typecheck
pnpm --filter @manut/web dev    # the web app against an in-memory fake of the API
```

Set `VITE_API_ORIGIN` to point the web app at a running backend. The backend's tests run in real workerd
(`pnpm --filter @manut/api test`); nothing here deploys anything.

## Deploying

Nothing is deployed yet. Before the first deploy of `apps/api`: create the Wrangler secrets (`CLOUD_API_KEY`,
`APPROVAL_LINK_SECRET`, and the vault key `CRED_KEY`), set `ADMIN_ACCESS_AUD` behind Cloudflare Access, set
`WEB_ORIGIN` and `PUBLIC_API_ORIGIN`, and turn on the feature flags the pilot needs. The worker names are
`manut-api-*`, so a deploy from here can never replace one of GoSpark's services.

## Credits

Code lifted from other projects keeps its notice here: GoSpark (`mygogocash/gospark`, our own); Oh My Hermes
(MIT) and Orca (MIT) as their code arrives; dtinth/promptpay-qr (MIT) for the PromptPay format and test vectors.
