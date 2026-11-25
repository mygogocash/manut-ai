// The preview's page drawn in the pane beside a lane, walked in WebKit, the engine of the macOS webview the app is (the cases are
// in preview-frame.ts; preview-frame.spec.ts runs them in Chromium, with the themes, the narrow window and the languages too). What
// WKWebView does with the app's own scheme (tauri://localhost) was checked with a scratch Tauri program (docs/code-editor.md, "The
// page in the pane"); this keeps the engine's part of it, the sandbox and the CSP's frame-src, checked on every Mac run.
import { existsSync } from "node:fs";
import { test, webkit } from "@playwright/test";
import { previewFrameCases } from "./preview-frame";

test.use({ browserName: "webkit" });
// Only the macOS window is WebKit; CI's Playwright jobs run Chromium on Linux, where this file skips itself, as
// cards-webkit.spec.ts does. A Mac without WebKit installed skips it too (`pnpm exec playwright install webkit`).
test.skip(
  process.platform !== "darwin" || (!process.env.CI && !existsSync(webkit.executablePath())),
  "WebKit is the macOS webview only; install it with `pnpm exec playwright install webkit` to run this locally",
);

previewFrameCases({ layout: false });
