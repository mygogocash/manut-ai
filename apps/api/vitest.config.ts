/// <reference types="@cloudflare/vitest-plugin/types" />
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/// Runs the cloud Worker and TaskObject in the real workerd runtime against a
/// test-only wrangler config (same entrypoint, compatibility date, and DO
/// bindings as deploys). Auth uses a committed test-only bearer key; nothing
/// here touches production secrets or deploys anything.
export default defineConfig({
  resolve: {
    alias: {
      // The web app's phone code (apps/web/src/app/mac/), which test/remote-phone.test.ts runs against the real relay,
      // names the channel package as the web app does, by an alias (apps/web/vite.config.ts), since the web app does not
      // list it as a dependency.
      "@manut/remote-channel": decodeURIComponent(new URL("../../packages/remote-channel/src/index.ts", import.meta.url).pathname),
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.json" },
    }),
  ],
});
