// SESSIONS in the sidebar: the `+` menu of agents, each two ways (owner, 25 Nov 2026, item 66): Chat with Kit opens its
// New session chat at once, whose first message starts a lane (see DraftPane in SessionView, and code/Lanes.tsx, which
// lists it), and In a terminal starts it in its own terminal at once, as since 16 Nov. One row per terminal session
// started in this run of the app. A draft row reads "New
// session" over its folder until its first message. A chat row shows the bot row's live states: the
// answer ring around the agent mark and the turn's elapsed time while a turn runs, and the amber dot with
// "waiting" while one of its approvals or questions is open (the same asks the Needs-you strip lists). A
// terminal row keeps a live dot while its program runs: a terminal has no turn to ring for.
// Every row ends line 2 with a small mark for the view it opens to: an outlined speech bubble for manut's chat, a
// solid little prompt window for the agent's terminal (a draft shows the way picked for it). A session's state takes
// the time's place on line 1 as a sign and a word: a yellow warning triangle and "waiting" while it waits for the
// person (an open ask, or its terminal rang), a red exclamation mark and "error" when it stopped on an error, a green
// check and "done" when it finished something the person has not opened yet. No dots: the row already has the live
// dot. A session that no longer runs steps back.
// Line 1 is the session's name (the person's, the agent's own title, a summary of the first message, else the
// folder) and line 2 the folder and the agent. Double-click the name, or right-click › Rename, to name it. A TERMINALS
// row dragged onto the open terminal splits it there (splitDrag.ts).
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { getStore, useStore } from "../state/store";
import { CloseIcon, LiveRing, PlusIcon, Popover, TypingDots } from "../ui";
import { busyFor, shortTime } from "../app/time";
import { t } from "../i18n";
import { composing } from "../lib/ime";
import { AgentMark } from "./AgentMark";
import { agentDef, agentLabel, chatAgents, draftFolder, folderChoices, folderName, installLine, offeredAgents, isTerminalRec, menuFocus, menuOrder, missingNote, parentPath, SHELL, splitPaneName, termActivity, termFallbackName, terminalAgents, termMarkAgent, termStatus, tildePath, type AgentId, type AgentInfo, type RowMark, type SessionRec, type TermStatus, type Unseen } from "./agents";
import { TermRowMark } from "./TermRowMark";
import { SplitGlyph, splitWith, useSplit, useSplitPrune } from "./SplitView";
import { pressToSplit } from "./splitDrag";
import { groupOf, groupSessions, paneOf } from "./splitState";
import type { Layout } from "../terminal/layout";
import { usePendingRequests } from "./termShare";
import { countRender, useAnyFlowing, useTermFace } from "./termActivity";
import { addFolder, addedFolders, allCollapsed, collapseOthers, folderGroups, pathKey, folderSummary, isCollapsed, isTildePath, getFolderPrefs, moveFolder, orderFolders, removeFolder, setAllFolders, setFolderGone, setFolderPrefs, toggleFolder, useFolderPrefs, useGoneFolders, withAdded } from "./folders";
import { ChevronDown, ChevronRight } from "../ui/icons";
import { CUE_PX, useEdgeFade } from "../sidebar/edgeFade";
import { getHost, type PastChat } from "./host";
import { getSessions, useSessions } from "./sessions";
import { pickTitle } from "./titles";
import { onOpenNewSessionMenu, useShells, type NewMenuStart } from "./newMenu";
import { onTermSettings, readTermSettings } from "./term/settings";
import { TermLinkGone } from "./termLinkOpen";
import type { Account, AccountGroup } from "../lib/protocol";
import { SESSION_CLI } from "./sessionCli";
import { agentSignedOut, signedOutTip, signedOutWord } from "./signedOut";
import { useAccounts } from "../settings/accounts/useAccounts";
import { accountForNewSessions } from "../settings/accounts/rules";


/** `work@example.com` -> `work@…`. */
const maskEmail = (email: string) => (email.includes("@") ? `${email.slice(0, email.indexOf("@"))}@…` : email);

/** The quiet "as …" next to an agent in the menu: the account Settings › Accounts picked for new sessions, by
 *  its name, else its masked email. Nothing for "This computer" or an agent without accounts. */
export function sessionAccountSuffix(groups: AccountGroup[] | null, agent: AgentId): string {
  const cli = SESSION_CLI[agent];
  const a: Account | null = cli ? accountForNewSessions(groups, cli) : null;
  if (!a || a.id === "default") return "";
  const name = a.label || maskEmail(a.email) || a.id;
  return `as ${name}`;
}

export { openNewSessionMenu } from "./newMenu";

/** "New folder…" (the TERMINALS background menu and a folder header's menu): the native folder dialog, opened at the
 *  last folder used, else home. Its own New Folder button makes a new one; manut makes none. The folder picked is
 *  listed as a group at once, with or without a session; one already listed only opens. Cancel changes nothing. */
export async function addTermFolder(): Promise<void> {
  const sx = getSessions();
  const before = sx.getState();
  const picked = await sx.pickFolder(draftFolder(before.recent, before.home));
  if (!picked || isTildePath(picked)) return;
  // the folder as the list names it: another spelling of a listed folder (`…/web-app/`) is that folder
  const got = pathKey(picked);
  const now = sx.getState();
  const listed = folderGroups(now.list.filter((r) => isTerminalRec(now.agents, r))).map((g) => g.cwd);
  const prefs = getFolderPrefs();
  // picked in the dialog just now, so it is on disk (again)
  setFolderGone(got, false);
  setFolderPrefs(addFolder(prefs, got, [...listed, ...addedFolders(prefs)]));
  // the group comes into view (a long list may hold it below the fold)
  requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>('[data-testid="term-group"]')].find((g) => g.dataset.cwd === got)?.scrollIntoView({ block: "nearest" }));
}

export function SessionsHeader() {
  const [open, setOpen] = useState(false);
  // how the menu was asked for: the + button asks for none, the Lanes band's New lane asks for the chat choice in its folder
  const [start, setStart] = useState<NewMenuStart | undefined>(undefined);
  const plus = useRef<HTMLButtonElement>(null);
  useEffect(
    () =>
      onOpenNewSessionMenu((s) => {
        setStart(s);
        setOpen(true);
      }),
    [],
  );
  return (
    <div className="side-sh side-sh-row">
      <span>{t("nav.terminals")}</span>
      <span className="ss-add">
        <CollapseAllButton />
        {/* "New session", not "New terminal": the menu it opens starts a chat with Kit too */}
        <button
          ref={plus}
          type="button"
          className="ss-plus"
          aria-label={t("sessions.new")}
          title={t("sessions.new")}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            setStart(undefined);
            setOpen((v) => !v);
          }}
          data-testid="session-new"
        >
          <PlusIcon size={14} />
        </button>
        {open && <NewSessionMenu onClose={() => setOpen(false)} trigger={plus} start={start} />}
      </span>
      <TermLinkGone />
    </div>
  );
}

/** The menu spans the section, 8px inside both sidebar edges. */
const MENU_W = "min(240px, calc(var(--side-w) - 16px))";

/** Space kept between the menu and what it must not cover. */
const MENU_GAP = 6;
/** Space kept between the menu's edge and a sidebar row it stops at. */
const ROW_CLEAR = 2;
/** Opened above its row, the menu keeps at least this much air under the row above it: a band of the sidebar's own
 *  colour (`.ss-pop.ui-pop-top::before`, the same height) covers what lies there. Sidebar rows stand 2px apart, so the
 *  air reaches into the next row's empty top padding, which the band hides; no row shows half. */
export const MENU_AIR = 6;

/** Where the + menu goes, how tall it may be in all (`max`) and, opened above its row, how tall the band of air over
 *  it is (`air`). It opens under its row when the whole list fits above the sidebar's bottom rows (Automations,
 *  Plugins, Settings, You), else on the side with more room. A list that fits whole above its row is never cut: the
 *  sidebar row its top edge would cross is hidden whole by the band instead. A list that does not fit scrolls
 *  inside, and its edge stops on a row boundary. Either way no row shows half. */
