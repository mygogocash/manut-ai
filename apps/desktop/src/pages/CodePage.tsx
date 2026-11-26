// Code: Kit's settings for one project (src/code/KitPanel.tsx: how much Kit does alone, what was stopped outside the
// project, what is always allowed), then the coding sessions the sidebar's TERMINALS section listed, reused whole from
// src/sessions/SessionsSection.tsx (its header with the + menu, its folder groups and rows, and the menu a right press
// on the empty part opens), then the Tasks row (src/tasks/TasksBar.tsx) that opens the Tasks page, and last how much of
// each coding tool's plan is used (src/sidebar/Usage.tsx), which sat in the side menu's foot until item 85i and is one
// click from it here. A session opened from here fills the main column, and the menu keeps marking Code while it does.
// New project (item 100b) sits in the page's top bar: it opens its panel at the top of the column (src/code/NewProject.tsx).
import { useCallback, useState } from "react";
import { t } from "../i18n";
import "../sessions/sessions.css";
import { SESSIONS_ENTRY } from "../sessions/entry";
import { SessionBackgroundMenu } from "../sessions/SessionBackgroundMenu";
import { listFolder, SessionList, SessionsHeader } from "../sessions/SessionsSection";
import { TasksBar } from "../tasks/TasksBar";
import { KitPanel } from "../code/KitPanel";
import { NewProject } from "../code/NewProject";
import { getHost } from "../sessions/host";
import { MenuPageFrame } from "./MenuPage";
import { can } from "../runtime";
import { Usage } from "../sidebar/Usage";
import { OutsideUse } from "../usage/OutsideUse";
import { useSessions } from "../sessions/sessions";

/** A press on the section itself, not on a row, a control or a menu: what opens the section's own menu. */
const sessionBackground = (target: EventTarget) =>
  target instanceof Element && !target.closest(".ss-row, .tg-h, button, input, textarea, select, a, [contenteditable], [role=menu], [role=menuitem]");

export function CodePage() {
  const [menu, setMenu] = useState<{ x: number; y: number; focus: HTMLElement } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const { list, home } = useSessions();
  const [making, setMaking] = useState(false);
  const host = getHost();
  const offerNew = SESSIONS_ENTRY && !!host.projectNew;
  return (
    <MenuPageFrame
      page="code"
      title={t("menu.code")}
      acts={
        offerNew ? (
          <button type="button" className="btn" aria-expanded={making} onClick={() => setMaking((v) => !v)} title={t("proj.newTip")} data-testid="np-open">
            {t("proj.new")}
          </button>
        ) : undefined
      }
    >
      <div className="col">
        {offerNew && <NewProject host={host} home={home} open={making} onClose={() => setMaking(false)} onMade={listFolder} />}
        {SESSIONS_ENTRY && <KitPanel />}
        {SESSIONS_ENTRY && (
          // It keeps the sidebar section's test id, so what found TERMINALS there finds it here.
          <section
            className="terms"
            data-testid="side-sessions"
            tabIndex={-1}
            onPointerDown={(e) => {
              // Keep the previous focus for Escape, before the right press can blur it.
              if (e.button === 2 && sessionBackground(e.target)) e.preventDefault();
            }}
            onContextMenu={(e) => {
              // Rows own their menu, and controls and text fields keep their native one.
              if (!sessionBackground(e.target)) return;
              e.preventDefault();
              const focus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : e.currentTarget;
              const box = e.currentTarget.getBoundingClientRect();
              setMenu({ x: e.clientX || box.left + 8, y: e.clientY || box.top + 8, focus });
            }}
          >
            <SessionsHeader />
            <SessionList />
            {menu && <SessionBackgroundMenu at={menu} onClose={closeMenu} />}
          </section>
        )}
        <TasksBar />
        {/* The coding CLIs' subscription usage, which only a runtime that reads their logins has. */}
        {can("accounts") && (
          <section className="code-plans" aria-labelledby="code-plans-h" data-testid="code-plans">
            <div className="band" id="code-plans-h">
              {t("menu.plans")}
            </div>
            <Usage named />
            <OutsideUse list={list} />
          </section>
        )}
      </div>
    </MenuPageFrame>
  );
}
