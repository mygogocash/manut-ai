// Where session processes run. In the desktop app: the Tauri shell, which starts an allow-listed agent
// in a pseudo-terminal (src-tauri/src/sessions.rs) or in its structured chat mode on pipes
// (src-tauri/src/agent_chat.rs). In a plain browser (dev, e2e against the mock bridge) there is no shell,
// so a mock host echoes terminal typing and a mock agent answers chats with the same events.
import type { HistoryHost } from "./term/history";
import { AGENTS, acpRow, agentDef, HERMES_LABEL, type AcpRow, type AgentId, type AgentInfo } from "./agents";
import { mockPtyOut, nextMockPty } from "./fg";
import mockAcpAgents from "./mockAcpAgents.json";
import { MockTurnFiles, tauriTurnFiles, type MockTurnGlobals, type TurnFilesHost } from "./turnFiles";
import { botRefusal, mockCheck, mockNewId, type CustomEntry, type CustomList, type CustomPreview, type CustomWhy } from "./custom";
import type { ApprovalChoice, AskTool, ClarifyAnswers } from "../lib/protocol";
import { t } from "../i18n";
import { steersOf } from "./controls";
import type { DiskLevel, DiskState } from "../lib/disk";
import type { ImportApp, ImportProfile } from "./term/import";
import { readLaneFolder, type LaneFolder } from "../code/laneFolder";
import { readView, type GitView } from "../code/moved";
import { MOCK_MOVED, MOCK_MOVED_ROOT } from "../code/mockMoved";
import { readCleaned, readKept, readMade, readReleased, readRemoved, type KeptLane, type LaneCleaned, type LaneMade, type LaneReleased, type LaneRemoveAsk, type LaneRemoved } from "../code/laneBranch";
import { readAgentConfig, type AgentConfig } from "../settings/mcp/agentConfig";
import { readInstallAsk, readInstallDone, readLinkRead, readSkillReads, type InstallAsk, type InstallDone, type LinkRead, type ReadSkill } from "../runtime/skillBundle";
import { readAsk, readDone, readDraft, readPulled, readTools, type MergeMethod, type Pulled, type ReviewAsk, type ReviewDone, type ReviewDraft, type SourceTools } from "../code/source";
import { checkArgs, checkVars, homeVarOf, rulesOf, versionAgent, type ProviderPatch, type ProviderView } from "../settings/providers/model";

/** What the person did in a chat. Mirrors `Input` in src-tauri/src/agent_chat.rs. `images`: saved copies
 *  (`saveFile`) of attached pictures, for the agent's own image input. */
export type ChatInput =
  | { kind: "send"; text: string; images?: string[]; /** the bubble's id: a queued message is reported by it */ id?: string }
  | { kind: "interrupt" }
  | { kind: "approve"; request_id: string; choice: ApprovalChoice }
  | { kind: "clarify"; request_id: string; answer: string | ClarifyAnswers }
  | { kind: "model"; model: string }
  /** the permission mode, one the shell offers for the agent (controls.ts MODES) */
  | { kind: "mode"; mode: string }
  /** reasoning effort, one of the levels the agent reported */
  | { kind: "effort"; effort: string }
  /** take back the last message, through the agent's own rewind (Claude Code and Codex) */
  | { kind: "rewind" }
  /** take back message `id` (its bubble's id) and everything after it, through the same rewinds: Rewind to before a
   *  turn (rewind.ts) */
  | { kind: "rewind_to"; id: string }
  /** a message manut held while a turn ran, handed to the running turn without stopping it (the agent's own
   *  mid-turn input; only the agents in controls.ts STEERS) */
  | { kind: "steer"; id: string; text: string };

/** An event from a chat agent: the bot chat's events (`turn.start`, `tool.start`, `delta`, `message`,
 *  `approval.request`, `turn.end`, …) plus `session.info`, `session.models`, `session.error` and, once,
 *  `exit`. */
export type ChatEvent = { event: string; [k: string]: unknown };

/** A conversation Claude Code or Codex keeps for a folder (src-tauri/src/past_chats.rs), listed read-only so it can be
 *  continued here. `at`: last change, seconds since the epoch. `named`: the title is a name, not the first words. */
export interface PastChat {
  agent: "claude" | "codex";
  id: string;
  cwd: string;
  title: string;
  named: boolean;
  at: number;
}

/** One message of such a conversation (what the person typed, or the agent's answer text). */
/** Whether a conversation's file is where its CLI looks for it (`conversation_state`). */
export type ConvState = "exists" | "absent" | "unknown";

