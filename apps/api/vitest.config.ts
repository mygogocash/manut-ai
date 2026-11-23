/// <reference types="@cloudflare/vitest-plugin/types" />
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/// Runs the cloud Worker and TaskObject in the real workerd runtime against a
/// test-only wrangler config (same entrypoint, compatibility date, and DO
/// bindings as deploys). Auth uses a committed test-only bearer key; nothing
/// here touches production secrets or deploys anything.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.json" },
    }),
  ],
});
