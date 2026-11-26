// Main column for a SESSIONS entry: a header (agent mark, the session's name, the agent and folder, status, the
// Terminal toggle and the model button) above either the chat (the bot chat's own Timeline and Composer, fed by
// the agent's structured mode) or the agent's terminal. A New session (draft) is a chat that has not started, on the
// agent picked in the SESSIONS + menu: its composer shows that agent read-only and, under it, the folder chip; the
// first message starts the agent there (Start, for an agent that opens in its terminal). After that the folder is
// read-only too. A chat agent's composer takes files as the bot chat's does (paste, the + menu, a drop on the chat),
// in a draft too; a file dropped or pasted on a terminal is saved and its path typed at the prompt. A TERMINALS session
// can split with up to three others on any side (SplitView: ⌘D / ⌘⇧D in its terminal, or a TERMINALS row dragged onto it).
import { useLimitOffer, WaitingRow } from "../chat/box/LaterRows";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getStore, selectAsks, useStore, type Chat, type OutFile } from "../state/store";
import { useResolvedTheme } from "../app/theme";
import { Timeline } from "../chat/parts/Timeline";
import { Composer } from "../chat/parts/Composer";
import { CheckIcon } from "../chat/model/CheckIcon";
import "../chat/model/model.css";
import { ArrowUp, ChatIcon, ChevronDown, Popover, TerminalIcon } from "../ui";
import { composing } from "../lib/ime";
import { modesOf, queueOff, steersOf, usageText } from "./controls";
import { ModelMenu } from "../chat/box/ModelMenu";
import { ApprovalMenu, DialRows } from "../chat/box/ApprovalMenu";
import { DEFAULT_KIT_LEVEL, KIT_LEVELS } from "@manut/member-grants";
import { setLevel, updateKitProjects, useKitProject } from "../code/project";
import { projectName } from "../code/kitAsks";
import type { SessionQueue } from "../chat/parts/Timeline";
import { ownSetting } from "./ownSetting";
import type { Bot } from "../lib/protocol";
import { AgentMark } from "./AgentMark";
import { fgName, TermRowMark } from "./TermRowMark";
import { SessionFace } from "./SessionFace";
import { agentDef, agentLabel, continues, GONE, isCustom, isGone, STOPS_BACKGROUND, draftOpen, folderChoices, folderName, hermesOnly, missingNote, opensAs, parentPath, sessionMode, termFallbackName, termMarkAgent, terminalNote, tildePath, type AgentId, type OpenAs, type SessionRec } from "./agents";
import { pickTitle } from "./titles";
import { t as tr, tx, type Key } from "../i18n";
import { windowWatched } from "../lib/notify";
import { getSessions, useSessions, type ModelOption } from "./sessions";
import { FindBar } from "./term/find-bar";
import { FIND_EVENT, type FindRequest } from "./term/engine-find";
import { sessionAccountSuffix } from "./SessionsSection";
import { PanelToggle } from "../chat/parts/PanelButton";
import { RewindButton } from "./RewindPanel";
import { clearSuggestion, useSuggestion } from "../chat/suggestion";
import { workingSubagents } from "./SessionPlans";
import { waitingSubs } from "../chat/activity/Subagents";
import { subagentEnded } from "../state/store";
import { useAccounts } from "../settings/accounts/useAccounts";
import { t } from "../i18n";
import { wireFileDrop, isWindows } from "../terminal/terms";
import { isMac } from "../app/shortcuts";
import { SplitView, useSplit, useSplitKeys } from "./SplitView";
import { groupOf } from "./splitState";
import { isCopyLinkKey, LINK_COPIED_EVENT } from "./termLink";
import { TermShareCards } from "./TermShareCard";
import { LanePane } from "../code/LanePane";
import { LaneReview } from "../code/Review";
import { isLaneChat } from "../code/laneStore";
import { HelpersSwitch } from "../jobs/HelpersSwitch";
import { MayReach } from "../jobs/MayReach";
import { chatPullOf, useChatPullsVersion, type ChatPull } from "../code/chatPull";
import { usePullsVersion } from "../tasks/pulls";
import { showBoardPull } from "../tasks/state";
import { Icon } from "../ui/icons";
import { chatScope } from "../chat/box/scope";
import { AgentContinue, ContinueLines, useLaneWait } from "./ContinueMenu";
import { usePlace } from "../palette/places";

const STATUS: Record<string, Key> = { starting: "ss.starting", running: "ss.running", exited: "ss.ended", failed: "ss.couldNotStart" };

/** Agents whose count of what is left in the background holds their background subagents (Claude Code's
 *  `background_tasks_changed` lists them beside its background commands). OmO counts commands only. */
const COUNTS_BACKGROUND_SUBAGENTS: readonly AgentId[] = ["claude"];

