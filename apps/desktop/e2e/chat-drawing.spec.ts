// A drawing in the chat, walked in Chromium, as CI runs the suite (the cases are in chat-drawing.ts; chat-drawing-webkit.spec.ts
// runs them in WebKit, the macOS web view's engine). Every way out aims at a listener of the spec's own on 127.0.0.1.
import { test } from "@playwright/test";
import { chatDrawingCases } from "./chat-drawing";

// Chromium refuses a page's request to this computer by a check of its own (Local Network Access) that WebKit, the macOS
// web view, does not have. Off here, so what keeps a drawing in is the box and its policy alone, as in the app's window.
test.use({ launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] } });

chatDrawingCases({ engine: "chromium" });
