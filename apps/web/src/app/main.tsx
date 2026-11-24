import "@manut/ui-kit/app.css";
import "../app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiProvider, createApi } from "../api";
import { loadBrandFonts } from "../fonts";
import { OwnerApp } from "./OwnerApp";
import { registerWorker } from "./register";

/// The owner's web app's own page (app/index.html), apart from the other pages' (index.html), so only this page names the
/// app's manifest and icons, and its service worker caches this app's shell and nothing of the console or the links'
/// pages.

const root = document.getElementById("root");
if (!root) throw new Error("app/index.html has no #root");

loadBrandFonts();

createRoot(root).render(
  <StrictMode>
    <ApiProvider value={createApi()}>
      <OwnerApp />
    </ApiProvider>
  </StrictMode>,
);

// The service worker is the build's (src/app/sw.ts, built to /app/sw.js); the dev server has none to register.
if (import.meta.env.PROD && "serviceWorker" in navigator) registerWorker();
