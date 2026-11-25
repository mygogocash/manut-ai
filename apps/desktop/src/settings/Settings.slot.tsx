// Settings view (main column while `ui.view === "settings"`). Left list: You (Accounts, when the runtime keeps them),
// Bots (one page per bot: Profile, Model, Work) and App (General, Voice, Terminal, Agents, Computer, Worktrees, MCP and
// Skills, Developer). Pages are `bot:<name>`
// and the App page names; the page lives in the store (`ui.settingsPage`) so the model popover can deep-link to a bot.
// Oh My Hermes also had Providers (`hermes auth`) and Remote machines (Hermes over SSH) here; both needed its bridge.
import { useEffect, useState } from "react";
import "./settings.css";
import type { SlotProps } from "../features";
import type { Bot, ModelOptions } from "../lib/protocol";
import { getStore, notifyEnabled, notifyErrorsEnabled, setNotifyEnabled, setNotifyErrorsEnabled, useStore } from "../state/store";
import { addToList } from "../addbot/bots";
import { appSounds, setSoundsEnabled, soundsEnabled } from "../lib/sounds";
import { LANG_NAMES, LANGS, t, type Key, type Lang } from "../i18n";
import { Avatar, GridIcon, ModelIcon, SourceIcon } from "../ui";
import { Seg } from "../chat/model/Seg";
import { reasoningLabel } from "../chat/model/levels";
import { Appearance } from "./Appearance";
import { AccountsPage } from "./accounts/AccountsPage";
import { TerminalPage } from "./terminal/TerminalPage";
import { can } from "../runtime";
import { setBar, useTasks } from "../tasks/state";
import { DISK_WARN_CHOICES, diskWarn, setDiskWarn } from "../lib/disk";
import { hideDetails, quietHours, setHideDetails, setQuietHours } from "../lib/outside";
import { Toggle } from "../pages/kit";
import { awakeEnabled, closeHides, isMacPlatform, setAwakeEnabled, setCloseHides } from "../lib/power";
import { AgentsPage } from "./agents/AgentsPage";
import { AvatarEditor, BotFacts, NameEditor, PictureActions, placeName, useBotInfo, usePictureEditor } from "./BotIdentity";
import { ShopSettings } from "../onboarding/ShopSettings";
import { PeoplePage, peopleOffered } from "../pages/PeoplePane";
import { DeveloperPage } from "./DeveloperPage";
import { WorktreesPage } from "./WorktreesPage";
import { VoicePage } from "./VoicePage";
import { ComputerPage } from "./ComputerPage";
import { McpSkillsPage } from "./mcp/McpSkillsPage";

export const slot = "settings";

const APP_PAGES: { id: string; label: Key }[] = [
  { id: "general", label: "set.general" },
  // the chat box's microphone and voice mode: the language spoken, this Mac or Apple, the voice (VoicePage.tsx)
  { id: "voice", label: "set.voice" },
  { id: "terminal", label: "set.terminal" },
  { id: "agents", label: "set.agents" },
  // computer use: the two macOS permissions, read without asking, and what the agent may look at and do (ComputerPage.tsx)
  { id: "computer", label: "set.computer" },
  // where lanes' folders are made, the remote start, the branch prefix and the clean-up (WorktreesPage.tsx)
  { id: "worktrees", label: "set.worktrees" },
  // the MCP servers and skills each coding agent has, read from its own files; changes nothing (mcp/McpSkillsPage.tsx)
  { id: "mcp", label: "set.mcp" },
  // Practice or Connected, and signing in to the API (DeveloperPage.tsx)
  { id: "developer", label: "set.developer" },
];

const STATUS: Record<string, Key> = { online: "bot.online", offline: "bot.offline", starting: "bot.starting" };
/** A bot's status in words; a status manut does not know stays as the bridge wrote it. */
export const statusText = (status: string) => (STATUS[status] ? t(STATUS[status]) : status);