export function fitMenu(
  anchor: { top: number; bottom: number },
  natural: number,
  gap: number,
  limits: { top: number; bottom: number },
  rows: { top: number; bottom: number }[],
): { side: "top" | "bottom"; max: number; air: number } {
  const below = limits.bottom - (anchor.bottom + gap);
  const above = anchor.top - gap - limits.top;
  if (natural <= below || below >= above) {
    let end = Math.min(anchor.bottom + gap + natural, limits.bottom);
    // pull the edge back past every row it would cross (moving it can reach the row before)
    for (let cut; (cut = rows.find((r) => r.top < end + ROW_CLEAR && r.bottom > end && r.top >= anchor.bottom)); ) end = cut.top - ROW_CLEAR;
    return { side: "bottom", max: Math.max(0, end - anchor.bottom - gap), air: 0 };
  }
  const whole = anchor.top - gap - natural;
  if (whole >= limits.top) {
    // the band grows up to the top of each row it would cross (rows stand 2px apart: it ends 1px under the row
    // before); never over the sidebar's own top rows, where the list is cut as below
    let air = MENU_AIR;
    for (let cut; (cut = rows.find((r) => r.top < whole - air + 1 && r.bottom > whole - air - 1 && r.bottom <= anchor.top)); ) air = whole - cut.top + 1;
    if (whole - air >= limits.top - MENU_GAP) return { side: "top", max: natural, air };
  }
  let start = Math.max(whole, limits.top);
  // a row that begins above the band must end above it; one that begins in the band is hidden by it and the menu. The
  // edge lands within a px of `start` (offsets round), so a row within 1px of the band counts as in it, and the menu
  // then stops 1px further down; with rows 2px apart that never reaches the next row's top.
  for (let cut; (cut = rows.find((r) => r.top < start - MENU_AIR + 1 && r.bottom > start - MENU_AIR - 1 && r.bottom <= anchor.top)); ) start = cut.bottom + MENU_AIR + 1;
  return { side: "top", max: Math.max(0, anchor.top - gap - start), air: MENU_AIR };
}

/** Measure the open menu `box` (its list scrolls in `.ss-scroll`) against the sidebar, and again on resize and
 *  whenever `shape` changes (the folded agents opened or closed). */
function useMenuFit(box: RefObject<HTMLDivElement | null>, ready: boolean, shape = "") {
  const [fit, setFit] = useState<{ side: "top" | "bottom"; max: number } | null>(null);
  useLayoutEffect(() => {
    if (!ready) return;
    const pop = box.current?.closest<HTMLElement>(".ss-pop");
    const measure = () => {
      const menu = box.current;
      const list = menu?.querySelector<HTMLElement>(".ss-scroll");
      // the row the menu is placed against (its positioned container)
      const anchor = pop?.offsetParent;
      if (!menu || !pop || !list || !(anchor instanceof HTMLElement)) return;
      const side = anchor.closest(".side");
      const a = anchor.getBoundingClientRect();
      // on the Code page the menu has no sidebar around it: the page's own header (header.top) is what it must not slide under.
      // A Lanes band with its New lane link (item 68) lowers the + button, so an upward menu began to reach it
      const top = Math.max(side?.querySelector(".side-top")?.getBoundingClientRect().bottom ?? 0, document.querySelector("header.top")?.getBoundingClientRect().bottom ?? 0);
      const foot = side?.querySelector(".side-foot")?.getBoundingClientRect().top ?? innerHeight;
      // the menu's own header, padding and border around the list, and the list's full height
      const chrome = pop.offsetHeight - list.clientHeight;
      const natural = chrome + list.scrollHeight;
      // the gap between the row and the menu, the same on both sides (offsets ignore the pop-in transform)
      const gap = Math.max(0, pop.classList.contains("ui-pop-bottom") ? pop.offsetTop - anchor.offsetHeight : -pop.offsetTop - pop.offsetHeight);
      // rows as drawn: a group's rows, not the group (TERMINALS lists folder groups), and only what its list shows
      const rows = [...(side?.querySelectorAll(".bot-list:not(.ss-list) > *, .ss-list .tg > *, .side-sec > .side-sh, .side > :not(.side-sec)") ?? [])]
        .map((r) => {
          const b = r.getBoundingClientRect();
          const box = r.closest(".bot-list")?.getBoundingClientRect();
          return box && (b.bottom <= box.top || b.top >= box.bottom) ? null : b;
        })
        .filter((b): b is DOMRect => !!b);
      const f = fitMenu(a, natural, gap, { top: Math.max(top, 0) + MENU_GAP, bottom: Math.min(foot, innerHeight) - MENU_GAP }, rows);
      // the band above an upward menu (`.ss-pop.ui-pop-top::before`) is as tall as the air it keeps
      pop.style.setProperty("--ss-air", `${f.air}px`);
      // whole px down: a fraction up would set the menu's edge into the row it stops at
      setFit({ side: f.side, max: Math.max(0, Math.floor(f.max - chrome)) });
    };
    measure();
    addEventListener("resize", measure);
    return () => {
      removeEventListener("resize", measure);
      // the next thing shown in this box (an agent's past conversations) keeps the plain band
      pop?.style.removeProperty("--ss-air");
    };
    // measured again once placed on its side: the gap to the row differs above and below
  }, [box, ready, fit?.side, shape]);
  return fit;
}

/** Whether the list `el` has more below what it shows: its bottom edge then fades, saying it scrolls. */
function useMoreBelow(el: RefObject<HTMLDivElement | null>, on: boolean, shape: boolean) {
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const list = el.current;
    if (!on || !list) return;
    const read = () => setMore(list.scrollTop + list.clientHeight < list.scrollHeight - 1);
    read();
    list.addEventListener("scroll", read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(list);
    return () => {
      list.removeEventListener("scroll", read);
      ro.disconnect();
    };
  }, [el, on, shape]);
  return more;
}

/** The SESSIONS + menu, under the folder chip: first Chat with Kit ([`ChatWay`]), each installed agent that runs as the
 *  app's chat, whose pick opens its New session chat in the chip's folder (a lane once its first message goes); then In a
 *  terminal, as before item 66: the Shell, the installed agents with their mark and name (by tier; the last one used has
 *  the focus, so ⌘N then Enter still starts a terminal), then one "More agents" row that opens the agents that are not
 *  installed, dimmed, each with its install line as text (picking one copies that line; manut installs nothing). Picking
 *  one of those starts it in its own terminal at once. Arrow keys move through both parts, Enter picks, Esc closes. */
