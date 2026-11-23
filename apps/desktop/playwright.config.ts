import { defineConfig } from "@playwright/test";
// The Playwright suite inherited from Oh My Hermes. It reaches the app through the WebSocket runtime adapter
// (VITE_MANUT_BRIDGE below) and the Node mock bridge in e2e/mock-bridge.mjs, not the in-process runtime the app
// uses by default. It has not been run since the fork: the specs of removed screens were deleted, and the rest
// need a pass against the changed sidebar and settings before they are trusted (see README.md).
// Each dag node runs its own ports (MANUT_PORT for vite, MANUT_MOCK_PORT for the mock bridge) so
// parallel e2e runs never collide. Defaults are for a person running `pnpm e2e` alone.
const port = Number(process.env.MANUT_PORT || 5307);
const mock = Number(process.env.MANUT_MOCK_PORT || 5308);
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  // One mock bridge holds shared state (calls log, running turn): spec files must not run against it at once.
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 820 },
    // past the first-run cards, with all four mock bots in the sidebar list: specs see the app as a returning person
    // who added them does (onboarding.spec.ts and roster.spec.ts start from nothing)
    storageState: {
      cookies: [],
      origins: [
        {
          origin: `http://127.0.0.1:${port}`,
          localStorage: [
            { name: "manut.onboarded", value: "1" },
            { name: "manut.roster", value: JSON.stringify(["kami", "friren", "default", "omh-tui"]) },
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
