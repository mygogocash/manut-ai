// A drawing in the chat, walked in WebKit, the engine of the macOS web view the app is (the cases are in chat-drawing.ts;
// chat-drawing.spec.ts runs them in Chromium). WebKit is where the safety model's limits were found: a script, or an
// unfiltered preconnect link, opens connections no policy covers, so its "why" cases run here only.
import { existsSync } from "node:fs";
import { test, webkit } from "@playwright/test";
import { chatDrawingCases, chatDrawingUiCases } from "./chat-drawing";

test.use({ browserName: "webkit" });
// Only the macOS window is WebKit; CI's Playwright jobs run Chromium on Linux, where this file skips itself, as
// preview-frame-webkit.spec.ts does. A Mac without WebKit installed skips it too (`pnpm exec playwright install webkit`).
test.skip(
  process.platform !== "darwin" || (!process.env.CI && !existsSync(webkit.executablePath())),
  "WebKit is the macOS webview only; install it with `pnpm exec playwright install webkit` to run this locally",
);

chatDrawingCases({ engine: "webkit" });
chatDrawingUiCases({ engine: "webkit", layout: false });
