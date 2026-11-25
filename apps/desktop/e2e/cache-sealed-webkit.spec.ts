// The offline cache sealed at rest, walked in WebKit, the engine of the macOS webview the app is (the cases are in cache-sealed.ts;
// cache-sealed.spec.ts runs them in Chromium). What WKWebView gives the app's own scheme (tauri://localhost: a secure context with
// Web Crypto's AES-GCM) was checked with a scratch Tauri program (docs/decisions.md, 25 Nov 2026); this keeps the engine's part of
// the seal, its Web Crypto, checked on every Mac run.
import { existsSync } from "node:fs";
import { test, webkit } from "@playwright/test";
import { sealedCacheCases } from "./cache-sealed";

test.use({ browserName: "webkit" });
// Only the macOS window is WebKit; CI's Playwright jobs run Chromium on Linux, where this file skips itself, as
// cards-webkit.spec.ts does. A Mac without WebKit installed skips it too (`pnpm exec playwright install webkit`).
test.skip(
  process.platform !== "darwin" || (!process.env.CI && !existsSync(webkit.executablePath())),
  "WebKit is the macOS webview only; install it with `pnpm exec playwright install webkit` to run this locally",
);

sealedCacheCases();
