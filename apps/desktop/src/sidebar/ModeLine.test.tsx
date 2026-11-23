// The quiet line above the account row that says which runtime the app runs on, drawn with react-dom/server.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { forgetStartedRuntime } from "../runtime";
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

  it("is not drawn for a WebSocket runtime configured on purpose (the e2e suite)", () => {
    (globalThis as { window?: unknown }).window = { __MANUT_BRIDGE_URL__: async () => "ws://127.0.0.1:1/?token=x" };
    expect(renderToString(<ModeLine onOpen={noop} />)).toBe("");
  });

  it("speaks the app's language", () => {
    setLang("zh");
    expect(words(renderToString(<ModeLine onOpen={noop} />))).toBe("练习模式");
  });
});