export default function Settings({ page }: SlotProps["settings"]) {
  const s = useStore();
  const botName = page.startsWith("bot:") ? page.slice(4) : null;
  const bot = botName ? s.bots.find((b) => b.name === botName) : undefined;
  const current = bot
    ? `bot:${bot.name}`
    : page === "bots" || (page === "accounts" && can("accounts")) || (page === "people" && peopleOffered()) || APP_PAGES.some((p) => p.id === page)
      ? page
      : "general";

  return (
    <div className="st" data-testid="settings-view">
      <nav className="st-nav" aria-label={t("set.sections")}>
        {/* coding-CLI logins are read by the runtime; one that keeps none has no Accounts page */}
        {can("accounts") && (
          <>
            <div className="st-sh">{t("set.you")}</div>
            <NavItem id="accounts" current={current} onPick={s.openSettings}>
              {t("nav.accounts")}
            </NavItem>
          </>
        )}
        <div className={`st-sh${can("accounts") ? " st-sh2" : ""}`}>{t("set.bots")}</div>
        <NavItem id="bots" current={current} onPick={s.openSettings}>
          <span className="st-nav-i" aria-hidden="true">
            <GridIcon />
          </span>
          {t("set.allBots")}<span className="st-count">{s.bots.length}</span>
        </NavItem>
        {s.bots.map((b) => (
          <NavItem key={b.name} id={`bot:${b.name}`} current={current} onPick={s.openSettings}>
            <Avatar bot={b.name} size={18} />
            <span className="st-nav-n">{b.display_name}</span>
          </NavItem>
        ))}
        {/* who can use Manut AI for the shop the switcher shows: the shop's owner's, so it sits with the shop and not with the app */}
        {peopleOffered() && (
          <>
            <div className="st-sh st-sh2">{t("set.shop")}</div>
            <NavItem id="people" current={current} onPick={s.openSettings}>
              {t("set.people")}
            </NavItem>
          </>
        )}
        <div className="st-sh st-sh2">{t("set.app")}</div>
        {APP_PAGES.map((p) => (
          <NavItem key={p.id} id={p.id} current={current} onPick={s.openSettings}>
            {t(p.label)}
          </NavItem>
        ))}
      </nav>
      <div className="st-body" data-testid={`settings-page-${current.replace(":", "-")}`}>
        {bot ? (
          <BotPage bot={bot} />
        ) : current === "accounts" ? (
          <AccountsPage />
        ) : current === "bots" ? (
          <BotsPage />
        ) : current === "terminal" ? (
          <TerminalPage />
        ) : current === "agents" ? (
          <AgentsPage />
        ) : current === "computer" ? (
          <ComputerPage />
        ) : current === "voice" ? (
          <VoicePage />
        ) : current === "worktrees" ? (
          <WorktreesPage />
        ) : current === "mcp" ? (
          <McpSkillsPage />
        ) : current === "developer" ? (
          <DeveloperPage />
        ) : current === "people" ? (
          <PeoplePage />
        ) : (
          <GeneralPage />
        )}
      </div>
    </div>
  );
}

function NavItem({
  id,
  current,
  onPick,
  children,
}: {
  id: string;
  current: string;
  onPick: (id: string) => void;
  children: React.ReactNode;
}) {
  const on = id === current;
  return (
    <button
      type="button"
      className={on ? "on" : undefined}
      aria-current={on ? "page" : undefined}
      onClick={() => onPick(id)}
      data-testid={`settings-nav-${id.replace(":", "-")}`}
    >
      {children}
    </button>
  );
}

function Row({
  title,
  hint,
  icon,
  children,
}: {
  title: string;
  hint?: string;
  icon?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="st-row">
      <div className="st-k">
        <b className={icon ? "st-kt" : undefined}>
          {icon}
          {title}
        </b>
        {hint && <span>{hint}</span>}
      </div>
      {children !== undefined && <div className="st-v">{children}</div>}
    </div>
  );
}

const Value = ({ children, mono }: { children: React.ReactNode; mono?: boolean }) => (
  <span className={`st-val${mono ? " mono" : ""}`}>{children}</span>
);

function providerName(opts: ModelOptions | undefined, slug: string): string {
  return opts?.providers.find((p) => p.slug === slug)?.name ?? slug;
}

