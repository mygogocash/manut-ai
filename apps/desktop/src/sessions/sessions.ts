// SESSIONS: the agent sessions manut started in this run of the app. Each one is an allow-listed agent
// (claude, codex, omo, dsh, omh, pi, omp, grok) in a folder the person picked. Most open as a chat: Claude Code,
// Codex, OmO, pi and oh-my-pi run in their structured mode in the desktop shell (src-tauri/src/agent_chat.rs),
// oh-my-hermes opens a Hermes chat in that folder through the bridge (`folder.open`). Their events land in
// the app store under the session's own chat key, so the bot chat's timeline, activity line, cards and
// composer draw them. DSH (DeepSeek Harness) is a chat too, one headless run per message continuing the harness's
// own session (`--session-id`); it has no terminal view. Grok has no chat mode here, so it stays a terminal (xterm on
// a pseudo-terminal). Every other chat can switch to its agent's terminal view.
//
// SESSIONS + opens a small menu of the agents; picking one opens a New session chat on it at once (a draft), its
// folder in the chip under the composer (the last folder used, else home). Nothing starts until the first message, which becomes the
// agent's first prompt (a terminal agent starts on Start and is sent nothing); then agent and folder are fixed.
// Closing a draft starts nothing.
//
// A session's program lives only while the app runs. The list itself comes back after a restart (resume.ts saves
// it): a Claude Code or Codex chat that was running continues its conversation in the same folder and account,
// the others come back paused with a Resume button, ended ones stay ended, and a draft comes back as a draft
// (never started). The last few folders (with the agent that used each) are remembered on this computer.
//
// Files the person attaches (paste, the + menu, a drop) are saved by the shell under manut's own folder, one per
// session (`~/.manut/session-files/<id>/`, removed when the session is closed). A picture goes to the agent as its
// own image input (Claude Code and OmO / pi inline, Codex by the saved path); any other file is named in the
// message by its saved copy's path. An oh-my-hermes session takes no files: the bridge attaches files to a bot's
// main chat only.
import { useSyncExternalStore } from "react";
import type { ITerminalInitOnlyOptions, ITerminalOptions, Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { afterOpen, bracketedPaste, CELLS_EVENT, feed, gpuComing, isParked, live, onVisible, PARKING_EVENT } from "./term/engine";
import { TERM_INPUT_EVENT } from "./term/paste-guard";
import { onCwd, onProgress } from "./term/engine-marks";
import { applyLook, termOptions } from "./term/look";
import { termFontsReady } from "./term/fonts";
import { onTermSettings, readTermSettings } from "./term/settings";
import { forgetHistory, pruneHistory, restoredText, trackHistory, watchHistorySetting } from "./term/history";
import { savedPanelKeys } from "../terminal/state";
import { termTheme } from "./term/themes";
import { getShellHost, learnThisHost } from "../terminal/host";
import { onSessionFg } from "./fg";
import { termActs } from "./termActivity";
import { isLinkId, LINK_COPIED_EVENT, newLinkId, termLinkUrl } from "./termLink";
import { acpRow, agentDef, agentLabel, continues, draftAgent, draftFolder, draftOpen, hermesOnly, idInUse, installLine, isBuiltin, isGone, isShell, isTerminalRec, LAST_LINE_MAX, refusedResume, SHELL, termEnd, termMarkAgent, lastPrintedLine, OPEN_KEY, setsUpScreen, UI_BYTES, opensAs, pushRecent, savedOpen, RECENT_KEY, registerAcp, sessionMode, folderName, type AgentId, type OpenAs, type Unseen, type SessionRec } from "./agents";
import { clearSuggestion, noteSuggestion } from "../chat/suggestion";
import { suggestOn, suggestWorks } from "../lib/suggest";
import { acceptTitle, chatMaterial, titleRequest, wantsTitle, whyKey } from "./titleWords";
import { titleModel } from "../lib/titleModel";
import { NAME_MAX, pickTitle, promptTitle, putTitle, TITLES_KEY } from "./titles";
import { getDraft, setDraft as setUnsent } from "../app/drafts";
import { getHost, type ChatEvent, type ChatInput, type ConvState, type PastChat, type SessionHost } from "./host";
import { localBot } from "../peers/peerKey";
import { askOpen, folderKey, getStore, notifySessionEvent, notifySessionNote, onBridgeEvent, selectAsks, setChatRoute, setSessionKeyLookup, type ApprovalItem, type OutFile, type SentFile, type Store } from "../state/store";
import { blobType, bytesOf, inlinePicture, pathsTyped, putSentFiles, SENT_FILES_KEY, shellQuote, wireText, type SavedFile, type SentFilesBook } from "./attach";
import type { AccountGroup, ApprovalChoice, BridgeEvent, ClarifyAnswers, DiffFile, EventOf, Msg } from "../lib/protocol";
import { settleApproval } from "../chat/cards/respond";
import { afterBranchRead, beforeBranchRead, kitAnswer, noteChange, savesAlone } from "../code/kitAsks";
import { readSaved, SAVED_READ_MS } from "../code/secrets";
import { planLaneBranch, workDir, type LaneBranch } from "../code/laneBranch";
import { openFolderInEditor } from "../code/editor";
import { startOf, worktreeSettings } from "../lib/worktrees";
import { forgetLane, keptLanesChanged, noteLaneEvent } from "../code/laneStore";
import { forgetChatPull, noteChatPull } from "../code/chatPull";
import { taskHost, type TaskHost } from "../tasks/host";
import { forgetPreview } from "../code/previewStore";
import { continuesItself, type SavedSession } from "../app/resume";
import { accountGroups } from "../settings/accounts/useAccounts";
import { ASK_MODE, modesOf, steersOf } from "./controls";
import { askRefusal, type AskPick, type AskRefusal } from "../jobs/ask";
import { noteChoices } from "../jobs/choices";
import { followUp as savedFollowUp, type FollowUp } from "../chat/box/keys";
import { draftFolders } from "../app/stash";
import { bareText, carry, type Scope } from "../chat/box/carry";
import { busyMate, continuedDraft, laneFree, type ContinuePick } from "./continueWith";
import { parseCommands, type AgentCommand } from "../chat/parts/commands";
import { noteMcpSeen } from "../settings/mcp/agentConfig";
import { t as tr, type Key } from "../i18n";
import { recordError } from "../report/errors";
import { notesSaid } from "./projectNotes";
import { createLeadLanes } from "../jobs/leadLanes";
import { createHelperLandings } from "../jobs/helperLanding";
import { createHelperRuns, type StartHelper } from "../jobs/helperRuns";
import type { LaneMade } from "../code/laneBranch";
import { createReach, type OpenLane } from "../jobs/reachChats";
import { appReader } from "../chat/box/contextReader";
import { chatScope } from "../chat/box/scope";
import type { ThreadRef } from "../chat/box/threadContext";
import { windowWatched, type SessionNote } from "../lib/notify";
import { createCloseGrace, graceMs, restoreSplitIn, type SplitWas } from "./closeGrace";
import { watchOpenFolder } from "./revealOpen";
import { getSplit, groupOf, leaveIn, setSplit } from "./splitState";
import { folderGroups, getFolderPrefs, orderFolders, pathKey, ranElsewhere, revealFolder as openFolderGroup, setFolderGone } from "./folders";
import { broughtBackNote, REWINDS, rewoundNote, TurnBook, turnTitle } from "./rewind";
import { NO_RULES, signedOutSaid, errText } from "./sessionErrors";
import { ACCOUNT_CLI, accountFor, SAID_MAX, OUT_MARK_MS, RESIZE_SETTLE_MS, utf8, newConversationId, TERM_CONTINUES, TERM_REOPENS, termComesBack, CODEX_ID_FIRST_MS, CODEX_ID_EVERY_MS } from "./sessionPure";
export { ACCOUNT_CLI, accountFor, RESIZE_SETTLE_MS, newConversationId } from "./sessionPure";
import { readRecent, readSentFiles, readTitles, titleKey, TITLED, readOpens } from "./sessionBooks";
export { NO_RULES, signedOutSaid } from "./sessionErrors";
import type { ModelOption, SessionsState, AgentLive, Term, TermIo, ChatProc } from "./sessionTypes";
export type { ModelOption, SessionsState, AgentLive } from "./sessionTypes";

type Xterm = [typeof import("@xterm/xterm"), typeof import("@xterm/addon-fit")];
let xtermLoad: Promise<Xterm> | null = null;
let xtermMods: Xterm | null = null;
/** xterm (about 88 kB gz) loads when the first session opens, not with the app. */
const loadXterm = () =>
  (xtermLoad ??= Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css"), termFontsReady()]).then(
    ([x, f]) => (xtermMods = [x, f]),
  ));

/** The time and a repeating timer, as the sessions store reads them: helper lanes' budgets (item 102h) run on it, and a test passes a
 *  stand-in clock. */
export interface SessionClock {
  now(): number;
  every(ms: number, fn: () => void): () => void;
}
const realClock: SessionClock = {
  now: () => Date.now(),
  every: (ms, fn) => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  },
};

/** `pulls`: the Tasks host a chat's own pull request is read through (item 100, code/chatPull.ts); none reads nothing. `clock`: the
 *  time helper lanes' budgets count by (item 102h). */
