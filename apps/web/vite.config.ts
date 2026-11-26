import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/// Workspace packages resolve from their source. `@manut/promptpay` is not a declared dependency of this
/// app yet (the lead adds it with the next install), and `@manut/ui-kit` is declared but may not be linked
/// into node_modules until then, so both are aliased to their folders. `@manut/format` is not declared
/// either, because declaring it changes pnpm-lock.yaml, so it is aliased the same way, and so are `@manut/people-rules`,
/// which the practice-mode fake runs so that it answers the owner's people as the API does, `@manut/routine-rules`, whose
/// `describeTrigger` and `nextRun` it runs so that a routine's words and next run are the API's, and `@manut/approval-core`,
/// whose `mayDecide` the People page reads, so the page cannot say what the one rule does not, and `@manut/remote-channel`,
/// the channel the Your Mac tab speaks to the person's Mac (src/app/mac/). The aliases keep
/// working after the install, because they point at the same files the links would.
function workspace(path: string): string {
  return decodeURIComponent(new URL(path, import.meta.url).pathname);
}

/// The owner's web app's service worker (src/app/sw.ts) is built as a script of its own at `/app/sw.js`, with no hash in
/// its name, so its address stays the one registered and a browser sees a new worker when its bytes change.
const SERVICE_WORKER = "app-sw";

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      // Two pages and the worker: every page but the app's (index.html), the owner's web app (app/index.html, served at
      // `/app/`), and the app's service worker.
      input: {
        main: workspace("./index.html"),
        app: workspace("./app/index.html"),
        [SERVICE_WORKER]: workspace("./src/app/sw.ts"),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === SERVICE_WORKER ? "app/sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  resolve: {
    alias: {
      "@manut/approval-core": workspace("../../packages/approval-core/src/index.ts"),
      "@manut/format": workspace("../../packages/format/src/index.ts"),
      "@manut/people-rules": workspace("../../packages/people-rules/src/index.ts"),
      "@manut/promptpay": workspace("../../packages/promptpay/src/index.ts"),
      // The channel to the person's Mac (src/app/mac/, docs/remote-access.md), shared with the desktop's side.
      "@manut/remote-channel": workspace("../../packages/remote-channel/src/index.ts"),
      "@manut/routine-rules": workspace("../../packages/routine-rules/src/index.ts"),
      "@manut/ui-kit": workspace("../../packages/ui-kit"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