function BotPage({ bot }: { bot: Bot }) {
  const s = useStore();
  const chat = s.chats[bot.name];
  const opts = s.models[bot.name];
  const routines = s.routines[bot.name];
  const model = chat?.model || opts?.current.model || bot.model;
  const provider = chat?.provider || opts?.current.provider || bot.provider;
  const reasoning = chat?.reasoning || opts?.current.reasoning || "";
  const offline = bot.status === "offline";
  const info = useBotInfo(bot);
  const picture = usePictureEditor(bot);
  const live = (bot.running || !!chat?.turn) && !offline;

  useEffect(() => {
    if (offline) return;
    if (!s.models[bot.name]) void s.loadModels(bot.name);
    if (!s.routines[bot.name]) void s.loadRoutines(bot.name);
    // fetch once per bot page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.name, offline]);

  return (
    <div className="st-page">
      <div className="be-head" data-testid="bot-head">
        <AvatarEditor bot={bot} ed={picture} />
        <div className="be-id">
          <NameEditor bot={bot} />
          <span className="be-sub">
            <i className={`st-dot ${live ? "working" : bot.status}`} aria-hidden="true" />
            {live ? t("bot.working") : statusText(bot.status)}
          </span>
          {bot.description && <p className="be-desc">{bot.description}</p>}
          <div className="be-acts">
            <button type="button" className="st-btn" onClick={() => void s.selectBot(bot.name)} data-testid="bot-open-chat">
              {t("set.openChat")}
            </button>
            <PictureActions ed={picture} />
          </div>
        </div>
      </div>
      <BotFacts info={info} />

      <div className="st-gh">{t("set.profile")}</div>
      <div className="st-grp">
        <Row title={t("set.profileId")} hint={bot.is_default ? t("set.profileDefault") : t("set.profileHere")}>
          <Value mono>{bot.name}</Value>
        </Row>
      </div>

      <div className="st-gh">{t("set.model")}</div>
      <div className="st-grp">
        <Row title={t("set.model")} hint={t("set.modelHint")}>
          <Value>
            {model || "—"}
            {provider && <small>{providerName(opts, provider)}</small>}
          </Value>
        </Row>
        <Row title={t("set.reasoning")} hint={t("set.reasoningHint")}>
          <Value>{reasoning ? reasoningLabel(reasoning) : "—"}</Value>
        </Row>
        <Row title={t("set.change")} hint={t("set.changeHint")}>
          <button type="button" className="st-btn" onClick={() => void s.selectBot(bot.name)} disabled={offline}>
            {t("set.changeInChat")}
          </button>
        </Row>
      </div>

      <div className="st-gh">{t("set.work")}</div>
      <div className="st-grp">
        <Row title={t("set.mainChat")} hint={t("set.mainChatHint")}>
          <Value>
            {chat?.loaded ? (chat.messages.length === 1 ? t("set.messages1") : t("set.messages", { n: chat.messages.length })) : "—"}
          </Value>
        </Row>
        <Row title={t("set.routines")} hint={t("set.routinesHint")}>
          <Value>
            {(() => {
              const n = routines?.length ?? info?.routines;
              return n === undefined ? "—" : n === 1 ? t("set.routine1") : t("set.routinesN", { n });
            })()}
          </Value>
        </Row>
        <Row title={t("set.askBefore")} hint={t("set.askBeforeHint")}>
          <Value>{t("set.inHermes")}</Value>
        </Row>
        <Row title={t("set.useComputer")} hint={t("set.useComputerHint")}>
          <Value>
            <span className="st-soon">{t("set.soon")}</span>
          </Value>
        </Row>
      </div>
    </div>
  );
}

/** Every bot at a glance: picture, name, status, what it is doing and where it works. It lists every profile on
 *  this computer (management, not the sidebar list); each card says whether the bot is in the sidebar, or adds it. */
function BotsPage() {
  const s = useStore();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const bots = needle
    ? s.bots.filter((b) =>
        [b.display_name, b.name, b.description, b.model].some((t) => (t ?? "").toLowerCase().includes(needle)),
      )
    : s.bots;
  const online = s.bots.filter((b) => b.status === "online").length;
  const working = s.bots.filter((b) => b.running || !!s.chats[b.name]?.turn).length;
  return (
    <div className="st-page st-wide">
      <div className="bots-h">
        <div>
          <b>{t("set.bots")}</b>
          <span>
            {s.bots.length === 1 ? t("set.botsCount1", { online }) : t("set.botsCount", { n: s.bots.length, online })}
            {working > 0 && t("set.botsWorking", { n: working })}
          </span>
        </div>
        <input
          type="search"
          className="bots-q"
          placeholder={t("set.findBot")}
          aria-label={t("set.findBot")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="bots-search"
        />
      </div>
      <div className="bots-grid" data-testid="bots-grid">
        {bots.map((b) => (
          <BotCard key={b.name} bot={b} />
        ))}
        {needle && bots.length === 0 && <div className="bots-empty">{t("set.noBotMatch", { q: q.trim() })}</div>}
      </div>
    </div>
  );
}

function BotCard({ bot }: { bot: Bot }) {
  const s = useStore();
  const info = useBotInfo(bot);
  const places = info ? Object.entries(info.places).slice(0, 3) : [];
  const live = bot.running || !!s.chats[bot.name]?.turn;
  const listed = (s.ui.roster ?? []).includes(bot.name);
  return (
    <div className="bot-card-w">
    <button
      type="button"
      className="bot-card"
      onClick={() => s.openSettings(`bot:${bot.name}`)}
      data-testid={`bot-card-${bot.name}`}
    >
      <span className="bc-top">
        <Avatar bot={bot.name} size={40} />
        <span className="bc-id">
          <b>{bot.display_name}</b>
          <span>
            <i className={`st-dot ${live ? "working" : bot.status}`} aria-hidden="true" />
            {live ? t("bot.working") : statusText(bot.status)}
            {bot.name !== bot.display_name.toLowerCase() && <code>{bot.name}</code>}
          </span>
        </span>
      </span>
      {bot.description && <span className="bc-desc">{bot.description}</span>}
      <span className="bc-foot">
        <span className="bc-model">
          <ModelIcon model={bot.model} provider={bot.provider} size={11} />
          {bot.model || "—"}
        </span>
        {places.map(([src, n]) => (
          <span key={src} className="bc-place" title={t("set.placeSessions", { n, place: placeName(src) })}>
            <SourceIcon source={src} size={11} />
            {n}
          </span>
        ))}
      </span>
    </button>
      {listed ? (
        <span className="bc-list in" data-testid={`bot-inlist-${bot.name}`}>
          {t("set.inList")}
        </span>
      ) : (
        <button
          type="button"
          className="bc-list"
          onClick={() => void addToList(getStore(), bot.name, { open: false })}
          aria-label={t("ab.addOf", { name: bot.display_name })}
          data-testid={`bot-addlist-${bot.name}`}
        >
          {t("set.addToList")}
        </button>
      )}
    </div>
  );
}

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
const SHORTCUTS: [string, Key][] = [
  [`${MOD}1 … ${MOD}9`, "key.openBot"],
  [`${MOD}K`, "key.search"],
  [`${MOD}.`, "key.details"],
  [`${MOD},`, "key.settings"],
  [`${MOD}J`, "key.nextAsk"],
  [MOD === "⌘" ? `${MOD}N · ${MOD}T` : `${MOD}N`, "key.newSession"],
  [MOD === "⌘" ? "⌘D · ⌘⇧D" : "Ctrl+Shift+D · Alt+Shift+D", "key.splitPane"],
  [MOD === "⌘" ? "⌘W" : "Ctrl+Shift+W", "key.closePane"],
  [MOD === "⌘" ? "⌘⌥ ←↑↓→" : "Ctrl+Alt+ ←↑↓→", "key.focusPane"],
  [MOD === "⌘" ? "⌘] · ⌘[" : "Ctrl+Tab · Ctrl+Shift+Tab", "key.stepPane"],
  [MOD === "⌘" ? "⌘⇧⌥ ←↑↓→" : "Ctrl+Alt+Shift+ ←↑↓→", "key.movePane"],
  [MOD === "⌘" ? "⌘⇧↩" : "Ctrl+Shift+Enter", "key.zoomPane"],
  [MOD === "⌘" ? "⌘⌃=" : "Ctrl+Alt+=", "key.equalizePanes"],
  [MOD === "⌘" ? "⌘= · ⌘- · ⌘0" : "Ctrl+= · Ctrl+- · Ctrl+0", "key.termFont"],
  ...(MOD === "⌘"
    ? ([
        ["⌘← · ⌘→ · ⌘⌫ · ⌘⌦", "key.termLine"],
        ["⌥← · ⌥→", "key.termWord"],
        ["⌘K", "key.termClear"],
      ] as [string, Key][])
    : ([["Ctrl+Shift+C · Ctrl+Shift+V · Ctrl+Insert · Shift+Insert", "key.termCopyPaste"]] as [string, Key][])),
  [MOD === "⌘" ? "⌘Home · ⌘End" : "Ctrl+Home · Ctrl+End", "key.termScroll"],
  [MOD === "⌘" ? "⌘⇧C" : "Alt+Shift+C", "key.copyLink"],
  ["1 · 2 · 3", "key.cardKeys"],
  ["Esc", "key.stop"],
];

function NotifySeg() {
  const [on, setOn] = useState(notifyEnabled());
  return (
    <Seg
      small
      label={t("set.notify")}
      value={on ? "on" : "off"}
      options={[
        { value: "on", label: t("set.on") },
        { value: "off", label: t("set.off") },
      ]}
      onChange={(v) => {
        setNotifyEnabled(v === "on");
        setOn(v === "on");
      }}
      testId="notify-seg"
    />
  );
}

function NotifyErrorsSeg() {
  const [on, setOn] = useState(notifyErrorsEnabled());
  return (
    <Seg
      small
      label={t("set.notifyErrors")}
      value={on ? "on" : "off"}
      options={[
        { value: "on", label: t("set.on") },
        { value: "off", label: t("set.off") },
      ]}
      onChange={(v) => {
        setNotifyErrorsEnabled(v === "on");
        setOn(v === "on");
      }}
      testId="notify-errors-seg"
    />
  );
}

/** "Hide details": a notification shows no names, amounts or customers, only how many requests need you. Off by default. */
export function HideDetailsView({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return <Toggle on={on} label={t("out.hideDetails")} onChange={onChange} testId="set-hide-details" />;
}

export function HideDetailsToggle() {
  const [on, setOn] = useState(hideDetails());
  return (
    <HideDetailsView
      on={on}
      onChange={(v) => {
        setHideDetails(v);
        setOn(v);
      }}
    />
  );
}

/** A start and an end, as two time fields. An emptied field says nothing: the hours stay as they were. */
export function QuietHoursView({ start, end, onStart, onEnd }: { start: string; end: string; onStart: (v: string) => void; onEnd: (v: string) => void }) {
  return (
    <span className="st-pair" data-testid="set-quiet">
      <input type="time" className="dev-in st-time" aria-label={t("out.quietStart")} value={start} onChange={(e) => e.target.value && onStart(e.target.value)} data-testid="set-quiet-start" />
      <span aria-hidden="true">{t("out.quietTo")}</span>
      <input type="time" className="dev-in st-time" aria-label={t("out.quietEnd")} value={end} onChange={(e) => e.target.value && onEnd(e.target.value)} data-testid="set-quiet-end" />
    </span>
  );
}

export function QuietHoursInputs() {
  const [hours, setHours] = useState(quietHours());
  const save = (next: { start: string; end: string }) => {
    setQuietHours(next);
    setHours(next);
  };
  return <QuietHoursView start={hours.start} end={hours.end} onStart={(start) => save({ ...hours, start })} onEnd={(end) => save({ ...hours, end })} />;
}

/** The two choices about what the app shows outside its window, as the canvas's rows. */
export function OutsideRows() {
  return (
    <>
      <Row title={t("out.hideDetails")} hint={t("out.hideDetailsHint")}>
        <HideDetailsToggle />
      </Row>
      <Row title={t("out.quiet")} hint={t("out.quietHint")}>
        <QuietHoursInputs />
      </Row>
    </>
  );
}

/** Under the notification choices: what quiet hours still let through, which clock they follow, and what the lock screen
 *  does, which the app cannot see (macOS hides previews there by itself, so Hide details cannot be keyed to it). */
export function OutsideNotes() {
  return (
    <>
      <div className="st-note">{t("out.quietAlerts")}</div>
      <div className="st-note">{t("out.quietZone")}</div>
      <div className="st-note">{t("out.lockNote")}</div>
    </>
  );
}

function SoundsSeg() {
  const [on, setOn] = useState(soundsEnabled());
  return (
    <span className="st-pair">
      <button type="button" className="st-btn" disabled={!on} onClick={() => appSounds().preview()} data-testid="sounds-play">
        {t("sounds.play")}
      </button>
      <Seg
        small
        label={t("sounds.title")}
        value={on ? "on" : "off"}
        options={[
          { value: "on", label: t("sounds.on") },
          { value: "off", label: t("sounds.off") },
        ]}
        onChange={(v) => {
          setSoundsEnabled(v === "on");
          setOn(v === "on");
        }}
        testId="sounds-seg"
      />
    </span>
  );
}

/** Settings › General: warn below 5/10/20/50 GB of free disk space, or not at all (src/lib/disk.ts). */
function DiskWarnSeg() {
  const [v, setV] = useState(diskWarn());
  return (
    <Seg
      small
      label={t("disk.setting")}
      value={String(v)}
      options={DISK_WARN_CHOICES.map((n) => ({ value: String(n), label: n ? t("disk.gb", { n }) : t("set.off") }))}
      onChange={(x) => {
        setV(Number(x));
        setDiskWarn(Number(x));
      }}
      testId="set-disk-warn"
    />
  );
}

function TasksBarToggle() {
  const tk = useTasks();
  return <Toggle on={tk.bar} label={t("tasks.barSetting")} onChange={setBar} testId="set-tasks-bar" />;
}

function CloseSeg() {
  const [hide, setHide] = useState(closeHides());
  return (
    <Seg
      small
      label={t("win.close")}
      value={hide ? "tray" : "quit"}
      options={[
        { value: "tray", label: t("win.closeTray") },
        { value: "quit", label: t("win.closeQuit") },
      ]}
      onChange={(v) => {
        setCloseHides(v === "tray");
        setHide(v === "tray");
      }}
      testId="window-close-seg"
    />
  );
}

function AwakeToggle() {
  const [on, setOn] = useState(awakeEnabled());
  return (
    <Toggle
      on={on}
      label={t("awake.title")}
      onChange={(v) => {
        setAwakeEnabled(v);
        setOn(v);
      }}
      testId="set-awake"
    />
  );
}

function GeneralPage() {
  const s = useStore();
  const h = s.hello;
  return (
    <div className="st-page">
      {/* The first-run setup again, on Your shop: the only place the person and the shop are changed. */}
      <ShopSettings shop={s.ui.shop} onSetUp={s.openFirstRun} />
      <div className="st-gh">{t("set.appearance")}</div>
      <Appearance />
      <div className="st-grp st-grp-lang">
        <Row title={t("lang.title")} hint={t("lang.hint")}>
          <Seg
            label={t("lang.title")}
            value={s.ui.lang}
            onChange={(v) => s.setLanguage(v as Lang)}
            options={LANGS.map((l) => ({ value: l, label: LANG_NAMES[l] }))}
            testId="language"
          />
        </Row>
      </div>
      <div className="st-gh">{t("set.notifications")}</div>
      <div className="st-grp">
        <Row title={t("set.notify")} hint={t("set.notifyHint")}>
          <NotifySeg />
        </Row>
        <Row title={t("set.notifyErrors")} hint={t("set.notifyErrorsHint")}>
          <NotifyErrorsSeg />
        </Row>
        <OutsideRows />
        <Row title={t("sounds.title")} hint={t("sounds.hint")}>
          <SoundsSeg />
        </Row>
        <Row title={t("disk.setting")} hint={t("disk.settingHint")}>
          <DiskWarnSeg />
        </Row>
      </div>
      <OutsideNotes />
      <div className="st-grp">
        <Row title={t("tasks.barSetting")} hint={t("tasks.barSettingHint")}>
          <TasksBarToggle />
        </Row>
      </div>
      <div className="st-gh">{t("set.system")}</div>
      <div className="st-grp" data-testid="set-system">
        <Row title={t("win.close")} hint={t(isMacPlatform() ? "win.closeHint" : "win.closeHintOther")}>
          <CloseSeg />
        </Row>
        <Row title={t("awake.title")} hint={t("awake.hint")}>
          <AwakeToggle />
        </Row>
      </div>
      <div className="st-gh">{t("set.keyboard")}</div>
      <div className="st-grp" data-testid="shortcuts">
        {SHORTCUTS.map(([keys, what]) => (
          <Row key={keys} title={t(what)}>
            <Value>
              <kbd className="st-kbd">{keys}</kbd>
            </Value>
          </Row>
        ))}
      </div>
      <div className="st-gh">{t("set.runtime")}</div>
      <div className="st-grp">
        <Row title={t("set.connection")} hint={h?.bridge === "mock" ? t("set.testBridge") : undefined}>
          <Value>
            <i className={`st-dot ${s.conn === "open" ? "online" : "offline"}`} aria-hidden="true" />
            {s.conn === "open" ? t("bot.online") : s.conn === "connecting" ? t("bot.connecting") : t("bot.offline")}
          </Value>
        </Row>
      </div>
    </div>
  );
}