function NewSessionMenu({ onClose, trigger, start }: { onClose: () => void; trigger: RefObject<HTMLButtonElement | null>; start?: NewMenuStart }) {
  const ss = useSessions();
  const accounts = useAccounts();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ss.agents === null) void getSessions().loadAgents();
  }, [ss.agents]);
  const parts = ss.agents ? terminalAgents(offeredAgents(ss.agents), ss.recent) : null;
  const agents = parts ? [...parts.shown, ...parts.more] : null;
  // Chat with Kit: the installed agents that run as the app's chat
  const chats = ss.agents ? chatAgents(offeredAgents(ss.agents), ss.recent) : [];
  // the agents that are not installed stay folded until the person opens them
  const [unfold, setUnfold] = useState(false);
  const [copied, setCopied] = useState<AgentId | null>(null);
  // the first row takes the focus once the list is there (installed first, so it is the one Enter should pick)
  const ready = agents !== null;
  // the second step: one agent's past conversations (its own list: this menu is not measured while it shows)
  const [past, setPast] = useState<PastAgent | null>(null);
  // the folder it starts in: the chip at the top (the last folder used, else home)
  const [folder, setFolder] = useState<string | null>(start?.folder ?? null);
  const [folders, setFolders] = useState(false);
  // measured again whenever its rows change (the folded agents, the folder list)
  const fit = useMenuFit(box, ready && !past, `${unfold ? "open" : "folded"}:${folders ? "folders" : ""}`);
  // once placed (a hidden menu cannot take focus)
  const placed = fit !== null;
  const list = useRef<HTMLDivElement>(null);
  const more = useMoreBelow(list, placed, unfold);
  const first = parts ? menuFocus(parts.shown, ss.recent) : null;
  useEffect(() => {
    if (!placed) return;
    // New lane in the Lanes band asks for the chat choice, so the first Chat with Kit row takes the focus; the + button, ⌘N
    // and ⌘T keep the terminal row (decisions, 25 Nov 2026)
    const chat = start?.chat ? box.current?.querySelector<HTMLButtonElement>('[data-testid^="session-chat-"][role="menuitem"]') : null;
    if (chat) {
      chat.focus({ preventScroll: true });
      return;
    }
    const row = first ? box.current?.querySelector<HTMLButtonElement>(`[data-testid="session-agent-${first}"]`) : null;
    (row ?? box.current?.querySelector<HTMLButtonElement>("[role=menuitem]"))?.focus({ preventScroll: true });
    // focus once, when the menu is placed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed]);
  const close = (why: "escape" | "outside" | "pick") => {
    onClose();
    if (why === "escape") trigger.current?.focus();
  };
  const at = folder ?? draftFolder(ss.recent, ss.home);
  const pick = (id: AgentId) => {
    close("pick");
    getSessions().startTerminal(id, at || undefined);
  };
  /** Chat with Kit ▸ an agent: its New session chat in the chip's folder, where the person says what Kit should do. */
  const pickChat = (id: AgentId) => {
    close("pick");
    getSessions().draftChat(id, at || undefined);
  };
  /** Shell ▸: a Shell row that runs shell `shell` (an id from the shell's own list). */
  const pickShell = (shell: string) => {
    close("pick");
    getSessions().startTerminal(SHELL, at || undefined, shell);
  };
  // Shell ▸: the shells this computer offers, when there is more than one (the plain Shell row keeps the default)
  const shells = useShells();
  const [shellsOpen, setShellsOpen] = useState(false);
  const shellMore = useRef<HTMLButtonElement>(null);
  const shellList = useRef<HTMLDivElement>(null);
  const defaultShell = useSyncExternalStore(onTermSettings, readTermSettings, readTermSettings).defaultShell;
  useEffect(() => {
    if (shellsOpen) shellList.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus({ preventScroll: true });
  }, [shellsOpen]);
  const closeShells = () => {
    setShellsOpen(false);
    shellMore.current?.focus({ preventScroll: true });
  };
  const choose = async () => {
    const got = await getSessions().pickFolder(at || ss.home || "");
    if (got) setFolder(got);
    setFolders(false);
  };
  const { recent: recentFolders, home } = folderChoices(ss.recent, ss.home);
  // an agent that is not installed: its install line goes to the clipboard, as text (manut runs nothing)
  const copyInstall = (id: AgentId) => {
    void navigator.clipboard?.writeText(installLine(id)).then(
      () => setCopied(id),
      () => undefined,
    );
  };
  const row = (a: NonNullable<typeof agents>[number]) => {
    const label = agentLabel(a.id, ss.agents);
    const account = sessionAccountSuffix(accounts.groups, a.id);
    const missing = !a.path;
    // installed, and the app has read that it is not signed in: said before the first message, and still pickable
    const signedOut = !missing && agentSignedOut(accounts, a.id);
    return (
      <button
        key={a.id}
        type="button"
        role="menuitem"
        className={`ss-item${missing ? " off" : ""}`}
        aria-disabled={missing || undefined}
        title={signedOut ? signedOutTip(a.id, label) : (a.path ?? missingNote(a.id))}
        onClick={() => (missing ? copyInstall(a.id) : pick(a.id))}
        data-testid={`session-agent-${a.id}`}
      >
        <span className="ss-ic">
          <AgentMark agent={a.id} />
        </span>
        <span className="ss-n ss-n-as" title={account ? `${label} ${account}` : label}>
          {missing ? (
            // the state word shares the name's line, so the install line under them has the whole width
            <span className="ss-head">
              <span className="ss-l">{label}</span>
              <span className="ss-missing">{copied === a.id ? t("ss.copiedInstall") : t("sessions.notInstalled")}</span>
            </span>
          ) : signedOut ? (
            <span className="ss-head">
              <span className="ss-l">{label}</span>
              <span className="ss-missing" data-testid={`session-signedout-${a.id}`}>
                {signedOutWord()}
              </span>
            </span>
          ) : (
            <span className="ss-l">{label}</span>
          )}
          {account && !missing && (
            <span className="ss-as" data-testid={`session-account-${a.id}`}>
              {account}
            </span>
          )}
          {missing && (
            // whole, on as many lines as it needs; it breaks between its words before it breaks inside one
            <span className="ss-as ss-install" data-testid={`session-install-${a.id}`}>
              {installLine(a.id).split(" ").map((word, i) => (
                <Fragment key={i}>
                  {i > 0 && " "}
                  <span className="ss-tok">{word}</span>
                </Fragment>
              ))}
            </span>
          )}
        </span>
      </button>
    );
  };
  if (past)
    return (
      <Popover open onClose={close} align="left" side={fit?.side ?? "bottom"} width={MENU_W} label={t("ss.past.title", { agent: agentLabel(past, ss.agents) })} className="ss-pop">
        <PastList agent={past} onBack={() => setPast(null)} onPick={() => close("pick")} />
      </Popover>
    );
  return (
    <Popover open onClose={close} align="left" side={fit?.side ?? "bottom"} width={MENU_W} label={t("sessions.new")} className={`ss-pop${ready && !fit ? " ss-pop-measuring" : ""}`}>
      <div
        ref={box}
        role="menu"
        aria-label={t("sessions.new")}
        data-testid="session-menu"
        onKeyDown={(e) => {
          // inside Shell ▸: Esc and ← close the list only, back on its chevron
          if (shellsOpen && shellList.current?.contains(document.activeElement) && (e.key === "Escape" || e.key === "ArrowLeft")) {
            e.preventDefault();
            e.stopPropagation();
            closeShells();
            return;
          }
          if (e.key === "ArrowRight" && (document.activeElement === shellMore.current || (document.activeElement as HTMLElement | null)?.dataset.testid === "session-agent-shell") && shellMore.current) {
            e.preventDefault();
            setShellsOpen(true);
            return;
          }
          const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
          const i = items.indexOf(document.activeElement as HTMLButtonElement);
          const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
          if (to === null || !items.length) return;
          e.preventDefault();
          const next = items[(to + items.length) % items.length];
          next?.focus({ preventScroll: true });
          next?.scrollIntoView({ block: "nearest" });
        }}
      >
        <div className="ss-h">{t("sessions.new")}</div>
        {agents === null && <div className="ss-empty">{t("ss.lookingAgents")}</div>}
        <button
          type="button"
          role="menuitem"
          className="ss-item ss-at"
          aria-expanded={folders}
          title={at}
          onClick={() => setFolders((v) => !v)}
          data-testid="session-folder"
        >
          <span className="ss-ic" aria-hidden="true">
            <FolderGlyph />
          </span>
          <span className="ss-n">{at ? folderName(at) : t("sessions.findingHome")}</span>
          <span className="ss-path">{at ? parentPath(tildePath(at, ss.home)) : ""}</span>
        </button>
        {folders && (
          <div className="ss-folders" data-testid="session-folders">
            {[...recentFolders, ...(home ? [home] : [])].map((cwd) => (
              <button
                key={cwd}
                type="button"
                role="menuitem"
                className={`ss-item${cwd === at ? " on" : ""}`}
                title={cwd}
                onClick={() => {
                  setFolder(cwd);
                  setFolders(false);
                }}
                data-testid="session-folder-pick"
              >
                <span className="ss-ic" />
                <span className="ss-n">{folderName(cwd)}</span>
                <span className="ss-path">{parentPath(tildePath(cwd, ss.home))}</span>
              </button>
            ))}
            <button type="button" role="menuitem" className="ss-item" onClick={() => void choose()} data-testid="session-choose">
              <span className="ss-ic" />
              <span className="ss-n">{t("sessions.choose")}</span>
            </button>
          </div>
        )}
        <div className="ss-sep" />
        <div ref={list} className={`ss-scroll${more ? " more" : ""}`} style={fit ? { maxHeight: fit.max } : undefined} data-testid="session-menu-list">
        {ready && (
          <ChatWay
            agents={chats.map((a) => ({ id: a.id, label: agentLabel(a.id, ss.agents), account: sessionAccountSuffix(accounts.groups, a.id), signedOut: agentSignedOut(accounts, a.id) }))}
            onPick={pickChat}
          />
        )}
        {ready && (
          <div className="ss-h ss-way-h" data-testid="session-term-head">
            {t("ss.way.terminal")}
          </div>
        )}
        {ready && (
          <div className="ss-shell-row" key="shell">
            <button type="button" role="menuitem" className="ss-item" title={t("term.shellTip")} onClick={() => pick(SHELL)} data-testid="session-agent-shell">
              <span className="ss-ic">
                <TermRowMark agent={null} size={16} />
              </span>
              <span className="ss-n ss-n-as">
                <span className="ss-l">{t("term.shell")}</span>
              </span>
            </button>
            {shells && shells.length > 1 && (
              <button
                ref={shellMore}
                type="button"
                role="menuitem"
                className={`ss-item ss-shell-more${shellsOpen ? " on" : ""}`}
                aria-haspopup="menu"
                aria-expanded={shellsOpen}
                aria-label={t("term.shellPick")}
                title={t("term.shellPick")}
                onClick={() => setShellsOpen((v) => !v)}
                data-testid="session-shell-more"
              >
                <ChevronRight size={10} />
              </button>
            )}
          </div>
        )}
        {ready && shellsOpen && shells && shells.length > 1 && (
          <div ref={shellList} className="ss-shells" role="group" aria-label={t("term.shellPick")} data-testid="session-shells">
            {shells.map((s) => {
              const isDefault = defaultShell ? s.id === defaultShell : s.default;
              return (
                <button key={s.id} type="button" role="menuitem" className="ss-item" title={s.path} onClick={() => pickShell(s.id)} data-testid="session-shell-pick" data-shell={s.id}>
                  <span className="ss-ic" />
                  <span className="ss-n">{s.label}</span>
                  {isDefault && <span className="ss-missing">{t("term.shellDefault")}</span>}
                </button>
              );
            })}
          </div>
        )}
        {(parts?.shown ?? []).map(row)}
        {parts && parts.more.length > 0 && (
          <button
            type="button"
            role="menuitem"
            className="ss-item ss-more"
            aria-expanded={unfold}
            onClick={() => setUnfold((v) => !v)}
            data-testid="session-more"
          >
            <span className="ss-ic ss-more-ic" aria-hidden="true">
              {unfold ? "⌄" : "›"}
            </span>
            <span className="ss-n">{t("ss.moreAgents")}</span>
            <span className="ss-missing">{parts.more.length}</span>
          </button>
        )}
        {unfold && parts?.more.map(row)}
        </div>
        {more && (
          <button
            type="button"
            className="ss-more-cue"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => list.current?.scrollBy({ top: list.current.clientHeight - 32, behavior: "smooth" })}
            data-testid="session-menu-more-below"
          >
            <ChevronDown size={10} />
            {t("term.moreBelow")}
          </button>
        )}
      </div>
    </Popover>
  );
}

