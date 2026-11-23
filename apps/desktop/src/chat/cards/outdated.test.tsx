// What an approval card shows for the connected runtime's answers: an ask this build cannot answer (a kind, an answer or
// a state it does not know) is shown whole with no answer offered and says to update the app, whether or not the API can
// be reached; and a card that stopped waiting closes in the runtime's own words when it gave them ("Already decided by
// Mint at 19:42"), else in the card's usual word for why. The runtime refuses an answer on its own too
// (runtime/http/answering.test.ts); this is what the person sees.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../../i18n";
import { forgetStartedRuntime } from "../../runtime";
import { sharedHttpHost, type CacheView, type LinkState } from "../../runtime/http";
import { RUNTIME_KEY } from "../../runtime/setting";
import type { ApprovalItem } from "../../state/store";
import Cards from "./Cards.slot";

const ORIGIN = "https://cards-outdated.manut.xyz";
const NONE: CacheView = { kind: "none" };

const ask = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  kind: "approval",
  id: "approval-action-1@1",
  ts: 1_795_396_200,
  request_id: "action-1@1",
  title: "Reply to Khun Mali",
  command: "Send on LINE: “Your order ships tomorrow morning.”",
  choices: ["once", "deny"],
  ...over,
});
const outdated = () => ask({ choices: [], outdated: true });

/** The page started Connected to ORIGIN, and its host is in `link` with `cache` standing in. */
function connected(link: LinkState, cache: CacheView = NONE) {
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

describe("an ask this build cannot answer", () => {
  it("is shown whole, offers no answer, and says to update the app", () => {
    setLang("en");
    connected("open");
    const html = renderToString(<Cards bot="buddy" item={outdated()} />);
    expect(html).toContain("Send on LINE: “Your order ships tomorrow morning.”");
    expect(html).toMatch(/data-testid="card-outdated"[^>]*>Update the app to answer this</);
    expect(html).not.toContain("data-choice");
    expect(html).not.toContain("aria-keyshortcuts");
  });

  it("says to update the app rather than to connect while only a kept read is shown: connecting would not help", () => {
    setLang("en");
    connected("offline", { kind: "showing", at: 1_795_396_200_000 });
    const html = renderToString(<Cards bot="buddy" item={outdated()} />);
    expect(html).toContain("Update the app to answer this");
    expect(html).not.toContain("Connect to answer this");
    expect(html).not.toContain("data-choice");
  });

  it("says it in the app's language", () => {
    connected("open");
    setLang("ko");
    expect(renderToString(<Cards bot="buddy" item={outdated()} />)).toContain("답하려면 앱을 업데이트하세요");
    setLang("zh");
    expect(renderToString(<Cards bot="buddy" item={outdated()} />)).toContain("请更新应用后再回复");
  });

  it("leaves every other card as it was: both answers, numbered", () => {
    setLang("en");
    connected("open");
    const html = renderToString(<Cards bot="buddy" item={ask()} />);
    expect(html).not.toContain("card-outdated");
    expect(html).toContain('data-choice="deny"');
    expect(html).toContain('data-choice="once"');
  });
});

describe("a card that stopped waiting", () => {
  it("closes in the runtime's words when it gave them", () => {
    setLang("en");
    connected("open");
    const html = renderToString(<Cards bot="buddy" item={ask({ expired: "resolved", expiredNote: "Already decided by Mint at 19:42" })} />);
    expect(html).toContain('data-testid="card-line"');
    expect(html).toContain("Already decided by Mint at 19:42");
    expect(html).not.toContain("Answered elsewhere");
    expect(html).toContain("Send on LINE: “Your order ships tomorrow morning.”");
  });

  it("closes in the card's usual word without them", () => {
    setLang("en");
    connected("open");
    expect(renderToString(<Cards bot="buddy" item={ask({ expired: "resolved" })} />)).toContain("Answered elsewhere");
  });

  it("keeps the person's own answer over any words: an answered card says what they chose", () => {
    setLang("en");
    connected("open");
    const html = renderToString(<Cards bot="buddy" item={ask({ resolved: "once", expired: "resolved", expiredNote: "Already decided by you at 19:42" })} />);
    expect(html).toContain("Allowed once");
    expect(html).not.toContain("Already decided");
  });
});