export interface PastMsg {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

/** What Buddy's chat may be sent (`buddy_chat::check` in src-tauri): a message, text only (an attached file goes by
 *  its saved copy's path in the text), Stop, an answer, and the chat box's choices: a model Claude Code listed in that
 *  chat, one of its own effort levels, and an approval level of `BUDDY_MODES` (src/runtime/mock/buddy.ts). The shell
 *  checks each against its own fixed list and refuses anything else. */
export type BuddyChatInput =
  | { kind: "send"; text: string }
  | { kind: "interrupt" }
  | { kind: "approve"; request_id: string; choice: ApprovalChoice }
  | { kind: "clarify"; request_id: string; answer: string | ClarifyAnswers }
  | { kind: "model"; model: string }
  | { kind: "effort"; effort: string }
  | { kind: "mode"; mode: string };

/** Buddy's chat through the person's own coding agent (src-tauri/src/buddy_chat.rs): Claude Code with their own account
 *  and configuration, in `~/.manut/buddy/chat`, kept apart from the coding sessions so their reset never stops it. Only
 *  an agent id and Buddy's instructions cross to the shell, which writes the instructions to a file of its own. */
export interface BuddyHost {
  agents(): Promise<AgentInfo[]>;
  buddyStart(agent: AgentId, prompt: string, onEvent: (ev: ChatEvent) => void): Promise<number>;
  buddyInput(id: number, input: BuddyChatInput): Promise<void>;
  buddyClose(id: number): Promise<void>;
  /** Stop every one of Buddy's chats, those a page before this one started included. */
  buddyCloseAll(): Promise<void>;
  /** Save a file the person attached in Buddy's chat under `~/.manut/buddy/files` (`buddy_chat::save_file`) and give its
   *  path, which the message names. Outside Buddy's own folder, so its agent asks before it reads the copy. */
  buddySaveFile(name: string, data: Uint8Array): Promise<string>;
}

/** What a title run is asked (title_run.rs `Request`): `material` is already masked by the page. */
export interface TitleRequest {
  agent: string;
  model: string;
  effort: string;
  purpose: "title" | "pull";
  key: string;
  material: string;
}
export interface TitleWords {
  title: string;
  body: string;
}

export interface SessionHost extends HistoryHost {
  readonly kind: "tauri" | "mock";
  /** Stop anything an earlier page load left running (a webview reload keeps the shell alive). */
  reset(): Promise<void>;
  agents(): Promise<AgentInfo[]>;
  home(): Promise<string>;
  /** Native folder picker; null when the person cancels. */
  pickFolder(defaultPath: string): Promise<string | null>;
  /** Start `agent` in `cwd` in a terminal. Only the agent id goes to the shell: never a command line.
   *  `resume` is a Claude Code or Codex conversation id to continue (`--resume <id>`, `codex resume <id>`);
   *  `sessionId` the id manut made for a new Claude Code conversation (`--session-id <id>`); the shell checks each is
   *  a UUID. `account` names the Settings › Accounts login it runs as (the one it ran with, after a restart); none =
   *  the one picked for new sessions. `link` (oh-my-hermes only) is the row's link id, which the terminal gets as
   *  `MANUT_TERMINAL_LINK` so `omh` reopens the session it dropped there; the shell refuses it for any other agent. */
  start(
    agent: AgentId,
    cwd: string,
    cols: number,
    rows: number,
    onData: (data: Uint8Array | string) => void,
    onExit: (code: number | null) => void,
    resume?: string,
    account?: string,
    sessionId?: string,
    link?: string,
  ): Promise<number>;
  write(id: number, data: string): Promise<void>;
  /** The terminal has drawn `bytes` more of session `id`'s output. The shell stops reading the program while the
   *  page is behind and reads again as these come back, so every message handed to `onData` is acknowledged once,
   *  in order. Never waited for; a session that is gone takes none. */
  ack(id: number, bytes: number): void;
  resize(id: number, cols: number, rows: number): Promise<void>;
  close(id: number): Promise<void>;
  /** Start `agent` in its chat mode in `cwd` (`resume`: a Claude Code or OmO session id or a Codex thread id to continue;
   *  `account`: as for `start`; `session`: the SESSIONS id, whose attachment folder a Claude Code chat reads without a card;
   *  `mode`: the permission mode the person picked, one of `modesOf(agent)`, which the agent starts in. None: the shell starts
   *  it in its careful mode, Ask (item 89), so no project file and no `defaultMode` of the agent's own chooses it). */
  chatStart(agent: AgentId, cwd: string, onEvent: (ev: ChatEvent) => void, resume?: string, account?: string, session?: string, suggest?: boolean, mode?: string): Promise<number>;
  chatInput(id: number, input: ChatInput): Promise<void>;
  chatClose(id: number): Promise<void>;
  /** Save a file the person attached in session `session` under manut's own folder
   *  (`~/.manut/session-files/<session>/`); the saved copy's absolute path. */
  saveFile(session: string, name: string, data: Uint8Array): Promise<string>;
  /** The bytes of a file `saveFile` saved (a sent bubble's picture after a restart). */
  readFile(path: string): Promise<Uint8Array>;
  /** Remove session `session`'s saved files. */
  removeFiles(session: string): Promise<void>;
  /** Remove the saved files of every session not in `keep`. */
  pruneFiles(keep: string[]): Promise<void>;
  /** A coding session's files as they were when each turn began, for Rewind to before a turn (turnFiles.ts). */
  readonly turnFiles?: TurnFilesHost;
  /** The git branch checked out in `cwd` (read from its `.git/HEAD`; no program runs), "" when it is not a
   *  repository, a short commit id when detached. */
  branch(cwd: string): Promise<string>;
  /** Make a lane's own working folder (src/code/laneBranch.ts): a git worktree under `~/.manut/lanes`, on the first of
   *  `names` that no branch has yet, made from the commit the folder `cwd` is on. The developer's folder is not touched (its
   *  branch, index, stash and HEAD stay as they are), and nothing is pushed or merged. Rejects with a short code
   *  (`not_a_repository`, `no_commit`, `not_committed`, `busy`, `taken`, `git_missing`) or git's own words. Absent in a shell
   *  older than lanes' folders: the session then works in its own folder, with no lane of its own. */
  laneWorktree?(cwd: string, names: string[], start?: LaneStart): Promise<LaneMade>;
  /** Settings › Worktrees: check the folder chosen for lanes' folders and make it; resolves with its real path, rejects with a
   *  code (`bad_root`, `root_too_broad`, `root_in_checkout`, `root_unwritable`). */
  laneRootCheck?(root: string): Promise<string>;
  /** Settings › MCP and Skills: the MCP servers and skills Claude Code and Codex have, by name and where each comes from, read
   *  from their own files (src-tauri/src/agent_config.rs) for the person's own home and, when given, the project folder `cwd`.
   *  Only reads. Null where this computer's files cannot be read (a plain browser). */
  agentConfig?(cwd?: string): Promise<AgentConfig[] | null>;
  /** Sharing skills by a link (item 84; src-tauri/src/skill_links.rs): the person's own skill folders `folders` of `agent`, read so
   *  the page can show every file before anything is asked. Nothing is followed through a link. Rejects `<why>:<folder>`. Absent
   *  where this computer's files cannot be read. */
  skillBundleRead?(agent: "claude" | "codex", folders: string[]): Promise<ReadSkill[]>;
  /** The bundle at `link`, fetched by the shell only when it is on `origin` (the artifact origin the API named; `other_host` with
   *  nothing fetched otherwise), held to the bundle rules and kept by the shell under the answer's `read`. */
  skillLinkRead?(link: string, origin: string): Promise<LinkRead>;
  /** The ask to install skills `names` of kept bundle `read` for `agent`. Writes nothing; rejects `exists:<name>`, `link_root`... */
  skillInstallAsk?(read: string, names: string[], agent: "claude" | "codex"): Promise<InstallAsk>;
  /** The answer to install ask `id`, after approval-core settled it (runtime/skillInstallAsks.ts is the only caller): a Yes writes
   *  what the ask named, once, with no executable bit, running nothing. */
  skillInstallSettle?(id: string, yes: boolean): Promise<InstallDone>;
  /** Takes a waiting install ask back. */
  skillInstallWithdraw?(id: string): Promise<void>;
  /** Settings › Source control: git, gh and glab, each on this computer or not, its version, and for the two CLIs whether it is
   *  signed in and as whom (names only; src-tauri/src/source_tools.rs). `fresh` asks the CLIs again. Only reads. */
  sourceTools?(fresh?: boolean): Promise<SourceTools>;
  /** Settings › Source control › Automatically pull: bring the default branch checked out in project folder `cwd` up to date,
   *  only when nothing in it is changed, new, unpushed or in progress and only by a fast-forward (src-tauri/src/git_pull.rs).
   *  Never a lane's folder. Null for an answer that is not one. */
  sourcePull?(cwd: string): Promise<Pulled | null>;
  /** One short run of the person's own Claude Code that writes a chat's title or a pull request's words (src-tauri/src/title_run.rs,
   *  item 96). Only asked when Settings › Titles and words is on. Returns the cleaned words; writes nothing. Rejects with a code
   *  (`off`, `busy`, `too_many`, `timeout`, `cancelled`, `empty`, `unsupported`, ...) or the program's own line. */
  titleRun?(req: TitleRequest): Promise<TitleWords>;
  /** Stops the title run made for `key` (a chat's id), when it is the one running. */
  titleCancel?(key: string): Promise<void>;
  /** A lane put up for review (src-tauri/src/review.rs): what it would go up with. Only reads. */
  reviewDraft?(worktree: string): Promise<ReviewDraft | null>;
  /** The ask to push the lane at `worktree` and open its pull request with `title` and `body`: the exact repository, branch,
   *  base, title and body. Writes nothing; rejects with a code (`no_remote`, `not_signed_in`, `no_commits`, ...). */
  reviewAsk?(worktree: string, title: string, body: string): Promise<ReviewAsk>;
  /** The ask to merge pull request `number`, made from the lane at `worktree`, with `method`: asked only when it can merge now,
   *  with the method and exactly the message that will be sent, the recognised agent credit lines taken out when `credits`.
   *  Writes nothing; rejects with a code (`cannot_merge:<why>`,
   *  `not_this_lane`, `not_signed_in`, ...). */
  reviewMerge?(worktree: string, number: number, method: MergeMethod, credits?: boolean): Promise<ReviewAsk>;
  /** The same ask for request `number` of `repo` from the Pull requests list (item 100): `folder` is the project it was listed
   *  for, whose remote must name `repo` (`not_this_project` otherwise). A lane's request is asked as the lane's own Merge. Writes
   *  nothing. */
  reviewMergePull?(folder: string, source: "github" | "gitlab", repo: string, number: number, method: MergeMethod, credits?: boolean): Promise<ReviewAsk>;
  /** The person's answer to ask `id`, after approval-core settled it (code/reviewAsk.ts is the only caller): a No runs nothing, a
   *  Yes runs what the ask named, once. Only the id and the answer go to the shell. Rejects with `already_decided`,
   *  `withdrawn`, `expired` or `not_found`. */
  reviewSettle?(id: string, yes: boolean): Promise<ReviewDone>;
  /** Takes a waiting ask back. */
  reviewWithdraw?(id: string): Promise<void>;
  /** A clean-up removes a deleted chat's folder only when nothing in it is changed, new or unpushed; the branch stays. */
  laneRelease?(worktree: string): Promise<LaneReleased>;
  /** A clean-up of the lanes of `cwd`'s repository whose pull request merged, through the person's own `gh` or `glab`;
   *  `held` are folders a session still works in. */
  laneCleanMerged?(cwd: string, held: string[]): Promise<LaneCleaned>;
  /** The lanes' working folders the app made for the repository `cwd` is in, newest first (only reads). */
  laneList?(cwd: string): Promise<KeptLane[]>;
  /** The developer's folders the app's lanes were made from, so the Code page lists a project whose last session closed while
   *  its lane's folder was kept (only reads). */
  laneProjects?(): Promise<string[]>;
  /** Remove a lane's working folder the app made, and its branch when `ask.branch` says so, once what is there is what the
   *  person saw (`ask`); otherwise nothing is done and the answer says what is there now. Rejects `not_a_lane` for anything
   *  the app did not make. */
  laneRemove?(worktree: string, ask: LaneRemoveAsk): Promise<LaneRemoved>;
  /** The main branch moving while Kit worked (src/code/moved.ts): what the person's own `git` says of `cwd`, read-only
   *  (src-tauri/src/git_moved.rs): its branch, the branch it started from, and the files each side changed since. `show`
   *  are the paths whose two diffs are wanted; `base` names the branch it started from (none: `origin/HEAD`'s, else
   *  `main`, else `master`). null when there is nothing to say: not a repository, a detached HEAD, no git, the base itself. */
  mainMoved(cwd: string, o?: { base?: string | null; show?: string[] }): Promise<GitView | null>;
  /** What really changed in the lane's own folder `worktree` since the lane started, from git (the Diff beside the lane): each file
   *  with its state and text, bounded. null when this host cannot read a folder; rejects for a folder the app did not make. */
  laneDiff(worktree: string): Promise<LaneFolder | null>;
  /** Show folder `cwd` in the file manager. */
  reveal(cwd: string): Promise<void>;
  /** Open the person's own system terminal in folder `cwd` (their shell; nothing typed into it). */
  openTerminal(cwd: string): Promise<void>;
  /** The editors installed on this computer, from the shell's fixed list (item 107); the page offers only those. Absent on a
   *  shell older than the item: no editor is offered then. */
  editors?(): Promise<{ id: string; label: string }[]>;
  /** Open folder `cwd` in the editor `editor`, an id from that list and never a path or a command. */
  openInEditor?(cwd: string, editor: string): Promise<void>;
  /** The recent conversations `agent` keeps for `cwds`, newest first (read-only). */
  pastChats(agent: "claude" | "codex", cwds: string[]): Promise<PastChat[]>;
  /** The last messages of `agent`'s conversation `id` in `cwd`. */
  pastMessages(agent: "claude" | "codex", id: string, cwd: string): Promise<PastMsg[]>;
  /** Whether the file of `agent`'s conversation `id` is where the CLI looks for it, in the home of `account` (none =
   *  the account new sessions use): `unknown` when that could not be told (a folder that cannot be read, an account
   *  whose folder is gone). Only names are looked at (rule 30). */
  conversationState?(agent: "claude" | "codex", id: string, account?: string): Promise<ConvState>;
  /** The conversation the Codex in the foreground of terminal session `id` (its pty) holds open: the UUID of the
   *  rollout that process keeps open in its Codex home, or null while it holds none (rule 11; only the id comes back). */
  codexConversation?(id: number): Promise<string | null>;
  /** How many asks wait: a Dock / launcher count, or a dot on the Windows taskbar button. 0 clears it. */
  badge(count: number): Promise<void>;
  /** Keep the computer awake while agents work (src/lib/power.ts): a busy or idle edge. `now`: the setting went off,
   *  so the shell lets go at once instead of a minute later. */
  power?(busy: boolean, now: boolean): Promise<void>;
  /** Settings › Providers (item 74): every agent the app knows with what the person set for it, as the shell read its
   *  own file now. Variables come as names only. */
  providers?(): Promise<ProviderView[]>;
  /** One change to agent `id`'s settings, checked and saved by the shell; the answer is its new view. A refusal rejects
   *  with `why:<code>` or `why:<code>:<option or variable name>`, never a value. */
  providerSave?(id: string, patch: ProviderPatch): Promise<ProviderView>;
  /** The version agent `id`'s program prints (the token only), or null. */
  providerVersion?(id: string): Promise<string | null>;
  /** Settings › Agents: the person's own agents, read and checked by the shell from manut's own file, and the broken
   *  entries. */
  customList(): Promise<CustomList>;
  /** The confirm card for the Add agent form: the checked entry and the exact command manut will run. Writes nothing.
   *  A refusal rejects with `why:<code>`. */
  customPreview(label: string, program: string, args: string, install: string): Promise<CustomPreview>;
  /** The same card for a bot's `manut-agent` draft: the form's checks and stricter (no shell, interpreter or built-in
   *  program), the arguments as the draft's own list. Writes nothing. A refusal rejects with `why:<code>`. */
  customBotPreview(label: string, program: string, args: string[], install: string): Promise<CustomPreview>;
  /** The card's Add: the only call that writes an entry. */
  customConfirm(entry: CustomEntry): Promise<void>;
  /** The remove confirm: agent `id` leaves the file. */
  customRemove(id: string): Promise<void>;
  /** Free space on the home folder's volume (src/lib/disk.ts): Settings' warn value in GB (0 = off), answered with
   *  the level and the last reading. */
  diskWatch(warnGb: number): Promise<DiskState>;
  /** The shell's `disk-level` event: the level got worse. Returns what stops listening. */
  onDiskLevel(fn: (s: DiskState) => void): () => void;
  /** Settings › Terminal › Import from… (macOS): which of iTerm2 / Apple Terminal have a prefs file the shell can read
   *  (its fixed file, not a symlink, at most 8 MB). Nothing is read until the person presses the button. */
  termImportList(): Promise<ImportApp[]>;
  /** The profiles of `app` (default first, at most 64): names, `#rrggbb` colours and a font, read once, read-only. */
  termImportRead(app: ImportApp): Promise<ImportProfile[]>;
}

// ---- Tauri ----------------------------------------------------------------------------------

export class TauriHost implements SessionHost, BuddyHost {
  readonly kind = "tauri" as const;
  readonly turnFiles: TurnFilesHost = tauriTurnFiles(async () => (await this.core()).invoke);
  /** The shell's command bridge (a test stands in for it by overriding this). */
  protected async core(): Promise<Pick<typeof import("@tauri-apps/api/core"), "invoke" | "Channel">> {
    return import("@tauri-apps/api/core");
  }
  async reset() {
    const { invoke } = await this.core();
    // the lanes' previews too (src-tauri/src/preview.rs): a preview whose page is gone would run on unseen. A shell older than
    // the preview has no such command, and that stops nothing else.
    await Promise.all([invoke("session_close_all"), invoke("chat_close_all"), invoke("preview_close_all").catch(() => undefined)]);
  }
  async agents() {
    const { invoke } = await this.core();
    return invoke<AgentInfo[]>("sessions_agents");
  }
  async home() {
    const { homeDir } = await import("@tauri-apps/api/path");
    return homeDir();
  }
  async pickFolder(defaultPath: string) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    // canCreateDirectories: the dialog's own "New Folder" button (macOS); manut itself makes no folder
    const r = await open({ directory: true, multiple: false, canCreateDirectories: true, defaultPath, title: t("ss.pickFolder") });
    return typeof r === "string" ? r : null;
  }
  async start(agent: AgentId, cwd: string, cols: number, rows: number, onData: (d: Uint8Array) => void, onExit: (c: number | null) => void, resume?: string, account?: string, sessionId?: string, link?: string) {
    const { invoke, Channel } = await this.core();
    const data = new Channel<ArrayBuffer>();
    data.onmessage = (b) => onData(new Uint8Array(b));
    const exit = new Channel<number | null>();
    exit.onmessage = (c) => onExit(c);
    return invoke<number>("session_start", { agent, cwd, sessionId: sessionId ?? null, resume: resume ?? null, link: link ?? null, account: account ?? null, cols, rows, onData: data, onExit: exit });
  }
  async chatStart(agent: AgentId, cwd: string, onEvent: (ev: ChatEvent) => void, resume?: string, account?: string, session?: string, suggest?: boolean, mode?: string) {
    const { invoke, Channel } = await this.core();
    const ch = new Channel<ChatEvent>();
    ch.onmessage = (ev) => onEvent(ev);
    // `suggest`: the person turned on suggested next messages (lib/suggest.ts); the shell passes Claude Code its own flag for it.
    // `mode`: checked again in the shell against the agent's own list, and none means its careful one
    return invoke<number>("chat_start", { agent, cwd, resume: resume ?? null, account: account ?? null, session: session ?? null, suggest: suggest === true, mode: mode ?? null, onEvent: ch });
  }
  async chatInput(id: number, input: ChatInput) {
    const { invoke } = await this.core();
    await invoke("chat_input", { id, input });
  }
  async chatClose(id: number) {
    const { invoke } = await this.core();
    await invoke("chat_close", { id });
  }
  async buddyStart(agent: AgentId, prompt: string, onEvent: (ev: ChatEvent) => void) {
    const { invoke, Channel } = await this.core();
    const ch = new Channel<ChatEvent>();
    ch.onmessage = (ev) => onEvent(ev);
    return invoke<number>("buddy_start", { agent, prompt, onEvent: ch });
  }
  async buddyInput(id: number, input: BuddyChatInput) {
    const { invoke } = await this.core();
    await invoke("buddy_input", { id, input });
  }
  async buddyClose(id: number) {
    const { invoke } = await this.core();
    await invoke("buddy_close", { id });
  }
  async buddyCloseAll() {
    const { invoke } = await this.core();
    await invoke("buddy_close_all");
  }
  async buddySaveFile(name: string, data: Uint8Array) {
    const { invoke } = await this.core();
    // as a session's file: the bytes raw, the name in a header
    return invoke<string>("buddy_file_save", data, { headers: { "x-name": encodeURIComponent(name) } });
  }
  async saveFile(session: string, name: string, data: Uint8Array) {
    const { invoke } = await this.core();
    // the bytes go raw (no JSON array of numbers); the name rides in a header
    return invoke<string>("session_file_save", data, { headers: { "x-session": session, "x-name": encodeURIComponent(name) } });
  }
  async readFile(path: string) {
    const { invoke } = await this.core();
    return new Uint8Array(await invoke<ArrayBuffer>("session_file_read", { path }));
  }
  async removeFiles(session: string) {
    const { invoke } = await this.core();
    await invoke("session_files_remove", { session });
  }
  async historySave(key: string, text: string, since: number) {
    const { invoke } = await this.core();
    await invoke("term_history_save", { key, text, since });
  }
  async historyRead(key: string) {
    const { invoke } = await this.core();
    const got = await invoke<[string, number] | null>("term_history_read", { key });
    return got ? { text: got[0], at: got[1] } : null;
  }
  async historyRemove(key: string) {
    const { invoke } = await this.core();
    await invoke("term_history_remove", { key });
  }
  async historyPrune(keep: string[]) {
    const { invoke } = await this.core();
    await invoke("term_history_prune", { keep });
  }
  async historyClear() {
    const { invoke } = await this.core();
    await invoke("term_history_clear");
  }
  async termImportList() {
    const { invoke } = await this.core();
    return invoke<ImportApp[]>("term_import_list");
  }
  async termImportRead(app: ImportApp) {
    const { invoke } = await this.core();
    return invoke<ImportProfile[]>("term_import_read", { app });
  }
  async pruneFiles(keep: string[]) {
    const { invoke } = await this.core();
    await invoke("session_files_prune", { keep });
  }
  async branch(cwd: string) {
    const { invoke } = await this.core();
    return invoke<string>("session_branch", { cwd });
  }
  async laneRootCheck(root: string) {
    const { invoke } = await this.core();
    return invoke<string>("lane_root_check", { root });
  }
  async agentConfig(cwd?: string) {
    const { invoke } = await this.core();
    return readAgentConfig(await invoke<unknown>("agent_config_list", { cwd: cwd || null }));
  }
  async skillBundleRead(agent: "claude" | "codex", folders: string[]) {
    const { invoke } = await this.core();
    const read = readSkillReads(await invoke<unknown>("skill_bundle_read", { agent, folders }));
    if (!read) throw new Error("unreadable");
    return read;
  }
  async skillLinkRead(link: string, origin: string) {
    const { invoke } = await this.core();
    const read = readLinkRead(await invoke<unknown>("skill_link_read", { link, origin }));
    if (!read) throw new Error("unreadable");
    return read;
  }
  async skillInstallAsk(read: string, names: string[], agent: "claude" | "codex") {
    const { invoke } = await this.core();
    const ask = readInstallAsk(await invoke<unknown>("skill_install_ask", { read, names, agent }));
    if (!ask) throw new Error("unreadable");
    return ask;
  }
  async skillInstallSettle(id: string, yes: boolean) {
    const { invoke } = await this.core();
    const done = readInstallDone(await invoke<unknown>("skill_install_settle", { id, yes }));
    if (!done) throw new Error("unreadable");
    return done;
  }
  async skillInstallWithdraw(id: string) {
    const { invoke } = await this.core();
    await invoke("skill_install_withdraw", { id });
  }
  async sourceTools(fresh = false) {
    const { invoke } = await this.core();
    return readTools(await invoke<unknown>("source_tools", { fresh }));
  }
  async sourcePull(cwd: string) {
    const { invoke } = await this.core();
    return readPulled(await invoke<unknown>("source_pull", { cwd }));
  }
  async titleRun(req: TitleRequest): Promise<TitleWords> {
    const { invoke } = await this.core();
    const v = await invoke<unknown>("title_run", { request: req });
    const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    return { title: typeof o.title === "string" ? o.title : "", body: typeof o.body === "string" ? o.body : "" };
  }
  async titleCancel(key: string) {
    const { invoke } = await this.core();
    await invoke<unknown>("title_cancel", { key });
  }
  async reviewDraft(worktree: string) {
    const { invoke } = await this.core();
    return readDraft(await invoke<unknown>("review_draft", { worktree }));
  }
  async reviewAsk(worktree: string, title: string, body: string) {
    const { invoke } = await this.core();
    const ask = readAsk(await invoke<unknown>("review_ask_open", { worktree, title, body }));
    if (!ask) throw new Error("unread");
    return ask;
  }
  async reviewMerge(worktree: string, number: number, method: MergeMethod, credits = false) {
    const { invoke } = await this.core();
    const ask = readAsk(await invoke<unknown>("review_ask_merge", { worktree, number, method, credits }));
    if (!ask || ask.kind !== "merge") throw new Error("unread");
    return ask;
  }
  async reviewMergePull(folder: string, source: "github" | "gitlab", repo: string, number: number, method: MergeMethod, credits = false) {
    const { invoke } = await this.core();
    const ask = readAsk(await invoke<unknown>("review_ask_merge_pull", { folder, source, repo, number, method, credits }));
    if (!ask || ask.kind !== "merge") throw new Error("unread");
    return ask;
  }
  async reviewSettle(id: string, yes: boolean) {
    const { invoke } = await this.core();
    const done = readDone(await invoke<unknown>("review_settle", { id, yes }));
    if (!done) throw new Error("unread");
    return done;
  }
  async reviewWithdraw(id: string) {
    const { invoke } = await this.core();
    await invoke("review_withdraw", { id });
  }
  async laneRelease(worktree: string) {
    const { invoke } = await this.core();
    return readReleased(await invoke<unknown>("lane_release", { worktree }));
  }
  async laneCleanMerged(cwd: string, held: string[]) {
    const { invoke } = await this.core();
    return readCleaned(await invoke<unknown>("lane_clean_merged", { cwd, held }));
  }
  async laneWorktree(cwd: string, names: string[], start?: LaneStart) {
    const { invoke } = await this.core();
    const made = readMade(await invoke<unknown>("lane_worktree", { cwd, names, start: start ?? null }));
    if (!made) throw new Error("no_folder");
    return made;
  }
  async laneList(cwd: string) {
    const { invoke } = await this.core();
    return readKept(await invoke<unknown>("lane_list", { cwd }));
  }
  async laneProjects() {
    const { invoke } = await this.core();
    const got = await invoke<unknown>("lane_projects");
    return Array.isArray(got) ? got.filter((p): p is string => typeof p === "string" && p !== "") : [];
  }
  async laneRemove(worktree: string, ask: LaneRemoveAsk) {
    const { invoke } = await this.core();
    return readRemoved(await invoke<unknown>("lane_remove", { worktree, ask }));
  }
  async laneDiff(worktree: string) {
    const { invoke } = await this.core();
    return readLaneFolder(await invoke<unknown>("lane_diff", { worktree }));
  }
  async mainMoved(cwd: string, o: { base?: string | null; show?: string[] } = {}) {
    const { invoke } = await this.core();
    return readView(await invoke<unknown>("session_main_moved", { cwd, base: o.base ?? null, show: o.show ?? [] }));
  }
  async reveal(cwd: string) {
    const { invoke } = await this.core();
    await invoke("session_reveal", { cwd });
  }
  async openTerminal(cwd: string) {
    const { invoke } = await this.core();
    await invoke("session_open_terminal", { cwd });
  }
  async editors() {
    const { invoke } = await this.core();
    const list = await invoke<unknown>("editors_installed");
    // (id, label) pairs, as the shell sends them
    return Array.isArray(list) ? list.flatMap((p) => (Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string" ? [{ id: p[0], label: p[1] }] : [])) : [];
  }
  async openInEditor(cwd: string, editor: string) {
    const { invoke } = await this.core();
    await invoke("session_open_in_editor", { cwd, editor });
  }
  async pastChats(agent: "claude" | "codex", cwds: string[]) {
    const { invoke } = await this.core();
    return invoke<PastChat[]>("past_chats_list", { agent, cwds });
  }
  async pastMessages(agent: "claude" | "codex", id: string, cwd: string) {
    const { invoke } = await this.core();
    return invoke<PastMsg[]>("past_chat_messages", { agent, id, cwd });
  }
  async conversationState(agent: "claude" | "codex", id: string, account?: string) {
    const { invoke } = await this.core();
    return invoke<ConvState>("conversation_state", { agent, id, account: account ?? null });
  }
  async codexConversation(id: number) {
    const { invoke } = await this.core();
    return invoke<string | null>("codex_conversation", { id });
  }
  async badge(count: number) {
    const { invoke } = await this.core();
    await invoke("asks_badge", { count });
  }
  async power(busy: boolean, now: boolean) {
    const { invoke } = await this.core();
    await invoke("power_busy", { busy, now });
  }
  async providers() {
    const { invoke } = await this.core();
    return invoke<ProviderView[]>("providers_list");
  }
  async providerSave(id: string, patch: ProviderPatch) {
    const { invoke } = await this.core();
    return invoke<ProviderView>("provider_save", { id, patch });
  }
  async providerVersion(id: string) {
    const { invoke } = await this.core();
    return invoke<string | null>("provider_version", { id });
  }
  async customList() {
    const { invoke } = await this.core();
    return invoke<CustomList>("custom_agents_list");
  }
  async customPreview(label: string, program: string, args: string, install: string) {
    const { invoke } = await this.core();
    return invoke<CustomPreview>("custom_agent_preview", { label, program, args, install });
  }
  async customBotPreview(label: string, program: string, args: string[], install: string) {
    const { invoke } = await this.core();
    return invoke<CustomPreview>("custom_agent_bot_preview", { label, program, args, install });
  }
  async customConfirm(entry: CustomEntry) {
    const { invoke } = await this.core();
    await invoke("custom_agent_confirm", { entry });
  }
  async customRemove(id: string) {
    const { invoke } = await this.core();
    await invoke("custom_agent_remove", { id });
  }
  async diskWatch(warnGb: number) {
    const { invoke } = await this.core();
    return invoke<DiskState>("disk_watch", { warnGb });
  }
  onDiskLevel(fn: (s: DiskState) => void) {
    let stop: (() => void) | null = null;
    let gone = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<DiskState>("disk-level", (e) => fn(e.payload)))
      .then((un) => (gone ? un() : (stop = un)))
      .catch(() => {});
    return () => {
      gone = true;
      stop?.();
    };
  }
  async write(id: number, data: string) {
    const { invoke } = await this.core();
    await invoke("session_write", { id, data });
  }
  /** Drawn bytes not yet sent to the shell, by session. */
  private drawn = new Map<number, number>();
  /** A send of `drawn` is waiting for the end of this task. */
  private sending = false;
  /** One `session_ack` per session for everything drawn in the same task: xterm runs the callbacks of a whole
   *  slice of its write queue (up to 12 ms of messages) in one task, so a flood costs one call per slice instead
   *  of one per message. A call that fails is not lost credit: its bytes go back into `drawn` and ride on the next
   *  acknowledgement (any session's), so the shell's count of what the page has drawn stays whole. */
  ack(id: number, bytes: number) {
    this.drawn.set(id, (this.drawn.get(id) ?? 0) + bytes);
    if (this.sending) return;
    this.sending = true;
    queueMicrotask(() => {
      this.sending = false;
      const all = [...this.drawn];
      this.drawn.clear();
      const keep = (sid: number, n: number) => void this.drawn.set(sid, (this.drawn.get(sid) ?? 0) + n);
      void this.core().then(
        ({ invoke }) => {
          for (const [sid, n] of all) void invoke("session_ack", { id: sid, bytes: n }).catch(() => keep(sid, n));
        },
        () => all.forEach(([sid, n]) => keep(sid, n)),
      );
    });
  }
  async resize(id: number, cols: number, rows: number) {
    const { invoke } = await this.core();
    await invoke("session_resize", { id, cols, rows });
  }
  async close(id: number) {
    const { invoke } = await this.core();
    await invoke("session_close", { id });
  }
}

// ---- mock (browser, e2e) --------------------------------------------------------------------

export interface MockCall {
  op:
    | "reset"
    | "start"
    | "write"
    | "ack"
    | "resize"
    | "close"
    | "chat.start"
    | "chat.input"
    | "chat.close"
    | "file.save"
    | "file.remove"
    | "file.prune"
    | "history.save"
    | "history.read"
    | "history.remove"
    | "history.prune"
    | "history.clear"
    | "import.list"
    | "import.read"
    | "reveal"
    | "terminal"
    | "editor"
    | "main.moved"
    | "custom.preview"
    | "custom.botPreview"
    | "custom.confirm"
    | "custom.remove"
    | "power.busy"
    | "lane.worktree"
    | "lane.remove"
    | "lane.root"
    | "lane.release"
    | "lane.clean"
    | "source.tools"
    | "source.pull"
    | "review.ask"
    | "title.run"
    | "title.cancel"
    | "review.settle"
    | "buddy.start"
    | "buddy.input"
    | "buddy.close"
    | "buddy.closeAll"
    | "buddy.file"
    | "providers"
    | "providerSave";
  /** editor: the id of the editor the folder `cwd` was opened in */
  editor?: string;
  /** providerSave: the fields the patch named (never a variable's value) */
  fields?: string[];
  id?: number | string;
  /** power.busy: the edge, and whether the shell lets go at once (the setting went off) */
  busy?: boolean;
  now?: boolean;
  /** ack: how many drawn bytes it acknowledges */
  bytes?: number;
  agent?: string;
  cwd?: string;
  data?: string;
  cols?: number;
  rows?: number;
  resume?: string;
  /** start: the id manut made for a new Claude Code conversation (`--session-id`) */
  sessionId?: string;
  account?: string;
  input?: ChatInput | BuddyChatInput;
  /** buddy.start: Buddy's instructions as the page handed them over */
  prompt?: string;
  session?: string;
  name?: string;
  size?: number;
  path?: string;
  keep?: string[];
  /** lane.worktree: the branch the shell made for a lane, and the one it was made from (main.moved: the one the page named) */
  branch?: string;
  base?: string;
  /** lane.worktree: where the folder was asked to be made ("" is the default) and whether it was asked to start from the remote;
   *  lane.clean: the folders a session still held */
  root?: string;
  remote?: boolean;
  held?: string[];
  /** main.moved: the paths whose two diffs were asked for */
  show?: string[];
  /** history: the terminal's key (a session id or `panel-<n>`) */
  key?: string;
  /** title.run: what was asked for, and with which model and effort ("" for the agent's own) */
  purpose?: "title" | "pull";
  titleModel?: string;
  titleEffort?: string;
  /** source.tools: the CLIs were asked again */
  fresh?: boolean;
  /** review.settle: the person's answer, and on a Yes the title and body the mock would have sent */
  yes?: boolean;
  title?: string;
  body?: string;
}

const BANNER: Record<string, string> = {
  claude: "\x1b[38;2;217;119;87m✻\x1b[0m \x1b[1mClaude Code\x1b[0m \x1b[2m(mock)\x1b[0m",
  codex: "\x1b[1m>_ Codex\x1b[0m \x1b[2m(mock)\x1b[0m",
  omo: "\x1b[1mOmO\x1b[0m \x1b[2m(mock)\x1b[0m",
  dsh: "\x1b[1mDeepSeek Harness\x1b[0m \x1b[2m(mock)\x1b[0m",
  omh: "\x1b[38;2;211;60;141m◆\x1b[0m \x1b[1moh-my-hermes\x1b[0m \x1b[2m(mock)\x1b[0m",
  pi: "\x1b[1mπ pi\x1b[0m \x1b[2m(mock)\x1b[0m",
  omp: "\x1b[1mπ oh-my-pi\x1b[0m \x1b[2m(mock)\x1b[0m",
  grok: "\x1b[1m𝕏 Grok\x1b[0m \x1b[2m(mock)\x1b[0m",
  opencode: "\x1b[1mopencode\x1b[0m \x1b[2m(mock)\x1b[0m",
};
/** A generic ACP agent's banner: its program's name, as the built-ins without art show theirs. */
const banner = (agent: AgentId) => BANNER[agent] ?? `\x1b[1m${agentDef(agent).program}\x1b[0m \x1b[2m(mock)\x1b[0m`;

/** The shell's generic ACP agents as `sessions_agents` sends them (src-tauri/src/acp_agents.rs `ACP_LIST`; a Rust
 *  test keeps this copy equal), for the mock host only: a browser has no shell to ask. */
const MOCK_ACP: readonly AcpRow[] = mockAcpAgents;
const PROMPT = "\x1b[2m›\x1b[0m ";

/** One step of a mock terminal's output: a message handed to the terminal (`feed`), or its acknowledgement. */
export interface MockFlow {
  op: "feed" | "ack";
  id: number;
  bytes: number;
}

const utf8 = new TextEncoder();

/** One message of a mock program that prints fast: 64 KiB of 64-byte lines, the size the shell hands output on in
 *  (`COALESCE_BYTES` in src-tauri/src/sessions.rs). */
const FLOOD_MESSAGE = `${"build output ".repeat(5).slice(0, 62)}\r\n`.repeat(1024);

/** What Settings › Worktrees asks of a new lane: where its folder is made ("" is the default) and whether it starts from the remote. */
export interface LaneStart {
  root: string;
  remote: boolean;
  /** Item 114: the lane is made with nobody there (a workflow by the clock). The shell then reads the repository's own config
   *  first, as the automatic pull does, and answers `config:<setting>` instead of making anything when it names a program or
   *  another address. A lane the person starts themselves never sets it. */
  unattended?: boolean;
}

/** A lane's working folder the mock shell made: its record, as lane.rs writes one. */
export interface MockLane {
  worktree: string;
  dir: string;
  branch: string;
  base: string;
  /** The developer's folder it was made from. */
  project: string;
  made: number;
}

export type MockGlobals = MockTurnGlobals & {
  /** Free bytes the mock's disk watch reads (src/lib/disk.ts); unset = 100 GB. */
  __manutDiskFree?: number;
  __manutPickFolder?: string | null;
  __manutSessionCalls?: MockCall[];
  /** e2e: every message a mock terminal's program printed and every acknowledgement of one, in the order they happened */
  __manutSessionFlow?: MockFlow[];
  __manutMockAgents?: AgentId[];
  /** e2e: Hermes is here and `omh` is not (the oh-my-hermes row reads "Hermes" and opens a Hermes chat) */
  __manutMockNoOmh?: boolean;
  /** e2e: the next file saves fail with this message */
  __manutFileSaveError?: string;
  /** e2e: the shell answers a history read this many ms late (a slow computer) */
  __manutMockHistoryDelay?: number;
  /** e2e: the profiles each app's prefs file holds for Settings › Terminal › Import from… (none = MOCK_IMPORT; an app
   *  left out has no prefs file) */
  __manutMockImport?: Partial<Record<ImportApp, ImportProfile[]>>;
  /** e2e: the branch of each folder (none = not a repository) */
  __manutBranches?: Record<string, string>;
  /** e2e: the names of branches that exist already, so a lane's branch of that name is made with a number after it */
  __manutMockTaken?: string[];
  /** e2e: the lanes' working folders the mock shell made (its records), as `lane_list` lists them */
  __manutLanes?: MockLane[];
  /** e2e: how many files are changed or new in each lane's folder, and how many commits on its branch are not on its base,
   *  by the folder's worktree (none: 0) */
  __manutLaneChanged?: Record<string, number>;
  __manutLaneAhead?: Record<string, number>;
  /** e2e: how many commits on each lane's branch are on no remote, by worktree (none: 0) */
  __manutLaneUnpushed?: Record<string, number>;
  /** e2e: the remote branch (`origin/main`) a folder's base starts a lane from when asked to; a folder left out has no remote */
  __manutRemoteFrom?: Record<string, string>;
  /** e2e: what the shell says of git, gh and glab for Settings › Source control (its `source_tools` answer) */
  __manutSourceTools?: unknown;
  /** e2e: what a pull of each project's default branch answers, by folder (the shell's `source_pull` answer) */
  __manutPulled?: Record<string, unknown>;
  __manutTitleRun?: Partial<TitleWords> | { error: string };
  /** e2e: what each lane would go up for review with, by worktree: its repository, its commits' subjects, a code its ask is
   *  refused with, or the step its Yes fails at */
  __manutReview?: Record<string, { source?: "github" | "gitlab"; repo?: string; commits?: string[]; refuse?: string; fail?: { step: string; error: string }; cannot?: string; title?: string }>;
  /** e2e: what the Pull requests list's Merge asks (item 100), by `<source>:<repo>:<number>`: why it cannot merge, a code it is
   *  refused with, the branch it is from and its title; none: it can merge, from `change/<number>` */
  __manutPullMerge?: Record<string, { cannot?: string; refuse?: string; branch?: string; title?: string; base?: string }>;
  /** e2e: the Tasks mock's folders and their remotes (tasks/host.ts), which the list's Merge checks the project against */
  __manutTasks?: { remotes?: Record<string, { source: string; repo: string }> };
  /** e2e: what a merged clean-up of each project's lanes finds */
  __manutCleanMerged?: Record<string, { removed: string[]; kept: { branch: string; why: string }[]; cannot: string | null }>;
  /** e2e: how many changed files the developer's folders have, by folder: they do not come along into a lane's */
  __manutLeft?: Record<string, number>;
  /** e2e: how many of a folder's own agent settings files come along into a lane (`config`) and how many stay (`stayed`) */
  __manutConfig?: Record<string, number>;
  __manutStayed?: Record<string, number>;
  /** e2e: what the shell reads for Settings › MCP and Skills; without it, a browser has nothing to read */
  __manutAgentConfig?: unknown;
  /** e2e: what git says of each folder for the main branch moving (src/code/moved.ts; none = the canvas's project, a
   *  lane whose main moved; a folder left out: nothing to say) */
  __manutMoved?: Record<string, GitView>;
  /** e2e: these agents are an old version that never answers in chat mode (the shell's start deadline ends them) */
  __manutMockNoChat?: AgentId[];
  /** ACP agents the mock host treats as signed in (the others of MOCK_SIGNED_OUT answer -32000). */
  __manutMockSignedIn?: AgentId[];
  /** Buddy's stand-in Claude Code answers that it is not signed in. */
  __manutMockBuddySignedOut?: boolean;
  /** e2e: the Codex thread a chat resumes is gone (deleted or archived): the shell starts a new one */
  __manutMockGoneThreads?: boolean;
  /** The text the mock Claude Code suggests after a turn, when the chat was started with suggestions on (lib/suggest.ts). */
  __manutMockSuggestion?: string;
  /** e2e: Codex's own config runs without approvals and with full disk access (its thread reports
   *  `approvalPolicy: never`, `sandbox: dangerFullAccess`, as codex-12-late-step-init.jsonl) */
  __manutMockCodexUnguarded?: boolean;
  /** e2e: the editors the mock shell finds installed (none set = Visual Studio Code and Cursor; [] = no editor) */
  __manutEditors?: { id: string; label: string }[];
  /** e2e: the text the mock shell refuses an Open in editor with */
  __manutEditorFails?: string;
  /** e2e: the conversations Claude Code and Codex keep (none = the built-in ones) */
  __manutPastChats?: PastChat[];
  /** e2e: reads of those conversations, apart from the session calls (opening the + menu lists them) */
  __manutPastReads?: { op: "list" | "read" | "own"; agent: string; cwds?: string[]; id?: string; cwd?: string; pty?: number }[];
  /** e2e: the conversation each mock pty's Codex holds open (pty id -> UUID), as a real Codex once its rollout exists */
  __manutMockCodexOwn?: Record<number, string>;
  /** e2e: the Dock / taskbar count manut last set */
  __manutBadge?: number;
  /** e2e: the mock's copy of manut's custom-agents file (`agents` of `~/.manut/custom-agents.json`, as written) */
  __manutCustomFile?: unknown[];
  /** Settings › Providers: the mock's copy of the shell's providers file, by agent id (values kept, as the shell keeps
   *  them; the page is only ever sent the names) */
  __manutProviders?: Record<string, MockProvider>;
  /** e2e: programs the mock finds on the search path, bare name -> where (absolute paths: any of the values) */
  __manutMockPrograms?: Record<string, string>;
  /** e2e: custom agents the mock treats as signed out (the others answer) */
  __manutMockCustomSignedOut?: AgentId[];
  /** e2e: CLIs that are not on this computer: a terminal of one is refused, as the shell refuses it */
  __manutMockMissing?: AgentId[];
  /** e2e: conversations Claude Code and Codex cannot continue (the file, its account folder or the login is gone): a
   *  terminal that continues one prints the CLI's refusal and ends with code 1 at once, as the real CLI does */
  __manutMockGoneConversations?: string[];
  /** e2e: what the shell's look for a conversation's file answers, by id, whatever the mock's CLIs wrote (a file the
   *  look misses answers `absent` while the CLI still finds it); the read of its messages misses it too */
  __manutMockConvStates?: Record<string, ConvState>;
  /** e2e: Settings › Accounts accounts whose folder is gone: a conversation of one is `unknown`, and a CLI started
   *  as one runs in another home, where it finds none of its conversations */
  __manutMockGoneAccounts?: string[];
  /** e2e: how long the mock's Codex takes to refuse a conversation it cannot continue, after it set up its screen
   *  (30 ms unless told) */
  __manutMockCodexRefuseMs?: number;
  /** e2e: every look for a conversation's file */
  __manutConvChecks?: { agent: string; id: string; account?: string }[];
};

/** What the mock keeps for one agent on Settings › Providers, as the shell's file does. */
export interface MockProvider {
  off?: boolean;
  name?: string;
  path?: string;
  home?: string;
  args?: string[];
  env?: { name: string; value: string }[];
}

/** The programs the mock host finds unless a test says otherwise. */
const MOCK_PROGRAMS: Record<string, string> = { "cursor-agent": "/opt/homebrew/bin/cursor-agent", "acme-agent": "/opt/homebrew/bin/acme-agent", "stub-acp": "/usr/local/bin/stub-acp" };

/** The mock's past conversations: two Claude Code and one Codex conversation in the e2e folders. */
const MOCK_EDITORS = [
  { id: "vscode", label: "Visual Studio Code" },
  { id: "cursor", label: "Cursor" },
];

const MOCK_PAST: PastChat[] = [
  { agent: "claude", id: "aaaaaaaa-1111-4222-8333-444444444444", cwd: "/home/you/code/web-app", title: "Fix the login redirect", named: true, at: Date.now() / 1000 - 3_600 },
  { agent: "claude", id: "bbbbbbbb-1111-4222-8333-444444444444", cwd: "/home/you/code/manut", title: "Remember the word MARIGOLD for later", named: false, at: Date.now() / 1000 - 3 * 86_400 },
  { agent: "codex", id: "01a1d060-4ab7-72b2-b02b-1dbee1d5f52c", cwd: "/home/you/code/web-app", title: "Add a dark theme", named: true, at: Date.now() / 1000 - 600 },
];
const MOCK_PAST_MSGS: Record<string, PastMsg[]> = {
  "bbbbbbbb-1111-4222-8333-444444444444": [
    { role: "user", text: "Remember the word MARIGOLD for later", ts: Date.now() / 1000 - 3 * 86_400 },
    { role: "assistant", text: "Noted: MARIGOLD.", ts: Date.now() / 1000 - 3 * 86_400 + 5 },
  ],
};

/** Echoes typing, answers each line, ends on `exit` or Ctrl+D. Installed: claude, codex, omh. */
export class MockHost implements SessionHost, BuddyHost {
  readonly kind = "mock" as const;
  private next = 0;
  private live = new Map<number, { agent: string; line: string; out: (d: string) => void; exit: (c: number | null) => void; conv?: string }>();
  /** The Claude Code conversations the mock's terminals named (`--session-id`), by id: their folder, and the first
   *  line typed in them once one was (Claude Code writes a conversation on its first message). In this page's storage,
   *  so they outlive a reload as Claude Code's files outlive manut (`__manutMockClaudeConvs`). */
  private convs(): Record<string, { cwd: string; text?: string }> {
    try {
      return JSON.parse(localStorage.getItem("__manutMockClaudeConvs") || "{}");
    } catch {
      return {};
    }
  }
  private putConvs(c: Record<string, { cwd: string; text?: string }>) {
    try {
      localStorage.setItem("__manutMockClaudeConvs", JSON.stringify(c));
    } catch {
      /* no storage */
    }
  }
  constructor(private g: MockGlobals = globalThis as MockGlobals) {}

