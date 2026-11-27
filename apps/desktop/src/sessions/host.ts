// Where session processes run. In the desktop app: the Tauri shell, which starts an allow-listed agent
// in a pseudo-terminal (src-tauri/src/sessions.rs) or in its structured chat mode on pipes
// (src-tauri/src/agent_chat.rs). In a plain browser (dev, e2e against the mock bridge) there is no shell,
// so a mock host echoes terminal typing and a mock agent answers chats with the same events.
import type { HistoryHost } from "./term/history";
import { type AgentId, type AgentInfo } from "./agents";
import { type TurnFilesHost } from "./turnFiles";
import { type CustomEntry, type CustomList, type CustomPreview } from "./custom";
import type { RegistryList } from "../settings/agents/acpRegistry";
import type { ApprovalChoice, ClarifyAnswers } from "../lib/protocol";
import type { DiskState } from "../lib/disk";
import type { ImportApp, ImportProfile } from "./term/import";
import { type LaneFolder } from "../code/laneFolder";
import { savedKeys, type SavedKeys } from "../code/secrets";
import { type GitView } from "../code/moved";
import { type KeptLane, type LaneCleaned, type LaneMade, type LaneReleased, type LaneRemoveAsk, type LaneRemoved } from "../code/laneBranch";
import { type AgentConfig } from "../settings/mcp/agentConfig";
import { type LaneLanded, type LanePatch, type LaneTakenBack } from "../jobs/landingWire";
import { type InstallAsk, type InstallDone, type LinkRead, type ReadSkill } from "../runtime/skillBundle";
import { type MergeMethod, type NewProjectMade, type Pulled, type RepoAsk, type ReviewAsk, type ReviewDone, type ReviewDraft, type SourceTools } from "../code/source";
import { type ProviderPatch, type ProviderView, type SignIn } from "../settings/providers/model";
import { type ImportFound } from "../importPast/offer";
import { inTauri } from "../lib/tauri";
import { TauriHost } from "./host.tauri";
import { MockHost } from "./host.mock";
import type { LaneStart } from "./host.mock";


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
  /** A helper lane's own working folder (item 102f, src-tauri/src/lane_helper.rs; item 102h starts its agent there): a snapshot of
   *  the lead lane's folder `lead` (the lane's `worktree`) as it is now, kept under the app's own ref and checked out in a new
   *  worktree beside the lead's, on a branch named from the lead's (`kit/<words>-help-1`), its record naming job `job`. The lead's
   *  index, HEAD, branch, stash and files never change, nothing is pushed and no agent starts. Rejects with a short code
   *  (`bad_job`, `not_a_lane`, `lead_is_helper`, `busy`, `no_commit`, `taken`, `no_folder`, `git_missing`) or git's own line, with
   *  nothing made. Absent in a shell older than helper lanes: none then starts. */
  laneHelperWorktree?(lead: string, job: string): Promise<LaneMade>;
  /** Land a helper lane's work in its lead lane's folder (item 102g's `lane_land`, src-tauri/src/lane_land.rs; item 102i calls it
   *  when the helper lane reported and its lead is idle): `helper` is the helper lane's `worktree`, and the shell finds its lead, job
   *  and snapshot from its record. Into the lead's working tree only, one at a time per lead folder, with what was there kept for
   *  Take back; a patch that will not apply, or names a file outside the lead's project, is kept (0600) and nothing is written.
   *  Rejects with a short code (`not_a_lane`, `not_a_helper`, `no_lead`, `landed`, `busy`, `no_snapshot`, `no_commit`,
   *  `config:<setting>`, `git_missing`) or git's own line. Absent in a shell older than landings: nothing lands. */
  laneLand?(helper: string): Promise<LaneLanded>;
  /** Take back this landing (item 102g's `lane_take_back`): the files the landing of helper lane `helper` wrote go back as they
   *  were, only while nothing in the lead's folder changed since. Rejects with a short code (`not_landed`, `changed`, `no_lead`,
   *  ...) or the system's words. */
  laneTakeBack?(helper: string): Promise<LaneTakenBack>;
  /** Show patch (item 102i's `lane_patch`): the patch a landing of helper lane `helper` kept, every line masked by the shell, at most
   *  256 KiB of it. Only reads. Rejects with `no_patch`, `not_a_lane` or `not_a_helper`. */
  lanePatch?(helper: string): Promise<LanePatch>;
  /** This computer's memory in bytes (item 102h, src-tauri/src/machine.rs; docs/several-agents.md R7), read once by the shell with no
   *  program run, so the page can tell how many helper lanes run at once. Null when it could not be read. */
  machineMemory?(): Promise<number | null>;
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
  /** New project on the Code page (item 100b, src-tauri/src/new_project.rs): the folder at `path`, made in the person's home when it
   *  is not there, with git started in it by the app's own git (no hook, no template). Writes only on this Mac. Rejects with a code
   *  (`bad_path`, `outside_home`, `not_empty`, `not_a_folder`, `link`, `git_missing`, `init_failed:<line>`, ...). */
  projectNew?(path: string): Promise<NewProjectMade>;
  /** The ask to make the GitHub repository `name` from the new project at `folder`, private unless `isPublic` (review.rs `ask_repo`):
   *  the exact `gh repo create` line. Writes nothing and pushes nothing; a Yes goes through `reviewSettle` like every ask. */
  repoAsk?(folder: string, name: string, isPublic: boolean): Promise<RepoAsk>;
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
  /** The keys in what a commit or a push from the lane's folder `worktree` would save, from the same read-only, bounded read
   *  (code/secrets.ts `savedKeys`, item 117). null when this host cannot read a folder; rejects for a folder the app did not
   *  make. Kit's dial asks before a commit or a push unless this answered in time with nothing unread and no key. */
  laneKeys?(worktree: string): Promise<SavedKeys | null>;
  /** A project's own icon (item 100b, src-tauri/src/project_icon.rs): the picture folder `cwd` keeps in one of a few known places,
   *  as a `data:` address of an SVG, PNG or ICO, or null. Read only by the shell, never through a link, at most 64 KiB; the page
   *  draws it only as an image (code/ProjectIcon.tsx). Absent on a shell older than the item. */
  projectIcon?(cwd: string): Promise<string | null>;
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
  /** The newest `max` conversations of `agent` across all of `cwds` together (the folders brought over, item 101e), for History
   *  (src-tauri/src/past_chats.rs `recent`): read-only, the files read bounded by `max` however many folders. Absent on a shell
   *  older than the item. */
  pastRecent?(agent: "claude" | "codex", cwds: string[], max: number): Promise<PastChat[]>;
  /** Bring over (item 101e, src-tauri/src/import_past.rs): the folders Claude Code and Codex worked in that are still on this Mac,
   *  each with its conversations counted, newest first, and what was skipped (folders gone, compressed or unreadable files,
   *  files past the bounds). Read-only: only folders and counts come back. Absent on a shell older than the item. */
  importScan?(): Promise<ImportFound>;
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
  /** Agent `id`'s sign-in as its own status command says it (Cursor, Antigravity: `signinAgent`), or null when it says
   *  nothing. Never a token: whether it is signed in, and an email at most. */
  providerSignin?(id: string): Promise<SignIn | null>;
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
  /** Settings › Providers › From the ACP registry (item 101c): the agents of the registry's pinned copy, which the shell
   *  compiles in and never fetches (src-tauri/src/acp_registry.rs), each offered or not with its reason. Absent on a
   *  shell older than the item. */
  acpRegistry?(): Promise<RegistryList>;
  /** The confirm card for registry entry `id`: drafted as a bot's draft is (the form's checks, and no shell, interpreter
   *  or built-in program), with the exact command and where it comes from. Writes nothing: Add is `customConfirm`. A
   *  refusal rejects with `why:<code>`. */
  acpRegistryPreview?(id: string): Promise<CustomPreview>;
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

export { TauriHost } from "./host.tauri";
export { MockHost } from "./host.mock";
export type { MockCall, MockFlow, LaneStart, MockLane, MockGlobals, MockProvider } from "./host.mock";

let host: (SessionHost & BuddyHost) | null = null;
export function getHost(): SessionHost & BuddyHost {
  return (host ??= inTauri() ? new TauriHost() : new MockHost());
}

