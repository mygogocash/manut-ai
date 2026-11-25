// The preview's page drawn in the pane beside a lane, walked in Chromium, as CI runs the suite (the cases are in preview-frame.ts;
// preview-frame-webkit.spec.ts runs the frame's own rules in WebKit, the macOS webview's engine). Nothing reaches a real site.
import { previewFrameCases } from "./preview-frame";

previewFrameCases({ layout: true });
