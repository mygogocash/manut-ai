// The outpost's write scripts against test pages in WebKit, the engine of the macOS webview the outpost's browser is (the
// cases are in outpost-scripts.ts; outpost-scripts.spec.ts runs them in Chromium). Nothing reaches a real site.
import { existsSync } from "node:fs";
import { test, webkit } from "@playwright/test";
import { writeScriptCases } from "./outpost-scripts";

test.use({ browserName: "webkit" });
// Only the macOS window is WebKit; CI's Playwright jobs run Chromium on Linux, where this file skips itself, as
// cards-webkit.spec.ts does. A Mac without WebKit installed skips it too (`pnpm exec playwright install webkit`).
test.skip(
  process.platform !== "darwin" || (!process.env.CI && !existsSync(webkit.executablePath())),
  "WebKit is the macOS webview only; install it with `pnpm exec playwright install webkit` to run this locally",
);

test.describe("the outpost's write scripts in WebKit", () => {
  writeScriptCases();
});
