// The shop switcher at the end of the account row (ShopSwitcher.tsx), drawn with react-dom/server: it shows only for two
// or more shops, opens a menu above the row, and leaves the row itself the way to Settings. The notice that a shop's
// place ended sits above the row until dismissed.
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import type { ShopLeft, ShopRow } from "../lib/protocol";
import { SideMenu, shopNotice } from "./Sidebar";
import { moveIn, shopItems, shopLabel } from "./ShopSwitcher";

const A: ShopRow = { id: "pilot:a", name: "Baan Mali", owner: "Fon", role: "owner" };
const B: ShopRow = { id: "pilot:b", name: "Ran Pa Noi", owner: "Noi", role: "helper" };
const noop = () => {};

function menu(list: ShopRow[], notice: { text: string; dismiss: () => void } | null = null) {
  setLang("en");
  return renderToString(
    <SideMenu
      current="new"
      needs={0}
      recent={[]}
      settings={false}
      account={{ name: "Fon, Baan Mali", initial: "F" }}
      shops={{ list, current: list[0]?.id ?? null, onSwitch: noop }}
      notice={notice}
      onRow={noop}
      onSearch={noop}
      onAccount={noop}
    />,
  );
}

describe("the shop switcher", () => {
  it("shows a switch button at the end of the account row only for a person in two or more shops", () => {
    const two = menu([A, B]);
    expect(two).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-label="Switch shop"[^>]*data-testid="shop-switch"/);
    // the row itself still opens Settings, and names the person and the shop shown
    expect(two).toMatch(/data-testid="nav-settings"/);
    expect(two).toContain("Fon, Baan Mali");
    for (const list of [[A], []]) expect(menu(list)).not.toContain("shop-switch");
  });

  it("lists the shops with their role in words and a tick on the one shown", () => {
    setLang("en");
    expect(shopItems([A, B], B.id)).toEqual([
      { id: A.id, name: "Baan Mali", role: "Owner", current: false },
      { id: B.id, name: "Ran Pa Noi", role: "Helper", current: true },
    ]);
    expect(shopLabel({ name: "" })).toBe("Your shop");
    setLang("ja");
    expect(shopItems([A, B], A.id).map((i) => i.role)).toEqual(["オーナー", "ヘルパー"]);
    setLang("en");
  });

  it("moves through the list with the arrow keys, Home and End, round at the ends", () => {
    expect(moveIn("ArrowDown", 0, 3)).toBe(1);
    expect(moveIn("ArrowDown", 2, 3)).toBe(0);
    expect(moveIn("ArrowUp", 0, 3)).toBe(2);
    expect(moveIn("Home", 2, 3)).toBe(0);
    expect(moveIn("End", 0, 3)).toBe(2);
    expect(moveIn("a", 0, 3)).toBeNull();
  });
});

describe("the notice that a shop's place ended", () => {
  const left: ShopLeft[] = [
    { id: B.id, name: "Ran Pa Noi", owner: "Noi", why: "removed", at: Date.UTC(2026, 10, 22, 3) / 1000 },
    { id: A.id, name: "Baan Mali", owner: "Fon", why: "gone", at: null },
  ];

  it("says the newest one not dismissed, above the account row, with a way to dismiss it", () => {
    setLang("en");
    const dismissed: string[] = [];
    const notice = shopNotice({ left, dismissed: [] }, (id) => dismissed.push(id));
    expect(notice?.text).toBe("You no longer have access to Ran Pa Noi. Noi removed you on Sunday, November 22. Ask Noi if this is a mistake");
    notice?.dismiss();
    expect(dismissed).toEqual([B.id]);
    expect(shopNotice({ left, dismissed: [B.id] }, noop)?.text).toBe("Baan Mali is no longer one of your shops");
    expect(shopNotice({ left, dismissed: [A.id, B.id] }, noop)).toBeNull();
    const html = menu([A], notice);
    expect(html).toMatch(/role="status"[^>]*data-testid="shop-notice"/);
    expect(html).toMatch(/aria-label="Dismiss"[^>]*data-testid="shop-notice-dismiss"/);
    expect(html.indexOf("shop-notice")).toBeLessThan(html.indexOf("nav-settings"));
  });
});
