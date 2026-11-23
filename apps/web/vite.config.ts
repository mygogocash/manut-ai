import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/// Workspace packages resolve from their source. `@manut/promptpay` is not a declared dependency of this
/// app yet (the lead adds it with the next install), and `@manut/ui-kit` is declared but may not be linked
/// into node_modules until then, so both are aliased to their folders. `@manut/format` is not declared
/// either, because declaring it changes pnpm-lock.yaml, so it is aliased the same way. The aliases keep
/// working after the install, because they point at the same files the links would.
function workspace(path: string): string {
  return decodeURIComponent(new URL(path, import.meta.url).pathname);
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@manut/format": workspace("../../packages/format/src/index.ts"),
      "@manut/promptpay": workspace("../../packages/promptpay/src/index.ts"),
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
