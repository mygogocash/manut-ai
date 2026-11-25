// The Artifacts page (item 83), drawn from the state it is given as menuPages.test.tsx draws the menu's pages: why Share cannot be used
// yet in each case, with nothing to send; the ask, which shows exactly what will be published and that anyone with the link can open
// it; the list with Open, Copy link and Remove; and Practice, which refuses every link op.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang, t } from "../i18n";
import type { BridgeError } from "../lib/protocol";
import { MockHost, MockRuntime } from "../runtime/mock";
import type { ArtifactLink, SharePlan } from "../runtime/artifacts";
import { ArtifactsPage, ArtifactsView, type ArtifactsViewProps } from "./ArtifactsPage";
import { blockedReason, planFromFile, sizeText } from "./artifacts";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const NOW = Date.UTC(2026, 10, 25, 5);
const LINK: ArtifactLink = { id: "art-1", title: "Menu", kind: "html", bytes: 2560, createdAt: NOW / 1000 - 3600, url: "https://links.example/a/s.k" };
const PLAN: SharePlan = { shop: "pilot:shop-a", title: "Opening hours", kind: "markdown", text: "# Open every day", bytes: 16 };

function draw(over: Partial<ArtifactsViewProps>): string {
  const noop = () => {};
  return renderToString(
    <ArtifactsView state={{ kind: "ready", shop: "pilot:shop-a", publishing: "on" }} links={[]} ask={null} busy={false} error={null} notice={null} copied={null} nowMs={NOW}
      onShare={noop} onAnswer={noop} onOpen={noop} onCopy={noop} onRemove={noop} onSettings={noop} onRetry={noop} {...over} />,
  );
}
const shareDisabled = (html: string) => /<button[^>]*disabled=""[^>]*data-testid="art-share"/.test(html);

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(), key: () => null, length: 0 } as Storage;
}

beforeEach(() => setLang("en"));
afterEach(() => vi.unstubAllGlobals());

describe("why Share cannot be used yet", () => {
  it("says it in plain words for the switch, Practice, no sign-in, and the API's own reasons, with Share off", () => {
    const cases: [ArtifactsViewProps["state"], string][] = [
      [{ kind: "switched_off" }, "Publishing public links is off on this Mac. Turn it on in Settings › Artifacts."],
      [{ kind: "practice" }, "Public links can be made once Manut AI is connected to your shop."],
      [{ kind: "signed_out" }, "Sign in to your shop first: a link belongs to your shop's account."],
      [{ kind: "ready", shop: "s", publishing: "feature_disabled" }, "Public links are not turned on for Manut AI yet."],
      [{ kind: "ready", shop: "s", publishing: "artifact_origin_not_configured" }, "Public links have no web address of their own yet, so none can be made."],
      [{ kind: "failed", code: "owner_only", message: t("art.err.ownerOnly") }, "Only the shop's owner shares or removes its links."],
    ];
    for (const [state, said] of cases) {
      const html = draw({ state });
      expect(words(html), state.kind).toContain(said);
      expect(shareDisabled(html), state.kind).toBe(true);
    }
    expect(draw({ state: { kind: "switched_off" } })).toContain('data-testid="art-open-settings"');
    expect(blockedReason({ kind: "ready", shop: "s", publishing: "on" })).toBeNull();
    expect(shareDisabled(draw({}))).toBe(false);
  });

  it("opens with the switch off by default, saying so, before anything is read", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    const html = renderToString(<ArtifactsPage />);
    expect(html).toContain('data-testid="page-artifacts"');
    expect(html).toContain('data-state="switched_off"');
    expect(shareDisabled(html)).toBe(true);
  });
});

describe("the ask", () => {
  it("shows the title, the kind, the size and that anyone with the link can open it, with yes and no, and Share waits", () => {
    const html = draw({ ask: { kind: "share", id: "a1", plan: PLAN } });
    const text = words(html);
    expect(text).toContain("Publish “Opening hours” as a public link?");
    expect(text).toContain("Markdown page");
    expect(text).toContain("16 bytes");
    expect(text).toContain("Anyone with the link can open it, without signing in. It stays open until you remove it.");
    expect(html).toContain('data-testid="art-ask-yes"');
    expect(html).toContain('data-testid="art-ask-no"');
    expect(shareDisabled(html)).toBe(true);
  });

  it("asks before a removal too, and says it cannot be undone", () => {
    const text = words(draw({ links: [LINK], ask: { kind: "remove", id: "r1", plan: { shop: "s", id: LINK.id, title: LINK.title, url: LINK.url } } }));
    expect(text).toContain("Remove the link to “Menu”?");
    expect(text).toContain("This cannot be undone.");
  });
});

describe("the list", () => {
  it("lists each link with its kind, size, day and address, and Open, Copy link and Remove", () => {
    const html = draw({ links: [LINK] });
    const text = words(html);
    expect(text).toContain("Menu");
    expect(text).toContain("HTML page · 2.5 KB · Published 25 November");
    expect(text).toContain(LINK.url!);
    for (const id of ["art-open", "art-copy", "art-remove"]) expect(html).toContain(`data-testid="${id}"`);
    expect(words(draw({ links: [LINK], copied: LINK.id }))).toContain("Copied");
  });

  it("offers only Remove for a link with no web address, and says it has none", () => {
    const html = draw({ links: [{ ...LINK, url: null }] });
    expect(words(html)).toContain("No web address yet");
    expect(html).not.toContain('data-testid="art-copy"');
    expect(html).toContain('data-testid="art-remove"');
  });

  it("says what shows here while there is no link", () => {
    expect(words(draw({}))).toContain("No public links yet");
  });

  it("says sizes as a person reads them", () => {
    expect([900, 2560, 40 * 1024].map(sizeText)).toEqual(["900 bytes", "2.5 KB", "40 KB"]);
  });
});

describe("a chosen file", () => {
  const file = (name: string, text: string) => ({ name, text: async () => text });

  it("becomes the plan the ask shows, titled by its name", async () => {
    expect(await planFromFile(file("Opening hours.md", "# Open every day"), "pilot:shop-a")).toEqual({ ok: true, plan: PLAN });
  });

  it("is refused in words, with nothing asked, when it is not HTML or Markdown, is empty, too large or cannot be read", async () => {
    expect(await planFromFile(file("photo.png", "x"), "s")).toEqual({ ok: false, message: t("art.err.kind") });
    expect(await planFromFile(file("empty.md", ""), "s")).toEqual({ ok: false, message: t("art.err.empty") });
    expect(await planFromFile(file("big.html", "a".repeat(129 * 1024)), "s")).toEqual({ ok: false, message: t("art.err.tooLarge", { max: 128 }) });
    expect(await planFromFile({ name: "gone.md", text: () => Promise.reject(new Error("gone")) }, "s")).toEqual({ ok: false, message: t("art.err.read") });
  });
});

describe("in Practice", () => {
  it("refuses every link op, so nothing is published or kept", async () => {
    const rt = new MockRuntime(new MockHost());
    await rt.connect();
    const req = rt.request.bind(rt) as unknown as (op: string, params?: unknown) => Promise<unknown>;
    for (const [op, params] of [["artifacts.list", {}], ["artifacts.publish", { ask: "a" }], ["artifacts.remove", { ask: "a" }]] as const) {
      const refused = await req(op, params).then(() => null, (e: BridgeError) => e);
      expect(refused, op).toEqual({ code: "practice", message: t("art.err.practice") });
    }
  });
});
