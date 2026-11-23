// Settings › General's Your shop group, drawn with react-dom/server: who and which shop the first-run setup kept, and the
// one button that opens the setup again on Your shop.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { EMPTY_SHOP } from "./shop";
import { ShopSettings } from "./ShopSettings";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const noop = () => {};

describe("Settings' Your shop group", () => {
  afterEach(() => setLang("en"));

  it("names the person and the shop the setup kept, and offers to set them up again", () => {
    setLang("en");
    const html = renderToString(<ShopSettings shop={{ ...EMPTY_SHOP, person: "Fon", shop: "Baan Mali", places: ["line"] }} onSetUp={noop} />);
    const text = words(html);
    expect(text).toMatch(/Your shop Fon, Baan Mali Your name, your shop and where it sells, kept on this computer\. Set up again/);
    expect(html).toMatch(/<button type="button" class="st-btn"[^>]*data-testid="set-shop-setup"[^>]*>Set up again<\/button>/);
    expect(html.split("<button").length - 1).toBe(1);
  });

  it("says nothing is set up yet when the setup was skipped before anything was typed", () => {
    setLang("en");
    const text = words(renderToString(<ShopSettings shop={EMPTY_SHOP} onSetUp={noop} />));
    expect(text).toMatch(/Your shop Not set up yet .* Set up $/);
  });
});

describe("Settings › General on the app's store", () => {
  afterEach(() => setLang("en"));

  // Settings loads every one of its pages' modules (Accounts, Terminal, Agents and the rest), which takes a few seconds on
  // a cold run, so this test waits longer than the default five seconds.
  it("opens with the Your shop group, whose button opens the setup again on Your shop", { timeout: 30_000 }, async () => {
    setLang("en");
    const { getStore } = await import("../state/store");
    const { default: Settings } = await import("../settings/Settings.slot");
    const store = getStore();
    await store.actions.init();
    store.actions.firstRunEnd();
    store.actions.openSettings("general");
    const html = renderToString(<Settings page="general" onClose={noop} />);
    // the first group on the page, before Appearance
    expect(html.indexOf('data-testid="set-shop"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="set-shop"')).toBeLessThan(html.indexOf("Appearance"));
    expect(words(html)).toContain("Not set up yet");
    store.actions.openFirstRun();
    expect(store.getState().ui.firstRun?.screen).toBe("shop");
  });
});
