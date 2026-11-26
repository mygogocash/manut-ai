import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dictionariesAsOneModule } from "./src/i18n/oneModule";
export default defineConfig({
  // The dev server sends each language's dictionary as one module, not one per area file (src/i18n/oneModule.ts says
  // why). The unit tests read the area files as they are.
  plugins: [react(), ...(process.env.VITEST ? [] : [dictionariesAsOneModule()])],
  clearScreen: false,
  server: { port: 5207, strictPort: true },
  // The Mac App Store edition (docs/app-store.md) is built with MANUT_APP_STORE=1, which the shell's build.rs reads too.
  // Only this one value reaches the page (src/appStore.ts); no other variable of the environment does.
  define: { __MANUT_APP_STORE__: JSON.stringify(process.env.MANUT_APP_STORE === "1") },
  test: { environment: "node", setupFiles: ["src/testSetup.ts"], include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
} as never);
