// The side menu as the design canvas draws it, drawn with react-dom/server: the rows in order, the one current row,
// the Needs-you count, Recent, Search and the account row. The last test draws the connected menu on the app's own
// store, where menu.ts decides the current row.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { forgetKeys, KEYS_KEY, setKeys } from "../app/keys";
import { getStore } from "../state/store";
import { SideMenu, Sidebar, type Budget, type RecentItem } from "./Sidebar";
import type { MenuRow } from "./menu";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const count = (html: string, needle: string) => html.split(needle).length - 1;
const noop = () => {};

function menu(over: { current?: MenuRow | null; needs?: number; recent?: RecentItem[]; settings?: boolean; account?: { name: string; initial: string }; budget?: Budget } = {}) {
  setLang("en");
  return renderToString(
    <SideMenu
      current={over.current === undefined ? "new" : over.current}
      needs={over.needs ?? 0}
      recent={over.recent ?? []}
      settings={over.settings ?? false}
      account={over.account}
      budget={over.budget}
      onRow={noop}
      onSearch={noop}
      onAccount={noop}
    />,
  );
}

/** The test id of the row marked current, or null. */
const currentOf = (html: string) => /aria-current="page"[^>]*data-testid="([^"]+)"/.exec(html)?.[1] ?? null;

