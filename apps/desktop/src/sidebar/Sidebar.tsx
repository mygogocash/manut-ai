// The side menu, as the design canvas draws it (`<nav class="sb">` in Main.dc.html and KitNavigation.dc.html, 196px
// wide): the brand mark and Search, then New, Needs you (with the count of open asks), Team, Code, Artifacts, Customize and
// History, a Recent list of the three newest threads, and at the foot the budget pill and the account row, which names
// the person with their shop and opens Settings. New and the brand mark open Home. A person in two or more shops also has
// the shop switcher at the end of the account row (ShopSwitcher.tsx), and is told above the row when their place in a
// shop ended (docs/several-shops.md). It replaces the sidebar the fork took from Oh My Hermes (a search box, a tasks bar, a
// needs strip, the BOTS and TERMINALS lists and a foot of icon buttons), and each of those now lives on one of the menu's
// pages (src/pages). The coding tools' use, which sat in the foot as three small marks, is on the Code page, one click
// away (item 85i). The budget pill shows only what the runtime gives it, and no runtime gives a budget yet; hiding the
// menu is not built yet.
//
// menu.ts decides which row is current. `SideMenu` draws whatever it is given, so tests can draw any state, and
// `Sidebar` feeds it from the app's store.
import type { ReactNode } from "react";
// sidebar.css still styles what the menu's foot carries (the disk chip, the update control), the usage meters the Code
// page shows, and .vh, and sessions.css styles the terminal view and the Code page's list.
import "./sidebar.css";
import "../sessions/sessions.css";
import "./menu.css";
import { t, type Key } from "../i18n";
import type { ShopRow } from "../lib/protocol";
import { helpedShop, leftWords } from "../lib/shops";
import { can } from "../runtime";
import { selectAsks, selectSidebarBots, shopName, useStore, viewedShopName, type ShopsState } from "../state/store";
import { AccountsWatcher } from "../settings/accounts/useAccounts";
import { isDesktop } from "../settings/accounts/native";
import { accountLabel, EMPTY_SHOP } from "../onboarding/shop";
import { currentRow, MENU_ROWS, recentParts, rowPage, type MenuRow } from "./menu";
import { rowStatus } from "../threads/ThreadTree";
import { MoreButton, settledWhy, useRowMenu } from "./RowMenu";
import { threadRowKey, useRowMarks } from "./rows";
import { RowsWatcher } from "./RowsWatcher";
import { useInbox } from "./inbox";
import { useRowSelect, useSelectionEscape } from "./useRowSelect";

type RowSelect = ReturnType<typeof useRowSelect>;
import { togglePalette } from "../palette/state";
import { BrandMark, MenuIcon, SearchGlyph } from "./menuIcons";
import { Icon } from "../ui/icons";
import { DiskChip } from "./DiskChip";
import { ModeLine } from "./ModeLine";
import { ShopSwitcher } from "./ShopSwitcher";
import { UpdateButton } from "./UpdateButton";
import { satangText } from "../pages/job";

const LABEL: Record<MenuRow, Key> = {
  new: "menu.new",
  needs: "menu.needs",
  team: "menu.team",
  code: "menu.code",
  artifacts: "menu.artifacts",
  customize: "menu.customize",
  history: "menu.history",
};

/** A thread as Recent names it, and what opens it. */
export interface RecentItem {
  key: string;
  title: string;
  open: () => void;
  /** Pinned (on top, marked) or settled (below, small and quiet); none for a plain recent chat. */
  place?: "pinned" | "settled";
  /** The row's key for its menu (rows.ts); a row without one has no menu. */
  rowKey?: string;
  /** Its turn runs: Snooze also offers "Until it finishes" (item 94). */
  working?: boolean;
  /** Why it settled by itself, on its quiet second line ("Done after 3 quiet days"); none for a row the person settled. */
  why?: string | null;
}

/** One chat of Recent: the row, and the menu of what can be done to it (Pin, Snooze, Done for now, Archive), to it alone or to every
 *  row selected with it (item 94). */
function RecentRow({ item, select }: { item: RecentItem; select: RowSelect }) {
  const marks = useRowMarks();
  const keys = item.rowKey ? select.actsOn(item.rowKey) : [];
  const many = keys.length > 1;
  const menu = useRowMenu({ rowKey: item.rowKey ?? "", kind: "chat", mark: item.rowKey ? marks[item.rowKey] : undefined, name: many ? t("row.count", { n: keys.length }) : item.title, working: item.working, keys });
  const selected = select.selected(item.rowKey);
  return (
    <li className={`rec-li${item.place ? ` ${item.place}` : ""}${menu.isOpen ? " menu-open" : ""}`} data-place={item.place} data-flip={item.key} data-row-key={item.rowKey} data-sel={selected || undefined} onContextMenu={item.rowKey ? menu.onContextMenu : undefined}>
      <button type="button" className="rec" title={item.title} onClick={(e) => select.click(e, item.rowKey, item.open)} onKeyDown={(e) => select.keyDown(e, item.rowKey)} data-testid="menu-recent">
        {item.place === "pinned" && (
          <span className="rec-pin" role="img" aria-label={t("row.pinned")} title={t("row.pinned")} data-testid="menu-recent-pin">
            <PinGlyph />
          </span>
        )}
        {item.title}
        {item.why && (
          <span className="rec-why" data-testid="menu-recent-why">
            {item.why}
          </span>
        )}
        {selected && <span className="vh">, {t("row.selected")}</span>}
      </button>
      {item.rowKey && <MoreButton name={item.title} onOpen={menu.open} className="rec-more" />}
      {menu.menu}
    </li>
  );
}

