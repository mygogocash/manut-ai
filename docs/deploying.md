# Deploying

Moved from the README on 26 Nov 2026, unchanged. Staging and production deploys are always the owner's.

Dev is deployed at `https://dev.manut.xyz` (staging and production are not). `apps/api` deploys two Workers per environment: the pages Worker
(`wrangler deploy -c wrangler.web.jsonc --env dev`, which builds the web app first) and then the API Worker
(`wrangler deploy --env dev`), the front door that hands every non-API path to the pages
(`docs/pilot-api.md`, "One origin"). Before the first deploy: create the Wrangler secrets (`CLOUD_API_KEY`,
`APPROVAL_LINK_SECRET`, and the vault key `CRED_KEY`); give the API Worker the host's route; put `/ops` and
`/v1/admin/*`, and nothing else, behind one Cloudflare Access application and set `ADMIN_ACCESS_AUD` to its
audience; set `WEB_ORIGIN` and `PUBLIC_API_ORIGIN`, both that host's origin; and turn on the feature flags the
pilot needs. The worker names are `manut-api-*` and `manut-web-*`, so a deploy from here can never replace one
of GoSpark's services.