describe("the side menu", () => {
  it("has the canvas's rows, top to bottom, under the brand mark and Search", () => {
    const html = menu();
    expect(html).toContain('data-testid="sidebar"');
    expect(html).toContain('aria-label="Manut AI home"');
    expect(html).toMatch(/<button[^>]*aria-label="Search"[^>]*data-testid="menu-search"/);
    expect(words(html)).toMatch(/New Needs you Team Code Artifacts Customize History/);
    // New is the canvas's highlighted first row
    expect(html).toMatch(/class="nav new"[^>]*data-testid="menu-new"/);
  });

  it("has Hide beside Search, and a hidden menu takes no focus and no clicks (the owner's ask of 27 Nov 2026)", () => {
    const shown = renderToString(<SideMenu current="new" needs={0} recent={[]} settings={false} onRow={noop} onSearch={noop} onAccount={noop} onHide={noop} />);
    expect(shown).toMatch(/data-testid="menu-search"[\s\S]*aria-label="Hide the side menu"[^>]*data-testid="menu-hide"/);
    expect(shown).not.toMatch(/data-testid="sidebar"[^>]*inert/);
    const hidden = renderToString(<SideMenu current="new" needs={0} recent={[]} settings={false} onRow={noop} onSearch={noop} onAccount={noop} onHide={noop} hidden />);
    expect(hidden).toMatch(/<nav[^>]*inert=""[^>]*aria-hidden="true"|<nav[^>]*aria-hidden="true"[^>]*inert=""/);
    // without the action, no button
    expect(menu()).not.toContain("menu-hide");
  });

  it("marks exactly the current row, or none", () => {
    for (const row of ["new", "needs", "team", "code", "artifacts", "customize", "history"] as const) {
      const html = menu({ current: row });
      expect(count(html, 'aria-current="page"'), row).toBe(1);
      expect(currentOf(html), row).toBe(`menu-${row}`);
    }
    expect(count(menu({ current: null }), 'aria-current="page"')).toBe(0);
  });

  it("counts the open asks beside Needs you, and shows no count at 0", () => {
    expect(menu({ needs: 0 })).not.toContain('class="cnt"');
    expect(menu({ needs: 4 })).toMatch(/data-testid="menu-needs"[^>]*>.*Needs you<span class="cnt"[^>]*>4<\/span>/);
  });

  it("names the three recent threads under Recent, and leaves out the heading with none", () => {
    const recent = ["Discount for a bulk order", "Replies about late parcels", "New thread"].map((title, i) => ({ key: `k${i}`, title, open: noop }));
    const html = menu({ recent });
    const text = words(html);
    expect(text).toMatch(/Recent Discount for a bulk order Replies about late parcels New thread/);
    expect(count(html, 'data-testid="menu-recent"')).toBe(3);
    expect(words(menu({ recent: [] }))).not.toContain("Recent");
  });

  it("marks a pinned chat and a settled chat, and gives each Recent row its menu button (item 76)", () => {
    const recent = [
      { key: "a", title: "Pinned one", open: noop, place: "pinned" as const, rowKey: "thread:buddy:a" },
      { key: "b", title: "Plain one", open: noop, rowKey: "thread:buddy:b" },
      { key: "c", title: "Settled one", open: noop, place: "settled" as const, rowKey: "thread:buddy:c" },
    ];
    const html = menu({ recent });
    expect(count(html, 'data-testid="menu-recent-pin"')).toBe(1);
    expect(count(html, 'data-testid="row-more"')).toBe(3);
    expect(html).toMatch(/data-place="settled"/);
    // the menu itself stays shut until it is asked for
    expect(html).not.toContain('role="menu"');
  });

  it("ends on the account row, which opens Settings and is current while Settings is open", () => {
    const html = menu();
    expect(words(html)).toMatch(/You , Settings/);
    expect(html).toMatch(/<button[^>]*class="acct"[^>]*data-testid="nav-settings"/);
    expect(menu({ current: null, settings: true })).toMatch(/class="acct" aria-current="page"/);
  });

  it("names the person and the shop on the account row once they are known, as the canvas's Fon, Baan Mali", () => {
    const html = menu({ account: { name: "Fon, Baan Mali", initial: "F" } });
    expect(html).toMatch(/<span class="av" aria-hidden="true">F<\/span><span class="acct-n">Fon, Baan Mali<\/span>/);
    expect(words(html)).toMatch(/Fon, Baan Mali , Settings/);
    // until then it says You, as before
    expect(menu()).toMatch(/<span class="av" aria-hidden="true">Y<\/span><span class="acct-n">You<\/span>/);
  });

  it("shows no budget until the runtime has one: no invented numbers", () => {
    const html = menu();
    expect(html).not.toContain("planp");
    expect(html).not.toContain("฿");
    // an amount that is not whole satang draws nothing rather than a guess
    expect(menu({ budget: { spentSatang: 186.5, capSatang: 30000 } })).not.toContain("planp");
    expect(menu({ budget: { spentSatang: -1, capSatang: 30000 } })).not.toContain("planp");
  });

  it("ends as the canvas's foot does: the budget pill, then the person with their shop (item 85i)", () => {
    const html = menu({ budget: { spentSatang: 18600, capSatang: 30000 }, account: { name: "Fon, Baan Mali", initial: "F" } });
    expect(html).toMatch(/<span class="planp" role="img" aria-label="AI budget this month: ฿186 of ฿300" data-testid="menu-budget">฿186 of ฿300<\/span>/);
    expect(words(html)).toMatch(/฿186 of ฿300 F Fon, Baan Mali , Settings/);
    // the coding tools' marks are not in the menu's foot: they are on the Code page
    expect(html).not.toContain('data-testid="usage"');
  });
});