  private turns?: TurnFilesHost;
  /** Pretend folders and their snapshots (turnFiles.ts), made the first time a session keeps one. */
  get turnFiles(): TurnFilesHost {
    return (this.turns ??= new MockTurnFiles(this.g));
  }

  private log(c: MockCall) {
    (this.g.__manutSessionCalls ??= []).push(c);
  }
  async reset() {
    this.log({ op: "reset" });
    this.live.clear();
    for (const c of this.chats.values()) c.stop();
    this.chats.clear();
  }
  async agents(): Promise<AgentInfo[]> {
    const installed = this.g.__manutMockAgents ?? ["claude", "codex", "omh"];
    const noOmh = !!this.g.__manutMockNoOmh;
    const builtins: AgentInfo[] = AGENTS.map((a) =>
      a.id === "omh" && noOmh
        ? { id: a.id, label: HERMES_LABEL, mode: a.mode, path: "/home/you/.hermes/hermes-agent/venv/bin/python", via: "hermes" as const }
        : { id: a.id, label: a.label, mode: a.mode, path: installed.includes(a.id) ? `/usr/local/bin/${a.program}` : null },
    );
    const acp: AgentInfo[] = MOCK_ACP.map((r) => ({ id: r.id, label: r.label, mode: "chat", path: installed.includes(r.id) ? `/usr/local/bin/${r.program}` : null, acp: r }));
    // what Settings › Providers says of each, as the shell's look-up adds it
    const set = this.g.__manutProviders ?? {};
    return [...builtins, ...acp, ...this.customInfos()].map((a) => {
      const p = set[a.id];
      if (!p) return a;
      return { ...a, ...(p.off ? { off: true } : {}), ...(p.name ? { name: p.name } : {}), ...(p.path && a.path !== null ? { path: p.path } : {}) };
    });
  }

