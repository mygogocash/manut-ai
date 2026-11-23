// What the app says about the runtime it runs on: the quiet mode line above the account row, and whether Settings ›
// Developer must offer a restart for a choice saved since the start.
import { afterEach, describe, expect, it } from "vitest";
import { setLang, t } from "../i18n";
import { modeLine, pendingRestart } from "./link";

const CONNECTED = { mode: "connected", origin: "https://dev.manut.xyz" } as const;
const text = (v: ReturnType<typeof modeLine>) => (v ? t(v.key, v.vars) : null);

afterEach(() => setLang("en"));

describe("the mode line", () => {
  it("says Practice mode for the demo runtime, never a host", () => {
    expect(text(modeLine({ mode: "practice" }, "mock", null))).toBe("Practice mode");
  });

  it("names the host it is connected to, and says plainly when it is not", () => {
    expect(text(modeLine(CONNECTED, "http", "open"))).toBe("Connected to dev.manut.xyz");
    expect(text(modeLine(CONNECTED, "http", "connecting"))).toBe("Connecting to dev.manut.xyz…");
    expect(text(modeLine(CONNECTED, "http", "signed_out"))).toBe("Signed out · dev.manut.xyz");
    expect(text(modeLine(CONNECTED, "http", "offline"))).toBe("Offline · dev.manut.xyz");
    expect(text(modeLine(CONNECTED, "http", "unavailable"))).toBe("Not answering · dev.manut.xyz");
    expect(text(modeLine({ mode: "connected", origin: "http://localhost:8787" }, "http", "open"))).toBe("Connected to localhost:8787");
  });

  it("says nothing when a WebSocket runtime was configured on purpose (the e2e suite), which is neither", () => {
    expect(modeLine({ mode: "practice" }, "websocket", null)).toBeNull();
    expect(modeLine(CONNECTED, "websocket", null)).toBeNull();
  });

  it("speaks the app's language", () => {
    setLang("ja");
    expect(text(modeLine({ mode: "practice" }, "mock", null))).toBe("練習モード");
    expect(text(modeLine(CONNECTED, "http", "offline"))).toBe("オフライン · dev.manut.xyz");
  });
});

describe("a restart to apply", () => {
  it("is needed only when the saved choice is not the one running", () => {
    expect(pendingRestart({ mode: "practice" }, { mode: "practice" })).toBe(false);
    expect(pendingRestart(CONNECTED, { mode: "practice" })).toBe(true);
    expect(pendingRestart({ mode: "practice" }, CONNECTED)).toBe(true);
    expect(pendingRestart(CONNECTED, CONNECTED)).toBe(false);
    expect(pendingRestart({ mode: "connected", origin: "https://staging.manut.xyz" }, CONNECTED)).toBe(true);
  });
});