describe("the menu on the app's store", () => {
  it("marks New on Home, where the app starts, Team on a member's main chat, a page its own row, and nothing in Settings", async () => {
    setLang("en");
    const store = getStore();
    await store.actions.init();
    expect(store.getState().selectedBot).toBe("buddy");
    expect(store.getState().ui.view).toBe("home");
    expect(currentOf(renderToString(<Sidebar />))).toBe("menu-new");
    // Buddy's main chat is Buddy's page now that Home is its own place
    await store.actions.selectBot("buddy");
    expect(currentOf(renderToString(<Sidebar />))).toBe("menu-team");
    store.actions.openPage("home");
    expect(currentOf(renderToString(<Sidebar />))).toBe("menu-new");
    await store.actions.selectBot("ton");
    expect(currentOf(renderToString(<Sidebar />))).toBe("menu-team");
    store.actions.openPage("history");
    expect(currentOf(renderToString(<Sidebar />))).toBe("menu-history");
    store.actions.openAutomations();
    expect(currentOf(renderToString(<Sidebar />))).toBe("menu-customize");
    store.actions.openSettings();
    const html = renderToString(<Sidebar />);
    expect(count(html, 'class="nav')).toBe(7);
    expect(html).not.toMatch(/class="nav[^"]*" aria-current/);
    expect(html).toMatch(/class="acct" aria-current="page"/);
  });

  it("names the person and the shop the first-run setup kept, as soon as a step's Next keeps them", async () => {
    setLang("en");
    const store = getStore();
    await store.actions.init();
    const a = store.actions;
    a.openFirstRun();
    a.firstRunDo({ type: "edit", field: "person", value: "Fon" });
    a.firstRunDo({ type: "edit", field: "shop", value: "Baan Mali" });
    a.firstRunDo({ type: "place", channel: "line" });
    expect(words(renderToString(<Sidebar />))).not.toContain("Baan Mali");
    a.firstRunDo({ type: "next" });
    expect(renderToString(<Sidebar />)).toMatch(/<span class="av" aria-hidden="true">F<\/span><span class="acct-n">Fon, Baan Mali<\/span>/);
    a.firstRunEnd();
  });
});

describe("the buttons that have a key say it in their tooltip (item 167d)", () => {
  const storage = new Map<string, string>();
  const mac = (on: boolean) => vi.stubGlobal("navigator", { platform: on ? "MacIntel" : "Linux x86_64" });
  beforeEach(() => {
    storage.clear();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
    forgetKeys();
    mac(true);
  });
  afterEach(() => vi.unstubAllGlobals());

  const withHide = () => renderToString(<SideMenu current="new" needs={0} recent={[]} settings={false} onRow={noop} onSearch={noop} onAccount={noop} onHide={noop} />);
  /** A button's tooltip and the key it names to assistive technology, found by its test id. */
  const tip = (html: string, id: string) => {
    const tag = new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? "";
    return { title: /title="([^"]*)"/.exec(tag)?.[1], keys: /aria-keyshortcuts="([^"]*)"/.exec(tag)?.[1], label: /aria-label="([^"]*)"/.exec(tag)?.[1] };
  };

  it("names the palette's, the side menu's and Settings' keys on Search, Hide and the account row", () => {
    setLang("en");
    const html = withHide();
    expect(tip(html, "menu-search")).toEqual({ title: "Search (⌘K)", keys: "Meta+K", label: "Search" });
    expect(tip(html, "menu-hide")).toEqual({ title: "Hide the side menu (⇧⌘S)", keys: "Shift+Meta+S", label: "Hide the side menu" });
    expect(tip(html, "nav-settings")).toEqual({ title: "Settings (⌘,)", keys: "Meta+,", label: undefined });
  });

  it("draws the keys of the keyboard it is on", () => {
    setLang("en");
    mac(false);
    forgetKeys();
    expect(tip(withHide(), "menu-search").title).toBe("Search (Ctrl+K)");
    expect(tip(withHide(), "menu-hide").title).toBe("Hide the side menu (Ctrl+Shift+S)");
  });

  it("names the key the person set, and the words alone when they gave none", () => {
    setLang("en");
    setKeys("search", [{ meta: true, ctrl: false, alt: false, shift: false, code: "KeyP" }], true);
    expect(tip(withHide(), "menu-search").title).toBe("Search (⌘P)");
    expect(tip(withHide(), "menu-search").keys).toBe("Meta+P");
    storage.set(KEYS_KEY, JSON.stringify({ search: [], sidebar: [] }));
    forgetKeys();
    expect(tip(withHide(), "menu-search")).toEqual({ title: "Search", keys: undefined, label: "Search" });
    expect(tip(withHide(), "menu-hide")).toEqual({ title: "Hide the side menu", keys: undefined, label: "Hide the side menu" });
    // the other keys are as they were
    expect(tip(withHide(), "nav-settings").title).toBe("Settings (⌘,)");
  });

  it("writes the tooltip in the language's own brackets", () => {
    setLang("ja");
    expect(tip(withHide(), "menu-search").title).toMatch(/（⌘K）$/);
    setLang("en");
  });
});
