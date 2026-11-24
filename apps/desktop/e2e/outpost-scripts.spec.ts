// The outpost's write scripts against test pages, in Chromium, as CI runs the suite (the cases are in outpost-scripts.ts;
// outpost-scripts-webkit.spec.ts runs them in WebKit, the macOS webview's engine). Nothing reaches a real site.
import { test } from "@playwright/test";
import { writeScriptCases } from "./outpost-scripts";

test.describe("the outpost's write scripts", () => {
  writeScriptCases();
});