function TerminalPane({ rec, splits }: { rec: SessionRec; splits?: boolean }) {
  const s = useStore();
  const box = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const mode = useResolvedTheme(s.ui.theme);
  // Cmd/Ctrl+F in this terminal: the engine says so with an event, the bar opens for that terminal only
  const [find, setFind] = useState<FindRequest | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const on = (e: Event) => setFind((e as CustomEvent<FindRequest>).detail);
    el.addEventListener(FIND_EVENT, on);
    return () => el.removeEventListener(FIND_EVENT, on);
  }, []);
  // A file dropped on the terminal, or a picture pasted there, is saved and its path typed at the prompt (as a
  // system terminal types a dropped file's path). Plain text pastes stay xterm's own. The bottom panel's panes use the
  // same wiring (terminal/terms.ts).
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    return wireFileDrop(el, (files) => void getSessions().dropOnTerminal(rec.id, files, isWindows()));
  }, [rec.id]);
  // the split keys in a TERMINALS terminal (⌘D, ⌘⇧D, ⌘W, ⌘⌥arrows...; SplitView), taken before xterm
  useSplitKeys(wrap, rec.id, !!splits);
  // ⌘⇧C (Alt+Shift+C off macOS) in a TERMINALS terminal: its link to the clipboard. Taken before xterm.
  useEffect(() => {
    const el = wrap.current;
    if (!el || !splits) return;
    const on = (e: KeyboardEvent) => {
      if (composing(e) || !isCopyLinkKey(e, isMac())) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) void getSessions().copyLink(rec.id);
    };
    el.addEventListener("keydown", on, true);
    return () => el.removeEventListener("keydown", on, true);
  }, [rec.id, splits]);
  // a copied link says so on the terminal for a moment (the row menu's Copy link too, while this one shows)
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== rec.id) return;
      setCopied(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setCopied(false), 1600);
    };
    window.addEventListener(LINK_COPIED_EVENT, on);
    return () => {
      window.removeEventListener(LINK_COPIED_EVENT, on);
      if (timer) clearTimeout(timer);
    };
  }, [rec.id]);
  useEffect(() => {
    if (!box.current) return;
    return getSessions().attach(rec.id, box.current, mode);
    // re-attach only when the session changes; theme changes go through setLook below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.id]);
  useEffect(() => {
    getSessions().setLook(mode);
  }, [mode]);
  return (
    <div className="term-wrap" ref={wrap} data-testid="terminal" data-session={rec.id}>
      <div className="term-box" ref={box} />
      {find && <FindBar req={find} onClose={() => setFind(null)} />}
      {copied && (
        <div className="tlink-copied" role="status" data-testid="term-link-copied">
          {t("tlink.copied")}
        </div>
      )}
      <TermShareCards sessionId={rec.id} title={pickTitle(rec, termFallbackName(rec, getSessions().getState().agents)).title} />
    </div>
  );
}

function ChatPane({ rec, chatKey }: { rec: SessionRec; chatKey: string }) {
  const s = useStore();
  const ss = useSessions();
  const chat = s.chats[chatKey];
  // files go to a chat agent; an oh-my-hermes session's chat is Hermes', which takes files in a bot's main chat only
  const takesFiles = (ss.agents?.find((a) => a.id === rec.agent)?.mode ?? agentDef(rec.agent).mode) === "chat";
  const label = agentLabel(rec.agent, ss.agents);
  const ended = isEnded(rec);
  // The bot chat's parts take a Bot: this session's chat stands in for one. An agent that ended before it named a
  // model (an old version that never answered in chat mode) gets no "pick a model" hint: its end says why.
  const bot: Bot = {
    name: chatKey,
    display_name: label,
    is_default: false,
    // DeepSeek Harness keeps its model in its own app and its headless stream names none: nothing to pick here
    model: rec.model || (rec.agent === "dsh" ? "dsh" : ended ? label : ""),
    provider: "",
    description: "",
    status: rec.status === "running" ? "online" : rec.status === "starting" ? "starting" : "offline",
    running: !!chat?.turn,
  };
  const offlineText = rec.paused
    ? tr("ss.isPaused", { agent: label })
    : rec.status === "failed"
      ? tr("ss.agentCouldNotStart", { agent: label })
      : rec.status === "starting"
        ? tr("ss.startingAgent", { agent: label })
        : tr("ss.hasEnded", { agent: label });
  // one element per chat: the bubbles are memoized on it
  const face = useMemo(() => <SessionFace chatKey={chatKey} size={28} />, [chatKey]);
  // steer queue sessions: the ↵ ↓ × buttons of an agent chat's waiting message (a Hermes folder chat has none)
  const queue = useMemo<SessionQueue | undefined>(
    () =>
      takesFiles
        ? {
            off: (it) => queueOff(rec.agent, label, !!it.held, it.wait === "queued" && !it.steered),
            // "send" is the bot chat's unknown-steer choice: an agent chat never offers it
            pick: (lid, c) => void (c !== "send" && getSessions().queuePick(rec.id, lid, c)),
          }
        : undefined,
    [takesFiles, rec.agent, rec.id, label],
  );
  const commands = ss.live[rec.id]?.commands?.length ? ss.live[rec.id]!.commands : undefined;
  // the agent's predicted next message, when the person turned suggestions on and this agent can give one (lib/suggest.ts)
  const suggestion = useSuggestion(chatKey);
  const limitOffer = useLimitOffer(chatKey, rec);
  // one working agent in a lane: while the chat this one is linked with by Continue with works there, the box holds (item 97)
  const laneWait = useLaneWait(rec);
  return (
    <div className="pane ss-chat" data-pane={chatKey} data-testid="session-chat">
      <Timeline
        bot={bot}
        face={face}
        connectionNotice={false}
        queue={queue}
        onEditLast={ss.live[rec.id]?.rewind && rec.status === "running" && !chat?.turn ? () => void getSessions().rewind(rec.id) : undefined}
      />
      {rec.paused ? <Paused rec={rec} /> : ended && <Ended rec={rec} />}
      <OwnApprovals agent={rec.agent} />
      {/* the chat this one continued in or from (item 97), each with Open */}
      <ContinueLines rec={rec} />
      {/* a message kept to send when this chat's account resets (item 95) */}
      <WaitingRow chatKey={chatKey} />
      <Composer
        key={chatKey}
        bot={bot}
        running={!!chat?.turn}
        asking={selectAsks(s).some((a) => a.bot === chatKey)}
        offline={rec.status !== "running"}
        offlineText={offlineText}
        suggestion={suggestion}
        onSuggestionTaken={() => clearSuggestion(chatKey)}
        onSend={(t, how) => {
          clearSuggestion(chatKey);
          void getSessions().send(rec.id, t, how);
        }}
        onSendFiles={takesFiles ? (t, files, how) => (clearSuggestion(chatKey), getSessions().sendFiles(rec.id, t, files, how)) : undefined}
        // only the agents with a mid-turn input of their own take a message into a running answer (controls.ts STEERS)
        steers={steersOf(rec.agent)}
        // a coding chat holds a message typed mid-answer until the person picks otherwise (chat/box/keys.ts FOLLOW_UP_USUAL)
        boxKind="code"
        // its account at its limit: Send at the reset keeps what is typed (chat/box/later.ts)
        limit={limitOffer}
        onStop={() => void getSessions().interrupt(rec.id)}
        commands={commands}
        // Add context: a folder is named by its path (the dial reads one outside the project as blocked, with Allow this
        // folder on the Code page), the `/` menu is the agent's own; a coding chat mentions no teammate
        onFolder={takesFiles ? () => getSessions().pickFolder(rec.lane?.dir || rec.cwd) : undefined}
        actions={!!commands}
        rows
        // the microphone and voice mode (item 81): voice mode talks with this session's agent, its asks on their cards
        voice
        waitNote={laneWait}
        tools={
          <>
            {/* an agent chat's agent chip opens Continue with… (item 97); a Hermes folder chat's stays as it was */}
            {takesFiles && rec.status !== "draft" ? <AgentContinue rec={rec} /> : <AgentFixed agent={rec.agent} />}
            {/* the chat box's model with its effort, and how much the agent may do before asking (item 80) */}
            <SessionModel rec={rec} options={ss.models[rec.id]} note={ss.notes[rec.id]} />
            {(modesOf(rec.agent).length > 0 || takesFiles) && <SessionApproval rec={rec} />}
            {/* Helpers, beside the approval level: only in a lane's chat with a folder of its own (item 102e) */}
            <HelpersSwitch rec={rec} />
          </>
        }
        foot={
          <>
            <Context rec={rec} />
            {/* the chats this chat's agent may ask to reach, each only after a card (item 102k) */}
            <MayReach rec={rec} chatKey={chatKey} />
          </>
        }
        // a note or another chat's context made under another account of this agent is not sent here (item 97)
        scope={chatScope(chatKey, null, rec, null)}
      />
    </div>
  );
}

/** A lane: a coding session's chat with the pane beside it that says what to look at (code/LanePane.tsx), as the design canvas's Code
 *  board draws it. The pane goes under the chat when the column is too narrow for both (code/lanepane.css). Only the chat is
 *  `session-chat`; the pane is its own. */
function LaneSplit({ rec, chatKey, chat }: { rec: SessionRec; chatKey: string; chat: Chat | undefined }) {
  return (
    <div className="ss-lane" data-testid="session-lane">
      <div className="ss-lane-body">
        <ChatPane rec={rec} chatKey={chatKey} />
        {/* a new key for each lane, so each opens on Diff and keeps its own question about a secret; a preview runs only in the
            lane's own folder */}
        <LanePane
          key={chatKey}
          chatKey={chatKey}
          chat={chat}
          laneDir={rec.lane?.dir || null}
          review={rec.lane?.worktree ? <LaneReview root={rec.cwd} worktree={rec.lane.worktree} branch={rec.lane.name} title={pickTitle(rec, folderName(rec.cwd)).title} /> : undefined}
        />
      </div>
    </div>
  );
}

const HomeIcon = () => <Icon name="home" />;

const FolderIcon = () => <Icon name="folder" />;

/** A person's own agent (Settings › Agents): one quiet line, once per session view, that its approval cards are the
 *  ones the agent itself asks for. manut cannot add asks to an agent it does not know. */
function OwnApprovals({ agent }: { agent: AgentId }) {
  useSessions(); // a row the look-up sends later shows the line then
  if (!isCustom(agent)) return null;
  return (
    <div className="ss-own" role="note" data-testid="session-own-approvals">
      {tr("ss.ownApprovals")}
    </div>
  );
}

/** The session's agent in the composer row, read-only (a draft's agent is changed from the SESSIONS + menu). */
function AgentFixed({ agent }: { agent: AgentId }) {
  const label = agentLabel(agent, useSessions().agents);
  return (
    <span className="ss-pick ro" title={label} data-testid="session-agent-fixed">
      <AgentMark agent={agent} size={14} />
      <span className="ss-pick-n">{label}</span>
    </span>
  );
}

/** How a New session opens, a quiet two-word choice beside the agent: Chat (manut's own chat) or Terminal (the agent's
 *  own program in a terminal). The picked word is gray, the other plain; one the agent does not have is dimmed and its
 *  tooltip says why. The pick is remembered per agent. */
function OpenPick({ rec, way }: { rec: SessionRec; way: OpenAs }) {
  const ss = useSessions();
  const has = opensAs(rec.agent, ss.agents);
  const label = agentLabel(rec.agent, ss.agents);
  const tip = (w: OpenAs): string =>
    has[w]
      ? w === "chat"
        ? t("ss.open.chatTip")
        : t("ss.open.terminalTip", { agent: label })
      : w === "terminal"
        ? t(rec.agent === "dsh" ? "ss.open.noTermDsh" : "ss.open.noTermHermes")
        : t("ss.open.noChat", { agent: label });
  return (
    <span className="ss-way" role="radiogroup" aria-label={t("ss.open.label")} data-testid="session-way">
      {(["chat", "terminal"] as const).map((w) => (
        <button
          key={w}
          type="button"
          role="radio"
          className={`ss-way-o${way === w ? " on" : ""}`}
          aria-checked={way === w}
          aria-disabled={!has[w] || undefined}
          // one Tab stop for the pair; the arrow keys move between the two, as in any radio group
          tabIndex={way === w ? 0 : -1}
          title={tip(w)}
          onClick={() => {
            if (has[w]) getSessions().setOpen(rec.id, w);
          }}
          onKeyDown={(e) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
            e.preventDefault();
            const other = w === "chat" ? "terminal" : "chat";
            // the focus moves even to a way the agent lacks, so its reason can be read; only one it has is picked
            // (picking Chat then hands the focus to the box, as a click on Chat does)
            e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-testid=session-way-${other}]`)?.focus();
            if (has[other]) getSessions().setOpen(rec.id, other);
          }}
          data-testid={`session-way-${w}`}
        >
          {t(w === "chat" ? "ss.open.chat" : "ss.open.terminal")}
        </button>
      ))}
    </span>
  );
}

/** The line under a session's composer: the folder (and the account it runs as). A draft's folder is a menu:
 *  the recent folders, Choose folder… (the native dialog) and the home folder. Started, it is read-only. */
function Context({ rec, account }: { rec: SessionRec; account?: string }) {
  const ss = useSessions();
  const [open, setOpen] = useState(false);
  const draft = rec.status === "draft";
  const name = rec.cwd ? folderName(rec.cwd) : t("sessions.findingHome");
  const as = draft ? account : rec.startedAs;
  const pick = (cwd: string) => {
    setOpen(false);
    getSessions().setDraft(rec.id, { cwd });
  };
  const choose = async () => {
    setOpen(false);
    await getSessions().chooseFolder(rec.id);
  };
  const { recent, home } = folderChoices(ss.recent, ss.home);
  const row = (cwd: string, label: string, testid: string, icon?: ReactNode, path = true) => {
    const on = cwd === rec.cwd;
    return (
      <button key={`${testid}:${cwd}`} type="button" className={`ss-item${on ? " on" : ""}`} title={cwd} aria-pressed={on} onClick={() => pick(cwd)} data-testid={testid}>
        <span className="ss-ic">{icon}</span>
        <span className="ss-n">{label}</span>
        {path && <span className="ss-path">{parentPath(tildePath(cwd, ss.home)) || tildePath(cwd, ss.home)}</span>}
        <span className="ss-ck">{on && <CheckIcon />}</span>
      </button>
    );
  };
  return (
    <div className="ss-ctx" data-testid="session-context">
      {draft ? (
        <span className="ss-chip-w">
          <button
            type="button"
            className="ss-chip"
            title={rec.cwd || undefined}
            aria-label={`${t("sessions.folder")}: ${name}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={!rec.cwd}
            onClick={() => setOpen((v) => !v)}
            data-testid="session-folder"
          >
            <FolderIcon />
            <span className="ss-chip-n">{name}</span>
            <ChevronDown />
          </button>
          <Popover open={open} onClose={() => setOpen(false)} side="top" align="left" width={280} label={t("sessions.folder")} className="ss-dpop">
            <div data-testid="session-folder-menu">
              {recent.length > 0 && <div className="ss-h">{t("sessions.recent")}</div>}
              {recent.map((cwd) => row(cwd, folderName(cwd), "session-recent"))}
              {recent.length > 0 && <div className="ss-sep" />}
              <button type="button" className="ss-item" onClick={() => void choose()} data-testid="session-choose">
                <span className="ss-ic">
                  <FolderIcon />
                </span>
                <span className="ss-n">{t("sessions.choose")}</span>
              </button>
              {home && row(home, t("sessions.home"), "session-home", <HomeIcon />, false)}
            </div>
          </Popover>
        </span>
      ) : (
        <span className="ss-chip ro" title={rec.cwd} data-testid="session-folder">
          <FolderIcon />
          <span className="ss-chip-n">{name}</span>
        </span>
      )}
      {as && (
        <span className="ss-acct" data-testid="session-account">
          {as}
        </span>
      )}
      {!draft && <LiveFoot rec={rec} />}
    </div>
  );
}

const BranchIcon = () => <Icon name="git-branch" />;

/** The pull request the chat opened itself (item 100, code/chatPull.ts), after the agent on the header's second line: pressed, it
 *  opens in Tasks › Pull requests. Nothing when the chat opened none. */
export function ChatPullView({ pull, onOpen }: { pull: ChatPull | null; onOpen: (p: ChatPull) => void }) {
  if (!pull) return null;
  return (
    <>
      {" · "}
      <button type="button" className="lk ss-head-pr" title={t("lane.prTip")} onClick={() => onOpen(pull)} data-testid="session-pull" data-state={pull.state}>
        {t("lane.pr", { n: pull.number, state: t(`tasks.st.${pull.state}` as Key) })}
      </button>
    </>
  );
}

function ChatPullLink({ chatKey }: { chatKey: string | null | undefined }) {
  useChatPullsVersion();
  usePullsVersion();
  return <ChatPullView pull={chatPullOf(chatKey)} onOpen={(p) => showBoardPull(p.source, p.repo, p.number) && getStore().actions.openTasks()} />;
}

/** The rest of the line under a running chat: the folder's git branch (none outside a repository) and how full the
 *  context is, both as the shell and the agent reported them. */
function LiveFoot({ rec }: { rec: SessionRec }) {
  const live = useSessions().live[rec.id];
  const u = usageText(live?.usage);
  return (
    <>
      {live?.branch ? (
        <span className="ss-branch" title={t("ctl.branch")} data-testid="session-branch">
          <BranchIcon />
          <span className="ss-branch-n">{live.branch}</span>
        </span>
      ) : null}
      {/* Rewind to before a turn: the files and the chat go back together (rewind.ts) */}
      <RewindButton rec={rec} />
      {u && (
        <span className="ss-usage" title={t("ctl.contextTip", { agent: agentDef(rec.agent).label })} data-testid="session-usage" data-pct={u.pct}>
          <span className="ss-ring" style={{ ["--p" as string]: `${u.pct}%` }} aria-hidden="true" />
          {u.text}
        </span>
      )}
    </>
  );
}

/** The session's approval level in the chat box (item 80): the agent's own preset, a quiet label in the composer row
 *  whose menu lists the modes manut offers for the agent (never one that skips approvals or lifts the sandbox), and
 *  under them Kit's dial for the session's project, the same setting as the Code page's (code/KitPanel.tsx). An agent
 *  with no presets shows the dial's level. */
function SessionApproval({ rec }: { rec: SessionRec }) {
  const ss = useSessions();
  const live = rec.status === "running";
  const cur = ss.live[rec.id]?.mode ?? rec.mode;
  const modes = modesOf(rec.agent);
  // the agent's own setting, when it asks for nothing or reaches the whole disk: said where the mode is
  const own = ownSetting({ ...ss.live[rec.id], mode: cur });
  const project = useKitProject(rec.cwd);
  // a workflow's lane asks before every change, whatever the project's dial says (sessions.ts `kitAsk`): its box says that level
  // and why, and offers no dial, since the project's would not reach it
  const careful = !!rec.workflow;
  // a helper lane runs in its agent's Ask mode, set by the job: its box says so and offers no other (item 102h, rule R3)
  const helper = !!rec.helperOf;
  return (
    <ApprovalMenu
      modes={helper ? [] : modes}
      current={cur}
      own={own ? { words: own, from: t("ctl.own.from", { agent: agentDef(rec.agent).label }) } : null}
      live={!helper && (live || !modes.length)}
      onPick={(m) => void getSessions().setMode(rec.id, m)}
      label={helper ? t("helpers.run.modeSet") : t(`kit.level.${careful ? DEFAULT_KIT_LEVEL : project.level}`)}
      foot={rec.agent === "codex" ? t("ctl.modeFoot") : undefined}
      testId={modes.length ? "session-mode" : "session-approval"}
      extra={
        careful ? (
          <div className="bx-dial" role="group" aria-label={t("kit.dial")} data-testid="kit-box-careful">
            <div className="ss-h ss-h-plain bx-dial-h">{`${t("kit.dial")} · ${t(`kit.level.${DEFAULT_KIT_LEVEL}`)}`}</div>
            <p className="bx-dial-line">{t("wf.lane.careful", { name: rec.workflow ?? "" })}</p>
          </div>
        ) : (
        <DialRows
          title={`${t("kit.dial")} · ${projectName(rec.cwd)}`}
          levels={KIT_LEVELS}
          level={project.level}
          label={(l) => t(`kit.level.${l}`)}
          line={t(`kit.line.${project.level}`)}
          note={t("kit.live")}
          onLevel={(l) => updateKitProjects((x) => setLevel(x, rec.cwd, l))}
          testId="kit-box-level"
        />
        )
      }
    />
  );
}

/** A New session: the chat before its agent runs. */
function DraftPane({ rec }: { rec: SessionRec }) {
  const ss = useSessions();
  const accounts = useAccounts();
  const way = draftOpen(rec.agent, ss.agents, ss.opens);
  const mode = sessionMode(ss.agents, { agent: rec.agent, open: way });
  const terminal = mode === "terminal";
  // until the look-up answers, the agent counts as there (a flash of "not found" would be wrong more often)
  const installed = ss.agents === null || !!ss.agents.find((a) => a.id === rec.agent)?.path;
  const account = sessionAccountSuffix(accounts.groups, rec.agent);
  const ready = installed && !!rec.cwd;
  const folder = rec.cwd ? folderName(rec.cwd) : "";
  // the session chat's own key: unsent text is kept under it (the resume snapshot saves it) and is still there
  // in the chat once it starts
  const key = `agent:${rec.id}`;
  const label = agentLabel(rec.agent, ss.agents);
  const bot: Bot = { name: key, display_name: label, is_default: false, model: "", provider: "", description: "", status: "online", running: false };
  const start = (text?: string) => void getSessions().start(rec.id, text, account || undefined);
  /** The first message with files: they are saved before the agent starts; a file that cannot be keeps the draft
   *  (and the chips) as they were. */
  const startWithFiles = async (text: string, files: OutFile[]) => {
    await getSessions().start(rec.id, text, account || undefined, files);
  };
  // the composer takes the focus once it can be typed in (the folder or the agent list may arrive after it shows)
  const live = ready && !terminal;
  // a chat made by Continue with waits while the chat it continues works in their lane (item 97)
  const laneWait = useLaneWait(rec);
  useEffect(() => {
    if (live) document.querySelector<HTMLTextAreaElement>(`[data-pane="${key}"] [data-testid=composer]`)?.focus();
  }, [live, key]);
  return (
    <div className="pane ss-chat ss-draft" data-pane={key} data-testid="session-chat" data-draft="true">
      <div className="thread" data-testid="timeline">
        <div className="day" data-testid="draft-note">
          {!rec.cwd
            ? t("sessions.findingHome")
            : !installed
              ? missingNote(rec.agent)
              : t(terminal ? "sessions.firstStart" : "sessions.firstSend", { agent: label, folder })}
        </div>
      </div>
      <OwnApprovals agent={rec.agent} />
      <ContinueLines rec={rec} />
      <Composer
        key={key}
        waitNote={laneWait}
        bot={bot}
        running={false}
        offline={!ready || terminal}
        offlineText={!ready ? (!rec.cwd ? t("sessions.findingHome") : missingNote(rec.agent)) : t("sessions.pressStart", { agent: label })}
        onSend={(text) => start(text)}
        onSendFiles={mode === "chat" ? startWithFiles : undefined}
        onFolder={mode === "chat" && rec.cwd ? () => getSessions().pickFolder(rec.cwd) : undefined}
        onStop={() => undefined}
        heldNote={terminal && !!rec.cwd ? t("ss.open.withheld") : undefined}
        tools={
          <>
            <AgentFixed agent={rec.agent} />
            <OpenPick rec={rec} way={way} />
          </>
        }
        action={
          terminal ? (
            <button type="button" className="ss-go" disabled={!ready} onClick={() => start()} data-testid="session-go">
              {t("sessions.start")}
              <ArrowUp />
            </button>
          ) : undefined
        }
        foot={<Context rec={rec} account={account} />}
        scope={chatScope(key, null, rec, accounts.groups)}
      />
    </div>
  );
}

const isEnded = (rec: SessionRec) => rec.status === "exited" || rec.status === "failed";

/** Restart's (and Resume's) tooltip: whether the agent continues this conversation or starts a new one. */
function againTip(rec: SessionRec): string {
  const agent = agentDef(rec.agent).label;
  return continues(rec.agent) && rec.agentSession ? tr("ss.restartContinue", { agent }) : tr("ss.restartFolder", { agent });
}

/** An ended session (chat or terminal): one quiet line, and Restart, which starts its agent again in the same folder
 *  and account (and, when its CLI could not continue its conversation, a new conversation instead). A session of an agent manut no longer offers (Kilo Code) says only that, with no Restart. */
function Ended({ rec }: { rec: SessionRec }) {
  if (isGone(rec.agent))
    return (
      <div className="ss-ended" role="status" data-testid="session-ended">
        <span className="ss-ended-t" data-testid="session-gone">
          {tr("ss.gone", { agent: GONE[rec.agent] })}
        </span>
      </div>
    );
  const why = rec.error ? rec.error.trim().split("\n").pop() : "";
  // an agent that is not signed in: its line says what to run (the command as inline code), and the person's own
  // terminal opens in the folder
  const signin = useSessions().live[rec.id]?.signin;
  return (
    <div className="ss-ended" role="status" data-testid="session-ended">
      <span className="ss-ended-t" title={why || undefined}>
        {signin ? tx("ss.signedOut", { agent: agentDef(rec.agent).label, cmd: <code>{signin}</code> }) : rec.status === "failed" ? tr("ss.couldNotStart") : tr("ss.ended")}
        {!signin && why ? ` · ${why}` : ""}
      </span>
      {signin && rec.cwd && (
        <button type="button" className="ss-restart" onClick={() => void getSessions().openTerminal(rec.id)} data-testid="session-signin-terminal">
          {tr("ss.menu.terminal")}
        </button>
      )}
      <button type="button" className="ss-restart" onClick={() => void getSessions().restart(rec.id)} title={againTip(rec)} data-testid="session-restart">
        {tr("ss.restart")}
      </button>
      {/* its CLI could not continue the conversation: a way out when the conversation itself is gone */}
      {rec.resumeFailed && (
        <button
          type="button"
          className="ss-restart"
          onClick={() => void getSessions().startFresh(rec.id)}
          title={tr("ss.restartFolder", { agent: agentDef(rec.agent).label })}
          data-testid="session-fresh"
        >
          {tr("ss.freshConversation")}
        </button>
      )}
    </div>
  );
}

/** A session that was running when manut restarted and does not continue by itself: one line and Resume, which
 *  starts it again in the same folder (and account). */
function Paused({ rec }: { rec: SessionRec }) {
  // why it did not come back by itself (an oh-my-hermes chat the bridge would not attach again), when known
  const why = rec.error ? rec.error.trim().split("\n").pop() : "";
  return (
    <div className="ss-ended" role="status" data-testid="session-paused">
      <span className="ss-ended-t" title={why || undefined}>
        {t("resume.paused")}
        {why ? ` · ${why}` : ""}
      </span>
      <button
        type="button"
        className="ss-restart"
        onClick={() => void getSessions().resume(rec.id)}
        title={againTip(rec)}
        data-testid="session-resume"
      >
        {t("resume.resume")}
      </button>
    </div>
  );
}

/** What a paused terminal showed before manut restarted, read-only (dimmed, under its divider); nothing starts. */
function PausedHistory({ rec }: { rec: SessionRec }) {
  const s = useStore();
  const mode = useResolvedTheme(s.ui.theme);
  const box = useRef<HTMLDivElement>(null);
  const [has, setHas] = useState(true);
  useEffect(() => {
    if (!box.current) return;
    return getSessions().previewHistory(rec.id, box.current, mode, setHas);
  }, [rec.id, mode]);
  // with nothing kept it is the same empty space the paused line always had above it
  return (
    <div className={has ? "term-wrap" : "chat-empty"} data-testid="session-paused-history">
      <div className="term-box" ref={box} hidden={!has} />
    </div>
  );
}

/** A restored terminal session that is not running: no terminal is started until the person asks (Resume, or
 *  Restart once it has ended). A paused one shows what it showed before the restart. */
function TerminalIdle({ rec }: { rec: SessionRec }) {
  const label = agentDef(rec.agent).label;
  return (
    <div className="pane ss-chat ss-idle" data-testid="session-idle">
      {rec.paused ? <PausedHistory rec={rec} /> : <div className="chat-empty">{tr("ss.agentEnded", { agent: label })}</div>}
      {rec.paused ? <Paused rec={rec} /> : <Ended rec={rec} />}
      {/* a bot's request waits here too: Deny, or Resume and send (termShare.ts) */}
      <TermShareCards sessionId={rec.id} title={pickTitle(rec, termFallbackName(rec, getSessions().getState().agents)).title} />
    </div>
  );
}

/** One TERMINALS session in a split pane: its terminal (with the Ended line once it ended), or what a paused or
 *  ended session without a terminal shows (Resume, Restart). */
function SplitPane({ rec }: { rec: SessionRec }) {
  const ended = isEnded(rec);
  if (rec.paused || (ended && !getSessions().hasTerm(rec.id))) return <TerminalIdle rec={rec} />;
  return (
    <>
      <TerminalPane key={`${rec.id}-term-${getSessions().termRun(rec.id)}`} rec={rec} splits />
      {ended && <Ended rec={rec} />}
    </>
  );
}

export { groupModels } from "../chat/box/ModelMenu";

/** The session's model in the chat box (item 80): the shared model menu (chat/box/ModelMenu.tsx) with what the agent
 *  itself offers and its own reasoning levels, on the effort card (item 132). A pick made while a turn runs waits for the
 *  next turn, which says so. */
function SessionModel({ rec, options, note }: { rec: SessionRec; options: ModelOption[] | undefined; note: string | undefined }) {
  const agentLive = useSessions().live[rec.id];
  const efforts = agentLive?.efforts ?? [];
  const effort = agentLive?.effort ?? rec.effort ?? "";
  const live = rec.status === "running";
  const label = agentDef(rec.agent).label;
  const vendor = rec.agent === "codex" ? "openai" : rec.agent;
  const isOn = (o: ModelOption) => (rec.modelNext ? o.label === rec.modelNext || o.id === rec.modelNext : o.label === rec.model || o.id === rec.model);
  return (
    <ModelMenu
      label={rec.model || ""}
      mark={{ model: rec.model || label, provider: vendor }}
      live={live}
      options={options}
      isOn={isOn}
      onPick={(o) => getSessions().setModel(rec.id, o)}
      canPick={live}
      efforts={efforts}
      effort={effort}
      onEffort={(v) => getSessions().setEffort(rec.id, v)}
      // the effort card's one-click Ultrathink row is Claude Code's keyword, so only its chats offer it (item 132)
      ultrathink={rec.agent === "claude"}
      empty={live ? tr("ss.loadingModels") : tr("ss.agentNotRunning", { agent: label })}
      badge={
        // a pick made while a turn ran: the agent takes it from the next turn, whose start confirms it
        rec.modelNext ? (
          <span className="mp-next" title={tr("ss.modelNextTip", { model: rec.model ?? "" })} data-testid="model-next">
            {tr("ss.modelNext", { model: rec.modelNext })}
          </span>
        ) : undefined
      }
      notes={
        <>
          {rec.modelNext && !note && (
            <div className="mp-note" role="status" data-testid="model-next-note">
              {tr("ss.modelNextTip", { model: rec.model ?? "" })}
            </div>
          )}
          {note && (
            <div className="mp-note" role="status" title={note} data-testid="model-note">
              {note}
            </div>
          )}
        </>
      }
      foot={tr("ss.applies")}
    />
  );
}

export function SessionView() {
  const s = useStore();
  const ss = useSessions();
  const sp = useSplit();
  const rec = ss.list.find((r) => r.id === s.ui.session) ?? null;
  // looking at a session sees what its row carried for the person (it rang, it finished): at once when it is opened,
  // and when the window comes back to it
  const shown = rec?.id ?? null;
  const unseen = shown ? ss.unseen[shown] : undefined;
  useEffect(() => {
    if (!shown) return;
    const see = () => {
      if (windowWatched()) getSessions().seen(shown);
    };
    see();
    window.addEventListener("focus", see);
    document.addEventListener("visibilitychange", see);
    return () => {
      window.removeEventListener("focus", see);
      document.removeEventListener("visibilitychange", see);
    };
  }, [shown, unseen]);
  // The palette's Open this session in <editor>: the session's own folder (a lane's when it has one), through the store's host
  const editable = rec?.cwd ? shown : null;
  const editorAction = useMemo(() => (editable ? { open: () => void getSessions().openInEditor(editable) } : null), [editable]);
  usePlace("editorSession", editorAction);
  if (!rec) {
    return (
      <div className="chat-empty" data-testid="session-gone">
        {tr("ss.closed")}
      </div>
    );
  }
  if (rec.status === "draft") {
    return (
      <>
        <header className="head" data-testid="header">
          <span className="ss-head-mark">
            <AgentMark agent={rec.agent} size={18} />
          </span>
          <span className="head-title" data-testid="session-title">
            {t("sessions.new")}
          </span>
        </header>
        <DraftPane key={rec.id} rec={rec} />
      </>
    );
  }
  const name = pickTitle(rec, folderName(rec.cwd)).title;
  const chatKey = getSessions().chatKey(rec.id);
  // a session opened as a terminal is one whatever its agent usually does: it has no chat, no model and no toggle
  const mode = sessionMode(ss.agents, rec);
  // a terminal names the CLI in its foreground (a Shell where `claude` runs reads Claude Code)
  const label = mode === "terminal" && rec.fgAgent ? fgName(rec.fgAgent) : agentLabel(rec.agent, ss.agents);
  // DeepSeek Harness ships no terminal profile: a DSH chat has no Terminal view (and its model is set in its own app).
  // A Hermes chat without oh-my-hermes has none either: that view starts `omh`, which is not there.
  const noTerminal = rec.agent === "dsh" || (rec.agent === "omh" && hermesOnly(ss.agents));
  const canToggle = mode !== "terminal" && !noTerminal;
  // the header's right side (model, panel) shows for every chat; only the Terminal toggle depends on canToggle
  const showRight = mode !== "terminal" && (canToggle || rec.agent === "omh");
  // a session with no terminal view is its chat (one saved in its terminal while `omh` was still there included)
  const showChat = (rec.view === "chat" || noTerminal) && !!chatKey;
  const c = chatKey ? s.chats[chatKey] : undefined;
  const turn = !!c?.turn;
  // an approval or question of this chat is still open (the Needs-you model: answered, expired or its turn over closes it)
  const needs = !!chatKey && selectAsks(s).some((a) => a.bot === chatKey);
  // What the agent says is left in the background. Its count can hold a command, which has no row, so nothing is
  // guessed about which task waits: the header says "waiting" only when the background subagents manut has rows
  // for are as many as the agent counts and each one's approval or question is open. Otherwise "running".
  const bg = showChat ? (rec.background ?? 0) : 0;
  const bgSubs = (c?.items ?? []).flatMap((i) =>
    i.kind === "activity"
      ? (i.turn.fanouts ?? [])
          .flatMap((f) => f.subs)
          // a background subagent: still out though its turn is over, or though the call that started it has
          // returned (Claude Code's Agent call returns at once for one it runs in the background)
          .filter((x) => !subagentEnded(x) && (i.turn.endedAt !== undefined || i.turn.steps.some((st) => st.id === x.id && st.endedAt !== undefined)))
      : [],
  );
  const asked = waitingSubs(c?.items);
  const bgWaits = bg > 0 && COUNTS_BACKGROUND_SUBAGENTS.includes(rec.agent) && bgSubs.length === bg && bgSubs.every((x) => asked.has(x.id));
  const bgText = tr(bgWaits ? (bg === 1 ? "ss.backgroundWaiting1" : "ss.backgroundWaitingN") : bg === 1 ? "ss.background1" : "ss.backgroundN", { n: bg });
  const status = rec.paused
    ? t("resume.pausedShort")
    : rec.view === "terminal" && canToggle
      ? tr("ss.terminalView")
      : rec.status === "exited" && rec.exitCode
        ? tr("ss.endedExit", { code: rec.exitCode })
        : rec.status === "running" && showChat
          ? needs
            ? tr("ss.needsYou")
            : turn
              ? tr("ss.working")
              : tr("ss.ready")
          : STATUS[rec.status]
            ? tr(STATUS[rec.status])
            : rec.status;
  return (
    <>
      <header className="head" data-testid="header">
        <span className="ss-head-mark">
          {mode === "terminal" ? <TermRowMark agent={termMarkAgent(rec)} size={18} /> : <AgentMark agent={rec.agent} size={18} />}
        </span>
        {/* two boxes that are not there on a wide header (display: contents): on a narrow one with background work
            they let the status, the label and its Stop go under the name (sessions.css) */}
        <span className={`ss-head-id${bg ? " bg" : ""}`}>
          <span className="head-title" data-testid="session-title" title={name}>
            {name}
          </span>
          {/* the same order as the row's second line: where, then which agent */}
          <span className="ss-head-path" title={rec.cwd}>
            <span data-testid="session-cwd">{tildePath(rec.cwd, ss.home)}</span>
            {" · "}
            <span data-testid="session-agent">{label}</span>
            <ChatPullLink chatKey={chatKey} />
          </span>
          <span className="ss-head-now">
            <span
              className={`ss-head-st ${rec.view === "terminal" && canToggle ? "mode" : rec.status}${mode === "terminal" ? " term" : ""}${showChat && !turn ? " idle" : ""}${showChat && needs ? " needs" : ""}`}
              title={status}
              data-testid="session-status"
            >
              {status}
            </span>
            {bg > 0 && (
              <>
                <span className="ss-head-bg" data-testid="session-background" title={bgText}>
                  {bgText}
                </span>
                {/* the same in fewer words, shown in its place when the line is tight */}
                <span className="ss-head-bg short" data-testid="session-background-short" title={bgText}>
                  {tr(bgWaits ? "ss.backgroundWaitingShort" : "ss.backgroundShort", { n: bg })}
                </span>
              </>
            )}
            {/* no turn runs, so the composer offers Send: the background work's own Stop sits beside the words that
                say it is there, and sends the agent's own interrupt (Esc keeps stopping a running turn only) */}
            {bg > 0 && !turn && rec.status === "running" && STOPS_BACKGROUND.includes(rec.agent) && (
              <button
                type="button"
                className="ss-head-stop"
                title={tr(bgWaits ? "ss.stopBackgroundWaiting" : "ss.stopBackground")}
                onClick={() => void getSessions().interrupt(rec.id)}
                data-testid="session-background-stop"
              >
                {tr("ss.stopBackgroundShort")}
              </button>
            )}
          </span>
        </span>
        {showRight && (
          <div className="head-right ss-head-right" data-testid="head-right">
            {canToggle && (
              <button
                type="button"
                className={`ss-toggle${rec.view === "terminal" ? " on" : ""}`}
                aria-pressed={rec.view === "terminal"}
                aria-label={rec.view === "terminal" ? tr("ss.backToChat") : tr("ss.openTerminal")}
                title={rec.view === "terminal" ? tr("ss.backToChat") : tr("ss.openTerminal")}
                aria-description={rec.view === "terminal" ? undefined : terminalNote(rec.agent)}
                onClick={() => void getSessions().setView(rec.id, rec.view === "terminal" ? "chat" : "terminal")}
                data-testid="session-terminal-toggle"
              >
                {rec.view === "terminal" ? <ChatIcon /> : <TerminalIcon />}
              </button>
            )}
            {showChat && <PanelToggle working={workingSubagents(c)} />}
          </div>
        )}
      </header>
      {mode === "terminal" && !showChat && groupOf(sp.groups, rec.id) ? (
        // a TERMINALS session in a split: every pane shows, each as its session is (running, paused, ended)
        <SplitView main={rec} pane={(r) => <SplitPane rec={r} />} />
      ) : showChat ? (
        // a coding session that runs as a chat is a lane (code/Lanes.tsx lists them): its chat has the pane beside it
        isLaneChat(chatKey) ? <LaneSplit rec={rec} chatKey={chatKey} chat={c} /> : <ChatPane rec={rec} chatKey={chatKey!} />
      ) : rec.paused || ((rec.status === "exited" || rec.status === "failed") && !getSessions().hasTerm(rec.id)) ? (
        <TerminalIdle rec={rec} />
      ) : rec.view === "chat" && mode !== "terminal" ? (
        // a Hermes folder chat between its first message and the bridge's chat id: not a reason to start a terminal
        <div className="pane ss-chat" data-testid="session-chat">
          <div className="thread" data-testid="timeline">
            <div className="day">{rec.status === "failed" ? (rec.error ? tr("ss.couldNotStartWhy", { agent: label, error: rec.error }) : tr("ss.agentCouldNotStart", { agent: label })) : tr("ss.startingAgent", { agent: label })}</div>
          </div>
        </div>
      ) : (
        <>
          {/* a new key after Restart: a fresh terminal for the program started again. A TERMINALS session can split
              (once split, the branch above draws every pane) */}
          {mode === "terminal" ? (
            <TerminalPane key={`${rec.id}-term-${getSessions().termRun(rec.id)}`} rec={rec} splits />
          ) : (
            <TerminalPane key={`${rec.id}-term-${getSessions().termRun(rec.id)}`} rec={rec} />
          )}
          {!canToggle && isEnded(rec) && <Ended rec={rec} />}
        </>
      )}
    </>
  );
}