export function createSessions(host: SessionHost, store: () => Store = getStore, accounts: () => AccountGroup[] | null = () => null, pulls: () => Pick<TaskHost, "remote" | "view"> | null = () => null, clock: SessionClock = realClock) {
  let state: SessionsState = { agents: null, home: null, list: [], recent: readRecent(), opens: readOpens(), models: {}, notes: {}, live: {}, unseen: {} };
  const listeners = new Set<() => void>();
  const terms = new Map<string, Term>();
  const procs = new Map<string, ChatProc>();
  /** app-store chat key per session id */
  const keys = new Map<string, string>();
  let seq = 0;
  let localSeq = 0;
  let resetDone: Promise<void> | null = null;
  let restored = false;
  /** The account a session starts with and its conversation is looked for in: the one it was made with or ran with
   *  (none = unknown: the shell uses the one picked for new sessions), so switching the account for new sessions
   *  does not start a kept conversation id in another account's home. */
  const accountOf = (r: SessionRec) => r.account;
  /** TERMINALS sessions put back after a restart whose agent continues its own conversation: their next start (once)
   *  continues it (`--resume`, `codex resume`) instead of starting a new one. */
  const termAgain = new Set<string>();
  /** TERMINALS sessions put back after a restart whose kept history goes into their terminal before their program's
   *  first output (once). */
  const histBack = new Set<string>();
  /** Each TERMINALS session's history keeping (term/history.ts). */
  const histOf = new Map<string, { touch: () => void; stop: () => void; flush: () => void }>();
  watchHistorySetting(host);
  /** drafts whose agent / folder the person picked: a late agent or home look-up no longer moves them */
  const picked = new Map<string, { agent?: boolean; cwd?: boolean }>();
  let notify: ((ev: BridgeEvent) => void) | null = null;
  let notifyState: ((id: string, n: SessionNote) => void) | null = null;

  const set = (patch: Partial<SessionsState>) => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };
  const rec = (id: string) => state.list.find((s) => s.id === id);
  /** Helper requests of lead lanes (item 102e, src/jobs/leadLanes.ts): the Helpers switch, the lead's note in front of each message
   *  while it is on, and the Start helpers card a turn's answer can ask for. It starts no agent. */
  const leads = createLeadLanes({
    rec,
    chatKey: (id) => keys.get(id),
    store: () => store(),
    agents: () => state.agents,
    models: (id) => state.models[id] ?? [],
    efforts: (id) => state.live[id]?.efforts ?? [],
  });
  /** Chats that reach other chats (item 102k, src/jobs/reachChats.ts): the "Kit may reach" list under a chat's box, the note naming it
   *  in front of each message, and the read, send and open cards a turn's answer can ask for. Nothing of another chat moves but from
   *  a card's press; a message into another chat goes through `route`, which sends text and nothing else. */
  const reach = createReach({
    rec,
    chatKey: (id) => keys.get(id),
    store: () => store(),
    agents: () => state.agents,
    models: (id) => state.models[id] ?? [],
    efforts: (id) => state.live[id]?.efforts ?? [],
    reader: () =>
      appReader({
        store: store(),
        sessions: { getState: () => state, chatKey: (id: string | null) => (id ? (keys.get(id) ?? null) : null), byKey: (key: string) => byKey(key) },
        host,
        groups: accounts,
      }),
    setList: (id, list) => patchRec(id, { reach: list.length ? [...list] : undefined }),
    sendTo: (id, text) => send(id, text, "queue"),
    route: (id, text) => route(id, text),
    running: (id) => {
      const p = procs.get(id);
      return p?.kind === "agent" && p.hostId !== undefined && rec(id)?.status === "running";
    },
    openLane: (p) => startOpenedLane(p),
    laneScope: (agent) => chatScope("agent:", null, { agent: agent as AgentId, status: "draft" }, accounts()),
  });
  /** Helper lanes (item 102h, src/jobs/helperRuns.ts): each round the person approved with Start helpers starts its helper lanes as
   *  this Mac has room (`startHelperLane`), each in its agent's Ask mode, and runs their budgets, their Stop and their end. Nothing of
   *  it answers an ask: a helper's asks are its own cards. */
  const runs = createHelperRuns({
    rec,
    asks: (id) => {
      const key = keys.get(id);
      return key ? selectAsks(store().getState()).filter((a) => a.bot === key).map((a) => a.item.request_id) : [];
    },
    working: (id) => working(id),
    lastAnswer: (id) => {
      const key = keys.get(id);
      const items = key ? (store().getState().chats[key]?.items ?? []) : [];
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "assistant") return it.text;
      }
      return "";
    },
    title: (id) => {
      const r = rec(id);
      return r ? pickTitle(r, folderName(r.cwd)).title : "";
    },
    othersRunning: () => state.list.filter((r) => r.job && working(r.id)).length,
    rounds: (lead) => leads.roundsOf(lead),
    setRounds: (lead, r) => leads.setRounds(lead, r),
    memory: () => (host.machineMemory ? host.machineMemory() : Promise.resolve(null)),
    groups: () => accounts(),
    freshJob: () => `j${freshLinkId()}`,
    startLane: (p) => startHelperLane(p),
    interrupt: (id) => input(id, { kind: "interrupt" }),
    steer: (id, text) => input(id, { kind: "steer", id: `local-s${++localSeq}`, text }),
    send: (id, text) => send(id, text, "queue"),
    endIdle: (id) => stopIdle(id),
    note: (id, text) => {
      const key = keys.get(id);
      if (key) store().dispatch({ type: "system.note", bot: key, text, now: Date.now() });
    },
    now: () => clock.now(),
    every: (ms, fn) => clock.every(ms, fn),
  });
  leads.whenRoundApproved((r) => runs.approved(r));
  /** Landings and the hand-over (items 102i and 102j, src/jobs/helperLanding.ts): each helper lane that came back in its round has
   *  its work landed in its lead lane's folder by the shell, one at a time and only while the lead is idle, and once everything is
   *  settled the reports go to the lead in one message. Nothing of it answers an ask. */
  const landings = createHelperLandings({
    laneDir: (id) => {
      const lane = rec(id)?.lane;
      return lane?.worktree ?? lane?.dir ?? null;
    },
    working: (id) => working(id),
    asks: (id) => {
      const key = keys.get(id);
      return key ? selectAsks(store().getState()).filter((a) => a.bot === key).map((a) => a.item.request_id) : [];
    },
    personWaiting: (id) => {
      const key = keys.get(id);
      return !!(key && chatOf(key)?.queue?.length);
    },
    rounds: (lead) => leads.roundsOf(lead),
    setRounds: (lead, r) => leads.setRounds(lead, r),
    helperSessions: (lead) => state.list.filter((r) => r.helperOf?.lead === lead).map((r) => r.id),
    land: (dir) => (host.laneLand ? host.laneLand(dir) : Promise.reject(new Error("no_shell"))),
    takeBack: (dir) => (host.laneTakeBack ? host.laneTakeBack(dir) : Promise.reject(new Error("no_shell"))),
    send: (id, text) => sendFromApp(id, text),
    note: (id, text, detail) => {
      const key = keys.get(id);
      if (key) store().dispatch({ type: "system.note", bot: key, text, now: Date.now(), ...(detail ? { detail } : {}) });
    },
    words: () => ({ reported: tr("helpers.reported"), failed: tr("helpers.reportFailed"), showSent: tr("helpers.showSent"), showUnsent: tr("helpers.showUnsent") }),
    every: (ms, fn) => clock.every(ms, fn),
  });
  runs.whenBack((b) => landings.back(b));
  /** The session whose chat has app-store key `key`. */
  const byKey = (key: string) => {
    for (const [id, k] of keys) if (k === key) return rec(id) ?? null;
    return null;
  };
  /** A link id no session in the list holds (termLink.ts). */
  const freshLinkId = (taken: ReadonlySet<string> = new Set(state.list.map((r) => r.linkId).filter((x): x is string => !!x))): string => {
    for (;;) {
      const id = newLinkId();
      if (!taken.has(id)) return id;
    }
  };

  // ---- what a session did while the person looked elsewhere --------------------------------

  /** The person sees session `id` right now: the window has focus and shows it. */
  const watching = (id: string) => {
    const ui = store().getState().ui;
    return windowWatched() && ui.view === "session" && ui.session === id;
  };
  /** A helper lane's name in Needs you and its notifications (item 102h): "Helper 1 of Add the PromptPay QR (Codex)", so an ask of
   *  it is never read as its lead's or another lane's. Null for any other session. */
  const helperName = (r: SessionRec): string | null => {
    if (!r.helperOf) return null;
    const lead = rec(r.helperOf.lead);
    const title = lead ? pickTitle(lead, folderName(lead.cwd)).title : tr("ss.session");
    return tr("helpers.run.askName", { n: r.helperOf.index + 1, lead: title, agent: agentLabel(r.agent, state.agents) });
  };
  /** `web-app · Claude Code`, as its notifications and its Needs-you row name it. */
  const nameOf = (r: SessionRec) => helperName(r) ?? `${r.cwd.split(/[\\/]/).filter(Boolean).pop() ?? r.cwd} · ${agentLabel(r.agent, state.agents)}`;
  /** Session `id` did something the person did not see: its row carries it until they open the session. True when
   *  this is news (they are not watching, and the row does not say it already). */
  const flag = (id: string, what: Unseen): boolean => {
    if (!rec(id) || watching(id) || state.unseen[id] === what) return false;
    set({ unseen: { ...state.unseen, [id]: what } });
    return true;
  };
  /** The person opened session `id`: what its row carried for them is seen. */
  const seen = (id: string) => {
    if (!(id in state.unseen)) return;
    const unseen = { ...state.unseen };
    delete unseen[id];
    set({ unseen });
  };
  /** Session `id`'s program ended or could not start while the person was elsewhere: its row says so and a
   *  notification goes out. */
  const tellEnd = (id: string, kind: "ended" | "failed", detail: { code?: number | null; error?: string }, told = false) => {
    const r = rec(id);
    if (!r || watching(id)) return;
    flag(id, "end");
    // `told`: the turn that failed with it said the same reason (a notification only with "Also notify on errors");
    // `ms`: a program that ends within its first seconds did not really run
    notifyState?.(id, { kind, name: nameOf(r), ...detail, ms: Date.now() - r.startedAt, told });
  };
  const patchRec = (id: string, p: Partial<SessionRec>) => {
    if (p.error) recordError("session", p.error);
    set({ list: state.list.map((s) => (s.id === id ? { ...s, ...p } : s)) });
  };
  let titles = readTitles();
  const saveTitles = (next: Record<string, string>) => {
    titles = next;
    try {
      localStorage.setItem(TITLES_KEY, JSON.stringify(next));
    } catch {
      /* no storage */
    }
  };
  /** The agent's conversation id is known now: a name given before it was keeps under it, a saved one comes back. */
  const onAgentSession = (id: string) => {
    const r = rec(id);
    const k = r && titleKey(r);
    if (!r || !k) return;
    if (r.title && titles[k] !== r.title) saveTitles(putTitle(titles, k, r.title));
    else if (!r.title && titles[k]) patchRec(id, { title: titles[k] });
  };
  /** The title the agent wrote for this conversation in its own session files (Claude Code's title, a Codex thread
   *  name), read by the bridge. Quietly nothing when the bridge is older or the file is not there. */
  const readAgentTitle = async (id: string) => {
    const r = rec(id);
    if (!r?.agentSession || !TITLED.includes(r.agent)) return;
    try {
      // the agent keeps its conversation for the folder it ran in: a lane's own
      const res = await store().actions.cliTitle(r.agent as "claude" | "codex", r.agentSession, workDir(r));
      const t = typeof res?.title === "string" ? res.title.trim() : "";
      if (t && rec(id) && rec(id)!.agentTitle !== t) patchRec(id, { agentTitle: t });
    } catch {
      /* an older bridge, or no file yet */
    }
  };
  const patchLive = (id: string, p: Partial<AgentLive>) => set({ live: { ...state.live, [id]: { ...state.live[id], ...p } } });
  /** The branch of the folder the agent works in (a lane's own), read again when a turn ends (the agent may have switched it).
   *  Kit's dial reads a push that names no branch with none while a step that may have moved it has run since (item 120). */
  const readBranch = async (id: string) => {
    const r = rec(id);
    if (!r?.cwd) return;
    const key = keys.get(id) ?? "";
    const token = beforeBranchRead(key);
    try {
      const b = await host.branch(workDir(r));
      if (rec(id) && state.live[id]?.branch !== b) patchLive(id, { branch: b });
      afterBranchRead(key, token);
    } catch {
      /* an older shell */
    }
  };
  /** The branch checked out in `dir` as the disk says now, or undefined when it cannot be read in time (item 120). */
  const branchNow = async (dir: string): Promise<string | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((done) => (timer = setTimeout(() => done(undefined), SAVED_READ_MS)));
    try {
      return await Promise.race([host.branch(dir).catch(() => undefined), late]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
  /** A lane's own working folder (src/code/laneBranch.ts). As a chat session starts, Kit makes a branch of its own for it from
   *  the branch the developer's folder is on, checked out in a folder of its own (a git worktree under `~/.manut/lanes`), and
   *  the session's agent works there: several lanes work at once without touching each other's files, and the developer's
   *  folder (its branch, index, stash and HEAD) never changes because of a lane. Never fatal and never pushed: a lane with no
   *  folder (no repository, a shell older than lanes' folders, git refusing) works in the session's folder, and its row shows
   *  no branch. The chat says where the lane works and what did not come along. True when the lane has a folder of its own: a
   *  workflow's lane starts only then (item 91, `start`). */
  const startLane = async (id: string): Promise<boolean> => {
    const r = rec(id);
    if (!r?.cwd || !host.laneWorktree) return false;
    try {
      const current = await host.branch(r.cwd);
      const ws = worktreeSettings();
      const plan = planLaneBranch({ title: r.title || r.promptTitle || "", current, prefix: ws.prefix });
      if (plan.kind === "none") return false;
      // a workflow's lane made with nobody there is the app's own doing (item 114): the shell reads the repository's config first
      const made = await host.laneWorktree(r.cwd, plan.names, unattended.has(id) ? { ...startOf(ws), unattended: true } : startOf(ws));
      if (!rec(id)) {
        // closed while its folder was made: the folder goes as a close takes it (nothing is in it yet)
        void letLaneGo({ name: made.branch, base: made.base, dir: made.dir, worktree: made.worktree });
        return false;
      }
      patchRec(id, { lane: { name: made.branch, base: made.base, dir: made.dir, worktree: made.worktree } });
      const key = keys.get(id);
      if (key) {
        const said = [tr("lane.note.made", { branch: made.branch, base: made.base, folder: made.dir })];
        if (made.left > 0) said.push(made.left === 1 ? tr("lane.note.leftOne", { base: made.base }) : tr("lane.note.leftMany", { n: made.left, base: made.base }));
        // the one exception: the project's own agent settings git does not hold, kept out of git in the lane
        if (made.config > 0) said.push(made.config === 1 ? tr("lane.note.configOne") : tr("lane.note.configMany", { n: made.config }));
        if (made.stayed > 0) said.push(made.stayed === 1 ? tr("lane.note.stayedOne") : tr("lane.note.stayedMany", { n: made.stayed }));
        // where it started, said whenever the person asked for the remote: from it, or why from the local branch
        if (made.from) said.push(tr("lane.note.fromRemote", { remote: made.from }));
        else if (ws.remote && made.local) said.push(tr(`lane.note.local.${made.local}` as Key, { base: made.base }));
        said.push(tr("lane.note.install"));
        store().dispatch({ type: "system.note", bot: key, text: said.join(" "), now: Date.now() });
      }
      return true;
    } catch (e) {
      /* no folder of its own. A folder the person chose that cannot be used now is said: the lane then works in the session's
         folder, not where they asked, and nothing is made anywhere else. */
      const code = e instanceof Error ? e.message : String(e);
      // the repository's own config names a program or another address, and nobody is there (item 114): the run says which
      if (unattended.has(id) && code.startsWith("config:")) laneConfig.set(id, code.slice("config:".length));
      const key = keys.get(id);
      if (key && /^root_|^bad_root$/.test(code)) {
        store().dispatch({ type: "system.note", bot: key, text: `${tr("worktrees.root.chat")} ${tr(`worktrees.root.${code}` as Key)}`, now: Date.now() });
      }
      return false;
    }
  };

  /** A closed session's lane folder goes when nothing in it would be lost: the shell keeps it when git says a file in it is
   *  changed or new (the Code page then lists it with Remove, which asks first), and the branch always stays. */
  const letLaneGo = async (lane: LaneBranch | undefined) => {
    if (!lane?.worktree || !host.laneRemove) return;
    // Settings › Worktrees: off keeps every folder of a deleted chat, listed with the kept ones
    if (!worktreeSettings().cleanDeleted) return;
    try {
      // the shell's clean-up also leaves a folder whose branch has commits on no remote; an older shell only knows Remove
      if (host.laneRelease) await host.laneRelease(lane.worktree);
      else await host.laneRemove(lane.worktree, { changed: 0, branch: false, ahead: null });
    } catch {
      /* kept: the Code page lists it */
    } finally {
      keptLanesChanged();
    }
  };

  /** Where session `id`'s lane runs its tests (lane.ts): a run its words send to another folder is not the lane's. */
  const laneWhere = (id: string): { root: string; home: string | null } | undefined => {
    const r = rec(id);
    return r?.cwd ? { root: workDir(r), home: state.home } : undefined;
  };

  const note = (id: string, text: string | null) => {
    const notes = { ...state.notes };
    if (text) notes[id] = text;
    else delete notes[id];
    set({ notes });
  };

  const ready = () => (resetDone ??= host.reset().catch(() => undefined));

  const loadAgents = async () => {
    try {
      const [agents, home] = await Promise.all([host.agents(), state.home ? Promise.resolve(state.home) : host.home()]);
      // the generic ACP agents are rows the shell sends with the look-up: learn them before anything names one
      registerAcp(agents);
      set({ agents, home });
      refreshDrafts();
    } catch {
      set({ agents: state.agents ?? [] });
    }
  };

  /** Drafts the person has not set yet follow what is now known: the installed agents, the home folder. */
  const refreshDrafts = () => {
    for (const r of state.list) {
      // a workflow's lane is a draft only while it starts, on the agent and folder its file names
      if (r.status !== "draft" || r.workflow || r.job || r.helperOf || r.continuedFrom) continue;
      const p = picked.get(r.id) ?? {};
      const patch: Partial<SessionRec> = {};
      if (!p.agent) {
        const agent = draftAgent(state.recent, state.agents);
        if (agent !== r.agent) patch.agent = agent;
      }
      if (!p.cwd && !r.cwd) {
        const cwd = draftFolder(state.recent, state.home);
        if (cwd) patch.cwd = cwd;
      }
      if (Object.keys(patch).length) patchRec(r.id, patch);
    }
  };

  // ---- chat plumbing ------------------------------------------------------------------------

  /** Apply one event from a session's chat to the app store, under the session's chat key. `quiet`: an ask the app
   *  answers by itself as it arrives (Kit's dial), which no notification announces. */
  const dispatchChat = (id: string, ev: ChatEvent, quiet = false) => {
    const key = keys.get(id);
    if (!key) return;
    // the agent's predicted next message (item 76) is the composer's, not the timeline's: it is kept apart, and a new turn drops it
    if (ev.event === "suggestion") {
      noteSuggestion(key, typeof ev.text === "string" ? ev.text : "");
      return;
    }
    if (ev.event === "turn.start") clearSuggestion(key);
    const full = { ...ev, bot: key } as unknown as BridgeEvent;
    store().dispatch({ type: "event", ev: full, now: Date.now() });
    if (!quiet) notify?.(full);
  };

  /** What Kit's dial does with an ask from a coding session as it arrives (src/code/kitAsks.ts): when the project's
   *  level, a kept rule or the project's edge settles it, the answer to send through the ask's own card. */
  const kitAsk = (id: string, ev: ChatEvent): (() => Promise<unknown>) | null => {
    const key = keys.get(id);
    const r = rec(id);
    if (ev.event !== "approval.request" || !key?.startsWith("agent:") || !r?.cwd) return null;
    const ask = ev as unknown as EventOf<"approval.request">;
    // a lane's project is the session's folder, whose settings the dial keeps; what is inside it is the lane's own folder
    // a helper lane is read at its project's level, as any lane of the project, and never above its lead's: a lead read careful
    // would make its helper lanes careful too (item 102h; a workflow's lane offers no helpers today)
    const careful = !!r.workflow || (!!r.helperOf && !!rec(r.helperOf.lead)?.workflow);
    const ctx = { chat: key, root: workDir(r), project: r.cwd, home: state.home, branch: state.live[id]?.branch, ...(careful ? { careful: true } : {}) };
    const card = { id: `approval-${ask.request_id}`, request_id: ask.request_id };
    if (savesAlone(ask, ctx)) {
      // a commit or a push the dial would let go alone: what it saves is read first (item 117), and a key there, or a read not
      // made whole and in time, leaves it to the person, who is then told of it as of any ask
      const dir = ctx.root;
      return async () => {
        // the branch is read again from disk as the step arrives (item 120): one a job left running or a project's own
        // code switched since the last read is the one a push that names no branch sends
        const [saved, branch] = await Promise.all([readSaved(() => (host.laneKeys ? host.laneKeys(dir) : Promise.resolve(null))), branchNow(dir)]);
        const a = kitAnswer(ask, { ...ctx, branch }, Date.now(), saved);
        if (a) return settleApproval(store(), key, card, a.choice);
        const items = store().getState().chats[key]?.items ?? [];
        const item = items.find((i): i is ApprovalItem => i.kind === "approval" && i.request_id === ask.request_id);
        if (item && askOpen(items, item)) notify?.({ ...ev, bot: key } as unknown as BridgeEvent);
      };
    }
    const a = kitAnswer(ask, ctx);
    return a ? () => settleApproval(store(), key, card, a.choice) : null;
  };

  /** The chat's program is gone (it exited, or manut stopped it): a turn the chat still shows ends with it. The
   *  shell sends the turn's end before the exit when its adapter knew of the turn; this covers the rest (manut
   *  stopped it, so its last events are dropped). */
  const endLiveTurn = (id: string, outcome: "interrupted" | "ended") => {
    const key = keys.get(id);
    if (!key) return;
    if (store().getState().chats[key]?.turn) store().dispatch({ type: "event", ev: { event: "turn.end", bot: key, outcome } as BridgeEvent, now: Date.now() });
    // nobody is left to take an answer: an ask still open (a background subagent's, which outlives its turn) reads
    // "Not answered"
    for (const a of selectAsks(store().getState()).filter((x) => x.bot === key))
      store().dispatch({ type: "event", ev: { event: "prompt.expired", bot: key, request_id: a.item.request_id, reason: "cancelled" } as BridgeEvent, now: Date.now() });
  };

  /** An agent that is not signed in: manut stops it and the session ends with that one line (`proc.noChat`), said once
   *  beside Restart; the turn it failed keeps no second copy. */
  const endSignedOut = (id: string, proc: ChatProc) => {
    if (procs.get(id) !== proc) return;
    const error = proc.noChat ?? "";
    proc.stopping = true;
    procs.delete(id);
    endLiveTurn(id, "ended");
    if (proc.hostId !== undefined) void host.chatClose(proc.hostId).catch(() => undefined);
    patchRec(id, { status: "exited", exitCode: null, error });
    const key = keys.get(id);
    if (key) store().dispatch({ type: "turn.reasonMoved", bot: key, error });
    tellEnd(id, "ended", { code: null, error });
  };

  /** Who hears a chat's events after the session has handled them (`onChatEvent`): a workflow's run (src/workflows/) moves to its
   *  next step when a turn ends. Only the session's own process is heard, never an old one's. */
  const chatWatchers = new Set<(id: string, ev: ChatEvent) => void>();
  const onAgentEvent = (id: string, proc: ChatProc) => {
    const handle = handleAgentEvent(id, proc);
    return (ev: ChatEvent) => {
      const current = procs.get(id) === proc;
      handle(ev);
      if (!current) return;
      // a helper lane's budget, its Stop and its end read its events once the chat has them (item 102h)
      runs.event(id, ev);
      for (const w of [...chatWatchers]) w(id, ev);
    };
  };

  const handleAgentEvent = (id: string, proc: ChatProc) => (ev: ChatEvent) => {
    if (procs.get(id) !== proc && ev.event !== "exit") return; // an old process of this session (Terminal toggle)
    switch (ev.event) {
      case "session.info": {
        const p: Partial<SessionRec> = {};
        const fresh = typeof ev.agent_session === "string" && !!ev.agent_session && ev.agent_session !== rec(id)?.agentSession;
        if (typeof ev.agent_session === "string" && ev.agent_session) p.agentSession = ev.agent_session;
        if (typeof ev.model === "string" && ev.model) p.model = ev.model;
        // a model picked mid-turn waits for the next turn ("" = it has taken effect, or was taken back)
        if (typeof ev.model_next === "string") p.modelNext = ev.model_next || undefined;
        // the agent named the conversation (Claude Code's session title, a Codex thread name)
        if (typeof ev.title === "string" && ev.title.trim()) p.agentTitle = ev.title.trim();
        if (typeof ev.background === "number") p.background = ev.background;
        // which MCP servers the agent connected, for Settings › MCP and Skills (names and a status word only)
        if (Array.isArray(ev.mcp)) noteMcpSeen(rec(id)?.agent ?? "", ev.mcp);
        patchRec(id, p);
        const l: Partial<AgentLive> = {};
        if (typeof ev.rewind === "boolean") l.rewind = ev.rewind;
        if (typeof ev.mode === "string") l.mode = ev.mode;
        if (typeof ev.approval === "string") l.approval = ev.approval;
        if (typeof ev.sandbox === "string") l.sandbox = ev.sandbox;
        if (typeof ev.effort === "string" && ev.effort) l.effort = ev.effort;
        if (Object.keys(l).length) patchLive(id, l);
        if (fresh) {
          onAgentSession(id);
          void readAgentTitle(id);
        }
        return;
      }
      case "session.models": {
        const options = Array.isArray(ev.options) ? (ev.options as ModelOption[]) : [];
        set({ models: { ...state.models, [id]: options } });
        // what the agent listed is kept for the Ask several panel, which offers it before any lane of the agent runs (item 102a)
        const who = rec(id)?.agent;
        if (who && options.length) noteChoices(who, { models: options.map((o) => ({ id: o.id, label: o.label })) });
        return;
      }
      case "session.efforts": {
        const levels = Array.isArray(ev.levels) ? ev.levels.filter((x): x is string => typeof x === "string" && !!x) : [];
        patchLive(id, { efforts: levels });
        const who = rec(id)?.agent;
        if (who && levels.length) noteChoices(who, { efforts: levels });
        return;
      }
      case "session.commands": {
        // an agent may send its list in parts (Codex: skills after start-up): keep each entry once
        const next = parseCommands(ev.commands);
        const had = state.live[id]?.commands ?? [];
        const key = (c: AgentCommand) => c.prefix + c.name;
        const seen = new Set(next.map(key));
        patchLive(id, { commands: [...had.filter((c) => !seen.has(key(c))), ...next] });
        return;
      }
      case "session.usage":
        if (typeof ev.used === "number" && typeof ev.max === "number" && ev.max > 0) patchLive(id, { usage: { used: ev.used, max: ev.max } });
        return;
      case "session.error":
        // a rewind to a turn that waits for the agent's answer: the agents' refusal ("Not taken back: …", agent_chat.rs),
        // or the agent ending, fails it (rewind.ts puts the files back); any other note leaves it waiting
        if (/^Not taken back/.test(String(ev.message ?? "")) || ev.kind === "signed_out" || ev.kind === "no_chat_mode") rewinding.get(id)?.fail(String(ev.message ?? ev.kind));
        if (ev.kind === "signed_out") {
          // not signed in: one line in the person's words with the agent's own sign-in command (its row in
          // acp_chat.rs), then the session ends; a turn already started fails with it first
          const agent = rec(id)?.agent ?? "claude";
          const login = typeof ev.login === "string" ? ev.login : "";
          proc.noChat = tr("ss.signedOut", { agent: agentDef(agent).label, cmd: login });
          proc.signedOut = true;
          patchLive(id, { signin: login });
          const key = keys.get(id);
          if (!key || !store().getState().chats[key]?.turn) endSignedOut(id, proc);
          return;
        }
        if (ev.kind === "no_chat_mode") {
          // the shell ends this session: say why in the person's words, with the line that updates the agent
          const agent = rec(id)?.agent ?? "claude";
          // (the App Store edition has no line to give, so it asks the person to update it themselves)
          const install = installLine(agent);
          proc.noChat = install ? tr("ss.noChatMode", { agent: agentDef(agent).label, install }) : tr("ss.noChatModeUpdate", { agent: agentDef(agent).label });
          return;
        }
        note(id, signedOutSaid(String(ev.message ?? "")));
        return;
      case "session.note":
        // something the agent's side did on its own that the person should know (Codex: a new conversation in place
        // of one that is gone)
        if (ev.kind === "new_conversation") {
          const key = keys.get(id);
          if (key) store().dispatch({ type: "system.note", bot: key, text: tr("ss.newConversation"), now: Date.now() });
        }
        // a lane's MCP server whose entry is not the one the person approved was not started (acp_mcp.rs, item 89): its names
        // and one that would run the lane's own files, which the lane's agent can change (acp_mcp.rs, item 114)
        if ((ev.kind === "mcp_differs" || ev.kind === "mcp_lane_files") && Array.isArray(ev.names)) {
          const key = keys.get(id);
          const names = ev.names.filter((n): n is string => typeof n === "string").join(", ");
          const said = ev.kind === "mcp_differs" ? tr("ss.mcpDiffers", { names }) : tr("ss.mcpLaneFiles", { names });
          if (key && names) store().dispatch({ type: "system.note", bot: key, text: said, now: Date.now() });
        }
        // the project's own instructions the shell read and handed to the agent as text (item 93, projectNotes.ts): said
        // once in the chat, so a restart that hands over the same files adds nothing
        // an agent held to its asking modes reported another (acp_chat.rs, item 101a): what the shell set it back to, or
        // that it would not go back and gets nothing more
        if (ev.kind === "asks_mode") {
          const key = keys.get(id);
          const agent = typeof ev.agent === "string" ? ev.agent : agentDef(rec(id)?.agent ?? "claude").label;
          const mode = typeof ev.mode === "string" ? ev.mode : "";
          const to = typeof ev.to === "string" ? ev.to : "";
          const said = ev.ok === true ? tr("ss.asksModeSet", { agent, mode, to }) : tr("ss.asksModeKept", { agent, mode });
          if (key && mode) store().dispatch({ type: "system.note", bot: key, text: said, now: Date.now() });
        }
        if (ev.kind === "instructions") {
          const key = keys.get(id);
          const text = notesSaid(ev);
          const said = key ? (store().getState().chats[key]?.items ?? []).some((i) => i.kind === "system" && i.text === text) : true;
          if (key && text && !said) store().dispatch({ type: "system.note", bot: key, text, now: Date.now() });
        }
        return;
      case "exit": {
        if (procs.get(id) === proc) procs.delete(id);
        rewinding.get(id)?.fail(tr("ss.agentNotRunning", { agent: agentDef(rec(id)?.agent ?? "claude").label }));
        if (proc.stopping) return;
        endLiveTurn(id, "ended");
        const code = typeof ev.code === "number" ? ev.code : null;
        // code 0 is an orderly close: whatever the program printed (a start-up warning) is not why it ended
        const error = proc.noChat ?? (code !== 0 && typeof ev.error === "string" ? signedOutSaid(ev.error.trim()) : "");
        patchRec(id, { status: "exited", exitCode: code, ...(error ? { error } : {}) });
        // the turn the exit failed says "Failed after 0s"; its reason is the Ended line's, said once beside Restart
        const key = keys.get(id);
        if (key && error) store().dispatch({ type: "turn.reasonMoved", bot: key, error });
        const last = key ? store().getState().chats[key]?.lastTurn : null;
        tellEnd(id, "ended", { code, error }, !!last && last.outcome === "error" && Date.now() - (last.endedAt ?? 0) < 3000);
        return;
      }
      case "rewound": {
        // the agent took the person's last message back, or (a rewind to a turn) the message it names with everything
        // after it: the chat drops them, and the box offers that message's text again (the text the person typed; the
        // agent's own copy when manut has none)
        const key = keys.get(id);
        const items = key ? (store().getState().chats[key]?.items ?? []) : [];
        const named = typeof ev.id === "string" && ev.id ? items.find((i) => i.kind === "user" && i.id === ev.id) : undefined;
        const last = named ?? [...items].reverse().find((i) => i.kind === "user");
        const text = last && last.kind === "user" ? last.text : typeof ev.text === "string" ? ev.text : "";
        // the lane's turn is taken back: it reads Reverted, and what its tests said is of work that is gone
        noteLaneEvent(key ?? "", ev, Date.now(), laneWhere(id));
        dispatchChat(id, ev);
        if (key && text) store().dispatch({ type: "ui.draft", bot: key, text });
        rewinding.get(id)?.done();
        return;
      }
      default:
        // a turn that failed because the agent is not signed in (a model that needs its account): the shell's
        // sentence, said in the person's language
        if (ev.event === "turn.end" && typeof ev.error === "string") ev = { ...ev, error: signedOutSaid(ev.error) };
        if (ev.event === "turn.end" && proc.noChat && ev.outcome === "error") ev = { ...ev, error: proc.noChat };
        // a lead lane with Helpers on: its turn is marked so the chat hides its helper blocks, and what it writes is kept for its
        // end to read (item 102e)
        ev = leads.before(id, ev);
        // a chat with chats on its "Kit may reach" list: its turn is marked so the chat hides its reach blocks, and what it writes is
        // kept for its end to read (item 102k)
        ev = reach.before(id, ev);
        // Kit's dial: the card is added either way, so the chat says what was done; its answer goes through the card
        const kit = kitAsk(id, ev);
        dispatchChat(id, ev, !!kit);
        if (kit) void kit();
        // the turn's end: a helper request becomes the Start helpers card under the answer, or a line saying why not
        void leads.after(id, ev);
        // and a reach block becomes its card, or a line saying why not (item 102k)
        void reach.after(id, ev);
        if (ev.event === "tool.diff" && Array.isArray(ev.files)) noteChange(keys.get(id) ?? "", ev.files as DiffFile[]);
        // what the lane's work has shown: its test runs read from their output, and the files that changed
        noteLaneEvent(keys.get(id) ?? "", ev, Date.now(), laneWhere(id));
        // a pull request the chat opened itself, by a command that printed its address: linked once checked (item 100)
        if (ev.event === "tool.end" && typeof ev.command === "string") {
          const tasks = pulls();
          const w = laneWhere(id);
          // the chat's own branch: a lane's own, else the one its folder had when it was read (item 120)
          const own = rec(id)?.lane?.name ?? state.live[id]?.branch;
          if (tasks && w) void noteChatPull(tasks, keys.get(id) ?? "", ev, { cwd: w.root, root: w.root, ...(w.home ? { home: w.home } : {}), ...(own ? { branch: own } : {}) }).catch(() => undefined);
        }
        if (ev.event === "turn.end") afterTurn(id, ev.outcome === "interrupted");
        // the files as the turn left them: what changes before the next turn reads as changed by hand (rewind.ts)
        if (ev.event === "turn.end") turns.afterTurn(id);
        // a turn began, the person's or the agent's own: the rewind before it can no longer be brought back
        if (ev.event === "turn.start") turns.turnStarted(id);
        if (ev.event === "turn.end" && proc.signedOut) {
          endSignedOut(id, proc);
          return;
        }
        // the agent may have titled the conversation during the turn
        // a new turn: the finished one its row still showed is behind it
        if (ev.event === "turn.start" && state.unseen[id] === "end") seen(id);
        if (ev.event === "turn.end") {
          // an answer the person did not watch arrive: the row says it finished until they open it
          if (ev.outcome === "done") flag(id, "end");
          void readAgentTitle(id);
          void readBranch(id);
          if (ev.outcome === "done") void writeTitle(id);
        }
    }
  };

  /** Mark the session's chat loaded in the store (empty, or with the messages saved before a restart), so the
   *  timeline says hi instead of loading. */
  const openChat = (id: string, model = "", messages: Msg[] = []) => {
    const key = keys.get(id)!;
    if (store().getState().chats[key]?.loaded) return;
    store().dispatch({
      type: "chat.opened",
      bot: key,
      res: { session_id: key, messages, running: false, model, provider: "", reasoning: "" },
      now: Date.now(),
    });
  };

  const startAgentChat = async (id: string, resume?: string) => {
    const r = rec(id)!;
    const proc: ChatProc = { kind: "agent" };
    procs.set(id, proc);
    // a new process can take back only what it was sent itself (its own rewind)
    if (state.live[id]?.rewind) patchLive(id, { rewind: false });
    // and so no turn kept before it can be rewound: their snapshots go
    turns.forget(id);
    try {
      // a lane's agent works in the lane's own folder, and starts in the mode the person picked (a restart, a Restart, a
      // workflow's Ask): named at the start (item 89), so it holds from the first turn; none, and the shell picks the careful one
      const mode = r.mode && modesOf(r.agent).includes(r.mode) ? r.mode : undefined;
      proc.hostId = await host.chatStart(r.agent, workDir(r), onAgentEvent(id, proc), resume, accountOf(r), id, suggestOn() && suggestWorks(r.agent), mode);
      // it said it is not signed in before manut knew its id: it is ended already, so only the process goes
      if (proc.signedOut) {
        void host.chatClose(proc.hostId).catch(() => undefined);
        return;
      }
      if (procs.get(id) !== proc) {
        // closed while starting
        void host.chatClose(proc.hostId).catch(() => undefined);
        return;
      }
      patchRec(id, { status: "running" });
      // the effort the person picked before (a restart, a Restart) is set again; the mode went with the start
      const again = rec(id);
      if (again?.effort) await host.chatInput(proc.hostId, { kind: "effort", effort: again.effort }).catch(() => undefined);
      void readBranch(id);
    } catch (e) {
      if (procs.get(id) === proc) procs.delete(id);
      // the shell's refusal to start an agent whose ask rules it could not prove (acp_chat.rs NO_RULES), translated
      const why = errText(e);
      const label = agentDef(r.agent).label;
      const error = why === NO_RULES ? tr("ss.noRules") : why === NO_RULES.replaceAll("OpenCode", label) ? tr("ss.noRulesAgent", { agent: label }) : why;
      patchRec(id, { status: "failed", error });
      tellEnd(id, "failed", { error });
    }
  };

  const loadHermesModels = async (id: string, bot: string) => {
    const st = store();
    if (!st.getState().models[bot]) await st.actions.loadModels(bot);
    const opts = st.getState().models[bot];
    if (!opts) return;
    const list: ModelOption[] = opts.providers.flatMap((p) => p.models.map((m) => ({ id: m, label: m, detail: p.name, provider: p.slug })));
    set({ models: { ...state.models, [id]: list } });
  };

  const startFolderChat = async (id: string) => {
    const r = rec(id)!;
    const bot = r.bot;
    const proc: ChatProc = { kind: "folder", bot };
    procs.set(id, proc);
    try {
      if (!bot) throw new Error(tr("ss.noBot"));
      const res = await store().actions.folderOpen(bot, r.cwd);
      proc.fid = res.session;
      if (procs.get(id) !== proc) {
        void store().actions.folderClose(bot, res.session).catch(() => undefined);
        return;
      }
      keys.set(id, folderKey(bot, res.session));
      registerRoute(id);
      openChat(id, res.model);
      // the row keeps Hermes' stored id (what `folder.resume` takes after a restart); the live bridge id is the proc's.
      // A chat the bridge could not record (`recorded: false`) would be refused after a restart: the row keeps no id,
      // so it comes back paused and Resume opens a new folder chat
      patchRec(id, { status: "running", model: res.model, agentSession: (res.recorded !== false && res.stored) || undefined });
      void loadHermesModels(id, bot);
    } catch (e) {
      if (procs.get(id) === proc) procs.delete(id);
      const error = errText(e);
      patchRec(id, { status: "failed", error });
      tellEnd(id, "failed", { error });
    }
  };

  /**
   * Attach again the Hermes folder chat session `id` held before manut restarted (`folder.resume` with the stored id
   * its row kept): the same conversation, its messages read back from Hermes, its waiting asks sent again. The bridge
   * takes only a folder chat it made for this folder (rule 3). Null when it is attached, else why not.
   */
  const reattachFolder = async (id: string): Promise<string | null> => {
    const r = rec(id);
    const bot = r?.bot;
    const stored = r?.agentSession;
    if (!r || !bot || !stored) return tr("ss.noBot");
    const proc: ChatProc = { kind: "folder", bot };
    procs.set(id, proc);
    try {
      const res = await store().actions.folderResume(bot, r.cwd, stored);
      proc.fid = res.session;
      if (procs.get(id) !== proc) {
        void store().actions.folderClose(bot, res.session).catch(() => undefined);
        return null;
      }
      // the chat restored from the snapshot gives way to the one Hermes holds (no await before this: the asks the
      // bridge sends after its reply find the chat open)
      const old = keys.get(id);
      const key = folderKey(bot, res.session);
      if (old && old !== key) {
        setChatRoute(old, null);
        store().dispatch({ type: "chat.forget", bot: old });
      }
      keys.set(id, key);
      registerRoute(id);
      store().dispatch({
        type: "chat.opened",
        bot: key,
        res: { session_id: key, messages: res.messages ?? [], running: !!res.running, model: res.model, provider: res.provider, reasoning: res.reasoning },
        now: Date.now(),
      });
      patchRec(id, { status: "running", model: res.model, agentSession: res.stored || stored, paused: undefined, error: undefined, exitCode: null });
      void loadHermesModels(id, bot);
      return null;
    } catch (e) {
      if (procs.get(id) === proc) procs.delete(id);
      return errText(e);
    }
  };

  /** The local ids of messages the app itself sends (the helpers' report, item 102j), which are not the person speaking. */
  const fromApp = new Set<string>();
  const input = async (id: string, i: ChatInput) => {
    const proc = procs.get(id);
    const r = rec(id);
    if (!proc || !r) throw new Error(tr("ss.agentNotRunning", { agent: r ? agentDef(r.agent).label : tr("ss.theAgent") }));
    if (proc.kind === "agent") {
      if (proc.hostId === undefined) throw new Error(tr("ss.stillStarting"));
      // a message that starts a turn of a coding session: its files are kept first, so the turn can be rewound
      // (rewind.ts); a message that joins a running turn starts none
      const key = keys.get(id);
      if (i.kind === "send" && i.id && REWINDS.includes(r.agent) && !(key && store().getState().chats[key]?.turn)) await turns.beforeSend(id, workDir(r), i.id);
      if (i.kind === "send") {
        // a message of the person's reaches the agent: it gets its own rounds of helper lanes, and while Helpers is on the lead's
        // note goes in front of it, never into the bubble (item 102e). The app's own report (item 102j) is not the person's: it
        // gives no new rounds (R4), and carries the lead's note only while one more round is open.
        const app = !!i.id && fromApp.delete(i.id);
        if (!app) leads.personSpoke(id);
        // and while chats are on its "Kit may reach" list, the note naming them goes in front too (item 102k)
        const reached = reach.wire(id, i.text);
        i = { ...i, text: !app || leads.roundsLeft(id) ? leads.wire(id, reached) : reached };
      }
      await host.chatInput(proc.hostId, i);
      return;
    }
    const a = store().actions;
    const bot = proc.bot!;
    const fid = proc.fid;
    if (!fid) throw new Error(tr("ss.stillStarting"));
    if (i.kind === "send") await a.folderSend(bot, fid, i.text);
    else if (i.kind === "interrupt") await a.folderInterrupt(bot, fid);
    else if (i.kind === "approve") await a.folderApprove(bot, fid, i.request_id, i.choice);
    else if (i.kind === "clarify") await a.folderClarify(bot, fid, i.request_id, i.answer);
  };

  // ---- rewind to before a turn ----------------------------------------------------------------
  //
  // A coding session's files are kept as each turn begins and ends (rewind.ts, turnFiles.ts). Rewind to before a turn
  // puts them back, then takes the chat back with the agent's own rewind to that message (`rewind_to`), waited for here.

  /** A rewind to a turn waiting for the agent's answer, by session. */
  const rewinding = new Map<string, { done: () => void; fail: (why: string) => void }>();
  /** How long the agent may take to answer before the files go back as they were (it answers at once when it can). */
  const REWIND_WAIT_MS = 30_000;
  /** The agent's own rewind to before message `bubble`, waited for: its `rewound` event, or its refusal, its end, or no
   *  answer in time (the turn book then puts the files back). */
  const chatRewind = (sid: string, bubble: string) =>
    new Promise<void>((resolve, reject) => {
      const end = (ok: boolean, why = "") => {
        clearTimeout(timer);
        if (rewinding.get(sid) === waiter) rewinding.delete(sid);
        if (ok) resolve();
        else reject(new Error(why));
      };
      const waiter = { done: () => end(true), fail: (why: string) => end(false, why) };
      const timer = setTimeout(() => end(false, tr("rw.to.noAnswer", { agent: agentDef(rec(sid)?.agent ?? "claude").label })), REWIND_WAIT_MS);
      rewinding.set(sid, waiter);
      input(sid, { kind: "rewind_to", id: bubble }).catch((e) => end(false, errText(e)));
    });
  const turns = new TurnBook({ host: host.turnFiles, chatRewind });

  // ---- steer queue sessions ------------------------------------------------------------------
  //
  // A message sent while an agent chat's turn runs stays in manut (a held row with the ↵ mark, "Waiting") instead of
  // going to the agent's own queue, so it can still be sent now, steered in, edited or deleted. When the turn ends the
  // head goes out, one per turn, in order. The rows reuse the bot chat's steer queue (held rows, `queue.take` /
  // `queue.front` / `queue.drop`); the store's own flush, which sends through the Hermes bridge, is kept off agent
  // chats by a standing `steering` mark (HOLD_MARK), so only this code sends them, to the agent.

  /** What each held row sends, by its bubble id. */
  const heldInputs = new Map<string, { id: string; input: Extract<ChatInput, { kind: "send" }>; sent?: () => void }>();
  /** Sessions whose running turn Send now stopped: its end sends the chosen one first and keeps the rest waiting. */
  const sendingNow = new Set<string>();
  const HOLD_MARK = "agent-hold";
  const chatOf = (key: string) => store().getState().chats[key];
  /** Held for agent chats only (a Hermes folder chat goes through the bridge as before). */
  const mustHoldHere = (id: string, key: string) => procs.get(id)?.kind === "agent" && (!!chatOf(key)?.turn || !!chatOf(key)?.queue?.length);
  const hold = (id: string, key: string, lid: string, i: Extract<ChatInput, { kind: "send" }>, show: () => void, sent?: () => void) => {
    const st = store();
    if (chatOf(key)?.steering !== HOLD_MARK) st.dispatch({ type: "queue.steering", bot: key, id: HOLD_MARK });
    heldInputs.set(lid, { id, input: i, sent });
    show();
    // the row reads "Waiting", as a message the agent queued does
    dispatchChat(id, { event: "message.queued", id: lid });
  };
  /** The head held message goes out now: the row leaves the queue (moved to the end) before the request, once. */
  const sendHead = async (id: string) => {
    const key = keys.get(id);
    const head = key ? chatOf(key)?.queue?.[0] : undefined;
    if (!key || !head || chatOf(key)?.turn) return;
    const h = heldInputs.get(head);
    heldInputs.delete(head);
    store().dispatch({ type: "queue.take", bot: key, id: head, now: Date.now() });
    dispatchChat(id, { event: "message.taken", id: head });
    // no text kept for it, or the send fails: no turn starts, so no turn.end would ever send the next one
    if (!h) return void setTimeout(() => void sendHead(id), 0);
    h.sent?.();
    try {
      await input(id, h.input);
    } catch (e) {
      store().dispatch({ type: "send.failed", bot: key, id: head, error: errText(e) });
      setTimeout(() => void sendHead(id), 0);
    }
  };
  /** A turn ended. Stop (not Send now) throws away what waited, as the agents themselves do; otherwise the head goes. */
  const afterTurn = (id: string, stopped: boolean) => {
    const key = keys.get(id);
    // a Send now mark is used by this turn's end, whatever waits: a later real Stop is never read as Send now
    const now = sendingNow.delete(id);
    if (!key || !chatOf(key)?.queue?.length) return;
    if (stopped && !now) {
      for (const lid of [...(chatOf(key)?.queue ?? [])]) {
        heldInputs.delete(lid);
        store().dispatch({ type: "queue.take", bot: key, id: lid, now: Date.now() });
        dispatchChat(id, { event: "message.dropped", id: lid });
      }
      return;
    }
    setTimeout(() => void sendHead(id), 0);
  };
  const heldIn = (id: string, lid: string) => {
    const key = keys.get(id);
    return key && chatOf(key)?.queue?.includes(lid) && heldInputs.get(lid)?.id === id ? key : null;
  };
  /** The ↵ ↓ × buttons of a waiting message in session `id`'s chat. */
  const queuePick = async (id: string, lid: string, c: "now" | "steer" | "edit" | "delete") => {
    const key = heldIn(id, lid);
    if (!key) return; // already with the agent: the menu offers nothing
    const st = store();
    if (c === "delete" || c === "edit") {
      const text = heldInputs.get(lid)?.input.text ?? "";
      heldInputs.delete(lid);
      st.dispatch({ type: "queue.drop", bot: key, id: lid });
      if (c === "edit") {
        const typed = getDraft(key).trim();
        st.dispatch({ type: "ui.draft", bot: key, text: typed ? `${text}\n${typed}` : text });
      }
      return;
    }
    if (c === "now") {
      st.dispatch({ type: "queue.front", bot: key, id: lid });
      if (!chatOf(key)?.turn) return void sendHead(id);
      // one Stop, however often it is pressed; the stopped turn's end sends this one first
      if (sendingNow.has(id)) return;
      sendingNow.add(id);
      await input(id, { kind: "interrupt" }).catch((e) => {
        sendingNow.delete(id);
        note(id, errText(e));
      });
      return;
    }
    // Steer: the agent's own mid-turn input, text only; with pictures, or no turn left to steer, it goes out next
    const h = heldInputs.get(lid)!;
    const agent = rec(id)?.agent ?? "";
    if (!steersOf(agent)) return;
    if (!chatOf(key)?.turn || h.input.images?.length) {
      st.dispatch({ type: "queue.front", bot: key, id: lid });
      if (!chatOf(key)?.turn) void sendHead(id);
      return;
    }
    try {
      await input(id, { kind: "steer", id: lid, text: h.input.text });
      heldInputs.delete(lid);
      // with the agent now: no longer held, "Waiting" until the agent says it took it
      st.dispatch({ type: "queue.take", bot: key, id: lid, now: Date.now() });
    } catch {
      st.dispatch({ type: "queue.front", bot: key, id: lid });
    }
  };

  /** The app's own message to a session (the helpers' report, item 102j): it goes to the agent with no bubble (the chat shows a
   *  quiet line instead, `system.note`), and it is not the person speaking, so it gives the lead no new rounds (R4). Sent only
   *  when the session is idle and nothing of the person's waits (`takeHandOver`), so it never queues. False when it did not go. */
  const sendFromApp = async (id: string, text: string): Promise<boolean> => {
    const t = text.trim();
    if (!t || !keys.get(id) || waitsFor(id)) return false;
    const lid = `local-a${++localSeq}`;
    fromApp.add(lid);
    try {
      await input(id, { kind: "send", text: t, id: lid });
      return true;
    } catch {
      fromApp.delete(lid);
      return false;
    }
  };

  /** Send chat text: the bubble shows at once; a refusal marks it "Not sent". True when it went to the agent or waits for the
   *  running turn, false when nothing was sent. While a turn runs it waits (the steer queue); with `how` "steer" (the chat
   *  box's Cmd+Enter or Settings' choice, chat/box/keys.ts) it is handed to the running turn at once, as its ↵ does, when
   *  the agent takes a steer and nothing waits ahead of it. */
  const send = async (id: string, text: string, how?: FollowUp): Promise<boolean> => {
    const t = text.trim();
    const key = keys.get(id);
    if (!t || !key) return false;
    // one working agent in a lane: the box holds it while the chat it continues (or that continues it) works (item 97)
    if (waitsFor(id)) return false;
    const st = store();
    const lid = `local-s${++localSeq}`;
    if (mustHoldHere(id, key)) {
      hold(id, key, lid, { kind: "send", text: t, id: lid }, () => st.dispatch({ type: "local.user", bot: key, id: lid, text: t, now: Date.now(), held: true }));
      if ((how ?? savedFollowUp("code")) === "steer" && chatOf(key)?.turn && chatOf(key)?.queue?.[0] === lid) await queuePick(id, lid, "steer");
      return true;
    }
    st.dispatch({ type: "local.user", bot: key, id: lid, text: t, now: Date.now() });
    // the first message that says something names the session until the agent or the person does
    const r = rec(id);
    if (r && !r.promptTitle) {
      // what was typed names it, never the notes or another chat's context in front (item 97)
      const pt = promptTitle(bareText(t));
      if (pt) patchRec(id, { promptTitle: pt });
    }
    try {
      await input(id, { kind: "send", text: t, id: lid });
      return true;
    } catch (e) {
      st.dispatch({ type: "send.failed", bot: key, id: lid, error: errText(e) });
      return false;
    }
  };

  /**
   * A message from another chat into session `id`'s chat (item 102k, after Send there on that chat's card): marked by the caller as
   * from that chat. It is only ever sent as text, so it has no way to answer, allow, deny or dismiss an ask, whatever its words. It
   * waits as a held row while a turn runs, while messages wait ahead of it, or while an ask or a question of this chat waits on the
   * person, and goes when the turn ends or when the person presses Send now on it; it is never steered into a running turn, whatever
   * the person's Return does. False when nothing could be sent (no agent of the app's running there).
   */
  const route = async (id: string, text: string): Promise<boolean> => {
    const key = keys.get(id);
    const t = text.trim();
    if (!key || !t || procs.get(id)?.kind !== "agent") return false;
    const asks = selectAsks(store().getState()).some((a) => a.bot === key);
    if (mustHoldHere(id, key) || asks) {
      const lid = `local-s${++localSeq}`;
      hold(id, key, lid, { kind: "send", text: t, id: lid }, () => store().dispatch({ type: "local.user", bot: key, id: lid, text: t, now: Date.now(), held: true }));
      return true;
    }
    return send(id, t, "queue");
  };

  // ---- files --------------------------------------------------------------------------------

  let sentFiles = readSentFiles();
  const saveSentFiles = (next: SentFilesBook) => {
    sentFiles = next;
    try {
      localStorage.setItem(SENT_FILES_KEY, JSON.stringify(next));
    } catch {
      /* no storage */
    }
  };
  const forgetSentFiles = (id: string) => {
    if (!sentFiles[id]) return;
    const next = { ...sentFiles };
    delete next[id];
    saveSentFiles(next);
  };

  /** The bubble's own preview of a file (the composer lets go of its chips' copies when it goes). */
  const preview = (name: string, kind: SentFile["kind"], bytes: Uint8Array) =>
    kind === "file" ? null : URL.createObjectURL(new Blob([bytes as BlobPart], { type: blobType(name) }));

  /** A message with files, ready for the agent: each file saved under the session's own folder (pictures the agent
   *  reads itself listed apart), the text naming the others. Throws on the first file that cannot be saved; then
   *  nothing is sent. */
  const prepare = async (id: string, text: string, files: OutFile[]) => {
    const images: string[] = [];
    const named: string[] = [];
    const saved: SavedFile[] = [];
    const shown: SentFile[] = [];
    for (const f of files) {
      let path: string;
      let bytes: Uint8Array;
      try {
        bytes = bytesOf(await f.read());
        path = await host.saveFile(id, f.name, bytes);
      } catch (e) {
        throw new Error(tr("att.failed", { name: f.name, error: errText(e) }));
      }
      (inlinePicture(f.name, f.size) ? images : named).push(path);
      saved.push({ name: f.name, size: f.size, kind: f.kind, path });
      shown.push({ name: f.name, size: f.size, kind: f.kind, url: preview(f.name, f.kind, bytes) });
    }
    return { input: { kind: "send" as const, text: wireText(text, named), ...(images.length ? { images } : {}) }, saved, shown };
  };

  /** The bubble for a message with files, kept on this computer so it shows them again after a restart. */
  const showWithFiles = (id: string, key: string, text: string, p: Awaited<ReturnType<typeof prepare>>) => {
    const t = text.trim();
    const now = Date.now();
    const lid = `local-s${++localSeq}`;
    store().dispatch({ type: "local.user", bot: key, id: lid, text: t, now, files: p.shown });
    saveSentFiles(putSentFiles(sentFiles, id, String(now), { ts: now / 1000, text: t, files: p.saved }));
    const r = rec(id);
    const pt = t ? promptTitle(bareText(t)) : "";
    if (r && !r.promptTitle && pt) patchRec(id, { promptTitle: pt });
    return lid;
  };

  /**
   * Send a message with files from a running chat. The files are saved first; if one cannot be, nothing is sent
   * and the error goes back to the composer (its chips stay).
   */
  const sendFiles = async (id: string, text: string, files: OutFile[], how?: FollowUp): Promise<void> => {
    if (!files.length) {
      await send(id, text, how);
      return;
    }
    const key = keys.get(id);
    if (!key) return;
    if (procs.get(id)?.kind !== "agent") throw new Error(tr("ss.agentNotRunning", { agent: agentDef(rec(id)?.agent ?? "claude").label }));
    const busy = waitsFor(id);
    if (busy) throw new Error(tr("cont.wait", { agent: agentLabel(busy.agent, state.agents) }));
    const p = await prepare(id, text, files);
    if (mustHoldHere(id, key)) {
      // held with its saved files: they go with it when it goes out
      const lid = `local-s${++localSeq}`;
      hold(
        id,
        key,
        lid,
        { ...p.input, id: lid },
        () => store().dispatch({ type: "local.user", bot: key, id: lid, text: text.trim(), now: Date.now(), files: p.shown, held: true }),
        // kept for a restart only once it went out (as showWithFiles does for a message sent at once)
        () => {
          const now = Date.now();
          saveSentFiles(putSentFiles(sentFiles, id, String(now), { ts: now / 1000, text: text.trim(), files: p.saved }));
        },
      );
      return;
    }
    const lid = showWithFiles(id, key, text, p);
    try {
      await input(id, { ...p.input, id: lid });
    } catch (e) {
      store().dispatch({ type: "send.failed", bot: key, id: lid, error: errText(e) });
    }
  };

  /** Open a restored chat with its sent files back in their bubbles: each sent message's bubble is put down first
   *  with the files (read back from the saved copies), and the restored message with the same text and time takes
   *  them over; one sent with files and no text stays as it is. */
  const openWithFiles = async (id: string, model: string, msgs: Msg[]) => {
    const key = keys.get(id)!;
    const entries = Object.entries(sentFiles[id] ?? {});
    const oldest = msgs.length ? msgs[0].ts : -Infinity;
    for (const [mid, e] of entries) {
      if (e.ts < oldest - 1) continue; // older than what the chat kept
      const shown: SentFile[] = await Promise.all(
        e.files.map(async (f) => {
          if (f.kind === "file") return { name: f.name, size: f.size, kind: f.kind, url: null };
          try {
            return { name: f.name, size: f.size, kind: f.kind, url: preview(f.name, f.kind, await host.readFile(f.path)) };
          } catch {
            return { name: f.name, size: f.size, kind: "file" as const, url: null };
          }
        }),
      );
      if (store().getState().chats[key]?.loaded) return;
      store().dispatch({ type: "local.user", bot: key, id: `local-f${mid}`, text: e.text, now: e.ts * 1000, files: shown });
    }
    openChat(id, model, msgs);
  };

  const registerRoute = (id: string) => {
    const key = keys.get(id)!;
    const r = rec(id);
    setChatRoute(key, {
      // folder first: it tells sessions apart, and a narrow Needs-you row keeps it when the name is cut
      // a helper lane names its place and its lead (item 102h): its asks in Needs you are never read as another lane's
      label: r ? nameOf(r) : tr("ss.session"),
      open: () => store().actions.openSession(id),
      send: async (text) => {
        await send(id, text);
      },
      interrupt: () => input(id, { kind: "interrupt" }),
      approve: (request_id: string, choice: ApprovalChoice) => input(id, { kind: "approve", request_id, choice }),
      clarify: (request_id: string, answer: string | ClarifyAnswers) => input(id, { kind: "clarify", request_id, answer }),
    });
  };

  // Hermes titles a folder chat on its own (instant title, then its titler): the session takes that name.
  onBridgeEvent((ev) => {
    if (ev.event !== "session.title" || !ev.session || !ev.title.trim()) return;
    for (const [id, p] of procs) if (p.kind === "folder" && p.bot === ev.bot && p.fid === ev.session) patchRec(id, { agentTitle: ev.title.trim() });
  });

  // A Hermes folder chat ends when the bridge says so (its gateway went away).
  onBridgeEvent((ev) => {
    if (ev.event !== "folder.closed" || !ev.session) return;
    for (const [id, p] of procs) {
      if (p.kind === "folder" && p.bot === ev.bot && p.fid === ev.session) {
        procs.delete(id);
        const error = ev.reason || tr("ss.hermesClosed");
        patchRec(id, { status: "exited", exitCode: null, error });
        tellEnd(id, "ended", { code: null, error });
      }
    }
  });

  // A Hermes folder chat's turns come over the bridge: an answer the person did not watch arrive marks its row, and
  // the next turn puts it behind.
  onBridgeEvent((ev) => {
    if (!ev.session || (ev.event !== "turn.start" && !(ev.event === "turn.end" && ev.outcome === "done"))) return;
    for (const [id, p] of procs) {
      if (p.kind !== "folder" || p.bot !== ev.bot || p.fid !== ev.session) continue;
      if (ev.event === "turn.end") flag(id, "end");
      else if (state.unseen[id] === "end") seen(id);
    }
  });

  // ---- sessions -----------------------------------------------------------------------------

  /**
   * Open a New session chat: a draft on `agent` (the one picked in the SESSIONS + menu; none = the last agent
   * used, else the first installed) in the last folder used (else home). An open draft is reused rather than
   * stacking a second one, and takes the agent picked. Nothing starts here.
   */
  const draft = (agent?: AgentId): string => {
    // a workflow's lane, a draft only while it starts, is never the person's
    // nor a chat Continue with made (item 97): it is tied to its lane and the chat it continues
    const open = state.list.find((r) => r.status === "draft" && !r.workflow && !r.job && !r.helperOf && !r.continuedFrom);
    if (open) {
      if (agent) setDraft(open.id, { agent });
      store().actions.openSession(open.id);
      return open.id;
    }
    const id = `s${++seq}`;
    if (agent) picked.set(id, { agent: true });
    const r: SessionRec = {
      id,
      linkId: freshLinkId(),
      agent: agent ?? draftAgent(state.recent, state.agents),
      cwd: draftFolder(state.recent, state.home),
      startedAt: Date.now(),
      status: "draft",
      view: "chat",
    };
    set({ list: [r, ...state.list] });
    store().actions.openSession(id);
    if (state.agents === null || state.home === null) void loadAgents();
    return id;
  };

  /**
   * The + menu's Chat with Kit: a New session chat on `agent` in `cwd` (none: the last folder used, else home), opened
   * as the app's chat whatever way was picked for the agent before, so its first message starts a lane (`startLane`: a
   * branch and a folder of its own) that the Code page's Lanes band lists. Nothing starts until that message: the lane's
   * branch is named from it. An open draft is reused, as `draft` does.
   */
  const draftChat = (agent: AgentId, cwd?: string): string => {
    const id = draft(agent);
    if (cwd) setDraft(id, { cwd });
    // kept for the agent on this computer, as the draft's own Chat or Terminal choice is (an agent with no chat keeps none)
    setOpen(id, "chat");
    return id;
  };

  /**
   * A lane a workflow starts (src/workflows/): a New session chat on `agent` in `cwd`, started with `first` as the person's own
   * first message starts a lane (`start`: a branch and a folder of its own, listed in the Lanes band). It is made beside the person's
   * drafts, never in place of one, is not opened in front of them, and changes neither how they last opened the agent nor their
   * last folder. It is named after the workflow, marked `workflow` (Kit's dial asks before every change in it, whatever the
   * project's dial says) and starts in its agent's Ask mode. `made` hears its id before anything runs, so no event of its first
   * turn is missed. `failed` when it did not start; `no_lane` when no branch and folder of its own could be made (item 91): then
   * no agent was started and the session is gone, since a lane working in the project's own folder is not one a workflow may
   * have. `unattended` (item 114): nobody is there, so the shell reads the repository's own config before it makes anything;
   * when that names a program or another address the answer is `{ why: "config", setting }`, with nothing started either.
   */
  const startWorkflowLane = async (p: {
    agent: AgentId;
    cwd: string;
    workflow: string;
    first: string;
    unattended?: boolean;
    made?: (id: string) => void;
  }): Promise<"started" | "failed" | "no_lane" | { why: "config"; setting: string }> => {
    const id = `s${++seq}`;
    if (p.unattended) unattended.add(id);
    const ask = ASK_MODE[p.agent];
    const r: SessionRec = {
      id,
      linkId: freshLinkId(),
      agent: p.agent,
      cwd: p.cwd,
      startedAt: Date.now(),
      status: "draft",
      view: "chat",
      title: p.workflow.replace(/\s+/g, " ").trim().slice(0, NAME_MAX),
      workflow: p.workflow,
      ...(ask && modesOf(p.agent).includes(ask) ? { mode: ask } : {}),
    };
    set({ list: [r, ...state.list] });
    p.made?.(id);
    const started = await start(id, p.first).finally(() => unattended.delete(id));
    const setting = laneConfig.get(id);
    laneConfig.delete(id);
    if (laneless.delete(id)) return setting !== undefined ? { why: "config", setting } : "no_lane";
    const key = keys.get(id);
    if (started && key) store().dispatch({ type: "system.note", bot: key, text: tr("wf.lane.note", { name: p.workflow }), now: Date.now() });
    return started ? "started" : "failed";
  };


  // ---- Ask several agents (item 102a) ---------------------------------------------------------------------------------------

  /**
   * Ask several agents: one message sent to up to three agents, each as an ordinary lane (`start`: a branch and a folder of its own,
   * listed in the Lanes band) started in its agent's Ask mode and grouped as one job (`SessionRec.job`). Nothing is sent until the
   * person pressed Send in the panel, which is the only caller, and nothing here starts an agent for another agent: every lane's
   * own asks are its own cards. The send is refused whole, with nothing started, when any row is refused (`askRefusal`: a limited
   * account's row cannot be sent). The lanes start one after the other, so two lanes never ask the shell for the same branch name
   * at once; a lane that fails to start leaves the others as they are. A folder that is not a repository makes no lane, and no
   * agent starts in it (rule R1): the answer then says `no_lane`.
   */
  const startJob = async (p: {
    cwd: string;
    text: string;
    files?: OutFile[];
    picks: readonly AskPick[];
  }): Promise<{ ok: true; job: string; ids: string[]; failed: number } | { ok: false; refused: AskRefusal; ids: string[] } | { ok: false; refused: { why: "no_lane" }; ids: string[] }> => {
    if (state.agents === null) await loadAgents();
    const text = p.text.trim();
    const files = p.files ?? [];
    const refused = askRefusal({ cwd: p.cwd, hasMessage: !!text || files.length > 0, picks: p.picks, agents: state.agents ?? [], groups: accounts() });
    if (refused) return { ok: false, refused, ids: [] };
    const job = `j${freshLinkId()}`;
    const ids: string[] = [];
    let failed = 0;
    for (const pick of p.picks) {
      const id = `s${++seq}`;
      const ask = ASK_MODE[pick.agent];
      const r: SessionRec = {
        id,
        linkId: freshLinkId(),
        agent: pick.agent,
        cwd: p.cwd,
        startedAt: Date.now(),
        status: "draft",
        view: "chat",
        job,
        // the agent's own Ask mode, named on its command line whatever mode the person last used (item 89)
        ...(ask && modesOf(pick.agent).includes(ask) ? { mode: ask } : {}),
        ...(pick.model ? { modelWant: pick.model } : {}),
        ...(pick.effort ? { effort: pick.effort } : {}),
      };
      set({ list: [r, ...state.list] });
      const started = await start(id, text, undefined, files).catch(() => false);
      if (laneless.delete(id)) return { ok: false, refused: { why: "no_lane" }, ids };
      if (!started) {
        failed++;
        continue;
      }
      ids.push(id);
      const key = keys.get(id);
      if (key) store().dispatch({ type: "system.note", bot: key, text: tr("several.lane.note", { n: p.picks.length }), now: Date.now() });
    }
    return { ok: true, job, ids, failed };
  };

  // ---- a lane another chat's card opened (item 102k) -------------------------------------------------------------------------

  /**
   * Start lane on another chat's open card: an ordinary lane on `agent` in the developer's folder `cwd` (`start`: a branch and a folder
   * of its own, listed in the Lanes band), started in its agent's Ask mode with `first` (the card's brief, marked as from the asking
   * chat) as its first message, named with the card's title. Made beside the person's drafts and never opened in front of them, as a
   * workflow's lane is, and it changes neither how they last opened the agent nor their last folder. The card's press is the only
   * caller. A folder that is not a repository makes no lane, and no agent starts in it (rule R1): the answer then says why.
   */
  const startOpenedLane = async (p: OpenLane): Promise<{ ok: true; id: string } | { ok: false; why: string }> => {
    if (state.agents === null) await loadAgents();
    const agent = p.agent as AgentId;
    const id = `s${++seq}`;
    const ask = ASK_MODE[agent];
    const r: SessionRec = {
      id,
      linkId: freshLinkId(),
      agent,
      cwd: p.cwd,
      startedAt: Date.now(),
      status: "draft",
      view: "chat",
      title: p.title.replace(/\s+/g, " ").trim().slice(0, NAME_MAX),
      ...(p.from ? { openedBy: p.from } : {}),
      // the agent's own Ask mode, named on its command line whatever mode the person last used (item 89)
      ...(ask && modesOf(agent).includes(ask) ? { mode: ask } : {}),
      ...(p.model ? { modelWant: p.model } : {}),
      ...(p.effort ? { effort: p.effort } : {}),
    };
    set({ list: [r, ...state.list] });
    const started = await start(id, p.first).catch(() => false);
    if (laneless.delete(id)) return { ok: false, why: tr("reach.noLane") };
    if (!started) return { ok: false, why: tr("reach.notStarted") };
    const key = keys.get(id);
    const from = rec(p.from);
    const note = p.program ? tr("tm.opened.note", { name: p.program }) : tr("reach.opened.note", { title: from ? pickTitle(from, folderName(from.cwd)).title : tr("ss.session") });
    if (key) store().dispatch({ type: "system.note", bot: key, text: note, now: Date.now() });
    return { ok: true, id };
  };

  // ---- helper lanes (item 102h) ---------------------------------------------------------------------------------------------

  /** The model a helper lane starts on: the one its block named, unless the card said the lead's agent does not list it; none named
   *  on the lead's own agent is the lead's model, as the card said, found among what the lead's agent listed. */
  const helperModel = (row: StartHelper["row"], lead: SessionRec): string | undefined => {
    if (row.model) return row.modelUnlisted ? undefined : row.model;
    if (!row.own || !lead.model) return undefined;
    const listed = (state.models[lead.id] ?? []).find((m) => m.id === lead.model || m.label === lead.model);
    return listed?.id;
  };

  /**
   * One helper lane of a round the person approved with Start helpers (src/jobs/helperRuns.ts is the only caller): its folder made by
   * the shell from a snapshot of the lead lane's folder as it is now (`laneHelperWorktree`, item 102f), then an ordinary lane on the
   * row's agent in that folder (`start`), started in its agent's Ask mode whatever mode the lead runs in (rule R3) with `first` (the
   * brief with its mark) as its first message, named with the card's title and marked `helperOf`. Made beside the person's drafts and
   * never opened in front of them, as a workflow's lane is. Its project is the lead's, the developer's folder, so Kit's dial reads its
   * asks at that project's level, as for any lane of it. `made` hears its id before its agent starts. `ok: false` says, in the
   * person's words, why its folder or its agent did not start.
   */
  const startHelperLane = async (p: StartHelper): Promise<{ ok: true; id: string } | { ok: false; why: string }> => {
    if (state.agents === null) await loadAgents();
    const lead = rec(p.lead);
    if (!lead?.lane?.worktree) return { ok: false, why: tr("helpers.run.why.noLead") };
    if (!host.laneHelperWorktree) return { ok: false, why: tr("helpers.run.why.noShell") };
    let made: LaneMade;
    try {
      made = await host.laneHelperWorktree(lead.lane.worktree, p.job);
    } catch (e) {
      return { ok: false, why: tr("helpers.run.why.folder", { why: errText(e) }) };
    }
    const lane = { name: made.branch, base: made.base, dir: made.dir, worktree: made.worktree };
    if (!rec(p.lead)) {
      // the lead was closed while the folder was made: nothing is in it yet, so it goes as a close takes it
      void letLaneGo(lane);
      return { ok: false, why: tr("helpers.run.why.noLead") };
    }
    const agent = p.row.agent as AgentId;
    const ask = ASK_MODE[agent];
    const model = helperModel(p.row, lead);
    const effort = p.row.effort && !p.row.effortUnlisted ? p.row.effort : p.row.own ? lead.effort : undefined;
    const id = `s${++seq}`;
    const r: SessionRec = {
      id,
      linkId: freshLinkId(),
      agent,
      cwd: lead.cwd,
      startedAt: Date.now(),
      status: "draft",
      view: "chat",
      title: p.row.title.replace(/\s+/g, " ").trim().slice(0, NAME_MAX),
      lane,
      helperOf: { lead: p.lead, job: p.job, round: p.round, index: p.index },
      // the agent's own Ask mode, named on its command line whatever mode the lead or the person last used (item 89, rule R3); an
      // agent with no modes here starts in the careful one the shell picks
      ...(ask && modesOf(agent).includes(ask) ? { mode: ask } : {}),
      // on the lead's own agent it runs as the lead's account, so it reads the same sign-in the lead does
      ...(agent === lead.agent && lead.account ? { account: lead.account } : {}),
      ...(model ? { modelWant: model } : {}),
      ...(effort ? { effort } : {}),
    };
    set({ list: [r, ...state.list] });
    p.made(id);
    // the chat says first where the helper lane works and what it is, so the brief below reads as what it was sent
    keys.set(id, `agent:${id}`);
    registerRoute(id);
    openChat(id);
    const title = pickTitle(lead, folderName(lead.cwd)).title;
    store().dispatch({ type: "system.note", bot: `agent:${id}`, text: tr("helpers.run.laneNote", { n: p.index + 1, lead: title, branch: made.branch, folder: made.dir }), now: Date.now() });
    const started = await start(id, p.first).catch(() => false);
    const now = rec(id);
    if (!started || !now) return { ok: false, why: tr("helpers.run.why.notStarted") };
    // the shell refused to start its agent (one whose own settings would skip asks, items 101a and 101b): its row says why
    if (now.status === "failed") return { ok: false, why: now.error || tr("helpers.run.why.notStarted") };
    return { ok: true, id };
  };

  // ---- Continue with (item 97) ----------------------------------------------------------------------------------------

  /** Whether session `id`'s turn runs (an ask of it waits inside its turn). */
  const working = (sid: string) => {
    const k = keys.get(sid);
    return !!k && !!store().getState().chats[k]?.turn;
  };
  /** The chat linked to `id` by Continue with that works in its lane or folder now: `id` waits for it (continueWith.ts). */
  const waitsFor = (id: string): SessionRec | null => {
    const r = rec(id);
    return r ? busyMate(state.list, r, working) : null;
  };

  /** A continued chat's model, picked in Continue with: set once its agent runs, before its first message goes. */
  const setWanted = async (id: string) => {
    const want = rec(id)?.modelWant;
    if (!want) return;
    patchRec(id, { modelWant: undefined });
    if (procs.get(id)?.kind !== "agent") return;
    try {
      await input(id, { kind: "model", model: want });
    } catch (e) {
      note(id, errText(e));
    }
  };

  /**
   * Continue chat `id` with another agent or model: a NEW chat in the same folder and, for a lane, the same lane, linked from
   * `id` both ways, with `id`'s context above its box as one chip (`context`, built by the caller with no model), unsent. It is
   * opened; nothing starts until the person sends. `id` is left as it is. Null when `id` is not a started chat.
   */
  const continueWith = (id: string, pick: ContinuePick, context?: { title: string; text: string; ref: string; scope: Scope }): string | null => {
    const old = rec(id);
    if (!old || old.status === "draft" || !keys.get(id)) return null;
    const linkId = old.linkId ?? freshLinkId();
    if (!old.linkId) patchRec(id, { linkId });
    const r = continuedDraft({ ...old, linkId }, pick, { id: `s${++seq}`, linkId: freshLinkId(), now: Date.now() });
    picked.set(r.id, { agent: true, cwd: true });
    set({ list: [r, ...state.list] });
    patchRec(id, { continuedIn: r.linkId });
    // a chat, whatever way the agent was last opened, as Chat with Kit opens one
    setOpen(r.id, "chat");
    if (context) carry(`agent:${r.id}`, { kind: "thread", id: `x${r.id}`, ref: context.ref, title: context.title, text: context.text, scope: context.scope });
    store().actions.openSession(r.id);
    return r.id;
  };

  /** Stop chat `id`'s agent, only while it is idle (no turn runs): the person said so after Continue with. Its chat stays and can be
   *  opened; Restart starts it again. False when it works or is not running. */
  const stopIdle = async (id: string): Promise<boolean> => {
    const r = rec(id);
    if (!r || r.status !== "running" || working(id)) return false;
    await stopChat(id);
    patchRec(id, { status: "exited", exitCode: null });
    return true;
  };

  /** New session here: a draft with session `id`'s agent and folder (an open draft takes them instead). */
  const draftHere = (id: string): string | null => {
    const r = rec(id);
    if (!r) return null;
    // an agent manut no longer offers: a New session on the usual agent, in the same folder
    if (isGone(r.agent)) {
      const d = draft();
      if (r.cwd) setDraft(d, { cwd: r.cwd });
      return d;
    }
    const d = draft(r.agent);
    if (r.cwd) setDraft(d, { agent: r.agent, cwd: r.cwd });
    return d;
  };

  /**
   * TERMINALS +: start `agent` (or the Shell, `SHELL`) in a terminal in `cwd` (none: the last folder used, else home)
   * at once, and open it. Never a chat: an agent that usually opens as manut's chat is opened as its own terminal.
   * A Shell runs `shell` (an id from the shell's list; none: Settings › Terminal › Default shell, else the login shell).
   * `as`: the account the terminal runs as, instead of the one picked for new sessions (Settings › Accounts opens pi's
   * terminal as the account it just added, so the person can type pi's own /login there; item 101d).
   */
  const startTerminal = (agent: AgentId, cwd?: string, shell?: string, as?: string): string | null => {
    const at = cwd || draftFolder(state.recent, state.home);
    if (!at) return null;
    const id = `s${++seq}`;
    const startedAt = Date.now();
    const asTerminal = !isShell(agent) && sessionMode(state.agents, { agent }) !== "terminal";
    const account = isShell(agent) ? undefined : as ?? accountFor(accounts(), agent);
    const shellId = isShell(agent) ? shell || readTermSettings().defaultShell || undefined : undefined;
    const r: SessionRec = {
      id,
      linkId: freshLinkId(),
      agent,
      cwd: at,
      startedAt,
      status: "starting",
      view: "terminal",
      ...(asTerminal ? { open: "terminal" as const } : {}),
      ...(account ? { account } : {}),
      ...(shellId ? { shell: shellId } : {}),
      fgAgent: null,
    };
    const recent = pushRecent(state.recent, { agent, cwd: at, at: startedAt });
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      /* no storage */
    }
    set({ list: [r, ...state.list], recent });
    store().actions.openSession(id);
    return id;
  };

  /** The CLI running in the foreground of session `id`'s terminal (the shell's foreground-process event), or null. */
  const setSessionFg = (id: string, agent: string | null) => {
    const r = rec(id);
    if (!r || (r.fgAgent ?? null) === agent) return;
    patchRec(id, { fgAgent: agent });
  };

  /**
   * Continue a conversation Claude Code or Codex keeps for a folder (made in its CLI, or anywhere else): a session in
   * that folder whose chat shows the conversation's last messages, and whose agent continues it (Claude Code
   * `--resume`, Codex `thread/resume`). A session that already runs that conversation is opened instead.
   */
  const continuePast = async (chat: PastChat): Promise<string> => {
    const there = state.list.find((r) => r.agent === chat.agent && r.agentSession === chat.id && r.status !== "draft");
    if (there) {
      store().actions.openSession(there.id);
      if (there.status === "exited" || there.status === "failed") void restart(there.id);
      return there.id;
    }
    const id = `s${++seq}`;
    const startedAt = Date.now();
    const r: SessionRec = {
      id,
      linkId: freshLinkId(),
      agent: chat.agent,
      cwd: chat.cwd,
      startedAt,
      status: "starting",
      view: "chat",
      agentSession: chat.id,
      ...(chat.named ? { agentTitle: chat.title } : { promptTitle: chat.title }),
    };
    const recent = pushRecent(state.recent, { agent: chat.agent, cwd: chat.cwd, at: startedAt });
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      /* no storage */
    }
    set({ list: [r, ...state.list], recent });
    keys.set(id, `agent:${id}`);
    registerRoute(id);
    store().actions.openSession(id);
    await ready();
    let msgs: Msg[] = [];
    try {
      msgs = (await host.pastMessages(chat.agent, chat.id, chat.cwd)).map((m, i) => ({ id: `p-${i}`, role: m.role, text: m.text, ts: m.ts }));
    } catch {
      /* the conversation continues all the same; only its earlier messages are not shown */
    }
    if (!rec(id)) return id; // closed meanwhile
    openChat(id, "", msgs);
    onAgentSession(id);
    await startAgentChat(id, chat.id);
    return id;
  };

  /** Show session `id`'s folder in the file manager; a failure is said under its chat. */
  const revealFolder = async (id: string) => {
    const r = rec(id);
    if (!r?.cwd) return;
    try {
      await host.reveal(workDir(r));
    } catch (e) {
      note(id, errText(e));
    }
  };

  /** Open the person's own system terminal in session `id`'s folder; a failure is said under its chat. */
  const openTerminal = async (id: string) => {
    const r = rec(id);
    if (!r?.cwd) return;
    try {
      await host.openTerminal(workDir(r));
    } catch (e) {
      note(id, errText(e));
    }
  };

  /** Open session `id`'s folder in the person's editor, through the host this store was built with. A lane's own folder when it has
   *  one (`workDir`), else the session's; a failure is said under its chat in the app's own words (code/editor.ts) and
   *  returned, for a row that has no chat to say it under. */
  const openInEditor = async (id: string): Promise<string | null> => {
    const r = rec(id);
    if (!r?.cwd) return null;
    try {
      await openFolderInEditor(host, workDir(r));
      return null;
    } catch (e) {
      const why = errText(e);
      note(id, why);
      return why;
    }
  };

  /** Change a draft's agent or folder (refused once it has started). */
  const setDraft = (id: string, p: { agent?: AgentId; cwd?: string }) => {
    const r = rec(id);
    if (!r || r.status !== "draft") return;
    const patch: Partial<SessionRec> = {};
    if (p.agent) patch.agent = p.agent;
    if (p.cwd) patch.cwd = p.cwd;
    picked.set(id, { ...picked.get(id), ...(p.agent ? { agent: true } : {}), ...(p.cwd ? { cwd: true } : {}) });
    patchRec(id, patch);
  };

  /** The native folder dialog for a draft, opening at its folder; cancelling it changes nothing. */
  const chooseFolder = async (id: string): Promise<string | null> => {
    const r = rec(id);
    if (!r || r.status !== "draft") return null;
    const folder = await host.pickFolder(r.cwd || state.home || "");
    if (folder) setDraft(id, { cwd: folder });
    return folder;
  };

  /** Pick how a draft opens, Chat or Terminal (one the agent has; remembered for the agent on this computer). */
  const setOpen = (id: string, way: OpenAs) => {
    const r = rec(id);
    if (!r || r.status !== "draft" || !opensAs(r.agent, state.agents)[way]) return;
    const opens = { ...state.opens, [r.agent]: way };
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(opens));
    } catch {
      /* no storage */
    }
    set({ opens });
  };

  /**
   * Start a draft: its agent in its folder, `first` as the agent's first prompt (a chat agent; the bubble shows at
   * once). A draft opened as a terminal (the agent's own, or the person's pick) starts the program in the folder and
   * is sent nothing. From here the agent, folder and way of opening are fixed.
   */
  /** Workflow lanes `start` closed before their agent started, because no lane of their own could be made (item 91). */
  const laneless = new Set<string>();
  /** Workflow lanes being made with nobody there (item 114), and, for those the shell refused, the setting it named. */
  const unattended = new Set<string>();
  const laneConfig = new Map<string, string>();
  /** A workflow's lane with no branch and folder of its own: it never starts its agent, and goes (`close`, nothing is in it). */
  const refuseLaneless = (id: string): false => {
    laneless.add(id);
    close(id);
    return false;
  };

  const start = async (id: string, first?: string, startedAs?: string, files: OutFile[] = []): Promise<boolean> => {
    const r0 = rec(id);
    if (!r0 || r0.status !== "draft" || !r0.cwd) return false;
    // a continued chat starts its agent in the shared lane only while the other chat there does not work (item 97)
    if (waitsFor(id)) return false;
    await ready();
    const r = rec(id);
    if (!r || r.status !== "draft") return false; // closed or started meanwhile
    // a workflow's lane and a job's lane (Ask several, item 102a) are chats whatever way the person last opened the agent, and run
    // only in a lane of their own: a folder that is not a repository gets no agent (rule R1 of docs/several-agents.md)
    const own = !!(r.workflow || r.job || r.openedBy || r.helperOf);
    const open = own ? "chat" : draftOpen(r.agent, state.agents, state.opens);
    const mode = sessionMode(state.agents, { agent: r.agent, open });
    // such a lane runs only in a lane of its own, which only a chat has
    if (own && mode !== "chat") return refuseLaneless(id);
    const text = first?.trim() ?? "";
    // the first message's files are saved before anything starts: one that cannot be leaves the draft as it was
    // (its chips stay)
    let withFiles: Awaited<ReturnType<typeof prepare>> | null = null;
    if (files.length && mode === "chat") {
      try {
        withFiles = await prepare(id, text, files);
      } catch (e) {
        void host.removeFiles(id).catch(() => undefined);
        throw e;
      }
      if (rec(id)?.status !== "draft") return false; // closed meanwhile
    }
    picked.delete(id);
    const app = store().getState();
    const startedAt = Date.now();
    // the account it runs as is the one picked for new sessions now (recorded so a restart continues as it)
    // a chat continued on the same agent keeps the account it ran as (item 97)
    const account = r.account ?? accountFor(accounts(), r.agent);
    // a workflow's folder is not the person's last one: their next New session opens where they last worked, and a job's
    // lanes leave the last agent used as it was
    if (!own) {
      const recent = pushRecent(state.recent, { agent: r.agent, cwd: r.cwd, at: startedAt });
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
      } catch {
        /* no storage */
      }
      set({ recent });
    }
    patchRec(id, {
      startedAt,
      status: "starting",
      view: mode === "terminal" ? "terminal" : "chat",
      // only a way the agent does not open by itself is kept on the session
      ...(open === "terminal" && sessionMode(state.agents, { agent: r.agent }) !== "terminal" ? { open } : {}),
      ...(account ? { account } : {}),
      ...(r.startedAs || startedAs ? { startedAs: r.startedAs ?? startedAs } : {}),
      // oh-my-hermes runs on the bot you were looking at (else the first bot)
      // a folder chat runs on this computer: a bot on another one (`<peer>:<name>`) is never its engine
      ...(mode === "hermes" ? { bot: localBot(app.selectedBot, app.bots) } : {}),
    });
    // the message is sent: the draft view goes before its composer clears its own unsent text, so clear it here
    // (a terminal starts without the text and files the draft held)
    if (text || files.length || mode === "terminal") setUnsent(`agent:${id}`, "");
    // the first message names the session (as a later one would in send) until the agent or the person does
    const pt = text ? promptTitle(bareText(text)) : "";
    if (pt) patchRec(id, { promptTitle: pt });
    if (mode === "chat") {
      keys.set(id, `agent:${id}`);
      registerRoute(id);
      openChat(id);
      if (!text && !withFiles) {
        if (!r.lane && !(await startLane(id)) && own) return refuseLaneless(id);
        await startAgentChat(id);
        await setWanted(id);
        return true;
      }
      // the first prompt shows at once (with its files) and goes to the agent as soon as it runs
      const st = store();
      const key = keys.get(id)!;
      const lid = withFiles ? showWithFiles(id, key, text, withFiles) : `local-s${++localSeq}`;
      if (!withFiles) st.dispatch({ type: "local.user", bot: key, id: lid, text, now: Date.now() });
      // the lane's own branch is there before the agent has a chance to change a file; a workflow's agent starts only in one. A
      // chat made by Continue with already has the lane it shares (item 97): no second folder or branch is made
      if (!r.lane && !(await startLane(id)) && own) return refuseLaneless(id);
      await startAgentChat(id);
      await setWanted(id);
      try {
        await input(id, withFiles ? { ...withFiles.input, id: lid } : { kind: "send", text, id: lid });
      } catch (e) {
        st.dispatch({ type: "send.failed", bot: key, id: lid, error: errText(e) });
      }
    } else if (mode === "hermes") {
      await startFolderChat(id);
      if (text && rec(id)?.status === "running") await send(id, text);
    }
    return true;
  };

  /** The app theme in force, as the terminal views last reported it. */
  let look: "dark" | "light" = "dark";

  /** How many times session `id`'s terminal was started again (Restart): the view keys its terminal on it. */
  const termRuns = new Map<string, number>();
  /** What stops following each session's foreground CLI (its pty's `session-fg` events). */
  const fgOff = new Map<string, () => void>();

  /** TERMINALS Codex sessions that do not know their conversation id yet: the next ask. A running Codex holds its
   *  own rollout open once its first prompt is answered, so while the row's Codex runs the shell is asked which
   *  conversation the Codex in that terminal's foreground holds open (rule 11: only the pty id goes out, only a UUID
   *  comes back), 5 s after it started and every 15 s after, until it names one; that is kept as the row's
   *  `agentSession` so a restart continues it (`codex resume <id>`) and the asking stops. A row only ever hears of the
   *  file its own process holds, so another row's conversation can never come to it. A Codex that ends stops the
   *  asking and hands its id to no row (its row goes on as its shell and is not resumed); one that never learned it
   *  comes back paused. */
  const codexIdTimer = new Map<string, ReturnType<typeof setTimeout>>();
  const findCodexId = (id: string, t: Term, run: number, pty: number, wait: number) => {
    if (!host.codexConversation) return;
    clearTimeout(codexIdTimer.get(id));
    codexIdTimer.set(
      id,
      setTimeout(async () => {
        codexIdTimer.delete(id);
        const live = () => terms.get(id) === t && t.run === run && !t.closed && t.hostId === pty && rec(id)?.agent === "codex" && !rec(id)?.agentSession;
        if (!live()) return;
        const got = await host.codexConversation!(pty).catch(() => null);
        if (!live()) return;
        if (got) patchRec(id, { agentSession: got });
        else findCodexId(id, t, run, pty, CODEX_ID_EVERY_MS);
      }, wait),
    );
  };

  /** Whether the file of TERMINALS session `r`'s own conversation is where its CLI looks for it (rule 30, names
   *  only, in the home of the account it runs with); `unknown` when that could not be told. */
  const convState = async (r: SessionRec): Promise<ConvState> => {
    const agent = r.agent === "claude" || r.agent === "codex" ? r.agent : null;
    if (!host.conversationState || !r.agentSession || !agent) return "unknown";
    return host.conversationState(agent as "claude" | "codex", r.agentSession, accountOf(r)).catch(() => "unknown" as const);
  };

  /**
   * Start session `id`'s program in its terminal `t`. A Shell row runs the person's login shell; a CLI row runs its
   * CLI and, when that ends, goes on as the login shell in the same terminal (same scrollback, size and folder), so
   * the next CLI the person starts there is followed like any other (`session-fg`). When the shell of a TERMINALS row
   * ends the row closes, as its x does; a shell that ends with an error before the person typed anything (it could
   * not start properly) stays, with what it printed.
   */
  const startTerm = async (id: string, t: Term) => {
    const r = rec(id);
    if (!r) return;
    const run = ++t.run;
    const shell = isShell(r.agent);
    const io: TermIo = shell ? getShellHost() : host;
    t.io = io;
    t.hostId = null;
    t.closed = false;
    t.keyed = false;
    t.heard = false;
    t.keyedHeard = false;
    t.told = null;
    // the terminal view of a chat session does not decide the session's status; the chat does
    const ofChat = sessionMode(state.agents, r) !== "terminal";
    // a TERMINALS Claude Code or Codex session that has its own conversation continues it: put back after a restart
    // (by itself, once) and on Restart; Claude Code's terminal view of a chat continues the chat's conversation
    if (!ofChat) termAgain.delete(id);
    const again = !ofChat && !!r.agentSession && TERM_CONTINUES.includes(r.agent);
    // a TERMINALS oh-my-hermes terminal is told its row's link (MANUT_TERMINAL_LINK): `omh` reopens by itself the
    // session it dropped in this terminal (after manut restarted, or on Restart), and no other program is told it
    const link = !ofChat && r.agent === "omh" && isLinkId(r.linkId) ? r.linkId : undefined;
    let resume = again ? r.agentSession : r.agentSession && ofChat && r.agent === "claude" ? r.agentSession : undefined;
    // any other Claude Code terminal starts a new conversation under an id manut makes, kept (once it started) so a
    // restart continues it
    let sessionId = !ofChat && !resume && r.agent === "claude" ? newConversationId() : undefined;
    // its conversation's file is looked for first (not after Claude Code refused that id as a new one). Absent: a
    // Claude Code conversation nobody used (no key pressed in it, no title of its own) was never written (Claude Code
    // writes it on the first message), so it starts again under the same id; a used one was deleted, and Codex has
    // nothing to continue: neither is started to refuse it
    const forced = !!t.resumeOnce;
    t.resumeOnce = false;
    let gone = false;
    if (again && !forced && (await convState(r)) === "absent") {
      if (t.run !== run) return;
      const used = !!(rec(id)?.used || rec(id)?.agentTitle);
      if (r.agent === "claude" && !used) {
        resume = undefined;
        sessionId = r.agentSession;
      } else gone = true;
    }
    if (t.run !== run) return;
    // what this terminal showed before manut restarted comes first, dimmed, under a divider (once)
    if (!ofChat && histBack.delete(id)) {
      const back = await restoredText(host, id);
      if (t.run !== run) return;
      if (back) feed(t.term, back);
    }
    if (!ofChat && !histOf.has(id)) {
      const h = trackHistory(host, id, () => (terms.get(id) === t && !isParked(t.raw) ? t.term : null));
      const flush = () => h.flush();
      t.el.addEventListener(PARKING_EVENT, flush);
      histOf.set(id, { ...h, stop: () => (t.el.removeEventListener(PARKING_EVENT, flush), h.stop()) });
    }
    if (gone) {
      // ended as a CLI that could not continue it ends (termEnd), keeping its conversation for Restart
      t.closed = true;
      feed(t.term, `\x1b[2m[${tr("ss.convGone", { agent: agentDef(r.agent).label })}]\x1b[0m\r\n`);
      patchRec(id, { status: "exited", exitCode: null, resumeFailed: true });
      tellEnd(id, "ended", { code: null });
      return;
    }
    const { cols, rows } = t.term;
    let marked = 0;
    // this program's pty id once known, and what was drawn of its output before that
    let pty: number | null = null;
    let owed = 0;
    // the TERMINALS card's second line: the last line on its screen with text, read a moment after output stops
    // flowing in (once per OUT_MARK_MS at most), from the terminal itself
    let lineTimer: ReturnType<typeof setTimeout> | null = null;
    const readLine = () => {
      lineTimer = null;
      const b = t.term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < t.term.rows; y++) lines.push(b.getLine(b.baseY + y)?.translateToString(true) ?? "");
      const line = lastPrintedLine(lines) || undefined;
      // its own small store: a line change re-renders that one row, never the sessions list
      if (rec(id)) termActs.patch(id, { lastLine: line });
    };
    // parked before that read came (only an e2e's short thresholds allow it: a real park waits for a minute of
    // quiet): the line is read now, from the xterm being parked, so the read does not make it again
    const lineBeforePark = () => {
      if (t.run !== run) return t.el.removeEventListener(PARKING_EVENT, lineBeforePark);
      if (lineTimer === null) return;
      clearTimeout(lineTimer);
      readLine();
    };
    t.el.addEventListener(PARKING_EVENT, lineBeforePark);
    // a CLI started with the row's conversation id: whether it set up its screen before the person pressed a key in
    // it, and the last of what it printed (a refusal), read when it ends (termEnd)
    let drew = false;
    let drawn = 0;
    let said = "";
    const sayText = new TextDecoder();
    const onData = (d: Uint8Array | string) => {
      // every message is acknowledged once the terminal has taken it, in order: the shell reads the program
      // no further ahead of the page than its credit allows (to this program only: a replaced one is gone)
      const bytes = typeof d === "string" ? utf8.encode(d).length : d.byteLength;
      if (t.run === run) t.heard = true;
      if (again) {
        // only the end of a large message can be the end of the output
        const text = typeof d === "string" ? d.slice(-SAID_MAX) : sayText.decode(d.byteLength > SAID_MAX ? d.subarray(d.byteLength - SAID_MAX) : d, { stream: true });
        if (!drew && !t.keyedHeard) {
          drawn += bytes;
          drew = drawn > UI_BYTES || setsUpScreen(said.slice(-16) + text); // a sequence split between two messages
        }
        said = (said + text).slice(-SAID_MAX);
      }
      feed(t.term, d, () => {
        if (t.run !== run) return;
        if (pty === null) owed += bytes;
        else io.ack(pty, bytes);
      });
      histOf.get(id)?.touch();
      // the TERMINALS row's spinner and age: when output last flowed (throttled)
      const now = Date.now();
      if (!ofChat && now - marked >= OUT_MARK_MS) {
        marked = now;
        termActs.patch(id, { lastOut: now });
      }
      if (!ofChat && lineTimer === null) lineTimer = setTimeout(readLine, OUT_MARK_MS);
    };
    // when this program was asked for: a CLI continuing its conversation that ends soon after could not continue it
    const began = Date.now();
    try {
      const onExit = (code: number | null) => {
        // a program manut stopped (the row closed, Restart) or one already replaced says nothing more
        if (terms.get(id) !== t || t.run !== run) return;
        t.closed = true;
        termActs.patch(id, { progress: undefined });
        if (lineTimer !== null) clearTimeout(lineTimer);
        lineTimer = null;
        fgOff.get(id)?.();
        fgOff.delete(id);
        if (rec(id)?.fgAgent) setSessionFg(id, null);
        // its row was closed and waits to be undone: with the program gone there is nothing to undo
        if (t.held) {
          grace.finish(id);
          return;
        }
        const label = agentDef(r.agent).label;
        // the look missed a conversation Claude Code has (it refused the id as a new one): continue it, once
        if (again && sessionId && !t.keyedHeard && idInUse(said, sessionId)) {
          t.resumeOnce = true;
          patchRec(id, { status: "starting", exitCode: null });
          void startTerm(id, t);
          return;
        }
        // a CLI that could not continue its conversation keeps it, ended, for Restart (termEnd)
        const end = termEnd({ ofChat, shell, keyed: shell ? t.keyed : t.keyedHeard, code, resumed: again, drew, refused: again && !!r.agentSession && refusedResume(said, r.agentSession), ms: Date.now() - began });
        if (end === "shell") {
          // the CLI ended: the same terminal goes on as the person's login shell in that folder
          feed(t.term, `\r\n\x1b[2m${code ? tr("ss.backToShellExit", { agent: label, code }) : tr("ss.backToShell", { agent: label })}\x1b[0m\r\n`);
          patchRec(id, { agent: SHELL, open: undefined, account: undefined, agentSession: undefined, agentTitle: undefined, used: undefined, startedAs: undefined, fgAgent: null, status: "starting", exitCode: null, error: undefined });
          void startTerm(id, t);
          return;
        }
        if (end === "close") {
          // exit, Ctrl+D: the row goes, as closing it with its x does (nothing runs, so no undo window)
          close(id);
          return;
        }
        if (!ofChat) {
          patchRec(id, { status: "exited", exitCode: code, ...(again ? { resumeFailed: true } : {}) });
          tellEnd(id, "ended", { code });
        }
        feed(t.term, `\r\n\x1b[2m[${code ? tr("ss.termEndedExit", { agent: label, code }) : tr("ss.termEnded", { agent: label })}]\x1b[0m\r\n`);
      };
      // a Shell row is the person's login shell (the bottom panel's `shell_start`: only a folder and a size go out)
      // this computer's name first, so the program's first OSC 7 already counts as local
      await learnThisHost();
      let hostId: number;
      if (shell) {
        const got = await getShellHost().start(r.cwd || null, cols, rows, onData, onExit, rec(id)?.shell);
        hostId = got.id;
        if (got.missing && t.run === run) {
          // the shell it was made with is gone from this computer: the default one runs, and the row says so once
          feed(t.term, `\x1b[33m${tr("term.shellMissing", { shell: got.missing })}\x1b[0m\r\n`);
          patchRec(id, { shell: undefined });
        }
        // the folder it was asked to start in is gone (the host starts it in home, `shell_cwd`): the row is listed
        // under the folder it runs in, never under the dead folder's header, and both the terminal and that header
        // say so
        const at = ranElsewhere(r.cwd, got.cwd);
        if (t.run === run && rec(id)) {
          if (at) {
            feed(t.term, `\x1b[33m${tr("term.folderGoneRan", { folder: r.cwd, at })}\x1b[0m\r\n`);
            patchRec(id, { cwd: at });
          }
          if (r.cwd) setFolderGone(r.cwd, !!at);
          // a collapsed group would hide its notice
          if (at) openFolderGroup(r.cwd);
        }
      } else hostId = await host.start(r.agent, workDir(r), cols, rows, onData, onExit, resume, accountOf(r), sessionId, link);
      if (t.run !== run) {
        // replaced while starting
        void io.close(hostId).catch(() => undefined);
        return;
      }
      t.hostId = hostId;
      pty = hostId;
      // the TERMINALS row's mark follows the CLI the shell sees in the foreground (`session-fg`)
      fgOff.get(id)?.();
      fgOff.set(id, onSessionFg(hostId, (agent) => setSessionFg(id, agent)));
      if (t.closed) {
        // closed while starting
        void io.close(hostId);
        return;
      }
      if (sessionId) patchRec(id, { agentSession: sessionId });
      if (owed) io.ack(hostId, owed);
      owed = 0;
      // the program started at this size; one that changed while it started is sent now
      t.told = { cols, rows };
      t.reflowed = false; // nothing was drawn by the program yet: no screen of its to redraw
      if (t.settle === null) tellSize(t);
      if (!ofChat) patchRec(id, { status: "running" });
      if (!ofChat && r.agent === "codex" && !rec(id)?.agentSession) findCodexId(id, t, run, hostId, CODEX_ID_FIRST_MS);
    } catch (e) {
      if (t.run !== run) return;
      t.closed = true;
      const error = errText(e);
      if (!ofChat) {
        patchRec(id, { status: "failed", error });
        tellEnd(id, "failed", { error });
      }
      feed(t.term, `\x1b[31m${error}\x1b[0m\r\n`);
    }
  };

  /** The person pressed a key or pasted in session `id`'s running program `t`. Once that is after its first output, a
   *  Claude Code or Codex row's conversation counts as used (kept with the row). */
  const pressed = (id: string, t: Term) => {
    t.keyed = true;
    if (!t.heard || t.keyedHeard) return;
    t.keyedHeard = true;
    const r = rec(id);
    if (r && !r.used && TERM_CONTINUES.includes(r.agent)) patchRec(id, { used: true });
  };

  /** Tell the program its terminal's size, if it is not the one it was last told. */
  const tellSize = (t: Term) => {
    t.settle = null;
    if (t.hostId === null || t.closed) return;
    const { cols, rows } = t.term;
    const same = t.told?.cols === cols && t.told.rows === rows;
    const reflowed = t.reflowed;
    t.reflowed = false;
    if (same && !reflowed) return;
    t.told = { cols, rows };
    const hostId = t.hostId;
    // Back at the size the program knows after xterm changed it and back (a show re-fits in the DOM renderer's cells,
    // then in the GPU's): xterm reflowed and trimmed its screen, the program saw no change and would never redraw it,
    // and a pty resize to the size it has sends no SIGWINCH. One size off and then the real one does, in that order.
    if (same) {
      void t.io
        .resize(hostId, cols + 1, rows)
        .catch(() => undefined)
        .then(() => t.io.resize(hostId, cols, rows))
        .catch(() => undefined);
      return;
    }
    void t.io.resize(hostId, cols, rows).catch(() => undefined);
  };

  const disposeTerm = (id: string) => {
    const t = terms.get(id);
    if (!t) return;
    // its history keeping follows the next terminal of the session (Restart), or ends with it
    histOf.get(id)?.stop();
    histOf.delete(id);
    clearTimeout(codexIdTimer.get(id));
    codexIdTimer.delete(id);
    fgOff.get(id)?.();
    fgOff.delete(id);
    if (t.hostId !== null && !t.closed) void t.io.close(t.hostId).catch(() => undefined);
    t.closed = true;
    if (t.settle !== null) clearTimeout(t.settle);
    const wasParked = isParked(t.raw);
    t.undo();
    if (!wasParked) t.raw.dispose(); // a parked one was disposed when it was parked
    t.el.remove();
    terms.delete(id);
  };

  /** Mount session `id`'s terminal into `container` (creating and starting it the first time). */
  const attach = (id: string, container: HTMLElement, mode: "dark" | "light"): (() => void) => {
    look = mode;
    if (xtermMods) return mount(xtermMods, id, container);
    let detach: (() => void) | null = null;
    let gone = false;
    void loadXterm().then((m) => {
      if (!gone) detach = mount(m, id, container);
    });
    return () => {
      gone = true;
      detach?.();
    };
  };

  const mount = ([{ Terminal }, { FitAddon }]: Xterm, id: string, container: HTMLElement, quiet = false): (() => void) => {
    const settings = readTermSettings();
    const theme = termTheme(look, settings);
    let t = terms.get(id);
    const fresh = !t;
    if (!t) {
      const el = document.createElement("div");
      el.className = "term-host";
      const make = (opts: ITerminalOptions & ITerminalInitOnlyOptions) => {
        const term = new Terminal(opts);
        const fit = new FitAddon();
        term.loadAddon(fit);
        return { term, fit };
      };
      const first = make(termOptions(theme, settings));
      t = {
        get term() {
          return live(this.raw);
        },
        raw: first.term,
        fit: first.fit,
        el,
        hostId: null,
        closed: false,
        undo: () => undefined,
        told: null,
        reflowed: false,
        settle: null,
        io: isShell(rec(id)?.agent) ? getShellHost() : host,
        run: 0,
        keyed: false,
        heard: false,
        keyedHeard: false,
      };
      terms.set(id, t);
      const tt = t;
      // the person's own keys or paste reached the program (engine-input.ts, paste-guard.ts); the terminal's replies to
      // a program's queries also go out through onData and are not input
      // (keys while nothing runs there, or while its row waits to be undone, reach no program and do not count)
      el.addEventListener(TERM_INPUT_EVENT, () => {
        if (tt.hostId === null || tt.closed || tt.held) return;
        pressed(id, tt);
      });
      // a parked terminal made again: the same options and handlers, at the size it had, where it was
      tt.remake = ({ cols, rows }) => {
        const s = readTermSettings();
        const th = termTheme(look, s);
        const next = make({ ...termOptions(th, s), cols, rows });
        tt.raw = next.term;
        tt.fit = next.fit;
        wire(next.term);
        next.term.open(tt.el);
        tt.undo = afterOpen(next.term, tt.el, s, tt.remake);
        applyLook(next.term, th, s);
        return next.term;
      };
      const wire = (term: Terminal) => {
        term.onData((d) => {
          if (tt.hostId === null || tt.closed || tt.held) return;
          void tt.io.write(tt.hostId, d).catch(() => undefined);
        });
        // the title the program sets (OSC 0/2): the TERMINALS card's second line until it prints a line
        term.onTitleChange((title) => {
          const v = title.replace(/\s+/g, " ").trim().slice(0, LAST_LINE_MAX) || undefined;
          if (rec(id)) termActs.patch(id, { oscTitle: v });
        });
        term.onResize(() => {
          tt.reflowed = true;
          // the size it ends on is sent, once (a drag gives one size per frame)
          if (tt.settle !== null) clearTimeout(tt.settle);
          tt.settle = setTimeout(() => tellSize(tt), RESIZE_SETTLE_MS);
        });
        // The program rang the terminal's bell, as agents do when they wait for the person. manut reads nothing the
        // program prints: the bell is the one thing a terminal tells it. The row says so and a notification goes
        // out, once, until the person comes back to the session.
        const ring = () => {
          const r = rec(id);
          if (r && !tt.closed && flag(id, "bell")) notifyState?.(id, { kind: "bell", name: nameOf(r), agent: termMarkAgent(r) !== null });
        };
        term.onBell(ring);
        // The notification escapes agents send instead of a bell count as a ring too: OSC 9 with a message (not a
        // `9;<number>` report such as the 9;4 progress bar) and OSC 777 `notify`. Their text is never shown or kept.
        term.parser.registerOscHandler(9, (d) => {
          if (!/^\d+(;|$)/.test(d)) ring();
          return false; // not consumed: another handler may want the escape
        });
        term.parser.registerOscHandler(777, (d) => {
          if (d.startsWith("notify;")) ring();
          return false;
        });
      };
      wire(first.term);
      // the folder its shell reports (OSC 7): the row's folder line. Progress (OSC 9;4): working while reported; done
      // after working, unseen, marks the row as the bell does (no notification: a report is not a ring). Both come
      // on the element, which a parked terminal made again keeps, and go with it.
      onCwd(el, (path) => {
        if (rec(id)) termActs.patch(id, { cwd: path });
      });
      onProgress(el, (st) => {
        if (!rec(id) || tt.closed) return;
        if (st === "busy") return termActs.patch(id, { progress: true });
        if (!termActs.get(id).progress) return;
        termActs.patch(id, { progress: undefined });
        flag(id, "bell");
      });
    }
    const tt = t;
    container.appendChild(tt.el);
    if (fresh) {
      tt.raw.open(tt.el);
      tt.undo = afterOpen(tt.raw, tt.el, settings, tt.remake);
    }
    applyLook(tt.term, theme, settings);
    const refit = () => {
      if (!tt.el.isConnected || tt.el.clientWidth === 0) return;
      // shown again with the GPU renderer on its way: fitted in the standard renderer's cells now, it is fitted again
      // in the GPU's, and the screen is reflowed twice. The engine's CELLS_EVENT fits it once, when they are known.
      if (!fresh && gpuComing(tt.raw)) return;
      try {
        tt.fit.fit();
      } catch {
        /* not measurable yet */
      }
    };
    // shown first: the engine then knows a GPU renderer is coming (`gpuComing`) when the first fit is made, and the
    // terminal is fitted again when its cells change size (CELLS_EVENT: the GPU renderer arrived, or went)
    tt.el.addEventListener(CELLS_EVENT, refit);
    onVisible(tt.term, true);
    refit();
    if (fresh) void ready().then(() => startTerm(id, tt));
    const ro = new ResizeObserver(refit);
    ro.observe(container);
    if (!quiet) tt.term.focus();
    return () => {
      ro.disconnect();
      tt.el.removeEventListener(CELLS_EVENT, refit);
      onVisible(tt.raw, false);
      if (tt.el.parentElement === container) container.removeChild(tt.el);
    };
  };

  /** A paused TERMINALS session's kept history (dimmed, under its divider), shown read-only in `container` until the
   *  person presses Resume: a terminal of its own that starts nothing, takes no keys and is not the session's
   *  terminal (Resume makes that one, which writes the same history back first). `shown` hears whether there was any. */
  const previewHistory = (id: string, container: HTMLElement, mode: "dark" | "light", shown: (has: boolean) => void): (() => void) => {
    let gone = false;
    let term: Terminal | null = null;
    let ro: ResizeObserver | null = null;
    if (!histBack.has(id)) {
      shown(false);
      return () => undefined;
    }
    void Promise.all([loadXterm(), restoredText(host, id)]).then(([[{ Terminal: Term }, { FitAddon }], text]) => {
      if (gone) return;
      if (!text) return shown(false);
      const s = readTermSettings();
      const theme = termTheme(mode, s);
      const t = (term = new Term({ ...termOptions(theme, s), disableStdin: true, cursorBlink: false }));
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(container);
      applyLook(t, theme, s);
      const refit = () => {
        if (!container.isConnected || container.clientWidth === 0) return;
        try {
          fit.fit();
        } catch {
          /* not measurable yet */
        }
      };
      refit();
      ro = new ResizeObserver(refit);
      ro.observe(container);
      // the kept text, and no cursor: nothing runs here
      t.write(`${text}\x1b[?25l`);
      shown(true);
    });
    return () => {
      gone = true;
      ro?.disconnect();
      term?.dispose();
    };
  };

  /** Type text at session `id`'s terminal prompt, as if the person had (a dropped file's path). */
  const typeAt = async (id: string, text: string) => {
    const t = terms.get(id);
    if (!t || t.hostId === null || t.closed || t.held) return;
    pressed(id, t);
    await t.io.write(t.hostId, text);
    t.term.focus();
  };

  /** Type a bot's prompt the person allowed (termShare.ts: the card's Allow, each request its own) into session
   *  `id`'s terminal, then Enter. A bracketed paste when the program turned that on, so a many-line prompt arrives as
   *  one (a parked terminal keeps the mode it had: term/engine.ts `bracketedPaste`); else its lines are typed as a
   *  paste types them. Control characters never reach the program (the prompt is
   *  cleaned before and here). Nothing else calls this. */
  const typeAllowed = async (id: string, prompt: string) => {
    const t = terms.get(id);
    if (!t || t.hostId === null || t.closed || t.held) return false;
    // eslint-disable-next-line no-control-regex
    const text = prompt.replace(/\r\n/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
    if (!text.trim()) return false;
    const bracketed = bracketedPaste(t.raw);
    await t.io.write(t.hostId, bracketed ? `\x1b[200~${text}\x1b[201~\r` : `${text.replace(/\n/g, "\r")}\r`);
    return true;
  };

  /** Files dropped or pasted on session `id`'s terminal: each saved under the session's own folder (the page
   *  never sees a dropped file's own path), then the saved paths typed at the prompt, shell-quoted (a paste when the
   *  program turned bracketed paste on: attach.ts `pathsTyped`). */
  const dropOnTerminal = async (id: string, files: { name: string; read: () => Promise<Uint8Array> }[], windows: boolean) => {
    const t = terms.get(id);
    if (t?.held) return; // closed, waiting to be undone: nothing is saved or typed
    const paths: string[] = [];
    for (const f of files) {
      try {
        paths.push(shellQuote(await host.saveFile(id, f.name, await f.read()), windows));
      } catch (e) {
        if (t) feed(t.term, `\r\n\x1b[31m${tr("att.failed", { name: f.name, error: errText(e) })}\x1b[0m\r\n`);
        return;
      }
    }
    const now = terms.get(id);
    if (paths.length && now) await typeAt(id, pathsTyped(paths, bracketedPaste(now.raw)));
  };

  const stopChat = async (id: string) => {
    const p = procs.get(id);
    if (!p) return;
    p.stopping = true;
    procs.delete(id);
    endLiveTurn(id, "interrupted");
    if (p.kind === "agent" && p.hostId !== undefined) await host.chatClose(p.hostId).catch(() => undefined);
    if (p.kind === "folder" && p.bot && p.fid) await store().actions.folderClose(p.bot, p.fid).catch(() => undefined);
  };

  /**
   * Switch a chat session between its chat and its agent's terminal. Claude Code's terminal continues the
   * same conversation (`--resume`), and coming back continues it in the chat; every other agent's terminal
   * starts its TUI fresh while its chat stays as it was.
   */
  const setView = async (id: string, view: "chat" | "terminal") => {
    const r = rec(id);
    if (!r || r.view === view || sessionMode(state.agents, r) === "terminal") return;
    // a Hermes chat without oh-my-hermes has no terminal view: that view would start `omh`
    if (view === "terminal" && r.agent === "omh" && hermesOnly(state.agents)) return;
    if (r.agent === "claude" && r.agentSession) {
      if (view === "terminal") {
        await stopChat(id);
        disposeTerm(id); // a fresh terminal each time, resuming the conversation as it is now
        patchRec(id, { view });
      } else {
        disposeTerm(id);
        patchRec(id, { view, status: "starting" });
        await startAgentChat(id, r.agentSession);
        // Claude Code's own terminal titles the conversation; the chat continues it under that title
        void readAgentTitle(id);
      }
      return;
    }
    patchRec(id, { view });
  };

  /** A session opened as a terminal whose agent has no terminal on this computer any more (oh-my-hermes was removed
   *  and only Hermes is left) goes on as its agent opens by itself, instead of starting a program that is not there. */
  const lostTerminal = (id: string) => {
    const r = rec(id);
    if (!r || r.open !== "terminal" || state.agents === null || opensAs(r.agent, state.agents).terminal) return;
    const t = terms.get(id);
    if (t && !t.closed) return; // its program still runs: leave it be
    disposeTerm(id);
    // a Hermes chat runs on a bot: the one in view (else the first), as a New session picks it
    const app = store().getState();
    const bot = agentDef(r.agent).mode === "hermes" && !r.bot ? localBot(app.selectedBot, app.bots) : undefined;
    patchRec(id, { open: undefined, view: "chat", ...(bot ? { bot } : {}) });
  };

  /**
   * Start an ended session's agent again: a chat agent in the same chat, a terminal agent in a fresh terminal, in
   * the same folder and account. Agents in `CONTINUES` continue their conversation (Claude Code `--resume`, Codex
   * `thread/resume`, OmO `--session`, DSH `--session-id`); the others (pi, oh-my-pi, Grok's terminal) start a new one.
   */
  const restart = async (id: string) => {
    lostTerminal(id);
    const r = rec(id);
    if (!r || (r.status !== "exited" && r.status !== "failed") || isGone(r.agent)) return;
    if (sessionMode(state.agents, r) === "terminal") {
      // a fresh terminal: the view mounts it and starts the program (continuing the conversation, as startTerm says)
      const t = terms.get(id);
      if (t && !t.closed) return;
      disposeTerm(id);
      termRuns.set(id, (termRuns.get(id) ?? 0) + 1);
      patchRec(id, { status: "starting", error: undefined, exitCode: null, view: "terminal", paused: undefined, resumeFailed: undefined });
      return;
    }
    if (procs.has(id) || sessionMode(state.agents, r) !== "chat") return;
    const resume = continues(r.agent) && r.agentSession ? r.agentSession : undefined;
    patchRec(id, { status: "starting", error: undefined, exitCode: null, view: "chat", paused: undefined });
    patchLive(id, { signin: undefined });
    note(id, null);
    await startAgentChat(id, resume);
  };

  /** Start an ended TERMINALS session whose CLI could not continue its conversation (the conversation or its account
   *  folder is gone) as a new conversation, in the same folder and account: the old id and the agent's title for it
   *  go first. */
  const startFresh = async (id: string) => {
    if (!rec(id)?.resumeFailed) return;
    patchRec(id, { agentSession: undefined, agentTitle: undefined, resumeFailed: undefined, used: undefined });
    await restart(id);
  };

  /**
   * Start a session that was running when manut closed and did not continue by itself (pi, oh-my-pi, Grok,
   * oh-my-hermes, a chat whose conversation id was never reported), in the same folder and account. Once only.
   */
  const resume = async (id: string) => {
    lostTerminal(id);
    const r = rec(id);
    if (!r?.paused || procs.has(id) || terms.has(id)) return;
    const mode = sessionMode(state.agents, r);
    if (mode === "chat") return restart(id);
    if (mode === "terminal") {
      // the terminal view starts the program when it mounts
      patchRec(id, { paused: undefined, status: "starting", error: undefined, exitCode: null });
      return;
    }
    patchRec(id, { paused: undefined, status: "starting", error: undefined, exitCode: null });
    // oh-my-hermes: the same Hermes chat when the bridge still has it (`folder.resume`, by the stored id the row kept)
    if (r.agentSession && r.bot && !(await reattachFolder(id))) return;
    // else a new Hermes chat in the folder; the saved one was only a picture of the old chat
    const old = keys.get(id);
    if (old) {
      keys.delete(id);
      setChatRoute(old, null);
      store().dispatch({ type: "chat.forget", bot: old });
    }
    await startFolderChat(id);
  };

  /**
   * Put back the sessions saved before manut restarted (once per page load; a second call does nothing, so no
   * program starts twice). Each keeps its id, folder, account and chat. A chat that was running and continues a
   * conversation (Claude Code, Codex, OmO) continues it; a TERMINALS Claude Code or Codex terminal continues its
   * conversation and an oh-my-hermes terminal starts again (`omh` reopens the session it dropped there); an
   * oh-my-hermes folder chat is attached again (`folder.resume`), paused with the reason when the bridge refuses; any
   * other running one comes back paused; ended ones stay ended (with Restart).
   */
  const restore = (saved: SavedSession[]) => {
    if (restored || state.list.length > 0) return;
    restored = true;
    if (!saved.length) {
      // the drafts kept on Home keep their files' folders (app/stash.ts)
      void ready().then(() => host.pruneFiles(draftFolders()).catch(() => undefined));
      void ready().then(() => turns.prune([]));
      void ready().then(() => pruneHistory(host, savedPanelKeys()));
      saveSentFiles({});
      return;
    }
    const list: SessionRec[] = [];
    const again: { id: string; resume: string }[] = [];
    // generic ACP agents the shell has not described yet (it answers after this): whether they continue by themselves
    // is known once it has
    const later: string[] = [];
    // oh-my-hermes terminals: started once the agents are known (an `omh` gone from this computer comes back paused)
    const omhLater: string[] = [];
    // oh-my-hermes folder chats to attach again once the bridge is up, each saved chat (bot and stored id) once: a
    // second row holding the same one comes back paused, so one Hermes session is never attached for two rows
    const folderAgain: string[] = [];
    const folderTaken = new Set<string>();
    for (const kept of saved) {
      // a Grok session saved while Grok was a terminal only is that terminal (item 101b)
      const s = savedOpen(kept);
      if (isGone(s.agent) && s.draft) {
        // a New session never started on an agent manut no longer offers: a draft again, on the usual agent
        list.push({ id: s.id, agent: draftAgent(state.recent, state.agents), cwd: s.cwd, startedAt: s.startedAt, view: "chat", status: "draft" });
        picked.set(s.id, { cwd: true });
        seq = Math.max(seq, Number(s.id.slice(1)) || 0);
        continue;
      }
      if (isGone(s.agent)) {
        // an agent manut no longer offers (Kilo Code): ended, with its chat as it was, one plain line and no Restart
        // (SessionView's Ended); nothing is started, now or on Resume
        list.push({ id: s.id, agent: s.agent, cwd: s.cwd, startedAt: s.startedAt, view: "chat", status: "exited", exitCode: null, ...(s.title ? { title: s.title } : {}), ...(s.modelTitle ? { modelTitle: s.modelTitle } : {}), ...(s.agentTitle ? { agentTitle: s.agentTitle } : {}), ...(s.promptTitle ? { promptTitle: s.promptTitle } : {}) });
        seq = Math.max(seq, Number(s.id.slice(1)) || 0);
        keys.set(s.id, `agent:${s.id}`);
        openChat(s.id, s.model ?? "", (s.messages ?? []).map((m) => ({ id: `r-${m.id}`, role: m.role, text: m.text, ts: m.ts })));
        continue;
      }
      // a job's lane that was still starting when the app closed: it never ran, and a draft of the person's it is not
      if (s.draft && (s.job || s.helperOf)) {
        seq = Math.max(seq, Number(s.id.slice(1)) || 0);
        continue;
      }
      if (s.draft) {
        // a New session chat that never started: a draft again, with its agent and folder fixed by the person
        list.push({
          id: s.id,
          agent: s.agent,
          cwd: s.cwd,
          startedAt: s.startedAt,
          view: "chat",
          status: "draft",
          // a chat made by Continue with keeps the lane it shares, its link and the account it continues under (item 97)
          ...(s.continuedFrom ? { continuedFrom: s.continuedFrom, ...(s.lane ? { lane: s.lane } : {}), ...(s.account ? { account: s.account } : {}), ...(s.modelWant ? { modelWant: s.modelWant } : {}) } : {}),
        });
        picked.set(s.id, { agent: true, cwd: true });
        seq = Math.max(seq, Number(s.id.slice(1)) || 0);
        continue;
      }
      const mode = sessionMode(state.agents, s);
      if (s.agent === "dsh" && s.view === "terminal") {
        // manut 0.2.4's DSH ran deepseek-bot's terminal (its id is a deepseek-bot conversation): it comes back ended
        // with a plain line and never starts deepseek-bot; Restart starts DeepSeek Harness in the folder
        list.push({ id: s.id, agent: s.agent, cwd: s.cwd, startedAt: s.startedAt, view: "chat", status: "exited", exitCode: null, error: tr("ss.dshOld"), ...(s.title ? { title: s.title } : {}) });
        seq = Math.max(seq, Number(s.id.slice(1)) || 0);
        keys.set(s.id, `agent:${s.id}`);
        openChat(s.id);
        continue;
      }
      // TERMINALS lists terminal sessions only: a saved chat-mode session is kept as it was (its files and messages
      // stay) but is not listed and never starts again
      const terminalOnly = !isTerminalRec(state.agents, { agent: s.agent, open: s.open, status: "exited" });
      // a helper lane is not started again by itself: its round did not survive the restart, so it comes back paused (item 102h)
      const auto = !terminalOnly && s.running && mode === "chat" && continuesItself(s) && !s.helperOf;
      // a TERMINALS Claude Code or Codex session that was running continues its own conversation in a fresh terminal;
      // an oh-my-hermes one starts again, and `omh` reopens what it dropped there
      const termAuto = !terminalOnly && s.running && mode === "terminal" && termComesBack(s);
      // an oh-my-hermes folder chat that was running is attached again (rule 3: only one the bridge made)
      const folderAuto = s.running && mode === "hermes" && !!s.agentSession && !!s.bot && !folderTaken.has(`${s.bot}\0${s.agentSession}`);
      if (folderAuto) folderTaken.add(`${s.bot}\0${s.agentSession}`);
      const r: SessionRec = {
        id: s.id,
        agent: s.agent,
        cwd: s.cwd,
        startedAt: s.startedAt,
        // a chat agent comes back as its chat (its terminal view would start the program on sight)
        view: mode === "terminal" ? "terminal" : "chat",
        ...(s.open === "terminal" ? { open: s.open } : {}),
        status: auto || termAuto || folderAuto ? "starting" : s.failed ? "failed" : "exited",
        exitCode: s.running ? null : (s.exitCode ?? null),
        ...(s.error && !s.running ? { error: s.error } : {}),
        ...(s.agentSession ? { agentSession: s.agentSession } : {}),
        ...(s.resumeFailed && s.agentSession && !s.running ? { resumeFailed: true } : {}),
        ...(s.used && s.agentSession ? { used: true } : {}),
        ...(s.account ? { account: s.account } : {}),
        ...(s.bot ? { bot: s.bot } : {}),
        ...(s.model ? { model: s.model } : {}),
        // its name comes back with it
        ...(s.title ? { title: s.title } : {}),
        ...(s.modelTitle ? { modelTitle: s.modelTitle } : {}), ...(s.agentTitle ? { agentTitle: s.agentTitle } : {}),
        ...(s.promptTitle ? { promptTitle: s.promptTitle } : {}),
        ...(s.mode ? { mode: s.mode } : {}),
        ...(s.effort ? { effort: s.effort } : {}),
        ...(s.shell && isShell(s.agent) ? { shell: s.shell } : {}),
        // a lane keeps its branch and its own folder: Resume and Restart start its agent there, never in the developer's
        ...(s.lane ? { lane: s.lane } : {}),
        ...(s.workflow ? { workflow: s.workflow } : {}),
        ...(s.helpers ? { helpers: true as const } : {}),
        ...(s.reach?.length ? { reach: s.reach } : {}),
        ...(s.continuedFrom ? { continuedFrom: s.continuedFrom } : {}),
        ...(s.continuedIn ? { continuedIn: s.continuedIn } : {}),
        ...(s.job ? { job: s.job } : {}),
        ...(s.helperOf ? { helperOf: s.helperOf } : {}),
        ...(s.running && !auto && !termAuto && !folderAuto ? { paused: true } : {}),
      };
      list.push(r);
      seq = Math.max(seq, Number(s.id.slice(1)) || 0);
      if (mode !== "terminal") {
        keys.set(s.id, `agent:${s.id}`);
        // fresh ids: the agent's own message ids start over in its new process
        const msgs: Msg[] = (s.messages ?? []).map((m) => ({ id: `r-${m.id}`, role: m.role, text: m.text, ts: m.ts }));
        if (sentFiles[s.id]) void openWithFiles(s.id, s.model ?? "", msgs);
        else openChat(s.id, s.model ?? "", msgs);
      }
      if (auto) again.push({ id: s.id, resume: s.agentSession! });
      if (termAuto) termAgain.add(s.id);
      if (termAuto && TERM_REOPENS.includes(s.agent)) omhLater.push(s.id);
      if (folderAuto) folderAgain.push(s.id);
      if (!terminalOnly && mode === "terminal") histBack.add(s.id);
      else if (s.running && s.agentSession && !isBuiltin(s.agent) && !acpRow(s.agent) && !terminalOnly) later.push(s.id);
    }
    // each keeps its link (a session saved before links existed, or a clash, gets a fresh one)
    const taken = new Set(state.list.map((r) => r.linkId).filter((x): x is string => !!x));
    for (const [i, r] of list.entries()) {
      const was = saved.find((x) => x.id === r.id)?.linkId;
      const linkId = was && !taken.has(was) ? was : freshLinkId(taken);
      taken.add(linkId);
      list[i] = { ...r, linkId };
    }
    set({ list: [...list, ...state.list] });
    for (const r of list) if (keys.has(r.id)) registerRoute(r.id);
    // the saved copies of sessions that are gone go; the ones kept show again in their bubbles
    const ids = list.map((r) => r.id);
    void ready().then(() => host.pruneFiles([...ids, ...draftFolders()]).catch(() => undefined));
    // and the kept turns of sessions that are gone
    void ready().then(() => turns.prune(ids));
    // the kept history of terminals that are gone goes (the bottom panel's tabs keep theirs)
    void ready().then(() => pruneHistory(host, [...ids, ...savedPanelKeys()]));
    saveSentFiles(Object.fromEntries(Object.entries(sentFiles).filter(([sid]) => ids.includes(sid))));

    // the home folder (for `~/…` paths) and each agent's mode, as a first launch would read them; then the generic ACP
    // agents' chats whose row says they continue go on by themselves, as the others did
    void loadAgents().then(() => {
      for (const id of later) {
        const r = rec(id);
        if (r?.paused && continues(r.agent) && sessionMode(state.agents, r) === "chat") void resume(id);
      }
      // an oh-my-hermes terminal whose `omh` is no longer here (only Hermes is) comes back paused, as it did before
      const gone = omhLater.filter((id) => {
        const r = rec(id);
        return !!r && r.status === "starting" && !terms.has(id) && !opensAs(r.agent, state.agents).terminal;
      });
      for (const id of gone) {
        termAgain.delete(id);
        patchRec(id, { status: "exited", exitCode: null, paused: true });
      }
      const go = omhLater.filter((id) => termAgain.has(id));
      if (go.length && typeof document !== "undefined") void loadXterm().then((m) => go.forEach((id) => startOffPage(m, id)));
    });
    if (again.length) void ready().then(() => Promise.all(again.map(({ id, resume: rid }) => (procs.has(id) ? undefined : startAgentChat(id, rid)))));
    // their terminals are made and started now, off the page (a view that opens one later takes it as it is)
    const now = [...termAgain].filter((id) => !omhLater.includes(id));
    if (now.length && typeof document !== "undefined") void loadXterm().then((m) => now.forEach((id) => startOffPage(m, id)));
    // the folder chats once the bridge has put back the bots: refused or failed, a row is paused with the reason
    if (folderAgain.length)
      void store().resumed.then(() =>
        Promise.all(
          folderAgain.map(async (id) => {
            if (procs.has(id) || rec(id)?.status !== "starting") return;
            const why = await reattachFolder(id);
            if (why !== null && rec(id)?.status === "starting" && !procs.has(id)) patchRec(id, { status: "exited", exitCode: null, paused: true, error: why });
          }),
        ),
      );
  };

  /** Make session `id`'s terminal and start its program without showing it: measured in a box off the page, then
   *  taken off it, as a terminal whose view the person left. Nothing happens when its view already made it. */
  const startOffPage = (m: Xterm, id: string) => {
    if (terms.has(id) || !rec(id)) return;
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:-10000px;top:0;width:960px;height:600px;visibility:hidden";
    document.body.appendChild(box);
    try {
      mount(m, id, box, true)();
    } finally {
      box.remove();
    }
  };

  /** What a closed row needs to come back: itself, where it stood in the list, and the split it was in. */
  type Held = { rec: SessionRec; index: number; split: SplitWas | null };
  /** Closed TERMINALS rows whose program still runs for the undo window; at its end the old close runs, once. */
  const grace = createCloseGrace<Held>({ expire: (g) => close(g.id) });
  /** The rows of closes waiting out their window (no longer listed): what `close` reads when the window ends. */
  const heldRecs = new Map<string, SessionRec>();
  if (typeof document !== "undefined") {
    // a hidden window may hold timers back: whatever passed its deadline closes when the window shows again
    document.addEventListener("visibilitychange", () => grace.sweep());
    window.addEventListener("focus", () => grace.sweep());
  }
  /** The undo window now, in ms (0: Off). The mock host takes `window.__manutCloseGraceMs` for a window that is on;
   *  a browser driven by a test (`navigator.webdriver`) that set none closes at once, as specs written before the
   *  undo window expect (term-close-undo.spec.ts sets it). */
  const graceNow = () => {
    let w: unknown;
    if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
      w = (window as unknown as { __manutCloseGraceMs?: unknown }).__manutCloseGraceMs;
      if (w === undefined && typeof navigator !== "undefined" && navigator.webdriver) w = 0;
    }
    return graceMs(readTermSettings().undoClose, w);
  };

  /** Close TERMINALS row `id` so it can be undone: it leaves the list (and its split) now, its terminal takes no
   *  input, its program runs on hidden. False when it closes as before: the setting is Off, it is not a TERMINALS row,
   *  or its program is not running (ended, or still starting with nothing yet). */
  const holdable = (id: string): boolean => {
    const r = rec(id);
    const t = terms.get(id);
    return !!r && !!t && !t.closed && !t.held && t.hostId !== null && isTerminalRec(state.agents, r) && graceNow() > 0;
  };
  /** What opens when `id`, the session in view, goes away (its program ended, or it was closed): the pane of its
   *  split that takes its place; else the row below it in the sidebar (the folder groups as shown, as ⌘⇧] steps),
   *  or the nearest above when it was the last. `was` still holds `id`, `list` no longer does. */
  const successor = (id: string, was: SessionRec[], list: SessionRec[]): string | null => {
    const left = new Set(list.map((s) => s.id));
    const heir = leaveIn(getSplit().groups, id).heir;
    if (heir && left.has(heir)) return heir;
    const order = orderFolders(folderGroups(was.filter((r) => isTerminalRec(state.agents, r))), getFolderPrefs().order).flatMap((g) => g.rows.map((r) => r.id));
    const at = order.indexOf(id);
    const near = at < 0 ? undefined : [...order.slice(at + 1), ...order.slice(0, at).reverse()].find((x) => left.has(x));
    if (near) return near;
    const index = was.findIndex((s) => s.id === id);
    return list[Math.min(index, list.length - 1)]?.id ?? null;
  };

  const holdClosed = (id: string): boolean => {
    const r = rec(id);
    const t = terms.get(id);
    if (!r || !t || !holdable(id)) return false;
    const ms = graceNow();
    const g = groupOf(getSplit().groups, id);
    const index = state.list.findIndex((s) => s.id === id);
    const split: SplitWas | null = g ? { layout: g.layout, ...(g.zoom ? { zoom: true as const } : {}) } : null;
    if (!grace.begin(id, r.title || nameOf(r), ms, { rec: r, index, split })) return false;
    heldRecs.set(id, r);
    t.held = true;
    const was = state.list;
    const list = was.filter((s) => s.id !== id);
    set({ list });
    const ui = store().getState().ui;
    if (ui.view === "session" && ui.session === id) store().actions.openSession(successor(id, was, list));
    return true;
  };

  /** Undo the close of row `id` (the newest when none is named): the same row, terminal and program back where it
   *  was, in its split when that is still there. False when there is nothing to undo. */
  const undoClose = (id?: string): boolean => {
    const which = id ?? grace.list()[0]?.id;
    const g = which ? grace.undo(which) : null;
    if (!g) return false;
    heldRecs.delete(g.id);
    const t = terms.get(g.id);
    if (t) t.held = false;
    const list = [...state.list];
    list.splice(Math.max(0, Math.min(g.data.index, list.length)), 0, g.data.rec);
    set({ list });
    if (g.data.split) {
      const groups = restoreSplitIn(getSplit().groups, g.id, g.data.split, new Set(list.map((r) => r.id)));
      if (groups !== getSplit().groups) setSplit({ groups });
    }
    store().actions.openSession(g.id);
    return true;
  };

  /** The person closes session `id` (row x, its menu, ⌘W): a running TERMINALS row waits out the undo window first
   *  (Settings › Terminal), anything else closes at once. A shell that ended by itself closes through `close`. */
  const closeRow = (id: string) => {
    if (holdClosed(id)) return;
    if (grace.finish(id)) return;
    close(id);
  };

  /** Stop the program(s) and remove the session. A row that waited out its undo window is no longer listed: its
   *  kept row says what it was. */
  const close = (id: string) => {
    const r = rec(id) ?? heldRecs.get(id);
    heldRecs.delete(id);
    picked.delete(id);
    histOf.get(id)?.stop();
    histOf.delete(id);
    histBack.delete(id);
    termAgain.delete(id);
    if (r && isTerminalRec(state.agents, { ...r, status: "exited" })) forgetHistory(host, id);
    disposeTerm(id);
    // the lane's folder goes once its agent has stopped, when nothing in it would be lost
    // a lane two chats share (Continue with, item 97) keeps its folder until the last of them is closed
    const free = !r || laneFree(state.list, r);
    void stopChat(id).then(() => Promise.all([host.removeFiles(id).catch(() => undefined), free ? letLaneGo(r?.lane) : undefined]));
    turns.forget(id);
    forgetSentFiles(id);
    // a helper lane that had not reported is back as stopped by the person; a lead's helper lanes stop and land nothing (item 102h)
    runs.closed(id);
    leads.forget(id);
    reach.forget(id);
    const key = keys.get(id);
    if (key) {
      // a title being written for it stops with it (item 96): nobody is left to read it, and it is the person's own use
      if (writingTitle.has(id)) void host.titleCancel?.(key).catch(() => undefined);
      setChatRoute(key, null);
      store().dispatch({ type: "chat.forget", bot: key }); // its asks leave the Needs-you strip with it
      forgetLane(key);
      forgetChatPull(key);
      // the lane's preview stops with its session, so no dev server of a closed lane runs on unseen
      forgetPreview(key);
    }
    keys.delete(id);
    const was = state.list;
    const list = was.filter((s) => s.id !== id);
    const models = { ...state.models };
    delete models[id];
    const notes = { ...state.notes };
    delete notes[id];
    const live = { ...state.live };
    delete live[id];
    const unseen = { ...state.unseen };
    delete unseen[id];
    set({ list, models, notes, live, unseen });
    const ui = store().getState().ui;
    if (ui.view === "session" && ui.session === id) store().actions.openSession(successor(id, was, list));
  };

  /** A person's own agent was removed on Settings › Agents: each open session of it ends cleanly (its program is
   *  stopped, its chat stays as it was, it says it ended), its drafts move to the usual agent, and the + menu forgets it. */
  const endAgent = async (agent: AgentId) => {
    for (const r of state.list.filter((x) => x.agent === agent)) {
      if (r.status === "draft") {
        picked.delete(r.id);
        patchRec(r.id, { agent: draftAgent(state.recent, (state.agents ?? []).filter((a) => a.id !== agent)) });
        continue;
      }
      disposeTerm(r.id);
      if (procs.has(r.id)) await stopChat(r.id);
      if (r.status === "running" || r.status === "starting" || r.paused) patchRec(r.id, { status: "exited", exitCode: null, paused: undefined });
    }
    const recent = state.recent.filter((x) => x.agent !== agent);
    set({ recent });
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      // storage refused: the recents are only this page's until it loads again
    }
    await loadAgents();
  };

  /** Name a session (Rename). Empty or null = back to the automatic name. Kept on this computer under the agent's
   *  own conversation id, so the name follows the conversation when it is resumed. */
  /** Row `id` dragged in TERMINALS to just before (or after) row `to` of the same folder: the list keeps that order,
   *  and so does the saved list (`manut.resume`). Rows of another folder, or the same place, change nothing. */
  const moveRow = (id: string, to: string, after: boolean) => {
    if (id === to) return;
    const r = rec(id);
    const at = rec(to);
    if (!r || !at || pathKey(r.cwd) !== pathKey(at.cwd)) return;
    const rest = state.list.filter((x) => x.id !== id);
    const i = rest.findIndex((x) => x.id === to);
    const list = [...rest.slice(0, after ? i + 1 : i), r, ...rest.slice(after ? i + 1 : i)];
    if (list.every((x, k) => x === state.list[k])) return;
    set({ list });
  };

  const rename = (id: string, title: string | null) => {
    const r = rec(id);
    if (!r || r.status === "draft") return; // a draft is named once it starts
    const t = (title ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
    patchRec(id, { title: t || undefined });
    const k = titleKey(r);
    if (k) saveTitles(putTitle(titles, k, t || null));
  };

  /** Chats whose title a model is writing now: one run at a time for a chat. */
  const writingTitle = new Set<string>();
  /** The title the person's chosen model writes for chat session `id` (item 96): off unless Settings › Titles and words is on. It is
   *  asked after a first answer, from the first message and that answer. The words go in as `modelTitle`, which ranks below a name
   *  the person gave; a name given while it ran is kept and the words dropped. `again` is "Write the title again". Quietly nothing
   *  when the host cannot, and `note`s why when the person asked and it failed. */
  const writeTitle = async (id: string, again = false) => {
    const r = rec(id);
    const settings = titleModel();
    const key = keys.get(id);
    if (!r || !key || !host.titleRun || writingTitle.has(id) || !wantsTitle(r, settings, again)) return;
    const material = chatMaterial(chatOf(key)?.messages ?? []);
    if (!material) return;
    writingTitle.add(id);
    try {
      const words = await host.titleRun(titleRequest(r.agent, settings, key, material));
      const patch = acceptTitle(rec(id), words);
      if (patch) patchRec(id, patch);
    } catch (e) {
      // an automatic run fails quietly (the title stays what it was); the person's own ask says why
      if (again) note(id, tr(`titles.why.${whyKey(e)}` as Key));
    } finally {
      writingTitle.delete(id);
    }
  };
  /** "Write the title again": for a chat the person has not named. */
  const rewriteTitle = (id: string) => writeTitle(id, true);

  /** Change a chat session's model (Claude Code `set_model`, Codex per turn, pi `set_model`, Hermes). */
  const setModel = async (id: string, option: ModelOption) => {
    const p = procs.get(id);
    if (!rec(id) || !p) return;
    note(id, null);
    try {
      if (p.kind === "folder") {
        const cur = await store().actions.folderSetModel(p.bot!, p.fid!, { model: option.id, ...(option.provider ? { provider: option.provider } : {}) });
        patchRec(id, { model: cur.model || option.label });
      } else {
        await input(id, { kind: "model", model: option.id });
      }
    } catch (e) {
      note(id, tr("ss.modelNotChanged", { error: errText(e) }));
    }
  };

  /** The Helpers switch in a lane's box (item 102e): on, the lane's agent is told how to ask for helper lanes with each message and
   *  its requests become Start helpers cards; off, a card still open is taken back. Kept with the session. Refused (false) where it
   *  is not offered: a chat with no lane of its own, a workflow's lane, an agent that does not run as a chat. */
  const setHelpers = (id: string, on: boolean): boolean => {
    if (!leads.offered(id)) return false;
    patchRec(id, { helpers: on ? true : undefined });
    if (!on) leads.switchedOff(id);
    return true;
  };

  /** Change a chat session's permission mode (Claude Code's own switch; Codex from its next turn). Kept with the
   *  session, so a restart sets it again. Only the modes controls.ts offers for the agent. */
  const setMode = async (id: string, mode: string) => {
    const r = rec(id);
    // a helper lane runs in its agent's Ask mode, set by the job, whatever the person or its lead would pick (item 102h, rule R3)
    if (!r || r.helperOf || !modesOf(r.agent).includes(mode)) return;
    note(id, null);
    try {
      await input(id, { kind: "mode", mode });
      patchRec(id, { mode });
    } catch (e) {
      note(id, tr("ss.modelNotChanged", { error: errText(e) }));
    }
  };

  /** Change a chat session's reasoning effort, one of the levels its agent reported. */
  const setEffort = async (id: string, effort: string) => {
    const r = rec(id);
    if (!r || !(state.live[id]?.efforts ?? []).includes(effort)) return;
    note(id, null);
    try {
      await input(id, { kind: "effort", effort });
      patchRec(id, { effort });
    } catch (e) {
      note(id, tr("ss.modelNotChanged", { error: errText(e) }));
    }
  };

  /** Every open terminal takes the look again: the app theme changed, or a terminal setting did. */
  const relook = () => {
    const settings = readTermSettings();
    const theme = termTheme(look, settings);
    for (const t of terms.values()) {
      if (isParked(t.raw)) continue; // takes the look when it is made again
      applyLook(t.term, theme, settings);
      // a changed font or line height changes how many cells fit
      if (t.el.isConnected && t.el.clientWidth > 0) {
        try {
          t.fit.fit();
        } catch {
          /* not measurable yet */
        }
      }
    }
  };
  // Every session view calls this when it mounts and when the app theme changes: only a mode the terminals have not
  // been given yet relooks them all (each mount used to re-apply the look and refit every open terminal)
  let looked: "dark" | "light" | null = null;
  const setLook = (mode: "dark" | "light") => {
    look = mode;
    if (mode === looked) return;
    looked = mode;
    relook();
  };
  onTermSettings(relook);

  return {
    getState: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Stop whatever an earlier load of this page left running (called once at startup). */
    reset: ready,
    loadAgents,
    endAgent,
    draft,
    draftChat,
    startWorkflowLane,
    startJob,
    /** Hear every chat's events after the session handled them (a workflow's run); the returned function stops it. */
    onChatEvent(fn: (id: string, ev: ChatEvent) => void) {
      chatWatchers.add(fn);
      return () => {
        chatWatchers.delete(fn);
      };
    },
    draftHere,
    continueWith,
    stopIdle,
    /** The chat linked by Continue with that works in session `id`'s lane now, so `id` waits (null: none). */
    waitsFor,
    startTerminal,
    setSessionFg,
    /** The pty id session `id`'s terminal runs on (the `session-fg` event's id), null before it started. */
    ptyOf: (id: string): number | null => terms.get(id)?.hostId ?? null,
    /** The id the shell gave session `id`'s chat (what `chat_start` answered), null before it started or for a session that is no
     *  coding chat of the shell's: what keeps running names its commands by it, as `ptyOf` names a terminal's. */
    chatIdOf: (id: string): number | null => procs.get(id)?.hostId ?? null,
    /** The native folder dialog (TERMINALS + menu's "Choose folder…"); null when cancelled. */
    pickFolder: (at: string) => host.pickFolder(at),
    continuePast,
    revealFolder,
    openTerminal,
    openInEditor,
    setDraft,
    setOpen,
    chooseFolder,
    start,
    attach,
    close: closeRow,
    /** Closing row `id` now could be undone (its row then closes without asking: the toast's Undo is the way back). */
    closeUndoable: holdable,
    undoClose,
    /** Closed rows waiting out their undo window, newest first (the toasts). */
    closing: grace.list,
    onClosing: grace.subscribe,
    setLook,
    setView,
    setModel,
    setMode,
    setEffort,
    setHelpers,
    /** Session `id` shows the "Kit may reach" list under its box (item 102k). */
    reachOffered: (id: string): boolean => reach.offered(id),
    /** Adds chat `ref` to session `id`'s "Kit may reach" list, at the person's press: null when added, else the line to show. */
    addReach: (id: string, ref: ThreadRef): string | null => reach.add(id, ref),
    /** Takes listed chat `n` off session `id`'s list; a card still open that names it is taken back. */
    removeReach: (id: string, n: number): void => reach.remove(id, n),
    /** Puts `text` in session `id`'s chat as a message from elsewhere, held while its turn runs, while messages wait ahead of it or
     *  while any ask or question of it waits, and never steered in, so its words never answer anything. For a message the person
     *  sent on from a card that showed it whole (item 102k's Send there, item 103c's); false when the chat's agent cannot take it. */
    route: (id: string, text: string): Promise<boolean> => route(id, text),
    /** Starts an ordinary lane at the person's Start lane on a card that showed its title, agent and brief whole (item 102k's, item
     *  103d's): in its agent's Ask mode, beside the person's drafts, not opened in front of them, the brief its first message. */
    openLane: (p: OpenLane): Promise<{ ok: true; id: string } | { ok: false; why: string }> => startOpenedLane(p),
    /** The person's yes (`yes`) or no on reach card `askId` of session `id`: checked again, settled once in approval-core, and only
     *  then read, sent or opened (item 102k). */
    answerReach: (id: string, askId: string, yes: boolean) => reach.answer(id, askId, yes),
    /** Session `id` may show the Helpers switch (item 102e). */
    helpersOffered: (id: string): boolean => leads.offered(id),
    /** The person's Start helpers (`start`) or Not now on the card `askId` of session `id`: settled once in approval-core; no agent
     *  starts (item 102h listens on `whenHelperRoundApproved`). */
    answerHelpers: (id: string, askId: string, start: boolean) => leads.answer(id, askId, start),
    /** Item 102e's hand-off: each round the person approved with Start helpers (item 102h's runs listen and start its lanes). */
    whenHelperRoundApproved: (fn: Parameters<typeof leads.whenRoundApproved>[0]) => leads.whenRoundApproved(fn),
    /** Session `id`'s rounds of helper lanes, as item 102d's rules keep them. */
    helperRounds: (id: string) => leads.roundsOf(id),
    /** The helper lanes of round `round` (the Card's rows, item 102h), and how to hear them change. */
    helperRuns: (round: string) => runs.roundRuns(round),
    onHelperRuns: (fn: () => void) => runs.subscribe(fn),
    /** How many helper lanes run at once on this Mac, once its memory was read (null before), and the read itself. */
    helpersAtOnce: () => runs.atOnce(),
    readHelpersAtOnce: () => runs.readCap(),
    /** The person's Stop on one helper lane of a round, or on all of them: only ever a press (item 102h, rule R5). */
    stopHelper: (round: string, index: number) => runs.stop(round, index),
    stopHelpers: (round: string) => runs.stopAll(round),
    /** Item 102h's hand-off to 102i and 102j: each helper lane that comes back, with its report bound to its round. */
    whenHelperBack: (fn: Parameters<typeof runs.whenBack>[0]) => runs.whenBack(fn),
    /** Helper `index` of round `round`'s landing, as its row on the Helpers card shows it (item 102i). */
    helperLanding: (round: string, index: number) => landings.viewOf(round, index),
    /** Take back this landing (item 102i): the lead's folder as it was before it. */
    takeBackLanding: (round: string, index: number) => landings.takeBack(round, index),
    subscribeLandings: (fn: () => void) => landings.subscribe(fn),
    /** Every helper's landing, by `round:index`: the same value until one changes (the Helpers card). */
    landingSnapshot: () => landings.snapshot(),
    /** The budget's clock, read now (tests drive it with their own clock). */
    helperTick: () => runs.tick(),
    /** Helper session `id`'s budget as it stands (tests). */
    helperBudget: (id: string) => runs.budgetOf(id),
    rename,
    rewriteTitle,
    moveRow,
    restart,
    startFresh,
    resume,
    restore,
    send,
    sendFiles,
    dropOnTerminal,
    typeAllowed,
    /** Session `id`'s terminal program runs and takes input now (what `typeAllowed` needs). */
    canType: (id: string): boolean => {
      const t = terms.get(id);
      return !!t && t.hostId !== null && !t.closed && !t.held;
    },
    /** The ↵ ↓ × buttons of a waiting message (steer queue sessions): Send now or Steer, Edit, Delete. */
    queuePick,
    /** Esc / Stop: the agent's own interrupt. */
    interrupt: (id: string) => input(id, { kind: "interrupt" }).catch(() => undefined),
    /** Rewind to before a turn: each coding session's kept turns and their snapshots (rewind.ts). */
    turns,
    /** Rewind session `id` to before turn `turn` (the id of the message that began it): the files, every file in `keep`
     *  left as it is, then the chat; the chat then says what went back. Throws a RewindError when it did not happen. */
    rewindTo: async (id: string, turn: string, keep: string[]) => {
      const key = keys.get(id);
      const item = key ? store().getState().chats[key]?.items.find((i) => i.kind === "user" && i.id === turn) : undefined;
      const title = item && item.kind === "user" ? turnTitle(item.text) : "";
      const done = await turns.rewind(id, turn, keep);
      if (key) store().dispatch({ type: "system.note", bot: key, text: rewoundNote(title, done.changed), now: Date.now() });
      return done;
    },
    /** Bring it back (the lane's Reverted state): put session `id`'s files back as they were just before its last rewind. Every
     *  file changed since the rewind stays as it is unless it is in `overwrite` (the ones the person saw listed and unticked).
     *  The chat stays where the rewind left it, since neither Claude Code nor Codex has a message that brings a rewound chat
     *  back; the chat says what came back, and the lane reads by its tests again. Throws when the files could not be put back
     *  (they are as they were) or are no longer kept. */
    bringBack: async (id: string, overwrite: string[]) => {
      const key = keys.get(id);
      const done = await turns.bringBack(id, overwrite);
      if (key) {
        store().dispatch({ type: "system.note", bot: key, text: broughtBackNote(done.changed), now: Date.now() });
        noteLaneEvent(key, { event: "files.back" });
      }
      return done;
    },
    /** Edit and resend: the agent takes back the last message (its own rewind), then the box holds its text. */
    rewind: async (id: string) => {
      try {
        await input(id, { kind: "rewind" });
      } catch (e) {
        note(id, errText(e));
      }
    },
    /** The session whose link id is `linkId`, if it is in the list. */
    byLink: (linkId: string): SessionRec | null => state.list.find((r) => r.linkId === linkId) ?? null,
    /** Session `id`'s link (`manut://terminal/<id>`), null when it has none. */
    linkOf: (id: string): string | null => {
      const l = rec(id)?.linkId;
      return l ? termLinkUrl(l) : null;
    },
    /** Copy session `id`'s link to the clipboard; false when it has none or the clipboard refused. */
    copyLink: async (id: string): Promise<boolean> => {
      const l = rec(id)?.linkId;
      if (!l) return false;
      try {
        await navigator.clipboard.writeText(termLinkUrl(l));
        window.dispatchEvent(new CustomEvent<string>(LINK_COPIED_EVENT, { detail: id }));
        return true;
      } catch {
        return false;
      }
    },
    /** Session `id` has a terminal in this page load (an ended one keeps its output until it is closed). */
    hasTerm: (id: string) => terms.has(id),
    previewHistory,
    /** Changes each time Restart starts session `id`'s terminal program again. */
    termRun: (id: string) => termRuns.get(id) ?? 0,
    /** The session whose chat has app-store key `key`. */
    byKey,
    /** The app-store chat key of session `id`'s chat, if it has one. */
    chatKey: (id: string | null) => (id ? (keys.get(id) ?? null) : null),
    /** Hook for system notifications of session chats (the app sets it). */
    setNotify(fn: ((ev: BridgeEvent) => void) | null) {
      notify = fn;
    },
    /** The person opened session `id`: what its row carried for them is seen. */
    seen,
    /** Hook for system notifications of what a session did outside its chat (the app sets it). */
    setNotifyState(fn: ((id: string, n: SessionNote) => void) | null) {
      notifyState = fn;
    },
  };
}

export type SessionsStore = ReturnType<typeof createSessions>;

let singleton: SessionsStore | null = null;
export function getSessions(): SessionsStore {
  if (!singleton) {
    const s = createSessions(getHost(), getStore, accountGroups, taskHost);
    singleton = s;
    // e2e (mock host only): drive a terminal's foreground CLI the way the shell's event will
    if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) (window as unknown as { __manutSessions?: SessionsStore }).__manutSessions = s;
    setSessionKeyLookup((id) => s.chatKey(id));
    // the folder of the session in view opens in the Code page's list, wherever the person is (revealOpen.ts)
    watchOpenFolder(getStore(), s);
    s.setNotify((ev) => notifySessionEvent(ev, getStore().getState()));
    s.setNotifyState((id, n) => notifySessionNote(id, n, getStore().getState()));
  }
  return singleton;
}

export function useSessions(): SessionsState {
  const s = getSessions();
  return useSyncExternalStore(s.subscribe, s.getState, s.getState);
}
