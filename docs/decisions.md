# Decisions

Every product, design and technical call made while building, newest first. "Owner" means the owner decided;
"Claude" means Claude took its own recommendation under the standing permission of 23 Nov 2026 (reversible
calls only). Anything about money, legal, launch dates or customers goes to the owner.

| Date | Decision | Why | By | Undo by |
| --- | --- | --- | --- | --- |
| 23 Nov 2026 | The GitHub Actions test workflow is manual only; tests run on the developer Mac before every commit | GitHub refused to start jobs for the organisation: a payment failed or the spending limit needs raising. Billing is the owner's call | Claude | Restore the `pull_request` trigger in `.github/workflows/test.yml` once billing is sorted |
| 23 Nov 2026 | `.claude/settings.json` denies pushing to main, force pushes, merging pull requests and staging or production deploys | The owner's limits hold in every permission mode, not only by habit | Claude | Edit the deny list |
| 23 Nov 2026 | A decision on an older revision is refused even when it is a decline; a helper can neither approve nor decline owner-only kinds | The person must act on the exact request they saw; stricter than GoSpark, which let a decline through | Claude | `evaluateDecision` in `packages/approval-core` |
| 23 Nov 2026 | PromptPay QR refuses any id that is not a 10-digit mobile number, a 13-digit national or tax id, or a 15-digit e-wallet id, and any all-zero id | A guessed id sends a customer's money to someone else | Claude | Loosen `targetOf` in `packages/promptpay` |
| 23 Nov 2026 | Pilot web pages use the design canvas's own CSS (`@manut/ui-kit`), not shadcn/ui; English first with every string in one table | Fastest route to pages that match the canvas; shadcn arrives with the desktop app in P3; Thai is parked | Claude | Swap the components when P3 starts |
| 23 Nov 2026 | Owners have no accounts in week 1: each reply is approved through a signed, single-use link that expires in 24 hours, with consent asked once on that page | The pilot runs over LINE; a login would slow every approval | Claude | Add LINE Login and keep the link as a fallback |
| 23 Nov 2026 | Operator routes stay behind the lifted backend's admin gate (Cloudflare Access plus the operator key) | Keeps the backend's security model unchanged | Claude | None needed |
| 23 Nov 2026 | Worker names `manut-api-*` and rate-limit namespaces of their own | A deploy from this repository can never replace or share counters with GoSpark's services | Claude | Rename in `apps/api/wrangler.jsonc` |
| 23 Nov 2026 | pnpm workspace; only esbuild and workerd may run install scripts | The Notion plan chose pnpm; every other install script stays blocked | Claude | `pnpm-workspace.yaml` |
| 23 Nov 2026 | The desktop app will be a fork of Oh My Hermes, with the Hermes bridge removed | Tauri 2 + React 19, tested, released on three systems; Monocode could not be checked | Claude | Decide before week 2's fork |
| 23 Nov 2026 | The backend is GoSpark's cloud code (Cloudflare Workers), lifted whole, instead of a new Node + Postgres server | Tenants, members, approvals, schedules, a vault and retention already exist with 449 tests | Owner | Port to Postgres if a real limit appears |
