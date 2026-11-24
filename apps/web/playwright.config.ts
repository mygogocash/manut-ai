import { defineConfig, devices } from "@playwright/test";

// The owner's two pages, the approval page and the deletion page, in real browser engines at phone sizes. An owner
// opens them from a LINE message on a phone, so these specs open every state of each on four phone-sized screens, in
// light and in dark, and at larger text sizes (docs/phone-pass.md says what they cover and what only a real phone can).
//
// The pages run in practice mode: the dev server below has no VITE_API_ORIGIN, so the app uses its in-memory fake and
// every demo link of the practice home page works with no backend. Each test gets a fresh browser context, so the
// fake starts from its sample world every time and tests never see each other's answers.
//
// The server has a port of its own, so it never collides with the desktop's (5307, 5308) and a second run says so
// instead of quietly testing another checkout's server: `reuseExistingServer` is off. If a run was killed and left
// its server behind, stop it with `pkill -f "vite --host 127.0.0.1 --port 5417"`.
const port = 5417;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // Every test opens its own page and writes nothing outside its own context, so they can run side by side. On a small
  // machine pass --workers=1, and run one project at a time with --project.
  fullyParallel: true,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // The page's own CSS stops every animation and transition under this setting, so a box is measured where it
    // settles and never half way through the rise or pop the cards play. Layout is the same either way.
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
  },
  // Playwright's own device list gives each phone's screen size, pixel density, touch input and user agent, and the
  // engine that phone's browser uses: WebKit for an iPhone, Chromium for an Android.
  projects: [
    // An iPhone of today (402 CSS pixels wide).
    { name: "iPhone 17 (WebKit)", use: { ...devices["iPhone 17"] } },
    // A small iPhone: 375 wide, as the SE and the mini models are.
    { name: "iPhone SE 375 wide (WebKit)", use: { ...devices["iPhone SE (3rd gen)"] } },
    // A Pixel, the widest of the four (412).
    { name: "Pixel 8 (Chromium)", use: { ...devices["Pixel 8"] } },
    // A small Android: 360 by 740, the size of the Galaxy S8 and many phones since.
    { name: "Android 360x740 (Chromium)", use: { ...devices["Galaxy S8"] } },
  ],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    port,
    reuseExistingServer: false,
  },
});
