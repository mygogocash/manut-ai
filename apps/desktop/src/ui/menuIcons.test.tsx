// Every menu led by an icon (item 122, the owner's request of 26 Nov 2026): each entry of the menus the owner named starts
// with one 16px slot, hidden from a screen reader, holding an icon of the set or (for an entry that names a product) that
// product's own logo, so the words of every entry stand on one column and the reading order is the words alone.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MenuIcon } from "./MenuIcon";
import { ICONS } from "./icons";
import { CHOICE_ICON, RowMenu, SNOOZE_ICON, rowChoices } from "../sidebar/RowMenu";
import { ROW_ACTION_ICON, rowMenuItems, termMenuItems } from "../sessions/SessionsSection";
import { TERM_MENU_ICON } from "../sessions/term/TermMenu";

/** Each menu entry of `html` (a menuitem button), as [its lead's markup, its words]. */
const entries = (html: string) =>
  [...html.matchAll(/<button[^>]*role="menuitem"[^>]*>([^]*?)<\/button>/g)].map(([, inner]) => {
    const lead = /^<span class="mi-ic" aria-hidden="true">([^]*?)<\/span>/.exec(inner);
    return { lead: lead?.[1] ?? null, words: inner.replace(/<[^>]+>/g, "").trim() };
  });

describe("a menu entry's lead", () => {
  it("is one 16px slot hidden from a screen reader: an icon of the set, a product's own logo, or nothing at all", () => {
    expect(renderToString(createElement(MenuIcon, { name: "pin" }))).toMatch(/^<span class="mi-ic" aria-hidden="true"><svg class="ic" width="16" height="16" viewBox="0 0 16 16"/);
    expect(renderToString(createElement(MenuIcon, { mark: { id: "zed", title: "Zed" } }))).toMatch(/^<span class="mi-ic" aria-hidden="true"><svg width="16" height="16"[^>]*data-agent="zed"/);
    expect(renderToString(createElement(MenuIcon, { mark: { id: "vscode", title: "Visual Studio Code" } }))).toContain('data-letter="V"');
    // the slot stays when it holds nothing, so the words never move
    expect(renderToString(createElement(MenuIcon, {}))).toBe('<span class="mi-ic" aria-hidden="true"></span>');
  });

  it("names a drawing of the set for every choice of a row's menu, its snooze step, a session's menu and a terminal's", () => {
    for (const icons of [CHOICE_ICON, SNOOZE_ICON, ROW_ACTION_ICON, TERM_MENU_ICON])
      for (const [k, name] of Object.entries(icons)) expect(ICONS, k).toHaveProperty(name);
    // and a session's menu has an icon for every entry it can offer
    const all = new Set([...rowMenuItems({ cwd: "/x", agentSession: "s" }, true), ...termMenuItems({ cwd: "/x", linkId: "l" }, { pinned: 1 }, true, true), ...termMenuItems({ cwd: "/x" }, { settled: true })]);
    for (const a of all) expect(ROW_ACTION_ICON, a).toHaveProperty(a);
  });
});

describe("a row's menu (a chat's, a lane's, a terminal's)", () => {
  const menu = (props: Partial<Parameters<typeof RowMenu>[0]>) =>
    renderToString(createElement(RowMenu, { rowKey: "thread:b:t", kind: "chat", mark: undefined, name: "Weekend sale post", at: { x: 4, y: 4 }, onDismiss: () => undefined, ...props }));

  it("leads Pin, Snooze, Done for now and Archive with their icons, and the extra rows given it keep theirs", () => {
    const rows = entries(menu({ extra: <button type="button" role="menuitem" className="row-mi"><MenuIcon mark={{ id: "cursor", title: "Cursor" }} />Open in Cursor</button> }));
    expect(rows.map((r) => r.words)).toEqual(["Pin to top", "Snooze", "Done for now", "Archive", "Open in Cursor"]);
    for (const r of rows) expect(r.lead, r.words).toMatch(/^<svg/);
    expect(rows[4].lead).toContain('data-agent="cursor"');
  });

  it("leads every other state's choices too", () => {
    for (const mark of [{ pinned: 1 }, { snoozed: 5 }, { archived: 5 }]) {
      const rows = entries(menu({ mark }));
      expect(rows.length).toBe(rowChoices("chat", mark).length);
      for (const r of rows) expect(r.lead, r.words).toMatch(/^<svg/);
    }
  });
});
