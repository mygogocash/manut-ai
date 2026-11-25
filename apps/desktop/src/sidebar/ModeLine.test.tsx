// The quiet line above the account row that says which runtime the app runs on, drawn with react-dom/server.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { forgetStartedRuntime } from "../runtime";
import { sharedHttpHost } from "../runtime/http";
import { RUNTIME_KEY } from "../runtime/setting";
import { ModeLine } from "./ModeLine";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => {};

function choose(saved: unknown) {
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k === RUNTIME_KEY ? JSON.stringify(saved) : null), setItem: noop });
  forgetStartedRuntime();
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { window?: unknown }).window;
  forgetStartedRuntime();
  setLang("en");
});

describe("the mode line", () => {
  it("says Practice mode on the demo runtime, as a button to the runtime settings", () => {
    setLang("en");
    const html = renderToString(<ModeLine onOpen={noop} />);
    expect(words(html)).toBe("Practice mode");
    expect(html).toMatch(/<button type="button" class="sb-mode" title="Runtime settings" data-testid="mode-line">/);
  });

  it("names the host when connected, connecting until the shop has been read", () => {
    setLang("en");
    choose({ mode: "connected", origin: "https://dev.manut.xyz" });
    expect(words(renderToString(<ModeLine onOpen={noop} />))).toBe("Connecting to dev.manut.xyz…");
  });

  it("says what is shown and when it was read while the API cannot be reached, and what it says again once it can", () => {
    setLang("en");
    const origin = "https://mode-offline.manut.xyz";
    choose({ mode: "connected", origin });
    const host = sharedHttpHost(origin);
    const read = new Date();
    read.setHours(14, 5, 0, 0);
    Object.assign(host, { link: "offline", cache: { kind: "showing", at: read.getTime() } });
    expect(words(renderToString(<ModeLine onOpen={noop} />))).toBe("Offline. Showing what was here at 14:05");
    Object.assign(host, { link: "unavailable" });
    expect(words(renderToString(<ModeLine onOpen={noop} />))).toBe("Not answering. Showing what was here at 14:05");
    Object.assign(host, { link: "offline", cache: { kind: "too_old", at: read.getTime() - 9 * 24 * 3600_000 } });
    expect(words(renderToString(<ModeLine onOpen={noop} />))).toBe("Offline. The saved copy is more than 7 days old, so it is not shown");
    Object.assign(host, { link: "offline", cache: { kind: "unkept" } });
    expect(words(renderToString(<ModeLine onOpen={noop} />))).toBe("Offline. This computer cannot keep a saved copy yet, so none is shown");
    Object.assign(host, { link: "offline", cache: { kind: "none" } });
    expect(words(renderToString(<ModeLine onOpen={noop} />))).toBe("Offline · mode-offline.manut.xyz");
    Object.assign(host, { link: "open", cache: { kind: "none" } });
    expect(words(renderToString(<ModeLine onOpen={noop} />))).toBe("Connected to mode-offline.manut.xyz");
  });

  it("is not drawn for a WebSocket runtime configured on purpose (the e2e suite)", () => {
    (globalThis as { window?: unknown }).window = { __MANUT_BRIDGE_URL__: async () => "ws://127.0.0.1:1/?token=x" };
    expect(renderToString(<ModeLine onOpen={noop} />)).toBe("");
  });

  it("speaks the app's language", () => {
    setLang("zh");
    expect(words(renderToString(<ModeLine onOpen={noop} />))).toBe("练习模式");
  });
});
