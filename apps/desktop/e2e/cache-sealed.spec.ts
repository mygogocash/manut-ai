// The offline cache sealed at rest, walked in Chromium, as CI runs the suite (the cases are in cache-sealed.ts;
// cache-sealed-webkit.spec.ts runs them in WebKit, the macOS webview's engine). Nothing reaches a real API.
import { sealedCacheCases } from "./cache-sealed";

sealedCacheCases();
