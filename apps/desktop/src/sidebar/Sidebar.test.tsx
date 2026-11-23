// The side menu as the design canvas draws it, drawn with react-dom/server: the rows in order, the one current row,
// the Needs-you count, Recent, Search and the account row. The last test draws the connected menu on the app's own
// store, where menu.ts decides the current row.
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { getStore } from "../state/store";
import { SideMenu, Sidebar, type RecentItem } from "./Sidebar";
import type { MenuRow } from "./menu";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const count = (html: string, needle: string) => html.split(needle).length - 1;
const noop = () => {};

function menu(over: { current?: MenuRow | null; needs?: number; recent?: RecentItem[]; settings?: boolean } = {}) {
  setLang("en");
  return renderToString(
    <SideMenu
      current={over.current === undefined ? "new" : over.current}
      needs={over.needs ?? 0}
      recent={over.recent ?? []}
      settings={over.settings ?? false}
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

  it("ends on the account row, which opens Settings and is current while Settings is open", () => {
    const html = menu();
    expect(words(html)).toMatch(/You , Settings/);
    expect(html).toMatch(/<button[^>]*class="acct"[^>]*data-testid="nav-settings"/);
    expect(menu({ current: null, settings: true })).toMatch(/class="acct" aria-current="page"/);
  });

  it("shows no budget until the runtime has one: no invented numbers", () => {
    const html = menu();
    expect(html).not.toContain("planp");
    expect(html).not.toContain("฿");
  });
});

describe("the menu on the app's store", () => {
  it("marks New on Buddy's main chat, Team on another member's, a page its own row, and nothing in Settings", async () => {
    setLang("en");
    const store = getStore();
    await store.actions.init();
    expect(store.getState().selectedBot).toBe("buddy");
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
});