/** One coding agent the + menu offers as a chat with Kit: its id, its name here, and the quiet "as …" of the account a
 *  new session of it runs as ("" for the CLI's own). */
export interface ChatWayAgent {
  id: AgentId;
  label: string;
  account: string;
  /** The app has read that the agent is installed but not signed in (signedOut.ts): a quiet word and a tooltip, the row still pickable. */
  signedOut?: boolean;
}

/** The + menu's first part, Chat with Kit (owner, 25 Nov 2026, item 66): a heading, then one row per agent, as the terminal
 *  part draws its own (the mark, the name, the account). Picking one opens its New session chat, which becomes a lane, with
 *  Kit's dial, the pane beside it, Rewind and Bring it back, as the design canvas's Code board draws it. With none installed
 *  it says so in one quiet line, and the terminal part's More agents row has their install lines. Props only and no hooks,
 *  so a test can draw it and press its rows. */
export function ChatWay({ agents, onPick }: { agents: ChatWayAgent[]; onPick: (id: AgentId) => void }) {
  return (
    <>
      <div className="ss-h ss-way-h" data-testid="session-chat-head">
        {t("ss.way.chat")}
      </div>
      {agents.length === 0 && (
        <div className="ss-empty" data-testid="session-chat-none">
          {t("ss.way.chatNone")}
        </div>
      )}
      {agents.map((a) => (
        <button key={a.id} type="button" role="menuitem" className="ss-item" title={a.signedOut ? `${t("ss.way.chatTip", { agent: a.label })} ${signedOutTip(a.id, a.label)}` : t("ss.way.chatTip", { agent: a.label })} onClick={() => onPick(a.id)} data-testid={`session-chat-${a.id}`}>
          <span className="ss-ic">
            <AgentMark agent={a.id} />
          </span>
          <span className="ss-n ss-n-as">
            {a.signedOut ? (
              <span className="ss-head">
                <span className="ss-l">{a.label}</span>
                <span className="ss-missing" data-testid={`session-chat-signedout-${a.id}`}>
                  {signedOutWord()}
                </span>
              </span>
            ) : (
              <span className="ss-l">{a.label}</span>
            )}
            {a.account && (
              <span className="ss-as" data-testid={`session-chat-account-${a.id}`}>
                {a.account}
              </span>
            )}
          </span>
        </button>
      ))}
    </>
  );
}

/** The agents whose conversations can be continued here: they keep them in files manut can read. */
const PAST_AGENTS = ["claude", "codex"] as const;
type PastAgent = (typeof PAST_AGENTS)[number];

/** How long ago `at` (seconds since the epoch) was: \"now\", \"5m\", \"3h\", \"2d\". */
export function ageOf(at: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.floor(nowMs / 1000 - at));
  if (s < 60) return t("time.nowShort");
  if (s < 3600) return t("unit.m", { n: Math.floor(s / 60) });
  if (s < 86_400) return t("unit.h", { n: Math.floor(s / 3600) });
  return t("unit.d", { n: Math.floor(s / 86_400) });
}

/** The + menu's second step: `agent`'s recent conversations for the folders the menu offers (the recent ones and
 *  home), newest first. Each row is its title or first words over its folder and age; picking one continues it as
 *  a session. ← (or Esc on the first row's left) goes back to the agents. */
