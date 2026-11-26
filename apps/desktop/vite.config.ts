import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5207, strictPort: true },
  // The Mac App Store edition (docs/app-store.md) is built with MANUT_APP_STORE=1, which the shell's build.rs reads too.
  // Only this one value reaches the page (src/appStore.ts); no other variable of the environment does.
  define: { __MANUT_APP_STORE__: JSON.stringify(process.env.MANUT_APP_STORE === "1") },
  test: { environment: "node", setupFiles: ["src/testSetup.ts"], include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
} as never);
