// The side menu, as the design canvas draws it (`<nav class="sb">` in Approvals.dc.html): the brand mark and Search,
// then New, Needs you (with the count of open asks), Team, Code, Artifacts, Customize and History, a Recent list of the
// three newest threads, and the account row that opens Settings. It replaces the sidebar the fork took from Oh My
// Hermes (a search box, a tasks bar, a needs strip, the BOTS and TERMINALS lists and a foot of icon buttons), and each
// of those now lives on one of the menu's pages (src/pages). The canvas's budget pill waits until the runtime has a
// budget to show, and hiding the menu is not built yet.
//
// menu.ts decides which row is current. `SideMenu` draws whatever it is given, so tests can draw any state, and
// `Sidebar` feeds it from the app's store.
import type { ReactNode } from "react";
// sidebar.css still styles what the menu's foot carries (the disk chip, the usage meters, the update control) and
// .vh; sessions.css styles the terminal view and the Code page's list
import "./sidebar.css";
import "../sessions/sessions.css";
import "./menu.css";
import { t, type Key } from "../i18n";
import { can } from "../runtime";
import { selectAsks, selectSidebarBots, useStore } from "../state/store";
import { AccountsWatcher } from "../settings/accounts/useAccounts";
import { currentRow, homeBot, MENU_ROWS, recentThreads, type MenuRow } from "./menu";
import { BrandMark, MenuIcon, SearchGlyph } from "./menuIcons";
import { DiskChip } from "./DiskChip";
import { UpdateButton } from "./UpdateButton";
import { Usage } from "./Usage";

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
}

export function SideMenu({
  current,
  needs,
  recent,
  settings,
  onRow,
  onSearch,
  onAccount,
  foot,
}: {
  /** the row marked current, or none (a thread, Settings) */
  current: MenuRow | null;
  /** how many asks wait on the person; no count shows at 0 */
  needs: number;
  recent: RecentItem[];
  /** Settings is open: the account row is current, as on the canvas's Settings board */
  settings: boolean;
  onRow: (row: MenuRow) => void;
  onSearch: () => void;
  onAccount: () => void;
  /** what the runtime and this computer add above the account row: the disk chip, usage meters, an update */
  foot?: ReactNode;
}) {
  return (
    <nav className="sb" aria-label={t("menu.label")} data-testid="sidebar">
      <div className="brand">
        {/* the mark leads where New does, as the canvas's mark links to Home */}
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
          <ul className="sb-recent" aria-labelledby="menu-recent-h">
            {recent.map((r) => (
              <li key={r.key}>
                <button type="button" className="rec" title={r.title} onClick={r.open} data-testid="menu-recent">
                  {r.title}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="sb-foot">
        {foot}
        {/* who uses the app, and their settings. The canvas names the owner and the shop here; the runtime names
            neither yet, so the row says "You" and adds nothing made up */}
        <button type="button" className="acct" aria-current={settings ? "page" : undefined} title={t("nav.settings")} onClick={onAccount} data-testid="nav-settings">
          <span className="av" aria-hidden="true">
            {Array.from(t("nav.you"))[0]}
          </span>
          <span className="acct-n">{t("nav.you")}</span>
          <span className="vh">, {t("nav.settings")}</span>
        </button>
      </div>
    </nav>
  );
}

export function Sidebar() {
  const s = useStore();
  const members = selectSidebarBots(s).map((b) => b.name);
  const home = homeBot(s.bots, members);
  const untitled = t("thread.untitled");
  const recent = recentThreads(s.threads, members).map((r) => ({
    key: `${r.bot}:${r.thread}`,
    title: r.title || untitled,
    open: () => void s.openThread(r.bot, r.thread),
  }));
  const go = (row: MenuRow) => {
    // New is Home, and the home member's main chat stands in for Home until Home exists
    if (row === "new") {
      if (home) void s.selectBot(home);
    } else s.openPage(row);
  };
  return (
    <SideMenu
      current={currentRow(s.ui, s.selectedBot, home)}
      needs={selectAsks(s).length}
      recent={recent}
      settings={s.ui.view === "settings"}
      onRow={go}
      onSearch={() => s.openPage("history", { find: true })}
      onAccount={() => s.openSettings()}
      foot={
        <>
          {/* little disk space left on the home folder's volume (src/lib/disk.ts); nothing while it is fine */}
          <DiskChip />
          {/* the coding CLIs' subscription usage, which only a runtime that reads their logins has */}
          {can("accounts") && <Usage />}
          {can("accounts") && <AccountsWatcher />}
          {/* a newer signed release; nothing until in-app updates are turned on (updater.ts) */}
          <UpdateButton />
        </>
      }
    />
  );
}