function PastList({ agent, onBack, onPick }: { agent: PastAgent; onBack: () => void; onPick: () => void }) {
  const ss = useSessions();
  const box = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<PastChat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { recent, home } = folderChoices(ss.recent, ss.home);
  const cwds = [...recent, ...(home ? [home] : [])];
  const key = cwds.join("\n");
  useEffect(() => {
    let live = true;
    getHost()
      .pastChats(agent, cwds)
      .then((r) => live && setRows(r))
      .catch((e: unknown) => live && (setRows([]), setError(e instanceof Error ? e.message : String(e))));
    return () => {
      live = false;
    };
    // the folders, not the array's identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, key]);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>(rows?.length ? ".ss-past [role=menuitem]" : "[role=menuitem]")?.focus({ preventScroll: true });
  }, [rows]);
  const label = agentLabel(agent, ss.agents);
  return (
    <div
      ref={box}
      role="menu"
      aria-label={t("ss.past.title", { agent: label })}
      data-testid="session-past-menu"
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onBack();
          return;
        }
        const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
        if (to === null || !items.length) return;
        e.preventDefault();
        const next = items[(to + items.length) % items.length];
        next?.focus({ preventScroll: true });
        next?.scrollIntoView({ block: "nearest" });
      }}
    >
      <button type="button" role="menuitem" className="ss-item ss-past-back" onClick={onBack} data-testid="session-past-back" aria-label={t("ss.past.back")}>
        <span className="ss-ic" aria-hidden="true">
          ‹
        </span>
        <span className="ss-ic">
          <AgentMark agent={agent} />
        </span>
        <span className="ss-n">{label}</span>
      </button>
      <div className="ss-h">{t("ss.past.head")}</div>
      {rows === null && <div className="ss-empty">{t("ss.past.looking")}</div>}
      {rows !== null && rows.length === 0 && (
        <div className="ss-empty" data-testid="session-past-none" title={error ?? undefined}>
          {t("ss.past.none", { agent: label })}
        </div>
      )}
      {rows !== null && rows.length > 0 && (
        <div className="ss-scroll ss-past" data-testid="session-past-list">
          {rows.map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              className="ss-item ss-past-row"
              title={`${c.title}\n${c.cwd}`}
              onClick={() => {
                onPick();
                void getSessions().continuePast(c);
              }}
              data-testid={`session-past-row-${c.id}`}
            >
              <span className="ss-n ss-n-as">
                <span className="ss-l">{c.title}</span>
                <span className="ss-as">
                  {tildePath(c.cwd, ss.home)} · {ageOf(c.at)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The empty section: one "New session" row built like the sidebar's nav rows, opening the same + menu under it, whose
 *  Chat with Kit and In a terminal both start from here. What it does and the installed coding agents sit in its tooltip;
 *  nothing else shows, nothing is centred or boxed. */
function SessionStart() {
  const ss = useSessions();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (ss.agents === null) void getSessions().loadAgents();
  }, [ss.agents]);
  const names = menuOrder(offeredAgents(ss.agents ?? []), [])
    .filter((a) => a.path)
    .map((a) => agentDef(a.id).label)
    .join(", ");
  const tip = names ? `${t("term.empty")} ${names}` : t("term.empty");
  return (
    <div className="ss-none" data-testid="session-none">
      <div className="ss-start-w">
        <button
          ref={btn}
          type="button"
          className="ss-start"
          title={tip}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          data-testid="session-start"
        >
          <PlusIcon size={16} />
          {t("sessions.new")}
        </button>
        {open && <NewSessionMenu onClose={() => setOpen(false)} trigger={btn} />}
      </div>
    </div>
  );
}

/** Whether session `rec` matches the sidebar search `needle` (lower case): by its name, as its row shows it, or its
 *  folder. */
export function sessionMatches(rec: SessionRec, needle: string): boolean {
  if (!needle) return true;
  const name = rec.status === "draft" ? t("ss.newTitle") : pickTitle(rec, folderName(rec.cwd)).title;
  return [name, rec.cwd].some((v) => v.toLowerCase().includes(needle));
}

export function SessionList({ needle = "", query = "" }: { needle?: string; query?: string }) {
  const s = useStore();
  const ss = useSessions();
  const sp = useSplit();
  useSplitPrune();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [refocus, setRefocus] = useState<string | null>(null);
  const current = s.ui.view === "session" ? s.ui.session : null;
  // the split the open session is in: its rows carry the split's shape
  const openSplit = current ? groupOf(sp.groups, current) : null;
  // every row in a split shows its shape: the open split's rows plainly, a split not in view dimmed
  const splitOf = (id: string) => {
    const g = paneOf(id) === null ? null : groupOf(sp.groups, id);
    return g ? g.layout : null;
  };
  useEffect(() => {
    if (!refocus) return;
    // the row itself (its × shows only on hover, so it cannot hold focus)
    document.querySelector<HTMLElement>(`[data-testid="session-${refocus}"] .ss-open`)?.focus();
    setRefocus(null);
  }, [refocus]);
  const folders = useFolderPrefs();
  // (the open terminal's folder opens wherever the person is, not here: sessions/revealOpen.ts)
  // the open terminal's row scrolls into view inside TERMINALS (never moving BOTS) and stays in view when the region
  // changes size (the dock gains a row, the window shrinks) or rows land above it (a newer folder lists first): only
  // then, never against the person's own scrolling
  const nav = useRef<HTMLElement>(null);
  const navRef = useEdgeFade(nav);
  const rowsKey = ss.list.map((r) => r.id).join(",");
  useEffect(() => {
    if (!current) return;
    const rowOf = () => nav.current?.querySelector<HTMLElement>(`[data-testid="session-${CSS.escape(current)}"]`) ?? null;
    // the band above the region's end is kept for the "more below" chevron (a row reaching into it is hidden)
    const inView = () => {
      const list = nav.current;
      const row = rowOf();
      if (!list || !row) return false;
      const l = list.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      return r.top >= l.top && r.bottom <= l.bottom - CUE_PX;
    };
    // held in view until the person scrolls TERMINALS themselves (wheel, touch, keys, the scrollbar): scrolling BOTS
    // brings the dock in and shrinks this region, which must not undo their own scroll. A scroll the browser makes
    // (the region shrank) does not let go of the row.
    let held = true;
    const keep = () => {
      const row = rowOf();
      if (!held || !row || inView()) return;
      row.scrollIntoView({ block: "nearest" });
    };
    const own = () => {
      held = false;
    };
    const id = requestAnimationFrame(keep);
    const el = nav.current;
    const input = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
    for (const k of input) el?.addEventListener(k, own, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(keep) : null;
    if (el) ro?.observe(el);
    return () => {
      cancelAnimationFrame(id);
      for (const k of input) el?.removeEventListener(k, own);
      ro?.disconnect();
    };
  }, [current, folders.collapsed, rowsKey]);
  const cancel = (id: string) => {
    setConfirm(null);
    setRefocus(id);
  };
  // one function for every row (a memoised row keeps its props)
  const ask = useCallback((rec: SessionRec) => {
    // a close that can be undone (Settings › Terminal › Undo window after closing) does not ask first
    if ((rec.status === "running" || rec.status === "starting") && !getSessions().closeUndoable(rec.id)) setConfirm(rec.id);
    else getSessions().close(rec.id);
  }, []);
  countRender("SessionList");
  const terms = ss.list.filter((r) => isTerminalRec(ss.agents, r));
  // each row's spinner and age, and a collapsed folder's spinner, follow the terminal's output on their own
  // (termActivity.ts): output never re-renders this list
  // the ages tick while any terminal runs (as one list-wide clock did before)
  const ticking = terms.some((r) => r.status === "running" || r.status === "starting");
  const added = addedFolders(folders);
  if (terms.length === 0 && added.length === 0) return <SessionStart />;
  const shown = terms.filter((r) => sessionMatches(r, needle));
  // an added folder with no session is a group too; a search keeps it only when its path matches
  const groups = orderFolders(withAdded(folderGroups(shown), needle ? added.filter((c) => c.toLowerCase().includes(needle)) : added), folders.order);
  return (
    <nav ref={navRef} className="bot-list ss-list" aria-label={t("nav.terminals")} data-testid="session-list">
      {needle && groups.length === 0 && (
        <div className="bot-empty" data-testid="session-none-match">
          {t("side.noSession", { q: query })}
        </div>
      )}
      {groups.map((g, gi, all) => {
        // a search shows every match, collapsed or not
        const shut = !needle && isCollapsed(folders, g.cwd);
        return (
        <div key={g.cwd} className={`tg${shut ? " shut" : ""}`} role="group" aria-label={folderName(g.cwd)} data-testid="term-group" data-cwd={g.cwd} data-collapsed={shut ? "true" : undefined}>
          <FolderHead
            cwd={g.cwd}
            home={ss.home}
            shut={shut}
            index={gi}
            all={all.map((x) => x.cwd)}
            added={added.includes(g.cwd)}
            summary={{ ...folderSummary(g.rows.map((r) => termStatus(r, ss.unseen[r.id], 0))), running: g.rows.filter((r) => (r.status === "running" || r.status === "starting") && termMarkAgent(r) !== null).length }}
            flowIds={shut ? g.rows.filter((r) => (r.status === "running" || r.status === "starting") && ss.unseen[r.id] !== "bell").map((r) => r.id) : NO_IDS}
          />
          {!shut && g.rows.map((rec) =>
            confirm === rec.id ? (
              <div
                key={rec.id}
                className="ss-row ss-confirm"
                role="group"
                aria-label={t("ss.stopIn", { agent: agentDef(rec.agent).label, folder: folderName(rec.cwd) })}
                data-testid={`session-confirm-${rec.id}`}
                onKeyDown={(e) => {
                  if (e.key !== "Escape") return;
                  e.preventDefault();
                  e.stopPropagation();
                  cancel(rec.id);
                }}
              >
                <span className="ss-q" title={rec.cwd}>
                  {t("ss.stopQ", { agent: agentDef(rec.agent).label })}
                </span>
                <button type="button" className="ss-btn" onClick={() => cancel(rec.id)} autoFocus>
                  {t("ss.cancel")}
                </button>
                <button
                  type="button"
                  className="ss-btn"
                  onClick={() => {
                    setConfirm(null);
                    getSessions().close(rec.id);
                  }}
                  data-testid="session-stop"
                >
                  {t("ss.stop")}
                </button>
              </div>
            ) : (
              <TermRow key={rec.id} rec={rec} agents={ss.agents} unseen={ss.unseen[rec.id]} active={current === rec.id} ticking={ticking} lang={s.ui.lang} onClose={ask} split={splitOf(rec.id)} away={!openSplit || !groupSessions(openSplit).includes(rec.id)} />
            ),
          )}
        </div>
        );
      })}
    </nav>
  );
}

/** A small folder outline, the TERMINALS group header's icon. */
function FolderGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

/** "Collapse all" / "Expand all" for the TERMINALS folders, in the section header next to its +. */
function CollapseAllButton() {
  const ss = useSessions();
  const prefs = useFolderPrefs();
  const all = [...new Set([...folderGroups(ss.list.filter((r) => isTerminalRec(ss.agents, r))).map((g) => g.cwd), ...addedFolders(prefs)])];
  if (all.length < 2) return null;
  const shut = allCollapsed(prefs, all);
  const label = shut ? t("term.expandAll") : t("term.collapseAll");
  return (
    <button type="button" className="ss-plus ss-fold-all" aria-label={label} title={label} onClick={() => setFolderPrefs(setAllFolders(getFolderPrefs(), all, !shut))} data-testid="term-collapse-all" data-all={shut ? "collapsed" : "expanded"}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {shut ? <path d="m7 9 5-5 5 5M7 15l5 5 5-5" /> : <path d="m7 4 5 5 5-5M7 20l5-5 5 5" />}
      </svg>
    </button>
  );
}

/** Drag folder headers to reorder them: the header under the pointer is where it goes (saved on this computer). */
function useFolderDrag(cwd: string, all: readonly string[]) {
  return (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest("button:not(.tg-open)")) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const head = e.currentTarget;
    let moving = false;
    const heads = () => [...(head.closest(".ss-list")?.querySelectorAll<HTMLElement>(".tg-h") ?? [])];
    const slot = (y: number) => {
      const hs = heads();
      const i = hs.findIndex((h) => {
        const g = h.closest(".tg")!.getBoundingClientRect();
        return y >= g.top && y <= g.bottom;
      });
      return i;
    };
    const move = (ev: PointerEvent) => {
      if (!moving && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      moving = true;
      head.classList.add("lifted");
      const to = slot(ev.clientY);
      for (const [i, h] of heads().entries()) h.classList.toggle("drop", i === to && h !== head);
    };
    const up = (ev: PointerEvent) => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      head.classList.remove("lifted");
      for (const h of heads()) h.classList.remove("drop");
      if (!moving) return;
      const to = slot(ev.clientY);
      if (to >= 0 && all[to] !== cwd) setFolderPrefs({ ...getFolderPrefs(), order: moveFolder(all, cwd, to) });
      // the click that follows a drag toggles nothing
      const stop = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      addEventListener("click", stop, { capture: true, once: true });
      setTimeout(() => removeEventListener("click", stop, { capture: true }), 0);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
}

const NO_IDS: readonly string[] = [];

/** A TERMINALS group's header, Orca-style: a chevron that collapses its sessions (kept on this computer), the
 *  folder's name (semibold) and its git branch in small grey; collapsed, it shows how many sessions it holds and
 *  their live summary (the spinner while one prints, the amber dot while one waits for you, a red dot when one
 *  failed). Right-click: New terminal here, Collapse others, Show in Finder, New folder…, and for a folder the person
 *  added (`added`) Remove from list. Drag to reorder. */
function FolderHead({ cwd, home, shut, index, all, added, summary: base, flowIds }: { cwd: string; home: string | null; shut: boolean; index: number; all: string[]; added: boolean; summary: ReturnType<typeof folderSummary> & { running: number }; flowIds: readonly string[] }) {
  // the spinner: output flows in one of its running sessions that is not waiting for the person (termStatus's
  // "busy"), followed here and not through the list
  const busy = useAnyFlowing(flowIds);
  const summary = { ...base, busy };
  const [branch, setBranch] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const drag = useFolderDrag(cwd, all);
  useEffect(() => {
    let live = true;
    if (cwd)
      void getHost()
        .branch(cwd)
        .then((b) => live && setBranch(b))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [cwd]);
  const name = folderName(cwd);
  // a shell asked to start here ran in another folder: this one is no longer on disk (Remove from list still works)
  const gone = useGoneFolders().includes(cwd);
  const toggle = () => setFolderPrefs(toggleFolder(getFolderPrefs(), cwd));
  return (
    <div
      className={`tg-h${index === 0 ? " first" : ""}`}
      title={tildePath(cwd, home)}
      data-testid="term-group-head"
      onPointerDown={drag}
      onContextMenu={(e) => {
        e.preventDefault();
        const side = e.currentTarget.closest(".side")?.getBoundingClientRect();
        const right = (side?.right ?? innerWidth) - 6;
        setMenu({ x: Math.max(6, Math.min(e.clientX, right - MENU_W_PX)), y: Math.max(6, Math.min(e.clientY, innerHeight - menuHeight(added ? 5 : 4) - 6)) });
      }}
    >
      <button type="button" className="tg-open" aria-expanded={!shut} aria-label={t(shut ? "term.folderOpen" : "term.folderClose", { name })} onClick={toggle} data-testid="term-group-toggle">
        <span className="tg-chev" aria-hidden="true">{shut ? <ChevronRight size={9} /> : <ChevronDown size={9} />}</span>
        <span className="tg-ic">
          <FolderGlyph />
        </span>
        <span className="tg-n">{name}</span>
        {shut && (
          <span className="tg-sum" data-testid="term-group-summary" data-busy={summary.busy ? "true" : undefined} data-needs={summary.needs ? "true" : undefined} data-failed={summary.failed ? "true" : undefined}>
            {summary.busy && <TermStatusGlyph status="busy" />}
            {summary.running > 0 && (
              <>
                <span className="tg-run" data-testid="term-group-running">
                  {t("term.folderRunning", { n: summary.running })}
                </span>
                <span aria-hidden="true">·</span>
              </>
            )}
            {/* the count says what it counts: "2 sessions", never a bare number */}
            <span className="tg-count" data-testid="term-group-count" data-n={summary.count}>
              {summary.count === 1 ? t("term.folderCount1") : t("term.folderCountN", { n: summary.count })}
            </span>
            {summary.needs && <span className="tg-dot needs" title={t("ss.mark.bell")} />}
            {summary.failed && <span className="tg-dot err" title={t("ss.mark.error")} />}
          </span>
        )}
        {branch && (
          <span className="tg-b" data-testid="term-group-branch">
            {branch}
          </span>
        )}
      </button>
      {/* an added folder no session runs in: one quiet line, inside the header so a right-click on it is the folder's.
          A folder found gone says that instead, with or without sessions listed under it. */}
      {!shut && gone ? (
        <div className="tg-empty gone" title={t("term.folderGone")} data-testid="term-group-gone">
          {t("term.folderGone")}
        </div>
      ) : (
        !shut &&
        summary.count === 0 && (
          <div className="tg-empty" title={t("term.folderEmpty")} data-testid="term-group-empty">
            {t("term.folderEmpty")}
          </div>
        )
      )}
      {menu && <FolderMenu at={menu} cwd={cwd} all={all} added={added} onDismiss={() => setMenu(null)} />}
    </div>
  );
}

/** A folder header's right-click menu: New terminal here (the + menu's Shell in that folder), Collapse others,
 *  Show in Finder, New folder… (as the background menu's) and, only for a folder the person added, Remove from list
 *  (the list forgets it; nothing on disk changes and its sessions go on). */
function FolderMenu({ at, cwd, all, added, onDismiss }: { at: { x: number; y: number }; cwd: string; all: string[]; added: boolean; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onDismiss]);
  const items: [string, string, () => void][] = [
    ["term-folder-new", t("term.here"), () => void getSessions().startTerminal(SHELL, cwd)],
    ["term-folder-others", t("term.collapseOthers"), () => setFolderPrefs(collapseOthers(getFolderPrefs(), all, cwd))],
    ["term-folder-reveal", revealWord(), () => void getHost().reveal(cwd).catch(() => undefined)],
    ["term-folder-add", t("term.newFolder"), () => void addTermFolder()],
    ...(added ? ([["term-folder-remove", t("term.folderRemove"), () => (setFolderGone(cwd, false), setFolderPrefs(removeFolder(getFolderPrefs(), cwd)))]] as [string, string, () => void][]) : []),
  ];
  return (
    <div
      ref={ref}
      className="row-menu"
      style={{ left: at.x, top: at.y }}
      role="menu"
      aria-label={folderName(cwd)}
      data-testid="term-folder-menu"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onDismiss();
          return;
        }
        const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 + btns.length : null;
        if (to === null) return;
        e.preventDefault();
        btns[to % btns.length]?.focus();
      }}
    >
      {items.map(([id, label, run]) => (
        <button
          key={id}
          type="button"
          role="menuitem"
          className="row-mi"
          data-testid={id}
          onClick={() => {
            onDismiss();
            run();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** The row's status glyph, 12px: an amber arc spinning while output flows (static under reduced motion), the bell's
 *  warning triangle, a green outlined check on exit 0, a red x on a non-zero exit; nothing when idle. */
export function TermStatusGlyph({ status }: { status: TermStatus }) {
  const label = status === "busy" ? t("term.st.busy") : status === "bell" ? t("ss.mark.bell") : status === "ok" ? t("ss.at.done") : status === "err" ? t("ss.mark.error") : "";
  return (
    <span className={`tst${status ? ` ${status}` : ""}`} data-testid="term-status" data-status={status ?? "idle"} role={status ? "img" : undefined} aria-label={label || undefined} title={label || undefined}>
      {status === "busy" && (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 1.6A4.4 4.4 0 1 1 1.6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )}
      {status === "ok" && (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M3.7 6.2 5.3 7.8 8.4 4.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {status === "err" && (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3.4 3.4 8.6 8.6M8.6 3.4 3.4 8.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
      {status === "bell" && <StateSign mark="needs" />}
    </span>
  );
}

/** `now`, `12m`, `3h`, `2d` since `ms`. */
const ageMs = (ms: number, now: number) => ageOf(ms / 1000, now);

/** What a session row's menu offers, in order: Rename, Reveal the folder, Open the folder in the system terminal,
 *  Copy the conversation id (only when the agent reported one), New session here, Close session. */
export function rowMenuItems(rec: Pick<SessionRec, "cwd" | "agentSession">): RowAction[] {
  return ["rename", ...(rec.cwd ? (["reveal", "terminal"] as const) : []), ...(rec.agentSession ? (["copy"] as const) : []), "here", "close"];
}
/** A TERMINALS row's menu: Rename, Reveal, Open in the system terminal, Copy link (its `manut://terminal/…`),
 *  New terminal here, Close. */
export function termMenuItems(rec: Pick<SessionRec, "cwd" | "linkId">): RowAction[] {
  return ["rename", ...(rec.cwd ? (["reveal", "terminal"] as const) : []), ...(rec.linkId ? (["link"] as const) : []), "here", "close"];
}
export type RowAction = "rename" | "reveal" | "terminal" | "copy" | "link" | "here" | "close";

/** \"Show in Finder\" on macOS, \"Show in Explorer\" on Windows, \"Show in file manager\" elsewhere. */
const revealWord = () => {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return t(/Windows/i.test(ua) ? "md.explorer" : /Mac/i.test(ua) ? "md.finder" : "ss.menu.files");
};

const ROW_ACTION_LABEL: Record<RowAction, () => string> = {
  rename: () => t("ss.rename"),
  reveal: revealWord,
  terminal: () => t("ss.menu.terminal"),
  copy: () => t("ss.menu.copyId"),
  link: () => t("tlink.copy"),
  here: () => t("term.here"),
  close: () => t("ss.close"),
};
const ROW_ACTION_ID: Record<RowAction, string> = {
  rename: "session-rename",
  reveal: "session-reveal",
  terminal: "session-system-terminal",
  copy: "session-copy-id",
  link: "session-copy-link",
  here: "session-new-here",
  close: "session-menu-close",
};

/** Right-click menu of a session row (rowMenuItems). Placed at the pointer, inside the window. Arrow keys move,
 *  Home / End jump, Enter picks, Esc closes. */
function SessionMenu({ at, name, actions, onPick, onDismiss }: { at: { x: number; y: number }; name: string; actions: RowAction[]; onPick: (a: RowAction) => void; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onDismiss]);
  return (
    <div
      ref={ref}
      className="row-menu"
      style={{ left: at.x, top: at.y }}
      role="menu"
      aria-label={t("ss.actions", { name })}
      data-testid="session-row-menu"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onDismiss();
          return;
        }
        const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 + btns.length : e.key === "Home" ? 0 : e.key === "End" ? btns.length - 1 : null;
        if (to === null) return;
        e.preventDefault();
        btns[to % btns.length]?.focus();
      }}
    >
      {actions.map((a) => (
        <button
          key={a}
          type="button"
          role="menuitem"
          className={`row-mi${a === "close" ? " sep" : ""}`}
          data-testid={ROW_ACTION_ID[a]}
          onClick={() => {
            onDismiss();
            onPick(a);
          }}
        >
          {ROW_ACTION_LABEL[a]()}
        </button>
      ))}
    </div>
  );
}

/** The row menu's size, to keep it inside the window: 168 wide, 26 per row plus its padding and separator. */
const MENU_W_PX = 168;
const menuHeight = (rows: number) => rows * 26 + 14;

/** The name field of a row being renamed: Enter or leaving it saves, Esc cancels, an empty name goes back to the
 *  automatic one. */
function NameInput({ initial, auto, onDone }: { initial: string; auto: boolean; onDone: (title: string | null | undefined) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const v = (ref.current?.value ?? "").replace(/\s+/g, " ").trim();
    // undefined = leave it as it was; "" = back to the automatic name
    onDone(!save ? undefined : !v ? "" : auto && v === initial ? undefined : v);
  };
  return (
    <input
      ref={ref}
      className="ss-name-in"
      defaultValue={initial}
      maxLength={80}
      aria-label={t("ss.name")}
      placeholder={t("ss.autoName")}
      spellCheck={false}
      data-testid="session-rename-input"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !composing(e)) {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** The sign before a row's state word: a warning triangle (it waits for you), an exclamation mark (it stopped on an
 *  error), a check (it finished). Three shapes, so the state reads without its colour. */
function StateSign({ mark }: { mark: RowMark }) {
  if (mark === "needs")
    return (
      <svg width="13" height="12" viewBox="0 0 13 12" aria-hidden="true">
        <path d="M6.5 1.3 11.9 10.7H1.1Z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M6.5 4.5v2.8" fill="none" stroke="var(--needs-ink, #1b1204)" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="6.5" cy="9.2" r="0.8" fill="var(--needs-ink, #1b1204)" />
      </svg>
    );
  if (mark === "error")
    return (
      <svg width="5" height="12" viewBox="0 0 5 12" aria-hidden="true">
        <path d="M2.5 1.5v5.6" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
        <circle cx="2.5" cy="10.3" r="1.25" fill="currentColor" />
      </svg>
    );
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 6.4 4.8 9.2 10 3.2" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The row's compact view mark. The terminal is a solid window with the prompt cut out of it, the chat an outlined
 *  bubble; the original 16 by 13 geometry scales together inside a 12 by 10 box. */
function ViewMark({ view }: { view: "chat" | "terminal" }) {
  return view === "terminal" ? (
    <svg width="12" height="10" viewBox="0 0 16 13" aria-hidden="true">
      <rect width="16" height="13" rx="3" fill="currentColor" />
      <path d="M4 4 6.5 6.5 4 9M8.3 9.2h3.9" fill="none" stroke="var(--ss-cut)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width="12" height="10" viewBox="0 0 16 13" aria-hidden="true">
      <path
        d="M3 .8h10a2.2 2.2 0 0 1 2.2 2.2v4.2A2.2 2.2 0 0 1 13 9.4H7.6l-3.1 2.8V9.4H3A2.2 2.2 0 0 1 .8 7.2V3A2.2 2.2 0 0 1 3 .8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A TERMINALS row. Memoised: it re-renders when its own record, unseen mark, selection or the language change, or
 *  when its terminal's output changes what it shows (useTermFace), never for another session's output. `lang` is
 *  only a key: the strings read the current language at render. */
const TermRow = memo(function TermRow({ rec, agents, unseen, active, ticking, onClose, split, away }: { rec: SessionRec; agents: AgentInfo[] | null; unseen?: Unseen; active: boolean; ticking: boolean; lang: string; onClose: (rec: SessionRec) => void; split?: Layout | null; away?: boolean }) {
  countRender(`row:${rec.id}`);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const live = rec.status === "running" || rec.status === "starting";
  const { act, now } = useTermFace(rec.id, rec.startedAt, ticking);
  const title = pickTitle(rec, termFallbackName(rec, agents));
  // a program reporting progress (OSC 9;4) is working for as long as it says so, printing or not
  // a bot's request to type into it waits on the person: the row says so as a ring does
  const asked = usePendingRequests().some((r) => r.sessionId === rec.id);
  const status = asked ? "bell" : termStatus({ status: rec.status, exitCode: rec.exitCode, lastOut: act.progress ? now : act.lastOut }, unseen, now);
  // the folder its shell reports now (OSC 7), when that is not the folder it started in (its group's header)
  const movedTo = act.cwd && act.cwd !== rec.cwd ? act.cwd : null;
  const markAgent = termMarkAgent(rec);
  const age = ageMs(act.lastOut ?? rec.startedAt, now);
  const activity = termActivity({ agent: rec.agent, fgAgent: rec.fgAgent, lastLine: act.lastLine, oscTitle: act.oscTitle });
  // a CLI runs in it: the card's thin amber lane on its left edge (the folder summary's "running" counts the same)
  const running = live && markAgent !== null;
  const actions = termMenuItems(rec);
  const pick = (a: RowAction) => {
    const sx = getSessions();
    if (a === "rename") setEditing(true);
    else if (a === "reveal") void sx.revealFolder(rec.id);
    else if (a === "terminal") void sx.openTerminal(rec.id);
    else if (a === "link") void sx.copyLink(rec.id);
    else if (a === "here") sx.startTerminal(rec.agent, rec.cwd, rec.shell);
    else if (a === "close") onClose(rec);
  };
  const endEdit = (name: string | null | undefined) => {
    setEditing(false);
    if (name !== undefined) getSessions().rename(rec.id, name);
    requestAnimationFrame(() => wrap.current?.querySelector<HTMLElement>(".ss-open")?.focus());
  };
  const body = (
    <>
      <TermStatusGlyph status={status} />
      {/* live: a CLI runs in it (its own, or one the shell reports in front): the amber frame; a bare shell prompt and
          an ended session keep the plain frame */}
      <TermRowMark agent={markAgent} live={live && markAgent !== null} size={16} />
      {editing ? (
        <NameInput initial={title.title} auto={title.source !== "person"} onDone={endEdit} />
      ) : (
        <span
          className={`tr-n${split ? " has-split" : ""}`}
          data-testid="session-name"
          data-source={title.source}
          title={title.title}
          onDoubleClick={(e) => {
            e.preventDefault();
            setEditing(true);
          }}
        >
          {split ? <span className="tr-nt">{title.title}</span> : title.title}
          {split && (
            <span className="tr-split" data-testid="term-split-glyph" role="img" aria-label={t(active ? "split.focusedPane" : "split.inSplit", { name: splitPaneName(rec, agents) })} title={t(active ? "split.focusedPane" : "split.inSplit", { name: splitPaneName(rec, agents) })}>
              <SplitGlyph layout={split} mine={paneOf(rec.id) ?? -1} size={11} />
            </span>
          )}
        </span>
      )}
      <span className="tr-age" data-testid="term-age">
        {age}
      </span>
      {/* line 2, muted: the CLI, then what it last printed (else the title it set) */}
      <span className="tr-sub" data-testid="term-meta" title={activity.line || undefined}>
        <span className="tr-cli">{activity.cli}</span>
        {movedTo && (
          <>
            <span className="tr-dot" aria-hidden="true">
              ·
            </span>
            <span className="tr-cwd" data-testid="term-cwd" title={movedTo}>
              {folderName(movedTo)}
            </span>
          </>
        )}
        {activity.line && (
          <>
            <span className="tr-dot" aria-hidden="true">
              ·
            </span>
            <span className="tr-line" data-testid="term-line">
              {activity.line}
            </span>
          </>
        )}
      </span>
    </>
  );
  return (
    <div
      ref={wrap}
      className={`ss-row tr${active ? " active" : ""}${running ? " run" : ""}${menu ? " menu-open" : ""}${split ? (active ? " split-focus" : away ? " split split-away" : " split") : ""}`}
      data-split={split ? (active ? "focused" : away ? "away" : "in") : undefined}
      data-testid={`session-${rec.id}`}
      data-status={rec.status}
      data-term-status={status ?? "idle"}
      data-fg={rec.fgAgent ?? undefined}
      onPointerDown={(e) => {
        // a drag onto the open terminal puts this session in a pane there (a press that stays put is a click)
        if (editing || (e.target as Element).closest(".ss-x, [role=menu]")) return;
        // ...and one dropped on another row of its folder moves there
        pressToSplit(
          e,
          rec.id,
          (d) => splitWith(d.at, rec.id, d.side),
          (r) => getSessions().moveRow(rec.id, r.at, r.after),
        );
      }}
      onContextMenu={(e) => {
        if (editing) return;
        e.preventDefault();
        const side = wrap.current?.closest(".side")?.getBoundingClientRect();
        const right = (side?.right ?? window.innerWidth) - 6;
        const h = menuHeight(actions.length);
        setMenu({ x: Math.max(6, Math.min(e.clientX, right - MENU_W_PX)), y: Math.max(6, Math.min(e.clientY, window.innerHeight - h - 6)) });
      }}
    >
      {editing ? (
        <div className="ss-open ss-editing" title={rec.cwd}>
          {body}
        </div>
      ) : (
        <button type="button" className="ss-open" onClick={() => getStore().actions.openSession(rec.id)} aria-current={active ? "true" : undefined} title={`${title.title}\n${act.cwd ?? rec.cwd}`}>
          {body}
        </button>
      )}
      {!editing && (
        <button type="button" className="ss-x" aria-label={t("ss.close")} title={t("ss.close")} onClick={() => onClose(rec)} data-testid="session-close">
          <CloseIcon />
        </button>
      )}
      {menu && <SessionMenu at={menu} name={title.title} actions={actions} onPick={pick} onDismiss={() => setMenu(null)} />}
    </div>
  );
});
