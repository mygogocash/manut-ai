// An approval card while the connected runtime can show only a kept read of the shop (the API cannot be reached): the
// ask is there to read, with its exact action, but answering needs the live record, so the card offers no answer and
// says "Connect to answer this". It is the same card, and answers as before, whenever the API answers or the runtime is
// Practice. The runtime refuses an answer on its own too (runtime/http/offline.test.ts); this is what the person sees.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../../i18n";
import { forgetStartedRuntime } from "../../runtime";
import { sharedHttpHost, type CacheView, type LinkState } from "../../runtime/http";
import { RUNTIME_KEY } from "../../runtime/setting";
import type { ApprovalItem } from "../../state/store";
import Cards from "./Cards.slot";

const ORIGIN = "https://cards-offline.manut.xyz";
const NONE: CacheView = { kind: "none" };

const ask = (): ApprovalItem => ({
  kind: "approval",
  id: "approval-action-1",
  ts: 1_795_396_200,
  request_id: "action-1",
  title: "Reply to Khun Mali",
  command: "Send on LINE: “Your order ships tomorrow morning.”",
  choices: ["once", "deny"],
});

/** The page started Connected to ORIGIN, and its host is in `view`. */
function connected(link: LinkState, cache: CacheView) {
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k === RUNTIME_KEY ? JSON.stringify({ mode: "connected", origin: ORIGIN }) : null), setItem: () => {} });
  forgetStartedRuntime();
  Object.assign(sharedHttpHost(ORIGIN), { link, cache });
}

afterEach(() => {
  Object.assign(sharedHttpHost(ORIGIN), { link: "connecting", cache: NONE });
  vi.unstubAllGlobals();
  forgetStartedRuntime();
  setLang("en");
});

describe("an ask on screen while the API cannot be reached", () => {
  it("is shown whole, says Connect to answer this, and offers no answer", () => {
    setLang("en");
    connected("offline", { kind: "showing", at: 1_795_396_200_000 });
    const html = renderToString(<Cards bot="buddy" item={ask()} />);
    expect(html).toContain("Send on LINE: “Your order ships tomorrow morning.”");
    expect(html).toMatch(/data-testid="card-offline"[^>]*>Connect to answer this</);
    // both answers are there to read but cannot be pressed
    expect(html).toMatch(/data-choice="deny"[^>]*disabled=""/);
    expect(html).toMatch(/data-choice="once"[^>]*disabled=""/);
  });

  it("says it in the app's language", () => {
    connected("unavailable", { kind: "showing", at: 1_795_396_200_000 });
    setLang("ko");
    expect(renderToString(<Cards bot="buddy" item={ask()} />)).toContain("답하려면 연결하세요");
    setLang("ja");
    expect(renderToString(<Cards bot="buddy" item={ask()} />)).toContain("返答するには接続してください");
  });

  it("is the card it always was while the API answers, and offers both answers", () => {
    setLang("en");
    connected("open", NONE);
    const html = renderToString(<Cards bot="buddy" item={ask()} />);
    expect(html).not.toContain("Connect to answer this");
    expect(html).not.toContain("card-offline");
    expect(html).not.toMatch(/disabled/);
    expect(html).toContain('data-choice="deny"');
    expect(html).toContain('data-choice="once"');
  });

  it("is the card it always was on Practice, which never shows a kept read", () => {
    setLang("en");
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    forgetStartedRuntime();
    const html = renderToString(<Cards bot="buddy" item={ask()} />);
    expect(html).not.toContain("card-offline");
    expect(html).not.toMatch(/disabled/);
  });

  it("is not changed for a card that was already answered or timed out: those are one line either way", () => {
    setLang("en");
    connected("offline", { kind: "showing", at: 1_795_396_200_000 });
    const html = renderToString(<Cards bot="buddy" item={{ ...ask(), resolved: "once" }} />);
    expect(html).toContain('data-testid="card-line"');
    expect(html).not.toContain("card-offline");
  });
});