/** A pinned chat's mark: the set's pin (src/ui/icons.tsx). */
function PinGlyph() {
  return <Icon name="pin" />;
}

export function SideMenu({
  current,
  needs,
  recent,
  working = [],
  settings,
  account = accountLabel(EMPTY_SHOP),
  helping = false,
  shops,
  notice,
  onRow,
  onSearch,
  onAccount,
  foot,
  budget = null,
}: {
  /** the row marked current, or none (a thread, Settings) */
  current: MenuRow | null;
  /** how many asks wait on the person; no count shows at 0 */
  needs: number;
  recent: RecentItem[];
  /** The Working group (item 94): chats whose turn runs, when the person turned the group on; nothing is drawn while it is empty. */
  working?: RecentItem[];
  /** Settings is open: the account row is current, as on the canvas's Settings board */
  settings: boolean;
  /** who the account row names and the initial in its avatar (onboarding/shop.ts `accountLabel`); "You" by default */
  account?: { name: string; initial: string };
  /** the shop the account row names is one the person only helps at: the row says "Helper" after it */
  helping?: boolean;
  /** the person's shops, for the switcher at the end of the account row; it shows only with two or more */
  shops?: { list: readonly ShopRow[]; current: string | null; onSwitch: (id: string) => void };
  /** that the person's place in a shop ended, said above the account row until dismissed */
  notice?: { text: string; dismiss: () => void } | null;
  onRow: (row: MenuRow) => void;
  onSearch: () => void;
  onAccount: () => void;
  /** what the runtime and this computer add above the account row: the disk chip, an update, which data this is */
  foot?: ReactNode;
  /** the shop's AI spend this month against its cap, in integer satang, when the runtime gives them; none draws no pill */
  budget?: Budget | null;
}) {
  // Recent and the Working group are one list to select in, in the order they are drawn
  const order = [...recent, ...working].flatMap((r) => (r.rowKey ? [r.rowKey] : []));
  const select = useRowSelect("recent", order);
  useSelectionEscape();
  return (
    <nav className="sb" aria-label={t("menu.label")} data-testid="sidebar" data-select-scope="recent">
      <div className="brand">
        {/* The mark leads where New does, as the canvas's mark links to Home. */}
        <button type="button" className="sb-home" aria-label={t("menu.home")} onClick={() => onRow("new")} data-testid="menu-home">
          <BrandMark />
        </button>
        <button type="button" className="ib" aria-label={t("nav.search")} title={t("nav.search")} onClick={onSearch} data-testid="menu-search">
          <SearchGlyph />
        </button>
      </div>
      {MENU_ROWS.map((row) => (
        <button
          key={row}
          type="button"
          className={row === "new" ? "nav new" : "nav"}
          aria-current={current === row ? "page" : undefined}
          onClick={() => onRow(row)}
          data-testid={`menu-${row}`}
        >
          <MenuIcon row={row} />
          {t(LABEL[row])}
          {row === "needs" && needs > 0 && (
            <span className="cnt" data-testid="menu-needs-count">
              {needs}
            </span>
          )}
        </button>
      ))}
      {recent.length > 0 && (
        <>
          <div className="sb-h" id="menu-recent-h">
            {t("menu.recent")}
          </div>
          <ul className="sb-recent" aria-labelledby="menu-recent-h" data-arrive="sidebar" data-arrive-rows=".rec-li" data-flip-list>
            {recent.map((r) => (
              <RecentRow key={r.key} item={r} select={select} />
            ))}
          </ul>
        </>
      )}
      {working.length > 0 && (
        <>
          <div className="sb-h" id="menu-working-h">
            {t("menu.working")}
          </div>
          <ul className="sb-recent sb-working" aria-labelledby="menu-working-h" data-testid="menu-working">
            {working.map((r) => (
              <RecentRow key={r.key} item={r} select={select} />
            ))}
          </ul>
        </>
      )}
      <div className="sb-foot">
        {foot}
        {/* Who uses the app, and their settings. The canvas names the owner and the shop here ("Fon, Baan Mali"): the
            row names them as the first-run setup took them on this computer, and says "You" for what it was not told,
            never anything made up. */}
        {notice && (
          <div className="sb-shop-note" role="status" data-testid="shop-notice">
            <span className="sb-shop-note-t">{notice.text}</span>
            <button type="button" className="ib" aria-label={t("shops.dismiss")} title={t("shops.dismiss")} onClick={notice.dismiss} data-testid="shop-notice-dismiss">
              <span aria-hidden="true">×</span>
            </button>
          </div>
        )}
        {/* The canvas's plan pill: the AI budget this month, read and never guessed, so it shows only with the runtime's
            numbers. */}
        {budget && <BudgetPill budget={budget} />}
        <div className="acct-row">
          <button type="button" className="acct" aria-current={settings ? "page" : undefined} title={t("nav.settings")} onClick={onAccount} data-testid="nav-settings">
            <span className="av" aria-hidden="true">
              {account.initial}
            </span>
            <span className="acct-n">{account.name}</span>
            {/* A shop the person only helps at is marked so on the row that names it, as the switcher marks it, so a helper
                with one shop (and so no switcher) knows too. */}
            {helping && (
              <span className="acct-role" data-testid="acct-role">
                {t("shops.helper")}
              </span>
            )}
            <span className="vh">, {t("nav.settings")}</span>
          </button>
          {shops && <ShopSwitcher list={shops.list} current={shops.current} onSwitch={shops.onSwitch} />}
        </div>
      </div>
    </nav>
  );
}

