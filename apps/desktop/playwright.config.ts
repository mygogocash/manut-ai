import { defineConfig } from "@playwright/test";
import { chatResume } from "./e2e/start";
import { ownStandIn, standIns, workerCount } from "./e2e/standIns";
// The Playwright suite inherited from Oh My Hermes. It reaches the app through the WebSocket runtime adapter
// (VITE_MANUT_BRIDGE below) and the Node mock bridge in e2e/mock-bridge.mjs, not the in-process runtime the app
// uses by default. CI runs it as shards of whole spec files balanced by their measured time, several workers to a shard
// (job `e2e` in .github/workflows/ci.yml, .github/scripts/e2e-shards.mjs and e2e/timings.json); on a small machine run
// one file at a time: `pnpm exec playwright test e2e/<file>`. The specs of screens the fork removed were deleted, or are
// skipped with the reason beside them.
//
// Each worker runs against a stand-in of its own: a mock bridge and a dev server with that bridge's address
// (e2e/standIns.ts), so no two workers share the bridge's state (calls log, running turn). MANUT_E2E_WORKERS sets how
// many (1 when unset, as for a person running `pnpm e2e`); `--workers` is not the way, since it starts no stand-in.
// MANUT_PORT (vite) and MANUT_MOCK_PORT (the mock bridge) are the first worker's ports, and each further worker takes
// the next two, so parallel e2e runs on their own ports never collide.
//
// Playwright loads this file again in every worker process, where TEST_PARALLEL_INDEX names the worker. There it writes
// the worker's own ports into MANUT_PORT and MANUT_MOCK_PORT before any spec file is loaded, so the specs that read them
// (most reach the mock bridge directly) reach their own worker's stand-in unchanged. The base ports are kept in
// MANUT_E2E_BASE_PORT and MANUT_E2E_BASE_MOCK_PORT, which the runner sets for its workers, so that writing them is never
// counted twice.
const env = process.env;
env.MANUT_E2E_BASE_PORT ||= env.MANUT_PORT || "5307";
env.MANUT_E2E_BASE_MOCK_PORT ||= env.MANUT_MOCK_PORT || "5308";
const workers = workerCount(env.MANUT_E2E_WORKERS);
const all = standIns({ app: Number(env.MANUT_E2E_BASE_PORT), mock: Number(env.MANUT_E2E_BASE_MOCK_PORT) }, workers);
const own = ownStandIn(all, env.TEST_PARALLEL_INDEX);
env.MANUT_PORT = String(own.app);
env.MANUT_MOCK_PORT = String(own.mock);
const port = own.app;
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  // On CI a failed test runs once more: a one-off slow start on a shared runner then shows as flaky in the shard's
  // summary instead of failing the run, and a real failure fails twice. On a person's machine it fails at once.
  retries: process.env.CI ? 1 : 0,
  // A spec file's tests run in order in one worker, as they were written to: workers share nothing, but a file's tests
  // may lean on what the one before left on its bridge.
  fullyParallel: false,
  workers,
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
  // Every stand-in's bridge and dev server. With more than one, each dev server keeps its pre-bundled dependencies in a
  // folder of its own (vite.config.ts's cacheDir), so servers starting side by side never replace each other's files.
  webServer: all.flatMap((s) => [
    { command: `node e2e/mock-bridge.mjs --port ${s.mock}`, port: s.mock, reuseExistingServer: false },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${s.app} --strictPort`,
      port: s.app,
      reuseExistingServer: false,
      env: { VITE_MANUT_BRIDGE: `ws://127.0.0.1:${s.mock}/?token=e2e`, ...(workers > 1 ? { MANUT_VITE_CACHE_DIR: `node_modules/.vite-e2e-${s.index}` } : {}) },
    },
  ]),
});