  // ---- Settings › Providers: the shell's checks over the mock's copy of its file (providers.rs) ---------------
  private providerView(a: AgentInfo): ProviderView {
    const p = this.g.__manutProviders?.[a.id] ?? {};
    const custom = !!a.acp && "custom" in a.acp && !!a.acp.custom;
    const builtin = !custom;
    const args = p.args ?? [];
    const fixed = a.acp?.args ?? (a.id === "claude" ? ["-p", "--input-format", "stream-json"] : a.id === "codex" ? ["app-server"] : []);
    const found = a.path;
    return {
      id: a.id,
      label: a.label,
      kind: custom ? "custom" : ["claude", "codex", "omo"].includes(a.id) ? "main" : a.acp ? "acp" : "builtin",
      mode: a.mode ?? "chat",
      off: !!p.off,
      name: p.name ?? "",
      found,
      path: p.path ?? "",
      path_ok: !p.path || Object.values(this.programs()).includes(p.path) || p.path === found,
      home_var: builtin ? (homeVarOf(a.id) ?? null) : null,
      home: p.home ?? "",
      args,
      env: (p.env ?? []).map((v) => v.name),
      takes_path: builtin,
      takes_args: builtin && !!rulesOf(a.id),
      takes_vars: builtin && a.id !== "dsh",
      version: versionAgent(a.id),
      signin: a.id === "claude" || a.id === "codex",
      chat: found && (a.mode ?? "chat") === "chat" && a.id !== "dsh" ? [found, ...(custom ? (a.acp?.args ?? []) : fixed), ...(custom ? [] : args)].join(" ") : null,
      terminal: found && !custom && a.id !== "dsh" ? [found, ...args].join(" ") : null,
    };
  }
  async providers(): Promise<ProviderView[]> {
    this.log({ op: "providers" });
    // oh-my-hermes is offered nowhere (offeredAgents), so the page does not list it (providers.rs `list_here`)
    return (await this.agents()).filter((a) => a.id !== "omh").map((a) => this.providerView(a));
  }
  async providerSave(id: string, patch: ProviderPatch): Promise<ProviderView> {
    this.log({ op: "providerSave", id, fields: Object.keys(patch) });
    const all = await this.agents();
    const a = all.find((x) => x.id === id);
    if (!a) throw new Error("why:unknown");
    const view = this.providerView(a);
    const cur = this.g.__manutProviders?.[id] ?? {};
    const next: MockProvider = { ...cur };
    if (patch.off !== undefined) next.off = patch.off;
    if (patch.name !== undefined) {
      if (patch.name && !/^[\p{L}\p{N} ._+-]{1,40}$/u.test(patch.name)) throw new Error("why:name");
      next.name = patch.name;
    }
    if (patch.path !== undefined) {
      if (patch.path && !view.takes_path) throw new Error("why:path_none");
      if (patch.path && !patch.path.startsWith("/")) throw new Error("why:path_shape");
      if (patch.path && !Object.values(this.programs()).includes(patch.path)) throw new Error("why:path_run");
      next.path = patch.path;
    }
    if (patch.home !== undefined) {
      if (patch.home && !view.home_var) throw new Error("why:home_none");
      if (patch.home && !patch.home.startsWith("/")) throw new Error("why:home_shape");
      next.home = patch.home;
    }
    if (patch.args !== undefined) {
      if (patch.args.length && !view.takes_args) throw new Error("why:arg_unchecked");
      const r = checkArgs(id, patch.args);
      if (r) throw new Error(`why:${r.why}${r.what ? `:${r.what}` : ""}`);
      next.args = patch.args;
    }
    if (patch.env !== undefined) {
      const env: { name: string; value: string }[] = [];
      for (const v of patch.env) {
        const kept = v.value ?? cur.env?.find((x) => x.name === v.name)?.value;
        if (kept === undefined) throw new Error(`why:var_keep:${v.name}`);
        env.push({ name: v.name, value: kept });
      }
      const r = checkVars(id, env, view.takes_vars);
      if (r) throw new Error(`why:${r.why}${r.what ? `:${r.what}` : ""}`);
      next.env = env;
    }
    this.g.__manutProviders = { ...(this.g.__manutProviders ?? {}), [id]: next };
    return this.providerView((await this.agents()).find((x) => x.id === id)!);
  }
  async providerVersion(id: string): Promise<string | null> {
    const a = (await this.agents()).find((x) => x.id === id);
    if (!a?.path || !versionAgent(id)) return null;
    return ({ claude: "2.1.332", codex: "0.167.0" } as Record<string, string>)[id] ?? "1.0.0";
  }

  // ---- the person's own agents: the shell's checks over the mock's file (custom_agents.rs) --------------------
  private programs() {
    return this.g.__manutMockPrograms ?? MOCK_PROGRAMS;
  }
  /** Where `program` is: an absolute path the mock knows, or a bare name it finds. */
  private findProgram(program: string): string | null {
    const p = this.programs();
    if (program.startsWith("/")) return Object.values(p).includes(program) ? program : null;
    return p[program] ?? null;
  }
  /** The file, read and checked as the shell reads it: the agents that may run and the broken entries. */
  private loadCustom(): { agents: CustomEntry[]; broken: { id: string; why: CustomWhy }[] } {
    const agents: CustomEntry[] = [];
    const broken: { id: string; why: CustomWhy }[] = [];
    for (const v of this.g.__manutCustomFile ?? []) {
      const raw = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
      const id = typeof raw.id === "string" && /^[a-z0-9-]{1,64}$/.test(raw.id) ? raw.id : "";
      const why = mockCheck(v, (p) => Object.values(this.programs()).includes(p));
      if (why) broken.push({ id, why });
      else if (agents.some((a) => a.id === id)) broken.push({ id, why: "dup" });
      else agents.push({ ...(v as CustomEntry), install: (v as CustomEntry).install ?? "" });
    }
    return { agents, broken };
  }
  private customInfos(): AgentInfo[] {
    return this.loadCustom().agents.map((c) => ({
      id: c.id,
      label: c.label,
      mode: "chat" as const,
      path: this.findProgram(c.program),
      acp: { id: c.id, label: c.label, program: c.program, args: c.args, login: c.program, install: c.install, mark: "", continues: true, custom: true },
    }));
  }
  async customList(): Promise<CustomList> {
    return { agents: this.customInfos(), broken: this.loadCustom().broken };
  }
  async customPreview(label: string, program: string, args: string, install: string): Promise<CustomPreview> {
    this.log({ op: "custom.preview", name: label, path: program, data: args });
    const taken = (this.g.__manutCustomFile ?? []).map((v) => (v && typeof v === "object" ? String((v as { id?: unknown }).id ?? "") : "")).filter(Boolean);
    const entry: CustomEntry = { id: mockNewId(label.trim(), program.trim(), taken), label: label.trim(), program: program.trim(), args: args.split(/\s+/).filter(Boolean), install: install.trim() };
    const why = mockCheck(entry, (p) => Object.values(this.programs()).includes(p));
    if (why) throw new Error(`why:${why}`);
    if (taken.length >= 32) throw new Error("why:many");
    const found = this.findProgram(entry.program);
    return { entry, command: found ? [found, ...entry.args].join(" ") : null };
  }
  async customBotPreview(label: string, program: string, args: string[], install: string): Promise<CustomPreview> {
    this.log({ op: "custom.botPreview", name: label, path: program, data: args.join(" ") });
    const why = botRefusal(program);
    if (why) throw new Error(`why:${why}`);
    if (!args.every((a) => /^[A-Za-z0-9._=/:-]{1,64}$/.test(a))) throw new Error("why:args");
    return this.customPreview(label, program, args.join(" "), install);
  }
  async customConfirm(entry: CustomEntry) {
    this.log({ op: "custom.confirm", agent: entry.id });
    const why = mockCheck(entry, (p) => Object.values(this.programs()).includes(p));
    if (why) throw new Error(`why:${why}`);
    const file = this.g.__manutCustomFile ?? [];
    if (file.some((v) => (v as { id?: unknown })?.id === entry.id)) throw new Error("why:dup");
    this.g.__manutCustomFile = [...file, { ...entry }];
  }
  async customRemove(id: string) {
    this.log({ op: "custom.remove", agent: id });
    this.g.__manutCustomFile = (this.g.__manutCustomFile ?? []).filter((v) => (v as { id?: unknown })?.id !== id);
  }
  private disk: { level: DiskLevel; alerts: number; rev: number; heard: Set<(s: DiskState) => void> } = { level: "ok", alerts: 0, rev: 0, heard: new Set() };
  /** The shell's rules (src-tauri/src/disk.rs) on `__manutDiskFree` bytes (unset: 100 GB free): the event only when
   *  the level gets worse, better only 2 GB past a threshold. */
  async diskWatch(warnGb: number) {
    const free = this.g.__manutDiskFree ?? 100e9;
    const warn = warnGb * 1e9;
    const crit = warn < 20e9 ? warn / 4 : 5e9;
    const raw: DiskLevel = !warnGb ? "ok" : free < crit ? "critical" : free < warn ? "low" : "ok";
    const rank = { ok: 0, low: 1, critical: 2 } as const;
    const prev = this.disk.level;
    const level: DiskLevel =
      !warnGb || rank[raw] >= rank[prev] || free >= warn + 2e9 ? raw : prev === "critical" && free >= crit + 2e9 ? "low" : prev;
    this.disk.level = level;
    if (rank[level] > rank[prev]) this.disk.alerts++;
    const state: DiskState = { level, free_bytes: free, volume: "/", alerts: this.disk.alerts, rev: ++this.disk.rev };
    if (rank[level] > rank[prev]) for (const f of this.disk.heard) f(state);
    return state;
  }
  onDiskLevel(fn: (s: DiskState) => void) {
    this.disk.heard.add(fn);
    return () => void this.disk.heard.delete(fn);
  }
  async home() {
    return "/home/you";
  }
  async pickFolder(defaultPath: string) {
    const v = this.g.__manutPickFolder;
    return v === undefined ? defaultPath : v;
  }
  async start(agent: AgentId, cwd: string, cols: number, rows: number, onData: (d: string) => void, onExit: (c: number | null) => void, resume?: string, account?: string, sessionId?: string, link?: string) {
    // the shell's own refusal (sessions::terminal_env): only an oh-my-hermes terminal is told its link
    if (link !== undefined && agent !== "omh") throw new Error(`${agent} sessions are not given a terminal link`);
    const id = nextMockPty();
    this.log({ op: "start", id, agent, cwd, cols, rows, ...(resume ? { resume } : {}), ...(sessionId ? { sessionId } : {}), ...(link ? { link } : {}), ...(account ? { account } : {}) });
    if (this.g.__manutMockMissing?.includes(agent)) throw new Error(`${agentDef(agent).label} is not installed (no \`${agentDef(agent).program}\` found)`);
    // as Claude Code: `--session-id` of a conversation it wrote is refused, `--resume` of one it never wrote too
    const convs = agent === "claude" ? this.convs() : {};
    const conv = agent === "claude" ? (resume ?? sessionId) : undefined;
    // a CLI started as an account whose folder is gone runs in another home, where its conversations are not
    const elsewhere = !!account && !!this.g.__manutMockGoneAccounts?.includes(account);
    const cannot = !!resume && ((convs[resume] && convs[resume].text === undefined) || elsewhere || !!this.g.__manutMockGoneConversations?.includes(resume));
    const refusal =
      sessionId && convs[sessionId]?.text !== undefined
        ? `Error: Session ID ${sessionId} is already in use.`
        : !cannot
          ? null
          : agent === "codex"
            ? `Error: No saved session found with ID ${resume}. Run \`codex resume\` without an ID to choose from existing sessions.`
            : `No conversation found with session ID: ${resume}`;
    if (sessionId && !convs[sessionId]) this.putConvs({ ...convs, [sessionId]: { cwd } });
    // a resumed Codex holds its own conversation's rollout open again
    if (agent === "codex" && resume) (this.g.__manutMockCodexOwn ??= {})[id] = resume;
    const out = (d: string) => {
      (this.g.__manutSessionFlow ??= []).push({ op: "feed", id, bytes: utf8.encode(d).length });
      onData(d);
    };
    this.live.set(id, { agent, line: "", out, exit: onExit, ...(conv ? { conv } : {}) });
    mockPtyOut(id, out);
    setTimeout(() => {
      // a continued Claude Code shows the conversation so far (its first message) above the prompt
      const before = agent === "claude" && resume && convs[resume]?.text ? `> ${convs[resume].text}\r\n\r\n` : "";
      if (refusal === null) return out(`${banner(agent)}\r\n\x1b[2m  ${agentDef(agent).program} in ${cwd}\x1b[0m\r\n\r\n${before}${PROMPT}`);
      if (this.live.get(id)?.out !== out) return;
      // Codex sets up its screen first and looks for the conversation after that (about 1 s on a real one)
      if (agent === "codex") out("\x1b[?1049h\x1b[?2004h");
      setTimeout(
        () => {
          if (this.live.get(id)?.out !== out) return;
          out(`${agent === "codex" ? "\x1b[?2004l\x1b[?1049l" : ""}${refusal}\r\n`);
          this.live.delete(id);
          onExit(1);
        },
        agent === "codex" ? (this.g.__manutMockCodexRefuseMs ?? 30) : 0,
      );
    }, 30);
    return id;
  }
  ack(id: number, bytes: number) {
    this.log({ op: "ack", id, bytes });
    (this.g.__manutSessionFlow ??= []).push({ op: "ack", id, bytes });
  }
  async write(id: number, data: string) {
    this.log({ op: "write", id, data });
    const s = this.live.get(id);
    if (!s) throw new Error("no such session");
    for (const ch of data) {
      if (ch === "\r") {
        const line = s.line.trim();
        s.line = "";
        // Claude Code writes its conversation on the first message
        if (s.conv && line && line !== "/exit") {
          const c = this.convs();
          if (c[s.conv] && c[s.conv].text === undefined) this.putConvs({ ...c, [s.conv]: { ...c[s.conv], text: line } });
        }
        // `exit`, or a CLI's own `/exit` command, ends the program
        if (line === "exit" || line === "/exit") {
          s.out("\r\n");
          this.live.delete(id);
          setTimeout(() => s.exit(0), 10);
          return;
        }
        // `after <ms> bell|osc9|progress` / `after <ms> exit [code]` / `after <ms> flood [MiB]`: the program rings
        // (BEL, or an OSC 9 message), reports progress (OSC 9;4, not a ring), ends, or prints a lot at once (1 MiB
        // unless told, as 64 KiB messages) later, as an agent does while the person looks elsewhere
        const later = /^after (\d+) (bell|osc9|progress|exit|flood)(?: (\d+))?$/.exec(line);
        if (later) {
          s.out(`\r\n${PROMPT}`);
          setTimeout(() => {
            if (this.live.get(id) !== s) return;
            if (later[2] === "bell") return s.out("\x07");
            if (later[2] === "osc9") return s.out("\x1b]9;Needs your approval\x07");
            if (later[2] === "progress") return s.out("\x1b]9;4;1;50\x07");
            if (later[2] === "flood") {
              for (let i = 0; i < Number(later[3] ?? 1) * 16; i++) s.out(FLOOD_MESSAGE);
              return;
            }
            this.live.delete(id);
            s.exit(Number(later[3] ?? 0));
          }, Number(later[1]));
          continue;
        }
        s.out(line ? `\r\n\x1b[2m(mock) you said:\x1b[0m ${line}\r\n${PROMPT}` : `\r\n${PROMPT}`);
      } else if (ch === "\x03") {
        s.line = "";
        s.out(`^C\r\n${PROMPT}`);
      } else if (ch === "\x04") {
        this.live.delete(id);
        setTimeout(() => s.exit(0), 10);
        return;
      } else if (ch === "\x7f") {
        if (s.line) {
          s.line = s.line.slice(0, -1);
          s.out("\b \b");
        }
      } else if (ch >= " ") {
        s.line += ch;
        s.out(ch);
      }
    }
  }
  async resize(id: number, cols: number, rows: number) {
    this.log({ op: "resize", id, cols, rows });
  }
  async close(id: number) {
    this.log({ op: "close", id });
    this.live.delete(id);
  }

  // ---- chat: a scripted agent with the same events the Rust adapters emit -------------------
  private chats = new Map<number, MockChat>();
  async chatStart(agent: AgentId, cwd: string, onEvent: (ev: ChatEvent) => void, resume?: string, account?: string, session?: string, suggest?: boolean, mode?: string) {
    const id = ++this.next;
    this.log({ op: "chat.start", id, agent, cwd, ...(resume ? { resume } : {}), ...(account ? { account } : {}), ...(session ? { session } : {}), ...(mode ? { mode } : {}) });
    // as the shell's `start_mode`: a mode the agent does not offer starts nothing, and none is its careful one (item 89)
    if (mode !== undefined && !(MOCK_MODES[agent] ?? []).includes(mode)) throw new Error(MOCK_MODES[agent] ? `not a mode Manut AI offers: ${mode}` : `${agent} has no permission mode here (${mode})`);
    const c = new MockChat(agent, onEvent, resume, cwd, {
      mode: mode ?? MOCK_CAREFUL[agent],
      noChat: !!this.g.__manutMockNoChat?.includes(agent),
      // the generic ACP agents are signed out on the mock host unless a test signs them in, as on a fresh Mac; a
      // person's own agent answers unless a test signs it out
      signedOut: acpRow(agent)?.custom ? !!this.g.__manutMockCustomSignedOut?.includes(agent) : !!acpRow(agent) && !this.g.__manutMockSignedIn?.includes(agent),
      gone: agent === "codex" && !!resume && !!this.g.__manutMockGoneThreads,
      // the stand-in for Claude Code's `--prompt-suggestions`: a finished turn is followed by the one suggestion a test set (or a plain one)
      suggest: agent === "claude" && suggest === true ? (this.g.__manutMockSuggestion ?? "Now add a test for it") : undefined,
      unguarded: agent === "codex" && !!this.g.__manutMockCodexUnguarded,
    });
    this.chats.set(id, c);
    c.boot();
    return id;
  }
  async chatInput(id: number, input: ChatInput) {
    this.log({ op: "chat.input", id, input });
    const c = this.chats.get(id);
    if (!c) throw new Error("no such session");
    c.input(input);
  }
  async chatClose(id: number) {
    this.log({ op: "chat.close", id });
    this.chats.get(id)?.stop();
    this.chats.delete(id);
  }

