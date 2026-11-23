import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Globals are off, so testing-library cannot register its own cleanup.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});