/** The shop's AI spend this month and its cap, both integer satang (money is never a float). */
export interface Budget {
  spentSatang: number;
  capSatang: number;
}

/** "฿186 of ฿300", the canvas's `.planp` in the menu's foot. Anything that is not two whole, non-negative amounts draws
 *  nothing rather than a guess. */
export function BudgetPill({ budget }: { budget: Budget }) {
  const ok = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!ok(budget.spentSatang) || !ok(budget.capSatang)) return null;
  const words = { spent: satangText(budget.spentSatang), cap: satangText(budget.capSatang) };
  return (
    <span className="planp" role="img" aria-label={t("menu.budgetAria", words)} data-testid="menu-budget">
      {t("menu.budget", words)}
    </span>
  );
}

/** The newest shop the person's place in ended and that they have not dismissed, in words, or null. */
export function shopNotice(shops: Pick<ShopsState, "left" | "dismissed">, dismiss: (id: string) => void): { text: string; dismiss: () => void } | null {
  const left = shops.left.find((l) => !shops.dismissed.includes(l.id));
  return left ? { text: leftWords(left), dismiss: () => dismiss(left.id) } : null;
}

export function Sidebar() {
  const s = useStore();
  const members = selectSidebarBots(s).map((b) => b.name);
  const untitled = t("thread.untitled");
  const marks = useRowMarks();
  const inbox = useInbox();
  const parts = recentParts(s.threads, members, marks, (bot, row) => rowStatus(s, bot, row) === "needs_you", Date.now(), 3, { working: (bot, row) => rowStatus(s, bot, row) === "running", group: inbox.working });
  const item = (place: RecentItem["place"]) => (r: { bot: string; thread: string; title: string; working?: boolean }): RecentItem => ({
    key: `${r.bot}:${r.thread}`,
    title: r.title || untitled,
    open: () => void s.openThread(r.bot, r.thread),
    place,
    rowKey: threadRowKey(r.bot, r.thread),
    working: r.working,
    why: place === "settled" ? settledWhy(marks[threadRowKey(r.bot, r.thread)]) : null,
  });
  const recent = [...parts.pinned.map(item("pinned")), ...parts.recent.map(item(undefined)), ...parts.settled.map(item("settled"))];
  // New (and the brand mark) opens Home; every other row opens its own page.
  const go = (row: MenuRow) => s.openPage(rowPage(row));
  return (
    <>
    <RowsWatcher />
    <SideMenu
      current={currentRow(s.ui, s.selectedBot)}
      needs={selectAsks(s).length}
      recent={recent}
      working={parts.working.map(item(undefined))}
      settings={s.ui.view === "settings"}
      account={accountLabel({ person: s.ui.shop.person, shop: viewedShopName(s) })}
      helping={!!helpedShop(s.shops)}
      shops={{ list: s.shops.list.map((r) => ({ ...r, name: shopName(s, r) })), current: s.shops.current, onSwitch: (id) => void s.switchShop(id) }}
      notice={shopNotice(s.shops, s.dismissShopNotice)}
      onRow={go}
      onSearch={() => togglePalette()}
      onAccount={() => s.openSettings()}
      foot={
        <>
          {/* A chip when the home folder's volume is low on space (src/lib/disk.ts), and nothing while it is fine. */}
          <DiskChip />
          {/* the desktop app's shell keeps the accounts in every mode (item 74); a runtime may keep them too */}
          {(can("accounts") || isDesktop()) && <AccountsWatcher />}
          {/* A newer signed release, which shows nothing until in-app updates are turned on (updater.ts). */}
          <UpdateButton />
          {/* Practice mode, or the API host it is connected to: never a guess about which data this is. */}
          <ModeLine onOpen={() => s.openSettings("developer")} />
        </>
      }
    />
    </>
  );
}