  // ---- Buddy's chat: the same stand-in agent, on a list of its own, as the shell keeps Buddy's chats apart --------
  private buddies = new Map<number, MockChat>();
  async buddyStart(agent: AgentId, prompt: string, onEvent: (ev: ChatEvent) => void) {
    // as the shell refuses it (buddy_chat::may_answer), and only once the agent is there
    if (agent !== "claude") throw new Error(`${agent} cannot answer as Buddy`);
    if (!(this.g.__manutMockAgents ?? ["claude", "codex", "omh"]).includes(agent)) throw new Error(`${agentDef(agent).label} is not installed (no \`${agentDef(agent).program}\` found)`);
    const id = ++this.next;
    this.log({ op: "buddy.start", id, agent, prompt });
    const c = new MockChat(agent, onEvent, undefined, "/home/you/.manut/buddy/chat", { signedOut: !!this.g.__manutMockBuddySignedOut });
    this.buddies.set(id, c);
    c.boot();
    return id;
  }
  async buddyInput(id: number, input: BuddyChatInput) {
    this.log({ op: "buddy.input", id, input });
    const c = this.buddies.get(id);
    if (!c) throw new Error("no such session");
    // as the shell's `buddy_chat::check`: Buddy's own approval levels only, and a model the agent listed
    if (input.kind === "mode" && !["default", "plan"].includes(input.mode)) throw new Error("Buddy's chat takes a message, Stop, an answer, or a model, effort or approval level it offers");
    if (input.kind === "model" && !(MOCK_MODELS.claude ?? []).some((m) => m.id === input.model)) throw new Error(`${input.model} is not a model Claude Code offered in this chat`);
    c.input(input);
  }
  async buddyClose(id: number) {
    this.log({ op: "buddy.close", id });
    this.buddies.get(id)?.stop();
    this.buddies.delete(id);
  }
  async buddyCloseAll() {
    this.log({ op: "buddy.closeAll" });
    for (const c of this.buddies.values()) c.stop();
    this.buddies.clear();
  }
  async buddySaveFile(name: string, data: Uint8Array) {
    if (this.g.__manutFileSaveError) throw new Error(this.g.__manutFileSaveError);
    const dir = "/home/you/.manut/buddy/files/";
    let n = 1;
    while (this.files.has(`${dir}${n}-${name}`)) n += 1;
    const path = `${dir}${n}-${name}`;
    this.files.set(path, data);
    this.log({ op: "buddy.file", name, size: data.length, path });
    return path;
  }

