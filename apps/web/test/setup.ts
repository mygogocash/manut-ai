import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// `findBy…` and `waitFor` give up after this long. Testing-library's own second is less than a practice-world round trip
// takes on a loaded machine: on 25 Nov 2026 the Routines page's "pauses everyone in practice" test failed so while
// another gate ran beside it, and passed alone. Three seconds stays under vitest's five-second limit for a whole test, and
// a passing wait returns as soon as it holds, so only a wait that would fail anyway takes longer.
configure({ asyncUtilTimeout: 3_000 });

// Globals are off, so testing-library cannot register its own cleanup.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});
