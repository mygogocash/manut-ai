import { defineConfig } from "@playwright/test";
import { chatResume } from "./e2e/start";
// The Playwright suite inherited from Oh My Hermes. It reaches the app through the WebSocket runtime adapter
// (VITE_MANUT_BRIDGE below) and the Node mock bridge in e2e/mock-bridge.mjs, not the in-process runtime the app
// uses by default. CI runs it as eight shards of whole spec files balanced by their measured time (job `e2e` in
// .github/workflows/ci.yml, .github/scripts/e2e-shards.mjs and e2e/timings.json); on a small machine run one file at a
// time: `pnpm exec playwright test e2e/<file>`. The specs of screens the fork removed were deleted, or are skipped with
// the reason beside them.
// Each dag node runs its own ports (MANUT_PORT for vite, MANUT_MOCK_PORT for the mock bridge) so
// parallel e2e runs never collide. Defaults are for a person running `pnpm e2e` alone.
const port = Number(process.env.MANUT_PORT || 5307);
const mock = Number(process.env.MANUT_MOCK_PORT || 5308);
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  // On CI a failed test runs once more: a one-off slow start on a shared runner then shows as flaky in the shard's
  // summary instead of failing the run, and a real failure fails twice. On a person's machine it fails at once.
  retries: process.env.CI ? 1 : 0,
  // One mock bridge holds shared state (calls log, running turn): spec files must not run against it at once.
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 820 },
    // past the first-run cards, with all four mock bots on the team, and Kami's chat left open: specs see the app as a
    // returning person who added them does (onboarding.spec.ts starts from nothing). The app opens on Home unless a
    // snapshot says otherwise, and these specs were written for a chat at start, so the snapshot opens Kami's
    // (e2e/start.ts says why this way and not through Team).
    storageState: {
      cookies: [],
      origins: [
        {
          origin: `http://127.0.0.1:${port}`,
          localStorage: [
            { name: "manut.onboarded", value: "1" },
            // quiet hours (22:00 to 08:00 Bangkok by default) would hold notifications back by the hour the suite runs at
            { name: "manut.notify.quiet", value: "00:00-00:00" },
            { name: "manut.roster", value: JSON.stringify(["kami", "friren", "default", "omh-tui"]) },
            { name: "manut.resume", value: chatResume("kami") },
            // Settings' "Under the hood" left open, as by a developer who used its pages before (item 85h): the specs
            // press a developer page's own entry in Settings' list, as they did before the pages moved under it.
            // settings-column.spec.ts starts without it, as everyone else does, and opens it by hand.
            { name: "manut.settings.hood", value: "1" },
          ],
        },
      ],
    },
  },
  webServer: [
    { command: `node e2e/mock-bridge.mjs --port ${mock}`, port: mock, reuseExistingServer: false },
    { command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`, port, reuseExistingServer: false,
      env: { VITE_MANUT_BRIDGE: `ws://127.0.0.1:${mock}/?token=e2e` } },
  ],
});