  // ---- files: kept in memory under the same paths the shell would use ------------------------
  private files = new Map<string, Uint8Array>();
  async saveFile(session: string, name: string, data: Uint8Array) {
    if (this.g.__manutFileSaveError) throw new Error(this.g.__manutFileSaveError);
    const dir = `/home/you/.manut/session-files/${session}/`;
    let n = 1;
    while (this.files.has(`${dir}${n}-${name}`)) n += 1;
    const path = `${dir}${n}-${name}`;
    this.files.set(path, data);
    this.log({ op: "file.save", session, name, size: data.length, path });
    return path;
  }
  async readFile(path: string) {
    const d = this.files.get(path);
    if (!d) throw new Error("not a file Manut AI saved");
    return d;
  }
  /** History the mock shell keeps: in this page's storage, so it outlives a reload as the shell's files outlive a
   *  restart (`__manutMockHistory`). */
  private hist(): Record<string, { text: string; at: number }> {
    try {
      return JSON.parse(localStorage.getItem("__manutMockHistory") || "{}");
    } catch {
      return {};
    }
  }
  private putHist(h: Record<string, { text: string; at: number }>) {
    try {
      localStorage.setItem("__manutMockHistory", JSON.stringify(h));
    } catch {
      /* no storage */
    }
  }
  /** when history was last cleared (ms), as the shell keeps it: a write sent before then is dropped */
  private clearedAt = 0;
  async historySave(key: string, text: string, since: number) {
    this.log({ op: "history.save", key, data: text });
    if (!(since > this.clearedAt)) return;
    this.putHist({ ...this.hist(), [key]: { text, at: Date.now() / 1000 } });
  }
  async historyRead(key: string) {
    this.log({ op: "history.read", key });
    const late = this.g.__manutMockHistoryDelay;
    if (late) await new Promise((r) => setTimeout(r, late));
    return this.hist()[key] ?? null;
  }
  async historyRemove(key: string) {
    this.log({ op: "history.remove", key });
    const h = this.hist();
    delete h[key];
    this.putHist(h);
  }
  async historyPrune(keep: string[]) {
    this.log({ op: "history.prune", keep });
    this.putHist(Object.fromEntries(Object.entries(this.hist()).filter(([k]) => keep.includes(k))));
  }
  async termImportList() {
    this.log({ op: "import.list" });
    const all = this.g.__manutMockImport ?? MOCK_IMPORT;
    return (["iterm2", "terminal"] as const).filter((a) => !!all[a]);
  }
  async termImportRead(app: ImportApp) {
    this.log({ op: "import.read", key: app });
    const got = (this.g.__manutMockImport ?? MOCK_IMPORT)[app];
    if (!got) throw new Error("missing");
    return got.slice(0, 64);
  }
  async historyClear() {
    this.log({ op: "history.clear" });
    this.clearedAt = Math.max(this.clearedAt, Date.now());
    this.putHist({});
  }
  async removeFiles(session: string) {
    this.log({ op: "file.remove", session });
    for (const k of [...this.files.keys()]) if (k.includes(`/session-files/${session}/`)) this.files.delete(k);
  }
  async pruneFiles(keep: string[]) {
    this.log({ op: "file.prune", keep });
  }
  async branch(cwd: string) {
    const b = this.g.__manutBranches ?? { "/home/you/code/manut": "feat/session-controls" };
    return b[cwd] ?? "";
  }
  /** As the shell does it (src-tauri/src/lane.rs): the first name no branch has, made from the branch the folder is on, in
   *  a folder of its own under `~/.manut/lanes/<project>/<words>`, which is then on that branch; the developer's folder stays
   *  on its own. `__manutBranches` is where the folders' branches are (a folder with none is not a repository),
   *  `__manutMockTaken` the names that exist already, and `__manutLanes` the folders made, as the shell's records. */
  async laneWorktree(cwd: string, names: string[], start?: LaneStart): Promise<LaneMade> {
    const folders = (this.g.__manutBranches ??= { "/home/you/code/manut": "feat/session-controls" });
    const base = folders[cwd];
    if (!base) throw new Error("not_a_repository");
    const taken = (this.g.__manutMockTaken ??= []);
    const branch = names.find((n) => !taken.includes(n));
    if (!branch) throw new Error("taken");
    const lanes = (this.g.__manutLanes ??= []);
    const project = (cwd.split("/").filter(Boolean).pop() ?? "project").replace(/[^A-Za-z0-9._-]+/g, "-");
    const words = branch.slice(branch.lastIndexOf("/") + 1);
    const under = start?.root ? start.root.replace(/\/+$/, "") : "/home/you/.manut/lanes";
    let worktree = `${under}/${project}/${words}`;
    for (let n = 2; lanes.some((l) => l.worktree === worktree); n++) worktree = `${under}/${project}/${words}-${n}`;
    taken.push(branch);
    folders[worktree] = branch;
    lanes.unshift({ worktree, dir: worktree, branch, base, project: cwd, made: Math.floor(Date.now() / 1000) });
    this.log({ op: "lane.worktree", cwd, branch, base, path: worktree, ...(start ? { root: start.root, remote: start.remote } : {}) });
    // e2e: `__manutRemoteFrom` names the remote branch a folder's base has; without one a lane asked to start from the remote
    // says the folder has no remote
    const remoteFrom = start?.remote ? (this.g.__manutRemoteFrom?.[cwd] ?? "") : "";
    return { branch, base, dir: worktree, worktree, left: this.g.__manutLeft?.[cwd] ?? 0, from: remoteFrom, local: start?.remote && !remoteFrom ? "no_remote" : "", config: this.g.__manutConfig?.[cwd] ?? 0, stayed: this.g.__manutStayed?.[cwd] ?? 0 };
  }
  /** A browser cannot read this computer's files: nothing, unless e2e gave a stand-in of the shell's answer. */
  async agentConfig(): Promise<AgentConfig[] | null> {
    return this.g.__manutAgentConfig === undefined ? null : readAgentConfig(this.g.__manutAgentConfig);
  }
  /** As the shell: a folder inside a checkout (a folder `__manutBranches` knows, or one below it) is refused, as is a relative one. */
  async laneRootCheck(root: string): Promise<string> {
    if (!root.startsWith("/") || root.includes("..")) throw new Error("bad_root");
    if (root === "/" || root === "/home/you") throw new Error("root_too_broad");
    const checkouts = Object.keys(this.g.__manutBranches ?? { "/home/you/code/manut": "" });
    if (checkouts.some((c) => root === c || root.startsWith(`${c}/`))) throw new Error("root_in_checkout");
    this.log({ op: "lane.root", path: root });
    return root.replace(/\/+$/, "");
  }
  /** What e2e says git, gh and glab are (`__manutSourceTools`); none: all three here, the two CLIs signed out. */
  async sourceTools(fresh = false): Promise<SourceTools> {
    this.log({ op: "source.tools", ...(fresh ? { fresh } : {}) });
    return readTools(this.g.__manutSourceTools ?? { git: { installed: true, version: "2.54.0" }, github: { installed: true, version: "2.104.0", signed_in: false, accounts: [] }, gitlab: { installed: false } });
  }
  /** What e2e says a pull of each project finds (`__manutPulled`, the shell's answer); none: the branch is up to date. */
  async sourcePull(cwd: string): Promise<Pulled | null> {
    this.log({ op: "source.pull", cwd });
    return readPulled(this.g.__manutPulled?.[cwd] ?? { done: false, why: "current", branch: this.g.__manutBranches?.[cwd] ?? "main", remote: "origin", from: "", to: "", count: 0 });
  }
  /** The mock's asks, by id, as review.rs keeps them: each answered once. */
  private asks = new Map<string, { state: "waiting" | "decided" | "withdrawn"; ask: ReviewAsk }>();
  /** What e2e says a lane would go up with (`__manutReview`, by worktree); none: one commit, on github.com/you/<project>. */
  private reviewOf(worktree: string): { source: "github" | "gitlab"; repo: string; commits: string[]; refuse?: string; fail?: { step: string; error: string }; cannot?: string; title?: string } {
    const lane = (this.g.__manutLanes ?? []).find((l) => l.worktree === worktree);
    if (!lane) return { source: "github", repo: "", commits: [], refuse: "not_a_lane" };
    const name = lane.project.split("/").filter(Boolean).pop() ?? "project";
    return { source: "github", repo: `you/${name}`, commits: ["Work in this lane"], ...(this.g.__manutReview?.[worktree] ?? {}) };
  }
  /** What e2e says a title run answers (`__manutTitleRun`: words, or `{ error }`); none: a fixed title and body. */
  async titleRun(req: TitleRequest): Promise<TitleWords> {
    this.log({ op: "title.run", purpose: req.purpose, key: req.key, titleModel: req.model, titleEffort: req.effort });
    const a = this.g.__manutTitleRun;
    if (a && typeof a === "object" && "error" in a) throw new Error(String((a as { error: unknown }).error));
    const w = (a ?? {}) as Partial<TitleWords>;
    return { title: w.title ?? "A written title", body: req.purpose === "pull" ? (w.body ?? "A written description") : "" };
  }
  async titleCancel(key: string) {
    this.log({ op: "title.cancel", key });
  }
  async reviewDraft(worktree: string): Promise<ReviewDraft | null> {
    const lane = (this.g.__manutLanes ?? []).find((l) => l.worktree === worktree);
    const r = this.reviewOf(worktree);
    if (!lane || r.refuse === "not_a_lane") throw new Error("not_a_lane");
    return { branch: lane.branch, base: lane.base, commits: r.commits, count: r.commits.length };
  }
  async reviewAsk(worktree: string, title: string, body: string): Promise<ReviewAsk> {
    const lane = (this.g.__manutLanes ?? []).find((l) => l.worktree === worktree);
    const r = this.reviewOf(worktree);
    if (!lane || r.refuse) throw new Error(r.refuse ?? "not_a_lane");
    if (r.commits.length === 0) throw new Error("no_commits");
    if (!title.trim() || /[\u0000-\u001f]/.test(title)) throw new Error("bad_title");
    const id = Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    const ask: ReviewAsk = { id, kind: "open", source: r.source, repo: r.repo, remote: "origin", from: "", branch: lane.branch, base: lane.base, head: "0".repeat(40), commits: r.commits.length, uncommitted: this.g.__manutLaneChanged?.[worktree] ?? 0, title: title.trim(), body: body.replace(/\r\n/g, "\n").trimEnd(), number: 0, url: "", method: "", subject: "", message: "", dropped: 0 };
    this.asks.set(id, { state: "waiting", ask });
    this.log({ op: "review.ask", path: worktree, branch: lane.branch });
    return ask;
  }
  /** As the shell: a merge is asked only for a pull request that can merge (`__manutReview[worktree].merge`: why it cannot, or
   *  the title it has), with GitHub's own messages. */
  async reviewMerge(worktree: string, number: number, method: MergeMethod, credits = false): Promise<ReviewAsk> {
    const lane = (this.g.__manutLanes ?? []).find((l) => l.worktree === worktree);
    const r = this.reviewOf(worktree);
    if (!lane || r.refuse) throw new Error(r.refuse ?? "not_a_lane");
    if (r.cannot) throw new Error(`cannot_merge:${r.cannot}`);
    const title = r.title ?? "Work in this lane";
    const [subject, full] = method === "rebase" ? ["", ""] : method === "squash" ? [`${title} (#${number})`, r.commits.map((c) => `* ${c}`).join("\n\n")] : [`Merge pull request #${number} from ${lane.branch}`, title];
    // a browser has no shell to take the credit lines out: it takes out the one line Kit's stand-in agent signs with, so a walk
    // sees the count change
    const lines = full.split("\n");
    const kept = credits && method !== "rebase" ? lines.filter((l) => !/^co-authored-by: .*<noreply@anthropic\.com>$/i.test(l.trim())) : lines;
    const message = kept.join("\n");
    const dropped = lines.length - kept.length;
    const id = Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    const ask: ReviewAsk = { id, kind: "merge", source: r.source, repo: r.repo, remote: "origin", from: r.repo, branch: lane.branch, base: lane.base, head: "0".repeat(40), commits: r.commits.length, uncommitted: 0, title, body: "", number, url: `https://github.com/${r.repo}/pull/${number}`, method, subject, message, dropped };
    this.asks.set(id, { state: "waiting", ask });
    this.log({ op: "review.ask", path: worktree, branch: lane.branch });
    return ask;
  }
  /** As the shell: the request must be of the project's own repository and able to merge (`__manutPullMerge`), and the ask names its
   *  repository and branch with GitHub's own message. */
  async reviewMergePull(folder: string, source: "github" | "gitlab", repo: string, number: number, method: MergeMethod, _credits = false): Promise<ReviewAsk> {
    const remote = this.g.__manutTasks?.remotes?.[folder];
    if (!remote) throw new Error("no_remote");
    if (remote.source !== source || remote.repo.toLowerCase() !== repo.toLowerCase()) throw new Error("not_this_project");
    const r = this.g.__manutPullMerge?.[`${source}:${repo}:${number}`] ?? {};
    if (r.refuse) throw new Error(r.refuse);
    if (r.cannot) throw new Error(`cannot_merge:${r.cannot}`);
    const branch = r.branch ?? `change/${number}`;
    const title = r.title ?? `Change ${number}`;
    const owner = repo.split("/")[0];
    const [subject, message] = method === "rebase" ? ["", ""] : method === "squash" ? [`${title} (#${number})`, title] : [`Merge pull request #${number} from ${owner}/${branch}`, title];
    const id = Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    const ask: ReviewAsk = { id, kind: "merge", source, repo, remote: "origin", from: repo, branch, base: r.base ?? "main", head: "c".repeat(40), commits: 1, uncommitted: 0, title, body: "", number, url: `https://github.com/${repo}/pull/${number}`, method, subject, message, dropped: 0 };
    this.asks.set(id, { state: "waiting", ask });
    this.log({ op: "review.ask", path: folder, branch });
    return ask;
  }
  async reviewSettle(id: string, yes: boolean): Promise<ReviewDone> {
    const e = this.asks.get(id);
    if (!e) throw new Error("not_found");
    if (e.state !== "waiting") throw new Error(e.state === "decided" ? "already_decided" : "withdrawn");
    e.state = "decided";
    this.log({ op: "review.settle", path: e.ask.branch, yes, ...(yes ? (e.ask.kind === "merge" ? { title: e.ask.subject, body: e.ask.message } : { title: e.ask.title, body: e.ask.body }) : {}) });
    if (!yes) return { outcome: "declined", pushed: false, url: "", number: 0, step: "", error: "" };
    const fail = this.reviewOf((this.g.__manutLanes ?? []).find((l) => l.branch === e.ask.branch)?.worktree ?? "").fail;
    if (fail) return { outcome: "failed", pushed: fail.step === "create", url: "", number: 0, step: fail.step, error: fail.error };
    if (e.ask.kind === "merge") return { outcome: "merged", pushed: false, url: e.ask.url, number: e.ask.number, step: "", error: "" };
    const number = 100 + this.asks.size;
    return { outcome: "opened", pushed: true, url: `https://github.com/${e.ask.repo}/pull/${number}`, number, step: "", error: "" };
  }
  async reviewWithdraw(id: string): Promise<void> {
    const e = this.asks.get(id);
    if (e?.state === "waiting") e.state = "withdrawn";
  }
  /** As the shell: a folder with changed files, or commits on no remote, is kept; the branch always stays. */
  async laneRelease(worktree: string): Promise<LaneReleased> {
    const lane = (this.g.__manutLanes ?? []).find((l) => l.worktree === worktree);
    if (!lane) throw new Error("not_a_lane");
    const changed = this.g.__manutLaneChanged?.[worktree] ?? 0;
    const unpushed = this.g.__manutLaneUnpushed?.[worktree] ?? 0;
    if (changed > 0) return { removed: false, kept: "changes", changed, unpushed: null };
    if (unpushed > 0) return { removed: false, kept: "unpushed", changed: 0, unpushed };
    this.g.__manutLanes = (this.g.__manutLanes ?? []).filter((l) => l !== lane);
    this.log({ op: "lane.release", path: worktree });
    return { removed: true, kept: null, changed: null, unpushed: null };
  }
  /** As the shell, from what `__manutCleanMerged` says each project's clean-up finds. */
  async laneCleanMerged(cwd: string, held: string[]): Promise<LaneCleaned> {
    this.log({ op: "lane.clean", cwd, held });
    return this.g.__manutCleanMerged?.[cwd] ?? { removed: [], kept: [], cannot: null };
  }
  /** The mock lane whose folder `dir` is, or is in. */
  private laneAt(dir: string): MockLane | undefined {
    return (this.g.__manutLanes ?? []).find((l) => dir === l.worktree || dir.startsWith(`${l.worktree}/`));
  }
  /** The repository folder `cwd` reads as: a lane's folder is a worktree of the developer's folder it was made from. */
  private repoOf(cwd: string): string {
    return this.laneAt(cwd)?.project ?? cwd;
  }
  async laneList(cwd: string): Promise<KeptLane[]> {
    const repo = this.repoOf(cwd);
    return (this.g.__manutLanes ?? [])
      .filter((l) => l.project === repo)
      .map((l) => ({ worktree: l.worktree, dir: l.dir, branch: l.branch, base: l.base, made: l.made, exists: true, changed: this.g.__manutLaneChanged?.[l.worktree] ?? 0, ahead: this.g.__manutLaneAhead?.[l.worktree] ?? 0, unpushed: this.g.__manutLaneUnpushed?.[l.worktree] ?? 0 }));
  }
  async laneProjects(): Promise<string[]> {
    return [...new Set((this.g.__manutLanes ?? []).map((l) => l.project))].sort();
  }
  /** As the shell: a folder it made goes only once what is in it is what the person saw, and its branch only when asked. */
  async laneRemove(worktree: string, ask: LaneRemoveAsk): Promise<LaneRemoved> {
    const lanes = this.g.__manutLanes ?? [];
    const lane = lanes.find((l) => l.worktree === worktree);
    if (!lane) throw new Error("not_a_lane");
    const changed = this.g.__manutLaneChanged?.[worktree] ?? 0;
    const ahead = ask.branch ? (this.g.__manutLaneAhead?.[worktree] ?? 0) : null;
    if ((changed > 0 && changed !== ask.changed) || (ask.branch && ahead !== ask.ahead && ahead !== 0)) return { removed: false, deleted: false, changed, ahead, error: null };
    this.g.__manutLanes = lanes.filter((l) => l !== lane);
    if (this.g.__manutBranches) delete this.g.__manutBranches[worktree];
    if (ask.branch) this.g.__manutMockTaken = (this.g.__manutMockTaken ?? []).filter((b) => b !== lane.branch);
    this.log({ op: "lane.remove", path: worktree, size: changed, ...(ask.branch ? { branch: lane.branch } : {}) });
    return { removed: true, deleted: ask.branch, changed: null, ahead: null, error: null };
  }
  async laneDiff() {
    // a browser reads no folder: the pane shows what the chat's events say
    return null;
  }
  async mainMoved(cwd: string, o: { base?: string | null; show?: string[] } = {}) {
    this.log({ op: "main.moved", cwd, show: o.show ?? [], ...(o.base ? { base: o.base } : {}) });
    // a lane's folder is a worktree of the developer's repository: the base moved there as it did for the developer
    const v = (this.g.__manutMoved ?? { [MOCK_MOVED_ROOT]: MOCK_MOVED })[this.repoOf(cwd)];
    if (!v) return null;
    // the diffs of the paths asked for, as the shell gives them (only a path both sides changed)
    const both = (o.show ?? []).flatMap((p) => v.both.filter((b) => b.path === p));
    // as the shell reads it: the branch the folder has checked out now (a lane's own in its folder), against the branch the
    // page names as the base, else the answer's own
    const branch = this.g.__manutBranches?.[cwd] || v.branch;
    return { ...v, branch, base: o.base || v.base, both };
  }
  async reveal(cwd: string) {
    this.log({ op: "reveal", cwd });
  }
  async openTerminal(cwd: string) {
    this.log({ op: "terminal", cwd });
  }
  async editors() {
    return this.g.__manutEditors ?? MOCK_EDITORS;
  }
  async openInEditor(cwd: string, editor: string) {
    this.log({ op: "editor", cwd, editor });
    // a spec makes the shell refuse, with the shell's own words
    const refuse = this.g.__manutEditorFails;
    if (refuse) throw new Error(refuse);
  }
  async pastChats(agent: "claude" | "codex", cwds: string[]) {
    (this.g.__manutPastReads ??= []).push({ op: "list", agent, cwds });
    const all = this.g.__manutPastChats ?? MOCK_PAST;
    return all.filter((c) => c.agent === agent && cwds.includes(c.cwd)).sort((a, b) => b.at - a.at);
  }
  async pastMessages(agent: "claude" | "codex", id: string, cwd: string) {
    (this.g.__manutPastReads ??= []).push({ op: "read", agent, id, cwd });
    if (this.g.__manutMockConvStates?.[id] === "absent") throw new Error("no such conversation");
    const mine = agent === "claude" ? this.convs()[id] : undefined;
    if (mine) {
      if (mine.text === undefined || mine.cwd !== cwd) throw new Error("no such conversation");
      return [{ role: "user" as const, text: mine.text, ts: 0 }];
    }
    const c = (this.g.__manutPastChats ?? MOCK_PAST).find((x) => x.agent === agent && x.id === id && x.cwd === cwd);
    if (!c) throw new Error("no such conversation");
    return MOCK_PAST_MSGS[id] ?? [{ role: "user" as const, text: c.title, ts: c.at }];
  }
  /** As the shell (`conversation_state`): a told answer first; an account whose folder is gone is `unknown`; a Claude
   *  Code conversation the mock's terminals named is there once something was said in it; anything else `unknown`. */
  async conversationState(agent: "claude" | "codex", id: string, account?: string): Promise<ConvState> {
    (this.g.__manutConvChecks ??= []).push({ agent, id, ...(account ? { account } : {}) });
    const told = this.g.__manutMockConvStates?.[id];
    if (told) return told;
    if (account && this.g.__manutMockGoneAccounts?.includes(account)) return "unknown";
    const mine = agent === "claude" ? this.convs()[id] : undefined;
    if (mine) return mine.text === undefined ? "absent" : "exists";
    return "unknown";
  }
  /** As the shell: the conversation the Codex running in pty `id` holds open (`__manutMockCodexOwn[id]`, set by the
   *  test as that process's Codex writes its rollout), and nothing once that program ended or is not Codex. */
  async codexConversation(id: number) {
    (this.g.__manutPastReads ??= []).push({ op: "own", agent: "codex", pty: id });
    const s = this.live.get(id);
    if (!s || s.agent !== "codex") return null;
    return this.g.__manutMockCodexOwn?.[id] ?? null;
  }
  async badge(count: number) {
    this.g.__manutBadge = count;
  }
  async power(busy: boolean, now: boolean) {
    this.log({ op: "power.busy", busy, now });
  }
}

const MOCK_MODELS: Record<string, { id: string; label: string; provider?: string }[]> = {
  claude: [
    { id: "opus", label: "Opus 5.5" },
    { id: "sonnet", label: "Sonnet 5.5" },
    { id: "haiku", label: "Haiku 5.5" },
  ],
  codex: [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { id: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
  ],
  pi: [{ id: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5" }],
  omp: [{ id: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5" }],
  // as real omo lists them on this Mac: many anthropic models, then two from another provider below the fold
  omo: [
    ...["Claude Fable 5.1", "Claude Opus 5", "Claude Opus 4.7", "Claude Sonnet 5.5", "Claude Sonnet 5", "Claude Haiku 5.5", "Claude Haiku 4.5", "Claude Opus 4.5", "Claude Sonnet 4.5", "Claude Opus 4.1", "Claude Sonnet 4", "Claude Opus 4", "Claude Haiku 4", "Claude 3.7 Sonnet"].map((label) => ({
      id: `anthropic/${label.toLowerCase().replace(/ /g, "-").replace(/\./g, "-")}`,
      label,
      provider: "anthropic",
    })),
    { id: "opengateway/gpt-6", label: "GPT-6 (gateway)", provider: "opengateway" },
    { id: "opengateway/gemini-4-carbon", label: "Gemini 4 Carbon (gateway)", provider: "opengateway" },
  ],
  opencode: [
    { id: "opencode/big-pickle", label: "OpenCode/Big Pickle" },
    { id: "opencode/beam-free", label: "OpenCode/Beam Free" },
  ],
};

/** The agents on the Agent Client Protocol adapter (OpenCode and the generic list): their cards offer Deny and Allow
 *  once only. */
const isAcp = (agent: AgentId) => agent === "opencode" || !!acpRow(agent);
/** A generic ACP agent's sign-in command, from its row (acp_chat.rs's `signed_out` names the same). */
const loginOf = (agent: AgentId) => acpRow(agent)?.login ?? "";

/** What each mock agent reports about its controls, as the real CLIs do (see agent_chat.rs). */
const MOCK_CONTROLS: Partial<Record<AgentId, { mode?: string; efforts: string[]; effort: string; commands: { name: string; description: string; hint: string; kind: "command" | "skill"; prefix: "/" | "$" }[]; max: number }>> = {
  claude: {
    mode: "default",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    effort: "high",
    commands: [
      { name: "compact", description: "Free up context by summarizing the conversation so far", hint: "<instructions>", kind: "command", prefix: "/" },
      { name: "context", description: "Visualize current context usage", hint: "", kind: "command", prefix: "/" },
      { name: "init", description: "Initialize a new CLAUDE.md file with codebase documentation", hint: "", kind: "command", prefix: "/" },
      { name: "review", description: "Review a pull request", hint: "<pr>", kind: "command", prefix: "/" },
      { name: "archify", description: "Architecture diagrams as standalone HTML (user)", hint: "", kind: "skill", prefix: "/" },
      ...Array.from({ length: 60 }, (_, i) => ({ name: `skill-${String(i + 1).padStart(2, "0")}`, description: `Sample skill ${i + 1} (user)`, hint: "", kind: "skill" as const, prefix: "/" as const })),
    ],
    max: 1_000_000,
  },
  codex: {
    mode: "",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    effort: "medium",
    commands: [{ name: "review", description: "Review a change", hint: "", kind: "skill", prefix: "$" }],
    max: 258_400,
  },
  omo: {
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    effort: "medium",
    commands: [
      { name: "todo", description: "Show or edit the todo list", hint: "", kind: "command", prefix: "/" },
      { name: "skill:hyperframes", description: "Make or edit a video", hint: "", kind: "skill", prefix: "$" },
    ],
    max: 1_000_000,
  },
};
const MOCK_MODES: Partial<Record<AgentId, string[]>> = { claude: ["default", "plan", "acceptEdits"], codex: ["read-only", "ask", "auto"] };
/** A Codex mode as the approval policy and sandbox its thread reports (`codex_mode` in src-tauri/src/agent_chat.rs). */
const CODEX_MOCK_POLICY: Record<string, { approval: string; sandbox: string }> = {
  "read-only": { approval: "on-request", sandbox: "readOnly" },
  ask: { approval: "untrusted", sandbox: "workspaceWrite" },
  auto: { approval: "on-request", sandbox: "workspaceWrite" },
};
/** The mode a chat starts in when the page names none, as the shell's `careful_mode`. */
const MOCK_CAREFUL: Partial<Record<AgentId, string>> = { claude: "default", codex: "ask" };

/** One mock chat agent. `/approve` asks to run `rm -rf ./build`; `/slow` streams long enough to stop with
 *  Esc; `/exit` ends the program; `/title <name>` names the conversation as the agent; anything else gets a
 *  short answer after one tool step. A message sent while a turn runs is queued and answered after it, as Claude
 *  Code and OmO do; Stop drops it. `noChat`: an old version that never speaks its chat protocol, ended by the
 *  shell's start deadline (shortened here). `gone`: a Codex resume onto a thread that no longer exists. */
/** The agents that can take a message back (their own rewind): Claude Code and Codex. */
const MOCK_REWINDS: AgentId[] = ["claude", "codex"];

/** A real two-file edit as the Claude adapter emitted it (claude-12-work.jsonl, paths made relative). */
const MOCK_WORK = {
  thinking: ["Three small steps: a docstring on `add`, a new `mul`, ", "then list the functions in README.md."],
  todo: ["Add docstring to add() in calc.py", "Add mul(a, b) function to calc.py", "Update README.md with function list"],
  edits: [
    {
      id: "e-1",
      detail: "calc.py +2 -1",
      file: { path: "calc.py", kind: "update", lines: ["@@ -1,4 +1,5 @@", " def add(a, b):", '+    """Return the sum of a and b."""', "     return a + b", " ", " "], added: 1, removed: 0 },
    },
    {
      id: "e-2",
      detail: "calc.py +5 -2",
      file: { path: "calc.py", kind: "update", lines: ["@@ -5,3 +5,7 @@", " def sub(a, b):", "     return a - b", "+", "+", "+def mul(a, b):", "+    return a * b"], added: 4, removed: 0 },
    },
    {
      id: "e-3",
      detail: "README.md +3 -1",
      file: { path: "README.md", kind: "update", lines: ["@@ -1,3 +1,5 @@", " # calc", " ", " Tiny math helpers.", "+", "+Functions: `add(a, b)`, `sub(a, b)`, `mul(a, b)`"], added: 2, removed: 0 },
    },
  ],
  answer: "Done. `add` has a docstring, `mul(a, b)` is in calc.py, and README.md lists the functions:\n\n```python\ndef mul(a, b):\n    return a * b\n```",
};

/** What vitest prints for the canvas's project when its 14 tests pass, and when one of them fails (`/kit pass`, `/kit fail`). */
const MOCK_TESTS_PASS = [
  " ✓ tests/checkout.test.ts (6 tests) 8ms",
  " ✓ tests/promptpay.test.ts (8 tests) 11ms",
  "",
  " Test Files  2 passed (2)",
  "      Tests  14 passed (14)",
  "   Duration  2.1s",
  "",
].join("\n");
const MOCK_TESTS_FAIL = [
  " ❯ tests/promptpay.test.ts (8 tests | 1 failed) 14ms",
  "   × promptpay > locks the amount into the QR 3ms",
  "     → expected '59.00' to be '590.00' // Object.is equality",
  "",
  " FAIL  tests/promptpay.test.ts > promptpay > locks the amount into the QR",
  "AssertionError: expected '59.00' to be '590.00' // Object.is equality",
  "",
  " Test Files  1 failed | 1 passed (2)",
  "      Tests  1 failed | 13 passed (14)",
  "   Duration  2.3s",
  "",
].join("\n");

/** The plan Claude Code 2.1.323 wrote in plan mode (claude-14-plan-deny.jsonl), in English here. */
const MOCK_PLAN =
  "# Plan: add mul(a, b) to calc.py\n\n1. In `calc.py`, add `def mul(a, b): return a * b` below `sub`, two blank lines apart as the others are.\n2. In `README.md`, list the functions (`add`, `sub`, `mul`) under \"Tiny math helpers.\"\n\nCheck: `python3 -c \"from calc import mul; assert mul(3, 4) == 12\"`";

/** The change a Codex 0.167 sub-agent made (codex-15-sub-edit.jsonl), as the adapter's `diff` gives it. */
const MOCK_SUB_EDIT = [
  { path: "README.md", kind: "update" as const, lines: ["@@ -3 +3,3 @@", " Tiny math helpers.", "+", "+Functions: add, sub, mul"], added: 2, removed: 0 },
  { path: "calc.py", kind: "update" as const, lines: ["@@ -6 +6,5 @@", "     return a - b", "+", "+", "+def mul(a, b):", "+    return a * b"], added: 4, removed: 0 },
];

class MockChat {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private turn = false;
  private seq = 0;
  private waiting: string | null = null;
  /** the open approval is a subagent's (/subask) */
  private subWaiting = false;
  /** the open approval is plan mode's plan (/plan) */
  private planAsk = false;
  /** "/kit …": the command a scripted ask of Kit's (src/code/) is waiting to run, or "" */
  private kitAsk = "";
  /** the open approval is a background subagent's, asked after the turn ended (/lateask) */
  private lateAsk = false;
  /** "/subagents hold": the second subagent is still out */
  private holding = false;
  /** work Claude Code says still runs in the background (`background_tasks_changed`), and the background subagent
   *  among it (/lateask) */
  private bg = 0;
  private bgSub = false;
  private model: string;
  /** a model picked while a turn ran (Claude Code): the next turn's init confirms it */
  private next = "";
  private session: string;
  private used = 18_400;
  private queue: { text: string; id: string; images?: string[] }[] = [];
  /** "/stoplate": the command still runs after Stop and ends on its own later */
  private lateStep = "";
  private dead = false;
  /** messages this process took, for a rewind (Claude Code and Codex only) */
  private sent = 0;
  /** their bubble ids, in step, for a rewind to a turn */
  private sentIds: string[] = [];
  constructor(
    private agent: AgentId,
    private emit: (ev: ChatEvent) => void,
    resume?: string,
    private cwd = "",
    private how: { noChat?: boolean; gone?: boolean; unguarded?: boolean; signedOut?: boolean; suggest?: string; mode?: string } = {},
  ) {
    this.model = MOCK_MODELS[agent]?.[0]?.label ?? agentDef(agent).label;
    this.session = resume ?? `${agent}-mock-${Math.random().toString(16).slice(2, 10)}-0000-0000-000000000000`;
    if (agent === "claude" && !resume) this.session = "11111111-2222-4333-8444-555555555555";
    if (agent === "opencode" && !resume) this.session = "ses_e34e28c01ffeKlpLA61p3XV1cy";
    // the id a real OmO 5.1.56 session reported (its subagents' records are keyed by it; mock.sessionRun agent omo)
    if (agent === "omo" && !resume) this.session = "01a1ce7b-1c30-7e45-8913-aa00b3b32296";
    if (how.gone) this.session = `codex-mock-${Math.random().toString(16).slice(2, 10)}-0000-0000-000000000000`;
    // DeepSeek Harness names its session `session-<uuid>` and reports no model in its headless stream
    if (agent === "dsh") {
      if (!resume) this.session = "session-8c11e2bc-9f55-4bcb-a597-19ea472184e8";
      this.model = "";
    }
  }
  private at(ms: number, fn: () => void) {
    this.timers.push(setTimeout(fn, ms));
  }
  boot() {
    if (this.how.noChat) {
      // the shell's start deadline (agent_chat.rs START_DEADLINE): no protocol line came, so it ends the session
      const why = `${agentDef(this.agent).label} did not answer in chat mode; it may be an old version: update it, then Restart.`;
      this.timers.push(
        setTimeout(() => {
          this.dead = true;
          this.emit({ event: "session.error", kind: "no_chat_mode", message: why });
          if (this.turn) this.emit({ event: "turn.end", outcome: "error", error: why });
          this.turn = false;
          this.emit({ event: "exit", code: null, error: why });
        }, 600),
      );
      return;
    }
    if (this.how.signedOut) {
      // `session/new` answered -32000: acp_chat.rs says so once, with the row's sign-in command; manut ends it
      this.at(40, () => {
        const why = `${agentDef(this.agent).label} is not signed in. Run \`${loginOf(this.agent)}\` in a terminal and sign in.`;
        this.emit({ event: "session.error", kind: "signed_out", message: why, login: loginOf(this.agent) });
        if (this.turn) {
          this.turn = false;
          this.emit({ event: "turn.end", outcome: "error", error: why, signed_out: true, login: loginOf(this.agent) });
        }
        this.dead = true;
      });
      return;
    }
    this.at(20, () => {
      if (this.how.gone) this.emit({ event: "session.note", kind: "new_conversation", text: "The earlier Codex conversation was not found; a new one started." });
      const c = MOCK_CONTROLS[this.agent];
      // the mode it started in, named at the start (item 89), as Claude Code's initialize and Codex's thread report it
      const mode = this.how.unguarded ? undefined : (this.how.mode ?? c?.mode);
      this.emit({ event: "session.info", agent_session: this.session, ...(this.model ? { model: this.model } : {}), ...(c ? { effort: c.effort } : {}), ...(mode !== undefined ? { mode } : {}) });
      // the thread's own approval policy and sandbox, as the Codex adapter reports them: the started mode's, unless a test
      // stands in for a Codex whose own config won over them
      if (this.agent === "codex")
        this.emit({ event: "session.info", ...(this.how.unguarded ? { approval: "never", sandbox: "dangerFullAccess", mode: "" } : CODEX_MOCK_POLICY[mode ?? "ask"]) });
      this.emit({ event: "session.models", options: (MOCK_MODELS[this.agent] ?? []).map((m) => ({ ...m, detail: "" })) });
      if (c) {
        this.emit({ event: "session.efforts", levels: c.efforts });
        this.emit({ event: "session.commands", commands: c.commands });
        this.emit({ event: "session.usage", used: this.used, max: c.max });
      }
      // the agent's own commands and skills (ACP `available_commands_update`), as acp_chat.rs sends them
      if (this.agent === "opencode")
        this.emit({ event: "session.commands", commands: ["init", "review"].map((name) => ({ name, description: "", hint: "", kind: "command", prefix: "/" })) });
    });
  }
  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
  private end(outcome: "done" | "interrupted" | "ended" | "error", error?: string) {
    if (!this.turn) return;
    this.stop();
    this.turn = false;
    this.waiting = null;
    const next = this.queue;
    this.queue = [];
    // Stop drops what waited (OmO clears its queue; Codex never recorded it)
    if (outcome === "interrupted") for (const q of next) this.emit({ event: "message.dropped", id: q.id });
    this.emit({ event: "turn.end", outcome, ...(error ? { error } : {}) });
    // Claude Code's predicted next prompt follows a turn that finished well (when the chat was started asking for it)
    if (outcome === "done" && this.how.suggest) this.emit({ event: "suggestion", text: this.how.suggest });
    if (MOCK_REWINDS.includes(this.agent)) this.emit({ event: "session.info", rewind: this.sent > 0 });
    const c = MOCK_CONTROLS[this.agent];
    if (c) {
      this.used += 6_200;
      this.emit({ event: "session.usage", used: this.used, max: c.max });
    }
    // a finished turn takes what was sent during it as the next turn
    if (outcome === "done" && next.length) {
      const [first, ...rest] = next;
      this.queue = rest;
      this.at(80, () => {
        this.emit({ event: "message.taken", id: first.id });
        this.input({ kind: "send", text: first.text, images: first.images });
      });
    }
  }
  private background(n: number) {
    this.bg = n;
    this.emit({ event: "session.info", background: n });
  }
  /** The agent took the person's message `id`: its own rewind can take it back (agent_chat.rs keeps each message it took). */
  private took(id?: string) {
    this.sent++;
    this.sentIds.push(id ?? "");
  }
  private say(text: string, at: number) {
    const parts = [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];
    this.at(at, () => this.emit({ event: "delta", text: parts[0] }));
    this.at(at + 120, () => this.emit({ event: "delta", text: parts[1] }));
    this.at(at + 240, () => this.emit({ event: "message", id: `m${++this.seq}`, text }));
  }
  input(i: ChatInput) {
    if (this.dead) throw new Error("the session has ended");
    if (i.kind === "send" && this.turn && i.id) {
      // sent while a turn runs: it waits until the agent takes it
      this.queue.push({ text: i.text, id: i.id, images: i.images });
      this.emit({ event: "message.queued", id: i.id });
      return;
    }
    if (i.kind === "steer") {
      // as the adapters do: only an agent with its own mid-turn input, only while a turn runs; it reads the message
      // into the running turn, then says it took it
      if (!steersOf(this.agent)) throw new Error(`${agentDef(this.agent).label} cannot take a message into a running answer`);
      if (!this.turn) throw new Error("nothing is running to steer");
      this.at(60, () => this.emit({ event: "message.taken", id: i.id }));
      return;
    }
    if (i.kind === "mode") {
      if (!(MOCK_MODES[this.agent] ?? []).includes(i.mode)) throw new Error(`not a mode Manut AI offers: ${i.mode}`);
      this.at(20, () => this.emit({ event: "session.info", mode: i.mode }));
      return;
    }
    if (i.kind === "effort") {
      if (!(MOCK_CONTROLS[this.agent]?.efforts ?? []).includes(i.effort)) throw new Error(`unknown effort ${i.effort}`);
      this.at(20, () => this.emit({ event: "session.info", effort: i.effort }));
      return;
    }
    if (i.kind === "send") {
      if (!this.turn) {
        this.turn = true;
        this.emit({ event: "turn.start" });
        if (this.next) {
          // the turn's init: it runs on the model picked during the last one
          this.model = this.next;
          this.next = "";
          this.emit({ event: "session.info", model: this.model, model_next: "" });
        }
      }
      if (this.how.noChat) return; // the old program reads it and says nothing
      const text = i.text.trim();
      if (text === "/exit") {
        this.at(30, () => {
          // a clean exit mid-turn, as the Rust watcher reports it (exit_turn_end)
          this.end("ended");
          this.emit({ event: "exit", code: 0, error: "" });
        });
        return;
      }
      if (text === "/quit") {
        // codex-15 (Codex 0.167): the person's own config makes Codex print a warning at start; the program then
        // closes in order (code 0). Before manut 0.2.7 the shell sent that warning as the exit's reason.
        this.at(30, () => {
          this.end("ended");
          this.dead = true;
          this.emit({ event: "exit", code: 0, error: "user (~/.codex/config.toml): `mcp_servers.playwright.type` is ignored." });
        });
        return;
      }
      if (text.startsWith("/plan")) {
        // claude-14-plan-deny.jsonl as the Claude adapter emits it: plan mode's end (ExitPlanMode) with the plan the
        // agent wrote; Claude Code offers no rule to keep for it, so Deny and Allow once only
        const rid = `req-${++this.seq}`;
        this.at(60, () => {
          this.waiting = rid;
          this.planAsk = true;
          this.emit({ event: "approval.request", request_id: rid, title: "Start working on this plan?", command: "", cwd: this.cwd, choices: ["deny", "once"], plan: MOCK_PLAN });
        });
        return;
      }
      if (text.startsWith("/kit ")) {
        // Kit's states on the Code page (src/code/): an ask as the shell writes it (agent_chat.rs), a key typed into a
        // change (`tool.diff`), each from a word; `/kit key` uses a plainly fake key; `/kit shop` a change that reads
        // the shop ID from the environment. Each is a whole turn like any other: the agent took its message, so Rewind
        // (src/sessions/rewind.ts) can take the turn back
        this.took(i.id);
        const word = text.slice(5).trim();
        if (word === "key") {
          const lines = ["@@ -1,2 +1,3 @@", " export const CURRENCY = 'THB';", '+export const PROMPTPAY_KEY = "sk-FAKE0000000000000000TEST";'];
          this.at(60, () => this.emit({ event: "tool.diff", tool_id: "t-kit", files: [{ path: "src/config.ts", kind: "update", lines, added: 1, removed: 0 }] }));
          this.say("I put the PromptPay key in src/config.ts.", 120);
          this.at(400, () => this.end("done"));
          return;
        }
        if (word === "shop") {
          // a change whose code reads the PromptPay shop ID from the environment, as the canvas's checkout needs (src/code/preview.ts)
          const lines = ["@@ -12,3 +12,4 @@", "   const total = order.items.reduce(sum, 0);", "+  const qr = promptPayQR(process.env.PROMPTPAY_SHOP_ID, total);", "   return <PayPanel amount={total} qr={qr} />;"];
          this.at(60, () => this.emit({ event: "tool.diff", tool_id: "t-kit", files: [{ path: "src/checkout.tsx", kind: "update", lines, added: 1, removed: 0 }] }));
          this.say("The QR code reads the shop ID from PROMPTPAY_SHOP_ID.", 120);
          this.at(400, () => this.end("done"));
          return;
        }
        // each names what it is as the shell does from Claude Code's own request (`tool`, src-tauri/src/ask_tool.rs)
        const cwd = this.cwd;
        const run = (line: string) => ({ title: "Run this command?", command: line, tool: { kind: "command" as const, name: "Bash", line, cwd } });
        // a lane's work as its events show it (src/code/lane.ts): a file edit, then a test run whose output comes with the
        // step's end (`tool.end`'s `output`, as the shell sends it). `pass`: 14 tests passed; `fail`: 1 of 14 failed;
        // `unread`: an output no runner printed; `slow`: the run goes on for a few seconds, so the lane is seen working.
        const runs: Record<string, { ok: boolean; output: string; say: string; ms: number }> = {
          pass: { ok: true, output: MOCK_TESTS_PASS, say: "I replaced bank transfer with a PromptPay QR. All 14 tests pass.", ms: 500 },
          slow: { ok: true, output: MOCK_TESTS_PASS, say: "The tests pass. Nothing is live.", ms: 3_000 },
          fail: { ok: false, output: MOCK_TESTS_FAIL, say: "One test fails: the QR holds 59.00 where it should hold 590.00.", ms: 500 },
          unread: { ok: true, output: "Done in 2.1s\n", say: "I ran the tests.", ms: 500 },
        };
        if (runs[word]) {
          const r = runs[word];
          const lines = ["@@ -12,3 +12,9 @@", "   const total = order.items.reduce(sum, 0);", "-  return <PayByTransfer amount={total} />;", "+  const qr = promptPayQR(SHOP_ID, total);"];
          this.at(60, () => this.emit({ event: "tool.start", tool_id: "t-edit", name: "patch", detail: "src/checkout.tsx +6 -1" }));
          this.at(80, () => this.emit({ event: "tool.diff", tool_id: "t-edit", files: [{ path: "src/checkout.tsx", kind: "update", lines, added: 6, removed: 1 }] }));
          this.at(120, () => this.emit({ event: "tool.end", tool_id: "t-edit", name: "", ok: true, ms: 60 }));
          this.at(200, () => this.emit({ event: "tool.start", tool_id: "t-test", name: "terminal", detail: "pnpm test" }));
          this.at(200 + r.ms, () => this.emit({ event: "tool.end", tool_id: "t-test", name: "", ok: r.ok, ms: r.ms, output: r.output }));
          this.say(r.say, 260 + r.ms);
          this.at(700 + r.ms, () => this.end("done"));
          return;
        }
        const asks: Record<string, { title: string; command: string; tool: AskTool }> = {
          install: run("pnpm add qrcode"),
          test: run("pnpm test"),
          merge: run("git merge main"),
          commit: run("git commit -m 'Add a PromptPay QR'"),
          deploy: run("wrangler deploy"),
          // a script run by its name: the card shows what the script runs, from the lane's package.json
          build: run("pnpm build"),
          edit: { title: "Allow Edit to change src/checkout.tsx?", command: "", tool: { kind: "edit", name: "Edit", paths: [`${cwd}/src/checkout.tsx`], cwd } },
          outside: { title: "Allow Read?", command: "/home/you/Documents/tax-2026.xlsx", tool: { kind: "read", name: "Read", paths: ["/home/you/Documents/tax-2026.xlsx"], cwd } },
        };
        const a = asks[word];
        if (!a) {
          this.say(`No such step: ${word}`, 40);
          this.at(200, () => this.end("done"));
          return;
        }
        const rid = `kit-${++this.seq}`;
        this.at(60, () => {
          this.waiting = rid;
          this.kitAsk = a.command || a.title;
          this.emit({ event: "approval.request", request_id: rid, title: a.title, command: a.command, cwd: this.cwd, choices: ["deny", "once", "session"], tool: a.tool });
        });
        return;
      }
      if (text.startsWith("/subedit")) {
        // codex-15-sub-edit.jsonl as the Codex adapter emits it: the edit runs in a sub-agent's own thread, whose file
        // change carries its patch; the main thread edits nothing
        const sub = (extra: Record<string, unknown>) =>
          this.emit({ event: "subagent", id: "thr-sub", agent: this.agent, name: "add mul", goal: "", delegation: "codex-turn-1", index: 0, count: 1, state: "running", model: "gpt-6.1-sol", ...extra });
        const step = MOCK_SUB_EDIT.map((f) => `${f.path} +${f.added}`).join(", ");
        this.at(40, () => sub({}));
        this.at(120, () => sub({ tool: "terminal", step: "cat calc.py README.md" }));
        this.at(200, () => sub({ tool: "patch", step, diff: MOCK_SUB_EDIT }));
        this.at(260, () => sub({ tool: "patch", step, diff: MOCK_SUB_EDIT }));
        this.at(400, () => sub({ state: "done", summary: "Added mul(a, b) to calc.py and listed the functions in README.md.", seconds: 18.2 }));
        this.say("The sub-agent added mul(a, b) to calc.py and listed the functions in README.md.", 480);
        this.at(800, () => this.end("done"));
        return;
      }
      if (text.startsWith("/approve")) {
        const rid = `req-${++this.seq}`;
        this.at(60, () => this.emit({ event: "tool.start", tool_id: "t-rm", name: "terminal", detail: "rm -rf ./build" }));
        this.at(140, () => {
          this.waiting = rid;
          // an ACP agent (OpenCode) offers Deny and Allow once only: its "always" is a saved project rule
          const choices = isAcp(this.agent) ? ["deny", "once"] : ["deny", "once", "session"];
          this.emit({ event: "approval.request", request_id: rid, title: "Run this command?", command: "rm -rf ./build", cwd: this.cwd, choices });
        });
        return;
      }
      if (text.startsWith("/ask")) {
        // the shapes the adapters emit for a question (Claude Code AskUserQuestion, a Codex question) and a file edit
        const rid = `ask-${++this.seq}`;
        this.at(60, () => {
          this.waiting = rid;
          this.emit({ event: "clarify.request", request_id: rid, question: "Which greeting should go in greet.txt?", choices: ["hello", "hi"] });
        });
        return;
      }
      if (text.startsWith("/bad")) {
        this.at(60, () => this.emit({ event: "tool.start", tool_id: "t-bad", name: "terminal", detail: "definitely-not-a-command-xyz --flag" }));
        this.at(140, () => this.emit({ event: "tool.end", tool_id: "t-bad", name: "", ok: false, ms: 20 }));
        this.say("Exit code: 127.", 200);
        this.at(600, () => this.end("done"));
        return;
      }
      if (text.startsWith("/title ")) {
        // the agent names the conversation (Claude Code session_title_changed, Codex thread/name/updated)
        const name = text.slice(7).trim();
        this.at(40, () => this.emit({ event: "session.info", title: name }));
        this.say("Named it.", 80);
        this.at(400, () => this.end("done"));
        return;
      }
      if (text.startsWith("/signedout")) {
        this.at(60, () => this.end("error", `${agentDef(this.agent).label} is not signed in. Sign in from Settings › Accounts, then Restart.`));
        return;
      }
      if (text === "/die") {
        // the program dies mid-turn with nothing more on its stdout (a crash before the shell saw the turn)
        this.at(60, () => this.emit({ event: "delta", text: "partial" }));
        this.at(120, () => {
          this.stop();
          this.turn = false;
          this.emit({ event: "exit", code: null, error: "" });
        });
        return;
      }
      if (text.endsWith("/late")) {
        // OmO (omo-1-plain.jsonl): the answer, the turn's end, then a status of its own (`setStatus`) after it
        this.say("ok", 60);
        this.at(400, () => {
          this.end("done"); // clears the pending timers: the late events are scheduled after it
          this.at(50, () => this.emit({ event: "status", text: "mem:khope-sionic-ai-d09472c9 9d ago (+1)" }));
          this.at(100, () => this.emit({ event: "thinking" }));
        });
        return;
      }
      if (text.startsWith("/batch")) {
        // omo-13-batch.jsonl as the Pi adapter emits it (OmO 5.1.56): one foreground `task` with two subagents and
        // a todo list; the task result names no answer, so each row ends with what OmO's own record of that task id
        // says (answer, model, its own time), the record Plans reads too
        const d = "pi-toolu_batch";
        const sub = (i: number, extra: Record<string, unknown>) =>
          this.emit({
            event: "subagent", id: `toolu_batch:${i}`, agent: this.agent, name: i ? "helper-b-line-count" : "helper-a-first-line",
            goal: i ? "helper-b-line-count: count lines of a.txt and reply LINE_COUNT: <number>" : "helper-a-first-line: read a.txt and reply FIRST_LINE: <first line>",
            delegation: d, index: i, count: i + 1, state: "queued", ...extra,
          });
        const plan = (a: string, b: string) => this.emit({ event: "plan", items: [{ text: "Spawn foreground batch of two helper tasks", status: a }, { text: "Give one-line summary of batch results", status: b }] });
        this.at(40, () => this.emit({ event: "tool.start", tool_id: "toolu_batch", name: "delegate_task", detail: "helper-a-first-line, helper-b-line-count" }));
        this.at(50, () => sub(0, {}));
        this.at(60, () => sub(1, {}));
        this.at(70, () => plan("in_progress", "pending"));
        this.at(900, () => {
          this.emit({ event: "tool.end", tool_id: "toolu_batch", name: "", ok: true, ms: 0 });
          sub(0, { count: 2, state: "done", summary: "FIRST_LINE: alpha line", model: "claude-haiku-5-5", seconds: 19.9 });
          sub(1, { count: 2, state: "done", summary: "LINE_COUNT: 3", model: "claude-haiku-5-5", seconds: 28.6 });
          plan("completed", "completed");
        });
        this.say("Both helpers came back: `FIRST_LINE: alpha line` and `LINE_COUNT: 3`.", 1000);
        this.at(1200, () => this.end("done"));
        return;
      }
      if (text.startsWith("/subagents")) {
        // the events the Claude adapter emitted for a real run (claude-9-subagents.jsonl): two Agent calls in one
        // message, each subagent's own step, then each one's own answer and time; the second one is slow enough to
        // look at while it works. "/subagents hold" leaves the second one working until Stop or "/release".
        // (OmO's `task` names its subagents' type, `explore`; Claude Code's Agent calls are `general-purpose`)
        const kind = this.agent === "omo" ? "explore" : "general-purpose";
        const sub = (id: string, index: number, goal: string, extra: Record<string, unknown> = {}) =>
          this.emit({ event: "subagent", id, agent: this.agent, name: kind, goal, delegation: "claude-msg_1", index, count: index + 1, state: "running", ...extra });
        this.at(40, () => this.emit({ event: "tool.start", tool_id: "sa-1", name: "delegate_task", detail: "Read a.txt first line" }));
        this.at(50, () => sub("sa-1", 0, "Read a.txt first line"));
        this.at(120, () => sub("sa-1", 0, "Read a.txt first line", { tool: "read_file", step: "a.txt" }));
        this.at(160, () => this.emit({ event: "tool.start", tool_id: "sa-2", name: "delegate_task", detail: "Count lines of b.txt" }));
        this.at(170, () => sub("sa-2", 1, "Count lines of b.txt", { count: 2 }));
        this.at(260, () => sub("sa-2", 1, "Count lines of b.txt", { count: 2, tool: "read_file", step: "b.txt" }));
        this.at(600, () => {
          this.emit({ event: "tool.end", tool_id: "sa-1", name: "", ok: true, ms: 0 });
          sub("sa-1", 0, "Read a.txt first line", { count: 2, state: "done", summary: "alpha line", seconds: 3.7, model: "claude-fable-5-2" });
        });
        if (text.includes("hold")) {
          this.holding = true;
          return;
        }
        this.at(1400, () => {
          this.emit({ event: "tool.end", tool_id: "sa-2", name: "", ok: true, ms: 0 });
          sub("sa-2", 1, "Count lines of b.txt", { count: 2, state: "done", summary: "3", seconds: 9.4, model: "claude-fable-5-2" });
        });
        this.say("a.txt starts with alpha line; b.txt has 3 lines.", 1500);
        this.at(1900, () => this.end("done"));
        return;
      }
      if (text.startsWith("/subask")) {
        // claude-9-subagent-ask.jsonl: a subagent's Bash needs approval; the card names the subagent
        const rid = `req-${++this.seq}`;
        this.at(40, () => this.emit({ event: "tool.start", tool_id: "sa-3", name: "delegate_task", detail: "Write c.txt via echo" }));
        this.at(50, () => this.emit({ event: "subagent", id: "sa-3", agent: this.agent, name: "general-purpose", goal: "Write c.txt via echo", delegation: "claude-msg_2", index: 0, count: 1, state: "running" }));
        this.at(120, () => this.emit({ event: "subagent", id: "sa-3", agent: this.agent, name: "general-purpose", goal: "Write c.txt via echo", delegation: "claude-msg_2", index: 0, count: 1, state: "running", tool: "terminal", step: "echo three > c.txt" }));
        this.at(160, () => {
          this.waiting = rid;
          this.subWaiting = true;
          this.emit({ event: "approval.request", request_id: rid, title: "Run this command?", command: "echo three > c.txt", cwd: this.cwd, choices: ["deny", "once", "session"], subagent: { id: "sa-3", name: "Write c.txt via echo" } });
        });
        return;
      }
      if (text.startsWith("/lateask")) {
        // claude-13-late-ask.jsonl (Claude Code 2.1.322): the subagent runs in the background, the turn ends, and only
        // then the subagent asks; the answer reaches Claude Code with no turn running, the subagent finishes, and
        // Claude Code's own turn tells of it
        const rid = `req-${++this.seq}`;
        const sub = (extra: Record<string, unknown>) =>
          this.emit({ event: "subagent", id: "sa-4", agent: this.agent, name: "general-purpose", goal: "Write gamma to c.txt", delegation: "claude-msg_3", index: 0, count: 1, state: "running", model: "claude-opus-5-5", ...extra });
        this.at(40, () => this.emit({ event: "tool.start", tool_id: "sa-4", name: "delegate_task", detail: "Write gamma to c.txt" }));
        this.at(50, () => {
          this.bgSub = true;
          sub({ model: "claude-opus-5-5" });
        });
        this.at(60, () => this.background(1));
        this.at(80, () => this.emit({ event: "tool.end", tool_id: "sa-4", name: "", ok: true, ms: 0 }));
        this.say("started", 100);
        this.at(500, () => {
          this.end("done"); // clears the pending timers: the late ask is scheduled after it
          this.at(300, () => sub({ tool: "terminal", step: "echo gamma > c.txt" }));
          this.at(400, () => {
            this.waiting = rid;
            this.lateAsk = true;
            this.emit({ event: "approval.request", request_id: rid, title: "Run this command?", command: "echo gamma > c.txt", cwd: this.cwd, choices: ["deny", "once", "session"], subagent: { id: "sa-4", name: "Write gamma to c.txt" } });
          });
        });
        return;
      }
      if (text.startsWith("/retry")) {
        // omo-12-retry.jsonl as the Pi adapter emits it: OmO retries the failed run once by itself (the line says
        // which try), the retry fails too, and the turn ends once with OmO's own reason
        this.at(60, () => this.emit({ event: "status", text: "Retrying 1 of 5", retry: { attempt: 1, max: 5 } }));
        if (text.includes("hold")) return;
        this.at(900, () =>
          this.end("error", "Anthropic rejected this conversation's request format, even after retrying without web search replay data. Run /compact or start a new session to continue, and report it if it happens again."),
        );
        return;
      }
      if (text.startsWith("/stoplate")) {
        // codex-12-late-step.jsonl: a foreground command; Stop ends the turn at once but the command runs on, and
        // Codex reports its end after the turn (`item/completed`, 39.9 s in all)
        this.at(60, () => this.emit({ event: "tool.start", tool_id: "exec-late", name: "terminal", detail: "sleep 40; echo late" }));
        this.lateStep = "exec-late";
        return;
      }
      if (text.startsWith("/draft")) {
        // an agent's reply holding an manut-agent draft: a session chat shows no Add agent chip for it
        this.say('Here is one:\n\n```manut-agent\n{"name": "Stub ACP", "program": "stub-acp", "args": ["acp"]}\n```', 80);
        this.at(200, () => this.end("done"));
        return;
      }
      if (text.startsWith("/background")) {
        // the turn ends with a command still running in the background (Claude background_tasks_changed, OmO
        // waiting_background): the header says so until it ends. "hold": it runs on until Stop; "busy": the turn
        // itself goes on too
        this.at(40, () => this.background(1));
        this.say("started", 80);
        if (text.includes("busy")) return;
        this.at(400, () => {
          this.end("done"); // clears the pending timers: the background's end is scheduled after it
          if (!text.includes("hold")) this.at(1100, () => this.background(0));
        });
        return;
      }
      if (text.startsWith("/slow")) {
        for (let k = 0; k < 40; k++) this.at(100 + k * 250, () => this.emit({ event: "delta", text: `line ${k + 1}\n` }));
        return;
      }
      this.took(i.id);
      if (text.startsWith("/work")) {
        // the events the Claude adapter emitted for a real two-file edit (Claude Code 2.1.322, claude-12-work.jsonl):
        // thinking text, its todo list (TaskCreate, then TaskUpdate per item), an Edit per file with its change,
        // then the answer. "/work hold" stops before the last item and the answer.
        const hold = text.includes("hold");
        const plan = (s: string[]) => this.emit({ event: "plan", items: MOCK_WORK.todo.map((t, k) => ({ text: t, status: s[k] })) });
        MOCK_WORK.thinking.forEach((t, k) => this.at(30 + k * 20, () => this.emit({ event: "thinking", text: t })));
        this.at(120, () => plan(["pending", "pending", "pending"]));
        this.at(160, () => plan(["in_progress", "pending", "pending"]));
        // held: the last edit has not run yet (the list shows it under way)
        MOCK_WORK.edits.slice(0, hold ? -1 : undefined).forEach((e, k) => {
          const at = 200 + k * 160;
          this.at(at, () => this.emit({ event: "tool.start", tool_id: e.id, name: "patch", detail: e.detail }));
          this.at(at + 10, () => this.emit({ event: "tool.diff", tool_id: e.id, files: [e.file] }));
          this.at(at + 80, () => this.emit({ event: "tool.end", tool_id: e.id, name: "", ok: true, ms: 70 }));
          this.at(at + 100, () => plan(MOCK_WORK.todo.map((_, j) => (j <= k ? "completed" : j === k + 1 ? "in_progress" : "pending"))));
        });
        if (hold) return;
        this.say(MOCK_WORK.answer, 620);
        this.at(1000, () => this.end("done"));
        return;
      }
      this.at(60, () => this.emit({ event: "tool.start", tool_id: `t${this.seq}`, name: "read_file", detail: "README.md" }));
      this.at(300, () => this.emit({ event: "tool.end", tool_id: `t${this.seq}`, name: "", ok: true, ms: 240 }));
      const pics = i.images?.length ? ` (${i.images.length} picture${i.images.length > 1 ? "s" : ""})` : "";
      this.say(`(mock ${agentDef(this.agent).label}) You said: ${text}${pics}`, 360);
      this.at(800, () => this.end("done"));
    } else if (i.kind === "rewind") {
      if (!MOCK_REWINDS.includes(this.agent)) throw new Error(`${agentDef(this.agent).label} cannot take a message back here`);
      if (this.turn) throw new Error("wait until the turn ends");
      if (this.sent < 1) throw new Error("nothing to take back");
      this.sent--;
      this.sentIds.pop();
      this.at(30, () => {
        this.emit({ event: "rewound" });
        this.emit({ event: "session.info", rewind: this.sent > 0 });
      });
    } else if (i.kind === "rewind_to") {
      // agent_chat.rs `Input::RewindTo`: back to before the named message, and everything after it goes too
      if (!MOCK_REWINDS.includes(this.agent)) throw new Error(`${agentDef(this.agent).label} cannot take a message back here`);
      if (this.turn) throw new Error("wait until the turn ends");
      const at = i.id ? this.sentIds.lastIndexOf(i.id) : -1;
      if (at < 0) throw new Error(`${agentDef(this.agent).label} cannot take that message back here`);
      this.sentIds = this.sentIds.slice(0, at);
      this.sent = at;
      this.at(30, () => {
        this.emit({ event: "rewound", id: i.id });
        this.emit({ event: "session.info", rewind: this.sent > 0 });
      });
    } else if (i.kind === "interrupt") {
      if (!this.turn && this.agent === "claude" && (this.bg > 0 || this.lateAsk)) {
        // claude-13-late-ask-stop / claude-14-background-stop.jsonl: no turn runs; Claude Code withdraws the late ask,
        // stops its background subagent and command, and says nothing is left in the background
        this.stop();
        this.at(20, () => {
          if (this.lateAsk && this.waiting) this.emit({ event: "prompt.expired", request_id: this.waiting, reason: "cancelled" });
          this.lateAsk = false;
          this.waiting = null;
          if (this.bgSub) this.emit({ event: "subagent", id: "sa-4", agent: this.agent, name: "general-purpose", goal: "Write gamma to c.txt", delegation: "claude-msg_3", index: 0, count: 1, state: "cancelled", model: "claude-opus-5-5" });
          this.bgSub = false;
          this.background(0);
        });
        return;
      }
      if (!this.turn) throw new Error("nothing is running");
      this.at(20, () => {
        // as the Claude adapter does: a subagent still out when the turn stops is cancelled with it
        if (this.holding) this.emit({ event: "subagent", id: "sa-2", agent: this.agent, name: "general-purpose", goal: "Count lines of b.txt", delegation: "claude-msg_1", index: 1, count: 2, state: "cancelled" });
        this.holding = false;
        const late = this.lateStep;
        this.lateStep = "";
        this.end("interrupted");
        if (late) this.timers.push(setTimeout(() => this.emit({ event: "tool.end", tool_id: late, name: "", ok: true, ms: 39_887 }), 600));
      });
    } else if (i.kind === "approve") {
      if (i.request_id !== this.waiting) throw new Error("no such request");
      this.waiting = null;
      if (this.lateAsk) {
        // no turn runs: the subagent goes on, ends, the background count drops, and Claude Code's own turn says so
        this.lateAsk = false;
        const done = i.choice !== "deny";
        this.at(300, () => {
          this.bgSub = false;
          this.emit({ event: "subagent", id: "sa-4", agent: this.agent, name: "general-purpose", goal: "Write gamma to c.txt", delegation: "claude-msg_3", index: 0, count: 1, state: "done", summary: done ? "WROTE" : "The command was not allowed.", seconds: 7.4, model: "claude-opus-5-5" });
        });
        this.at(320, () => this.background(0));
        this.at(400, () => {
          this.turn = true;
          this.emit({ event: "turn.start" });
          this.say(done ? "The subagent finished and reported WROTE." : "The subagent could not write c.txt.", 20);
          this.at(400, () => this.end("done"));
        });
      } else if (this.planAsk) {
        // allowed: plan mode ends and the work starts; denied: the agent asks what to change
        this.planAsk = false;
        if (i.choice === "deny") this.say("What should change in the plan?", 60);
        else {
          this.at(30, () => this.emit({ event: "session.info", mode: "default" }));
          this.say("Starting on the plan.", 60);
        }
        this.at(400, () => this.end("done"));
      } else if (this.kitAsk) {
        const what = this.kitAsk;
        this.kitAsk = "";
        this.say(i.choice === "deny" ? `Okay, I did not do it: ${what}` : `Done: ${what}`, 60);
        this.at(400, () => this.end("done"));
      } else if (i.request_id.startsWith("req-") && this.subWaiting) {
        // the subagent's command ran (or was refused); the subagent hands back, then the agent answers
        this.subWaiting = false;
        const done = i.choice !== "deny";
        this.at(60, () => this.emit({ event: "tool.end", tool_id: "sa-3", name: "", ok: true, ms: 0 }));
        this.at(80, () => this.emit({ event: "subagent", id: "sa-3", agent: this.agent, name: "general-purpose", goal: "Write c.txt via echo", delegation: "claude-msg_2", index: 0, count: 1, state: "done", summary: done ? "done" : "The command was not allowed.", seconds: 4.2 }));
        this.say(done ? "ok" : "The subagent could not write c.txt.", 120);
        this.at(500, () => this.end("done"));
      } else if (i.choice === "deny") {
        this.at(40, () => this.emit({ event: "tool.end", tool_id: "t-rm", name: "", ok: false, ms: 0 }));
        this.say("Okay, I left the build folder alone.", 80);
        this.at(500, () => this.end("done"));
      } else {
        this.at(80, () => this.emit({ event: "tool.end", tool_id: "t-rm", name: "", ok: true, ms: 300 }));
        this.say(`Cleaned the build folder (${i.choice === "session" ? "allowed for this session" : "allowed once"}).`, 140);
        this.at(560, () => this.end("done"));
      }
    } else if (i.kind === "model") {
      const m = (MOCK_MODELS[this.agent] ?? []).find((x) => x.id === i.model);
      if (!m) throw new Error(`unknown model ${i.model}`);
      if (this.agent === "claude" && this.turn) {
        // Claude Code keeps the running turn on its model: the pick is for the next turn
        this.next = m.label === this.model ? "" : m.label;
        this.timers.push(setTimeout(() => this.emit({ event: "session.info", model_next: this.next }), 20));
        return;
      }
      this.model = m.label;
      this.at(20, () => this.emit({ event: "session.info", model: this.model }));
    } else if (i.kind === "clarify") {
      if (i.request_id !== this.waiting) throw new Error("no question is open");
      this.waiting = null;
      const answer = typeof i.answer === "string" ? i.answer : Object.values(i.answer).filter(Boolean).join(", ");
      this.at(40, () => this.emit({ event: "tool.start", tool_id: "t-w", name: "patch", detail: "greet.txt +1" }));
      this.at(120, () => this.emit({ event: "tool.end", tool_id: "t-w", name: "", ok: true, ms: 60 }));
      this.say(`Wrote ${answer} to greet.txt.`, 160);
      this.at(600, () => this.end("done"));
    } else {
      throw new Error("unknown input");
    }
  }
}

/** The mock's prefs files for Settings › Terminal › Import from…: an iTerm2 profile (the default first), and an Apple
 *  Terminal one beside a profile that cannot be read. */
const MOCK_IMPORT: Partial<Record<ImportApp, ImportProfile[]>> = {
  iterm2: [
    {
      name: "Harbor Night",
      default: true,
      ok: true,
      font: { name: "Menlo-Regular", size: 14 },
      colors: {
        foreground: "#d8dee9",
        background: "#14202b",
        cursor: "#f5c779",
        selection: "#2e4a62",
        ansi: ["#1c2a36", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#cfd8e3", "#4b5d6e", "#ff7a85", "#b5e08f", "#ffd68a", "#82c4ff", "#dd9cf0", "#7fd6e0", "#ffffff"],
      },
    },
    { name: "Paper", default: false, ok: true, font: { name: "NoSuchFontAnywhere-Regular", size: 12 }, colors: { foreground: "#222222", background: "#fbf8f0", cursor: "#222222", selection: "#d8d2c0", ansi: [] } },
  ],
  terminal: [
    { name: "Basic", default: true, ok: true, font: null, colors: { foreground: "#000000", background: "#ffffff", cursor: "#929292", selection: "#a4cdff", ansi: ["#000000", "#990000", "#00a600", "#999900", "#0000b2", "#b200b2", "#00a6b2", "#bfbfbf", "#666666", "#e50000", "#00d900", "#e5e500", "#0000ff", "#e500e5", "#00e5e5", "#e5e5e5"] } },
    { name: "Archived", default: false, ok: false, font: null, colors: null },
  ],
};

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let host: (SessionHost & BuddyHost) | null = null;
export function getHost(): SessionHost & BuddyHost {
  return (host ??= inTauri() ? new TauriHost() : new MockHost());
}
